#!/usr/bin/env bash
# End-to-end check of what FleetPanel does for PGClockBot, on a throwaway Ubuntu 24.04 machine (CI):
# the helper's PostgreSQL commands, database isolation, the control plane's dump/restore commands, the
# hash-pinned package install, the schema, and the bot itself started through FleetPanel's launcher.
# Usage (as root): tests/e2e/pgclock.sh <PGClockBot checkout at the pinned commit>
# It installs packages and creates users and databases: never run it on a real server.
set -euo pipefail
SRC="$(cd "${1:?usage: pgclock.sh <PGClockBot checkout>}" && pwd)"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
step() { printf '\n=== %s\n' "$*"; }
ok() { printf 'OK: %s\n' "$*"; }
bad() { printf 'FAIL: %s\n' "$*"; exit 1; }

step "base packages"
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends ca-certificates curl sudo acl iproute2 >/dev/null

# Without systemd (a container): a small stand-in for the systemctl calls runtime-postgres makes.
if [[ ! -d /run/systemd/system ]]; then
cat > /usr/local/bin/systemctl <<'EOF'
#!/bin/bash
case "$*" in
  *postgresql*) v=$(ls /etc/postgresql); pg_ctlcluster "$v" main start 2>/dev/null || true; exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x /usr/local/bin/systemctl
fi
H="$REPO/deploy/fleetpanel-helper"

step "runtime-postgres (installs PostgreSQL)"
bash "$H" runtime-postgres
v=$(ls /etc/postgresql); ok "PostgreSQL $v running"
listen=$(cd / && runuser -u postgres -- psql -XAtqc 'SHOW listen_addresses')
[[ $listen == localhost ]] && ok "listens on: $listen" || bad "listen_addresses=$listen"
bash "$H" runtime-postgres && ok "re-running is harmless"

PW=AbcDEF0123456789abcdefGHIJ012345
step "pg-create"
printf '%s\n' "$PW" | bash "$H" pg-create fp_clock_bot fp_clock_bot
printf '%s\n' "$PW" | bash "$H" pg-create fp_clock_bot fp_clock_bot && ok "idempotent"
printf '%s\n' "OtherPass0123456789OtherPass01" | bash "$H" pg-create fp_other fp_other
attrs=$(cd / && runuser -u postgres -- psql -XAtqc "SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname='fp_clock_bot'")
[[ $attrs == 'f|f|f|t' ]] && ok "role: login only ($attrs)" || bad "role attrs $attrs"
owner=$(cd / && runuser -u postgres -- psql -XAtqc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='fp_clock_bot'")
[[ $owner == fp_clock_bot ]] && ok "database owner $owner" || bad "owner $owner"
sowner=$(cd / && runuser -u postgres -- psql -XAtq -d fp_clock_bot -c "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'")
[[ $sowner == fp_clock_bot ]] && ok "schema public owner $sowner" || bad "schema owner $sowner"
if grep -rq "$PW" /var/log/postgresql/ 2>/dev/null; then bad "password in the server log"; else ok "password not in the server log"; fi

step "isolation between bots"
out=$(PGPASSWORD=OtherPass0123456789OtherPass01 psql -X -h 127.0.0.1 -U fp_other -d fp_clock_bot -c 'SELECT 1' 2>&1 || true)
[[ $out == *"permission denied for database"* ]] && ok "another bot's role cannot connect: $(echo "$out" | head -1)" || bad "other role: $out"
out=$(PGPASSWORD=wrong psql -X -h 127.0.0.1 -U fp_clock_bot -d fp_clock_bot -c 'SELECT 1' 2>&1 || true)
[[ $out == *"password authentication failed"* ]] && ok "wrong password refused" || bad "wrong pw: $out"

# The control plane's own commands (src/system/toolchain.ts), as an unprivileged user.
useradd -m fleetpanel 2>/dev/null || true
CONN=(--host=127.0.0.1 --port=5432 --username=fp_clock_bot --no-password)
as_cp() { runuser -u fleetpanel -- env PGPASSWORD="$PW" PGCONNECT_TIMEOUT=10 "$@"; }
step "control-plane sql / dump / restore"
as_cp psql "${CONN[@]}" -X -q -v ON_ERROR_STOP=1 --dbname=fp_clock_bot -c "CREATE TABLE t (id int); INSERT INTO t VALUES (1),(2),(3);"
n=$(as_cp psql "${CONN[@]}" -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 --dbname=fp_clock_bot -c 'SELECT COUNT(*) FROM t;')
[[ $n == 3 ]] && ok "sql() returns $n" || bad "sql $n"
cd /home/fleetpanel
as_cp pg_dump "${CONN[@]}" --format=custom --no-owner --no-acl --file=/home/fleetpanel/db.dump fp_clock_bot
[[ $(head -c5 db.dump) == PGDMP ]] && ok "custom-format dump ($(stat -c %s db.dump) bytes)"
as_cp psql "${CONN[@]}" -X -q -v ON_ERROR_STOP=1 --dbname=fp_clock_bot -c "CREATE TABLE newer (x int); DELETE FROM t;"
as_cp pg_restore --list db.dump >/dev/null && ok "pg_restore --list"
as_cp psql "${CONN[@]}" -X -q -v ON_ERROR_STOP=1 --dbname=fp_clock_bot -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
as_cp pg_restore "${CONN[@]}" --no-owner --no-acl --single-transaction --exit-on-error --dbname=fp_clock_bot db.dump
n=$(as_cp psql "${CONN[@]}" -X -q -A -t --dbname=fp_clock_bot -c 'SELECT COUNT(*) FROM t;')
tables=$(as_cp psql "${CONN[@]}" -X -q -A -t --dbname=fp_clock_bot -c "SELECT string_agg(tablename, ',') FROM pg_tables WHERE schemaname='public';")
[[ $n == 3 && $tables == t ]] && ok "restore: rows=$n tables=$tables (newer table gone)" || bad "restore rows=$n tables=$tables"
as_cp psql "${CONN[@]}" -X -q --dbname=fp_clock_bot -c 'DROP TABLE t;'

step "Python 3.12 + pinned packages (as the bot's user)"
curl -fsSL --proto '=https' -o /tmp/uv.tgz "https://github.com/astral-sh/uv/releases/download/0.11.31/uv-x86_64-unknown-linux-gnu.tar.gz"
echo "8cc1cd82d434ec565376f98bd938d4b715b5791a80ff2d3aa78821cf85091b4b  /tmp/uv.tgz" | sha256sum -c --quiet && ok "uv checksum"
tar -xzf /tmp/uv.tgz -C /tmp && install -d /opt/rt/bin /opt/rt/python && install -m755 /tmp/uv-x86_64-unknown-linux-gnu/uv /opt/rt/bin/uv
UV_PYTHON_INSTALL_DIR=/opt/rt/python UV_NO_CACHE=1 /opt/rt/bin/uv python install 3.14 3.12 >/dev/null 2>&1 && ok "Python 3.14 + 3.12"
chmod -R a+rX /opt/rt
useradd --system --user-group --no-create-home --home-dir /srv/clock --shell /usr/sbin/nologin fp-clock
rm -rf /srv/clock && cp -r "$SRC" /srv/clock && rm -rf /srv/clock/.git
cp "$REPO/deploy/locks/pgclock.txt" /srv/clock/fleetpanel-requirements.txt
mkdir -p /srv/clock/workdir /srv/clock/logs && chown -R fp-clock:fp-clock /srv/clock
cd /srv/clock
H2=$(mktemp -d); chown fp-clock "$H2"
BASE=(PATH="/opt/rt/bin:/usr/bin:/bin" LANG=C.UTF-8 HOME="$H2" UV_PYTHON_INSTALL_DIR=/opt/rt/python UV_PYTHON_DOWNLOADS=never
  UV_PYTHON_PREFERENCE=only-managed UV_CACHE_DIR=/srv/clock/.cache/uv UV_LINK_MODE=copy)
# Same command as the helper's python-reqs task.
time runuser -u fp-clock -- env -i "${BASE[@]}" bash -c '"$0" venv --clear --quiet --python "$1" .venv && exec "$0" pip sync --require-hashes --no-build --quiet --python .venv/bin/python "$2"' /opt/rt/bin/uv 3.12 fleetpanel-requirements.txt
ok "python-reqs: $(.venv/bin/python --version), $(.venv/bin/python -m pip --version 2>/dev/null || echo 'no pip') "
.venv/bin/python -c 'import aiogram, fastapi, asyncpg, sqlalchemy; print("imports:", aiogram.__version__, fastapi.__version__, asyncpg.__version__, sqlalchemy.__version__)'

step "environment as FleetPanel writes it"
WEBPW='Ab3dE-fG7hJ-kL9mN-pQ2rS'
cat > /tmp/clock.env <<EOF
BOT_TOKEN=123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
BOT_USERNAME=clock_bot
ADMIN_IDS=42
DATABASE_URL=postgresql+asyncpg://fp_clock_bot:$PW@127.0.0.1:5432/fp_clock_bot
WEB_HOST=127.0.0.1
WEB_PORT=20005
WEB_SECRET=sssssssssssssssssssssssssssssssssssssssssss
WEB_ADMIN_USER=admin
WEB_ADMIN_PASSWORD=$WEBPW
WEBHOOK_URL=https://clock.example.com
WEBHOOK_PATH=/telegram/webhook
WEBHOOK_SECRET_TOKEN=wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww
PUBLIC_BASE_URL=https://clock.example.com
TRUST_PROXY=1
TRUST_PROXY_HOPS=1
EOF
# The helper's own validation of every line (instance-env).
RE_ENV_LINE="$(grep -E '^readonly RE_ENV_LINE=' "$H" | sed -E "s/^readonly RE_ENV_LINE='(.*)'$/\1/")"
KEYS="$(grep -E '^readonly ENV_KEYS=' "$H" | sed -E 's/^readonly ENV_KEYS="(.*)"$/\1/')"
while IFS= read -r line; do
  [[ $line =~ $RE_ENV_LINE ]] || bad "helper would refuse: ${line%%=*}"
  [[ " $KEYS " == *" ${line%%=*} "* ]] || bad "key not allowed: ${line%%=*}"
done < /tmp/clock.env
ok "every line passes the helper's checks"
runenv() { runuser -u fp-clock -- env -i "${BASE[@]}" bash -c 'while IFS= read -r line || [[ -n $line ]]; do [[ -z $line ]] || export "$line"; done; exec "$@" </dev/null' fleetpanel-run "$@" < /tmp/clock.env; }

step "alembic upgrade head (python-migrate)"
runenv .venv/bin/alembic upgrade head 2>&1 | tail -3
n=$(as_cp psql "${CONN[@]}" -X -q -A -t --dbname=fp_clock_bot -c 'SELECT COUNT(*) FROM alembic_version;')
[[ $n -gt 0 ]] && ok "ready check: alembic_version rows=$n" || bad "alembic"
ntab=$(as_cp psql "${CONN[@]}" -X -q -A -t --dbname=fp_clock_bot -c "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public';")
ok "$ntab tables, owned by $(as_cp psql "${CONN[@]}" -X -q -A -t --dbname=fp_clock_bot -c "SELECT string_agg(DISTINCT tableowner, ',') FROM pg_tables WHERE schemaname='public';")"

step "start run.py through FleetPanel's launcher"
# The launcher the helper writes (write_pyrun), extracted from the helper itself.
sed -n "/^  cat > \"\$PYRUN.tmp\" <<'EOF'/,/^EOF/p" "$H" | sed '1d;$d' > /tmp/pyrun.py
cd /srv/clock/workdir
(runenv /srv/clock/.venv/bin/python /tmp/pyrun.py /srv/clock/run.py > /tmp/bot.log 2>&1 &)
for i in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:20005/ || true)
  [[ $code != 000 ]] && break; sleep 2
done
[[ $code == 303 || $code == 302 || $code == 200 ]] && ok "GET / -> $code ($(curl -s -o /dev/null -w '%{redirect_url}' http://127.0.0.1:20005/))" || { tail -40 /tmp/bot.log; bad "web $code"; }
curl -fsS -o /dev/null -w '' http://127.0.0.1:20005/ && ok "curl -f passes (service-wait)"
ss -Hltn 'sport = :20005' | awk '{print $4}' | sed 's/^/listening: /'
ss -Hltn 'sport = :20005' | awk '{print $4}' | grep -qv '^127\.0\.0\.1:' && bad "listens beyond loopback" || ok "loopback only"
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:20005/setup)
ok "/setup -> $code (first-run wizard closed)"
[[ -f /srv/clock/data/setup_complete.flag ]] && ok "setup complete flag written" || bad "setup not complete"
hash=$(/srv/clock/.venv/bin/python -c 'import json;print(json.load(open("/srv/clock/data/web_admin.json"))["password"][:4])')
[[ $hash == '$2b$' ]] && ok "web_admin.json holds a bcrypt hash" || bad "web_admin.json: $hash"
cd /srv/clock
v=$(runenv .venv/bin/python -c "from app.services.web_auth import verify_web_admin as v; print(v('admin', '$WEBPW'), v('admin', 'wrong-Password-12'))")
[[ $v == 'True False' ]] && ok "first web login works, a wrong password does not" || bad "login check: $v"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:20005/telegram/webhook -d '{}' -H 'X-Telegram-Bot-Api-Secret-Token: nope')
ok "webhook without the secret -> $code"
[[ -f /srv/clock/.env ]] && echo ".env written by the bot: $(grep -c . /srv/clock/.env) lines (keys: $(cut -d= -f1 /srv/clock/.env | tr '\n' ' '))" || ok "no .env written by the bot"
grep -E 'Web panel ready|Bot online|Cannot connect|Webhook set|ERROR' /tmp/bot.log | head -8 || true
if grep -q "$WEBPW" /tmp/bot.log; then bad "web password in the log"; else ok "web password not in the log"; fi
pkill -u fp-clock || true

step "db-drop (postgres)"
bash "$H" db-drop fp_clock_bot fp_clock_bot postgres
left=$(cd / && runuser -u postgres -- psql -XAtqc "SELECT COUNT(*) FROM pg_database WHERE datname='fp_clock_bot'")$(cd / && runuser -u postgres -- psql -XAtqc "SELECT COUNT(*) FROM pg_roles WHERE rolname='fp_clock_bot'")
[[ $left == 00 ]] && ok "database and role dropped" || bad "left: $left"
bash "$H" db-drop fp_clock_bot fp_clock_bot postgres && ok "idempotent"
printf '\nALL CHECKS PASSED\n'
