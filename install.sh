#!/usr/bin/env bash
# FleetPanel installer (Ubuntu 24.04+/Debian 12+). Safe to re-run.
#
#   curl -fsSL https://raw.githubusercontent.com/NexusGuide/FleetPanel/main/install.sh | sudo bash
#
# Non-interactive overrides: FLEETPANEL_DOMAIN, FLEETPANEL_ADMIN_USER, FLEETPANEL_ACME_EMAIL,
# FLEETPANEL_PANEL_PORT (IP mode only, default 8080), FLEETPANEL_REF (git branch/tag; default: the
# current update channel, else main).
#
# What it does NOT do: it never deletes or edits existing nginx sites, databases or
# certificates. FleetPanel only adds its own files (fleetpanel-*.conf, fp_* databases).
set -euo pipefail

REPO_URL="${FLEETPANEL_REPO:-https://github.com/NexusGuide/FleetPanel.git}"
# Re-running keeps the update channel the server already follows (e.g. a pinned release).
REPO_REF="${FLEETPANEL_REF:-$(cat /etc/fleetpanel/ref 2>/dev/null || echo main)}"
[[ $REPO_REF =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || REPO_REF=main
FLEET_DIR=/opt/fleetpanel
APP_DIR="$FLEET_DIR/app"
SERVICE_USER=fleetpanel
BACKEND_PORT=3000
PANEL_PORT="${FLEETPANEL_PANEL_PORT:-8080}"
DOMAIN_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'

info() { printf '\033[0;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[0;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

HAS_TTY=false
if { : < /dev/tty; } 2>/dev/null; then HAS_TTY=true; fi

# ask VAR "prompt" DEFAULT  (reads from the terminal even under curl | bash)
ask() {
  local reply=""
  if [[ $HAS_TTY == true ]]; then read -r -p "$2" reply < /dev/tty || true; fi
  printf -v "$1" '%s' "${reply:-$3}"
}

[[ $EUID -eq 0 ]] || die "Run as root: curl -fsSL ... | sudo bash"
[[ -r /etc/os-release ]] || die "Cannot detect the operating system."
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) die "Only Ubuntu and Debian are supported (found: ${ID:-unknown})." ;;
esac
[[ $PANEL_PORT =~ ^[0-9]{2,5}$ ]] || die "FLEETPANEL_PANEL_PORT must be a port number."

# ---------------------------------------------------------------------------
info "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
PACKAGES=(ca-certificates curl git acl sudo openssl nginx certbot python3-certbot-nginx
          php-fpm php-cli php-mysql php-curl php-mbstring php-xml php-zip php-gd php-intl php-bcmath
          composer unzip build-essential python3)
if command -v mysqld >/dev/null 2>&1 || command -v mariadbd >/dev/null 2>&1; then
  info "Existing MySQL/MariaDB server found: reusing it (existing databases are not touched)"
else
  PACKAGES+=(mariadb-server mariadb-client)
fi
apt-get update -qq
apt-get install -y -qq "${PACKAGES[@]}" >/dev/null

# The web UI build (Vite) needs Node.js >= 20.19.
node_ok() { node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)' 2>/dev/null; }
if ! node_ok; then
  info "Installing Node.js 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  node_ok || die "Node.js >= 20.19 is required (found $(node -v 2>/dev/null || echo none))."
fi

if systemctl list-unit-files mariadb.service >/dev/null 2>&1; then
  systemctl enable --now mariadb >/dev/null 2>&1 || true
else
  systemctl enable --now mysql >/dev/null 2>&1 || true
fi
mysqladmin --protocol=socket -u root ping >/dev/null 2>&1 \
  || die "Cannot reach MySQL/MariaDB as root over the local socket (unix_socket auth is required)."

PHP_VER="$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')"
[[ $PHP_VER =~ ^[0-9]\.[0-9]$ ]] || die "Could not detect the PHP version."
if ! php -r 'exit(PHP_VERSION_ID >= 80200 ? 0 : 1);'; then
  warn "PHP $PHP_VER is installed, but MirzaBot and Faoxima need PHP >= 8.2 (Ubuntu 24.04+ / Debian 12+ ship it). The panel installs, but bots will fail to provision."
fi
systemctl enable --now "php${PHP_VER}-fpm" >/dev/null

# Offer the current panel domain as the default when re-running.
EXISTING_DOMAIN="$(grep -hoP '^\s*server_name\s+\K[a-z0-9.-]+(?=;)' \
  /etc/nginx/sites-available/fleetpanel-panel.conf 2>/dev/null | head -n 1 || true)"
[[ $EXISTING_DOMAIN =~ $DOMAIN_RE ]] || EXISTING_DOMAIN=""

# ---------------------------------------------------------------------------
info "Creating service user and directories"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$FLEET_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -o root -g root -m 0711 "$FLEET_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$FLEET_DIR/data" "$FLEET_DIR/config" "$FLEET_DIR/backups"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0711 "$FLEET_DIR/instances"
install -d -o root -g root -m 0755 /etc/fleetpanel
printf '%s\n' "$PHP_VER" > /etc/fleetpanel/php-version
# `fleetpanel update` follows the same branch/tag the panel was installed from.
printf '%s\n' "$REPO_REF" > /etc/fleetpanel/ref

# ---------------------------------------------------------------------------
info "Fetching FleetPanel ($REPO_REF)"
if [[ -d $APP_DIR/.git ]]; then
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"   # the repository may have been renamed
  git -C "$APP_DIR" fetch --quiet --depth 1 origin "$REPO_REF"
  git -C "$APP_DIR" reset --quiet --hard FETCH_HEAD
else
  git clone --quiet --depth 1 --branch "$REPO_REF" "$REPO_URL" "$APP_DIR"
fi
chown -R root:root "$APP_DIR"

info "Building (this can take a minute)"
(
  cd "$APP_DIR"
  # Install scripts run as root here: allow only the native modules that need them.
  npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
  npm rebuild argon2 better-sqlite3 esbuild --loglevel=error
  npm run build --silent
  npm prune --omit=dev --no-audit --no-fund --loglevel=error
)

# ---------------------------------------------------------------------------
KEY_FILE="$FLEET_DIR/config/master.key"
if [[ ! -s $KEY_FILE ]]; then
  ( umask 077; openssl rand 32 > "$KEY_FILE" )
  chown "$SERVICE_USER:$SERVICE_USER" "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  warn "Generated $KEY_FILE. Back it up: without it, stored bot tokens and DB passwords cannot be decrypted."
fi

info "Installing privileged helper and CLI"
install -o root -g root -m 0755 "$APP_DIR/deploy/fleetpanel-helper" /usr/local/sbin/fleetpanel-helper
install -o root -g root -m 0755 "$APP_DIR/bin/fleetpanel" /usr/local/bin/fleetpanel
SUDOERS_TMP="$(mktemp)"
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/fleetpanel-helper\nDefaults:%s !requiretty\n' \
  "$SERVICE_USER" "$SERVICE_USER" > "$SUDOERS_TMP"
visudo -cf "$SUDOERS_TMP" >/dev/null || { rm -f "$SUDOERS_TMP"; die "Generated sudoers rule is invalid."; }
install -o root -g root -m 0440 "$SUDOERS_TMP" /etc/sudoers.d/fleetpanel
rm -f "$SUDOERS_TMP"

ACME_EMAIL="${FLEETPANEL_ACME_EMAIL:-}"
if [[ -z $ACME_EMAIL && ! -f /etc/fleetpanel/acme-email ]]; then
  ask ACME_EMAIL "Email for Let's Encrypt expiry notices (optional): " ""
fi
if [[ -n $ACME_EMAIL ]]; then printf '%s\n' "$ACME_EMAIL" > /etc/fleetpanel/acme-email; fi

# ---------------------------------------------------------------------------
CLI=(sudo -u "$SERVICE_USER" env "FLEET_DIR=$FLEET_DIR" node "$APP_DIR/dist/cli.js")
ADMIN_USER=""
ADMIN_PASS=""
ADMIN_PASS_GENERATED=false
# Same rules as the panel (src/security/validation.ts, src/security/passwords.ts).
USERNAME_RE='^[A-Za-z0-9_.-]{3,32}$'
random_alnum() { local s=""; while (( ${#s} < $1 )); do s+="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9')"; done; printf '%s' "${s:0:$1}"; }
password_problem() {
  local p="$1" classes=0
  (( ${#p} >= 12 )) || { echo "at least 12 characters"; return; }
  (( ${#p} <= 256 )) || { echo "at most 256 characters"; return; }
  [[ $p =~ [a-z] ]] && classes=$((classes + 1))
  [[ $p =~ [A-Z] ]] && classes=$((classes + 1))
  [[ $p =~ [0-9] ]] && classes=$((classes + 1))
  [[ $p =~ [^A-Za-z0-9] ]] && classes=$((classes + 1))
  (( classes >= 3 )) || echo "mix at least three of: lowercase, uppercase, digits, symbols"
}
if "${CLI[@]}" has-admins; then
  info "An administrator already exists; not creating another one"
else
  ADMIN_USER="${FLEETPANEL_ADMIN_USER:-}"
  if [[ -n $ADMIN_USER ]]; then
    [[ $ADMIN_USER =~ $USERNAME_RE ]] || die "FLEETPANEL_ADMIN_USER: 3-32 characters of letters, digits, dot, dash, underscore."
  else
    while :; do
      ask ADMIN_USER "Administrator username (Enter = generate one): " ""
      if [[ -z $ADMIN_USER ]]; then
        ADMIN_USER="admin-$(random_alnum 8 | tr 'A-Z' 'a-z')"
        break
      fi
      [[ $ADMIN_USER =~ $USERNAME_RE ]] && break
      warn "Username: 3-32 characters of letters, digits, dot, dash or underscore. Try again."
    done
  fi
  if [[ $HAS_TTY == true ]]; then
    while :; do
      read -r -s -p "Administrator password (Enter = generate a strong one): " ADMIN_PASS < /dev/tty || ADMIN_PASS=""
      echo > /dev/tty
      [[ -n $ADMIN_PASS ]] || break
      problem="$(password_problem "$ADMIN_PASS")"
      if [[ -n $problem ]]; then warn "Password: $problem. Try again."; continue; fi
      read -r -s -p "Repeat the password: " confirm < /dev/tty || confirm=""
      echo > /dev/tty
      [[ $confirm == "$ADMIN_PASS" ]] && break
      warn "The passwords do not match. Try again."
    done
  fi
  if [[ -z $ADMIN_PASS ]]; then
    ADMIN_PASS="Fp-$(random_alnum 22)"
    ADMIN_PASS_GENERATED=true
  fi
  printf '%s\n' "$ADMIN_PASS" | "${CLI[@]}" create-admin "$ADMIN_USER" --role Owner >/dev/null
  [[ $ADMIN_PASS_GENERATED == true ]] || ADMIN_PASS=""
fi

# ---------------------------------------------------------------------------
PANEL_DOMAIN="${FLEETPANEL_DOMAIN:-}"
if [[ -z $PANEL_DOMAIN ]]; then
  if [[ -n $EXISTING_DOMAIN ]]; then
    ask PANEL_DOMAIN "Panel domain [$EXISTING_DOMAIN]: " "$EXISTING_DOMAIN"
  else
    ask PANEL_DOMAIN "Panel domain, e.g. panel.example.com (empty = use server IP on port $PANEL_PORT): " ""
  fi
fi
PANEL_DOMAIN="${PANEL_DOMAIN,,}"
if [[ -n $PANEL_DOMAIN && ! $PANEL_DOMAIN =~ $DOMAIN_RE ]]; then die "Invalid domain: $PANEL_DOMAIN"; fi

NGINX_CONF=/etc/nginx/sites-available/fleetpanel-panel.conf
NGINX_LINK=/etc/nginx/sites-enabled/fleetpanel-panel.conf
if [[ -n $PANEL_DOMAIN ]]; then
  LISTEN="listen 80;
    listen [::]:80;"
  SERVER_NAME="$PANEL_DOMAIN"
else
  LISTEN="listen $PANEL_PORT;
    listen [::]:$PANEL_PORT;"
  SERVER_NAME="_"
fi

info "Configuring nginx (existing sites are left untouched)"
# The default server_names_hash_bucket_size (32 on many VPS CPUs) breaks nginx once a few
# domains are hosted. Raise it unless the admin already set it (a duplicate is an error).
if [[ ! -f /etc/nginx/conf.d/fleetpanel.conf ]] \
  && ! nginx -T 2>/dev/null | grep -Eq '^[[:space:]]*server_names_hash_bucket_size[[:space:]]'; then
  printf '# Managed by FleetPanel: room for many/long server names\nserver_names_hash_bucket_size 128;\n' > /etc/nginx/conf.d/fleetpanel.conf
fi
cat > "$NGINX_CONF" <<EOF
# Managed by the FleetPanel installer
server {
    $LISTEN
    server_name $SERVER_NAME;
    client_max_body_size 1m;

    # Bot database imports (Instances -> Import database): large uploads on this path only.
    location ~ ^/api/instances/[0-9]+/import-db$ {
        client_max_body_size 512m;
        proxy_request_buffering off;
        proxy_pass http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 1800s;
    }

    location / {
        proxy_pass http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
EOF
ln -sfn "$NGINX_CONF" "$NGINX_LINK"
if ! nginx -t >/dev/null 2>&1; then
  rm -f "$NGINX_LINK"
  die "nginx rejected the panel config (port $PANEL_PORT in use?). Nothing else was changed. Run 'nginx -t' for details."
fi
systemctl reload nginx

COOKIE_SECURE=false
PANEL_URL="http://$(curl -fsS -4 --max-time 5 https://icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}'):$PANEL_PORT"
if [[ -n $PANEL_DOMAIN ]]; then
  PANEL_URL="http://$PANEL_DOMAIN"
  info "Requesting a Let's Encrypt certificate for $PANEL_DOMAIN"
  if /usr/local/sbin/fleetpanel-helper cert-issue "$PANEL_DOMAIN"; then
    COOKIE_SECURE=true
    PANEL_URL="https://$PANEL_DOMAIN"
  else
    warn "Certificate issuance failed. The panel works over plain HTTP until you fix DNS and re-run the installer."
  fi
fi
if [[ $COOKIE_SECURE == false ]]; then
  warn "The panel is served over plain HTTP. Use a domain with TLS before managing real bots."
fi

# ---------------------------------------------------------------------------
info "Installing systemd service"
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/fleetpanel.service <<EOF
[Unit]
Description=FleetPanel control plane
After=network-online.target nginx.service mariadb.service mysql.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/dist/server.js
Restart=on-failure
RestartSec=3
UMask=0077
PrivateTmp=true
ProtectHome=true
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=$BACKEND_PORT
Environment=FLEET_DIR=$FLEET_DIR
Environment=COOKIE_SECURE=$COOKIE_SECURE

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable fleetpanel.service >/dev/null 2>&1
systemctl restart fleetpanel.service

HEALTHY=false
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1; then HEALTHY=true; break; fi
  sleep 1
done
if [[ $HEALTHY != true ]]; then
  journalctl -u fleetpanel.service -n 20 --no-pager >&2 || true
  die "FleetPanel did not become healthy. See the log above."
fi

echo
echo "  FleetPanel is running."
echo "  Panel     : $PANEL_URL"
if [[ -n $ADMIN_PASS ]]; then
  echo "  Username  : $ADMIN_USER"
  echo "  Password  : $ADMIN_PASS"
  echo "  (shown once and not stored anywhere; change it with: sudo fleetpanel reset-password $ADMIN_USER)"
elif [[ -n $ADMIN_USER ]]; then
  echo "  Username  : $ADMIN_USER   (with the password you chose)"
fi
echo "  Manage    : sudo fleetpanel          (menu; or: status, doctor, logs, update)"
echo
echo "  Next: back up the master key and copy the file OFF this server:"
echo "        sudo fleetpanel backup"
echo
