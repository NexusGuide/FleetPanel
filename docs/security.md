# Security implementation details

This document maps each control in [SECURITY.md](../SECURITY.md) to the code that implements it.

## Passwords and sessions

- `src/security/passwords.ts`: Argon2id with `memoryCost 65536, timeCost 3, parallelism 4`. For unknown
  usernames a dummy hash is still verified so timing does not reveal valid accounts. Policy: 12+
  characters mixing three of lowercase, uppercase, digits, symbols.
- `src/http/sessions.ts`: 32-byte random tokens; only `sha256(token)` is stored. A separate random
  `public_id` identifies sessions in the API. Idle (2 h) and absolute (24 h) expiry are checked on every
  request; disabled accounts lose their sessions immediately. Logging in always creates a new session
  (session-fixation defence). Changing a password signs out all other sessions.
- `src/http/routes/auth.ts`: login is rate limited per client (30 / 15 min), per client+username
  (5 / 15 min) and per username alone (50 / 15 min), so rotating addresses cannot speed up guessing one
  account. `src/http/rateLimit.ts` keys IPv6 clients by their /64.

## Request protection

- `src/http/middleware.ts`:
  - `originCheck`: state-changing requests with an `Origin` header must match `Host`.
  - `csrfProtection`: authenticated `POST/PUT/PATCH/DELETE` need `X-CSRF-Token` equal to the session's
    token (constant-time comparison).
  - `requirePermission`: RBAC from `src/security/rbac.ts`; denials are audited.
  - `securityHeaders`: CSP `default-src 'self'; script-src 'self'; style-src 'self'; …`, frame and
    referrer headers, `Cache-Control: no-store` for the API, HSTS over TLS.
- `src/http/app.ts`: JSON bodies limited to 64 KB; a global API rate limit; errors never leak stack traces.
- The web UI is built without inline scripts or styles (`assetsInlineLimit: 0`) so the CSP needs no exceptions.

## Secrets at rest

- `src/security/crypto.ts`: `SecretBox` (AES-256-GCM, 12-byte random IV, 16-byte tag, versioned format).
  `fromFile` refuses keys readable by group/others.
- `src/secrets.ts`: each secret's AAD is `instance:<id>:<name>`, so ciphertexts cannot be swapped between
  rows or instances. Stored secrets: bot token, database password (32 random alphanumerics), webhook
  secret (32 random bytes, base64url).
- Database passwords reach MySQL clients through a temporary `my.cnf` (mode 600), never argv
  (`src/system/toolchain.ts`).

## Input validation and injection

- `src/security/validation.ts`: zod schemas with allowlist regexes for slugs, domains, bot tokens,
  Telegram ids and usernames; unknown fields are rejected.
- `deploy/fleetpanel-helper` re-validates every argument with equivalent regexes as root.
- `src/security/php.ts`: `phpString()` produces single-quoted PHP literals (escapes `\` then `'`) and
  rejects control characters. Provider configs are filled only through it (`src/providers/index.ts`).
- `src/system/exec.ts`: the only way to run programs; `execFile` with an argument array, a fixed `PATH`,
  output masked by `src/security/mask.ts`.
- SQL in the control plane uses prepared statements. The few SQL statements sent to bot databases inline
  only values that were validated against strict patterns first.

## Upstream bot code

- Each provider is pinned to one reviewed upstream commit (40-hex id), never a branch or tag. Installs and
  **Repair** fetch exactly that commit and verify `HEAD` afterwards, so a compromised upstream repository
  cannot push new code onto FleetPanel servers; moving a pin is a reviewed FleetPanel release
  (see [providers.md](providers.md#pinned-upstream-versions)).
- The commit each instance was installed from is recorded and shown in the panel.

## Isolation on the host

Bot updates copy the new code into a bot's folder as the bot's own user (helper `instance-upgrade-sync`),
from a staging folder only that user may read (ACL); the control plane never writes into a folder the bot
controls. Only versions reviewed and pinned in a FleetPanel release can be installed; newer upstream
versions are only announced.

PHP bots' cron jobs run from `fleetpanel-cron-<slug>.timer` as the bot's user, sandboxed
(`ProtectSystem=strict`, only the bot's folder writable, `NoNewPrivileges`, private `/tmp`). Bot users are
listed in `/etc/cron.deny`, so a bot cannot install crontab entries of its own; `/cron/` and `/cronbot/` are
reachable from the server itself only. The nginx sites also deny `storage/`, `api/handlers/`, `api/lib/`,
`panel/lib/` and Faoxima's cronbot state files, as the upstream projects' own configurations do.

Service bots (PasarguardBot) additionally:

- run as systemd services under `fp-<slug>` with `ProtectSystem=strict` (only their own folder is
  writable), `NoNewPrivileges`, `PrivateTmp`, kernel/cgroup protection and memory limits;
- get their secrets from `/etc/fleetpanel/instances/<slug>.env` (root-only, allowlisted keys, shell-safe
  values), never from a file in their folder or from a command line;
- each have their own Redis on a Unix socket with mode 700 (no TCP, no shared keyspace);
- have their web server forced onto 127.0.0.1 (the upstream code binds 0.0.0.0); provisioning stops the bot
  if it listens anywhere else, and nginx hides the API documentation;
- get no `www-data` access to their folder (nginx only proxies to them);
- use toolchains pinned by version and SHA-256 (uv, bun) and lock files with hashes (`uv.lock`,
  `bun.lock`); dependencies are installed as the bot's user. A project without a lock file (PGClockBot) is
  installed from a hash-pinned lock FleetPanel ships (`deploy/locks/`), wheels only.

PostgreSQL (PGClockBot): installed from the distribution with the first bot that uses it and left listening
on loopback only (`doctor` warns otherwise). Each bot gets a login role with no other privileges
(`NOSUPERUSER NOCREATEDB NOCREATEROLE`) that owns its own database and its `public` schema; `CONNECT` is
revoked from `PUBLIC`, so other bots' roles cannot open it. Roles are created as `postgres` over the local
socket with the password on stdin and statement logging off for that session. The control plane reaches a
bot's database over TCP on 127.0.0.1 with its password in the environment (`PGPASSWORD`), never in argv.
Restores and imports use `pg_restore` of custom-format dumps only: plain SQL would need `psql`, which runs
client-side commands (`\!`) found in its input.

PGClockBot's own web panel gets its first password from FleetPanel (in the root-only environment file; the
bot stores it as a bcrypt hash on first start), so its first-run wizard is never open on a public domain. It
runs with `TRUST_PROXY=1` behind nginx, which appends the real client address to `X-Forwarded-For`.

- Each instance has its own Linux user `fp-<slug>` and PHP-FPM pool with
  `open_basedir = <instance dir>:/tmp`, `display_errors off`.
- `instance-perms` (helper): files owned by `fp-<slug>`, `chmod u=rwX,g=rX,o=`; ACLs grant the
  `fleetpanel` user read/write and `www-data` read; `config.php` is explicitly unreadable to `www-data`.
  It works from inside the instance directory (`cd -P`, then relative paths), so swapping the path for a
  symlink during the run cannot redirect `chmod` elsewhere.
- `instance-run` (helper): the bot's install steps run as `fp-<slug>` via `runuser` with a clean
  environment and a private `HOME`; Composer runs with `--no-scripts --no-plugins`. Code from the bot's
  repository or its dependencies therefore never runs as the control-plane user.
- nginx vhost per instance: `disable_symlinks if_not_owner`; denies dotfiles,
  `*.sql|log|ini|env|bak|sh|lock|md|json|txt|zip|tar|gz|tgz|bz2|xz|7z|rar|db|sqlite|csv|xls|xlsx|pem|key`,
  `error_log` files, `config.php`, `config/`, `vendor/`, `db/`, `logs/` (the bots write their own database
  backups and exports inside their folder). The webhook location requires the instance's secret (header
  or `?secret=`, per provider) and does not log query-string secrets.
- `instance-create` refuses a domain that another enabled nginx site already serves.
- Generated pool and vhost files are validated with `php-fpm -t` and `nginx -t` before anything is
  enabled; on failure they are removed and the tool's error is reported.

## Backups

- Instance backups (`src/services/backups.ts`): tar of the instance directory, a `mysqldump` and a
  manifest; mode 600; SHA-256 recorded and verified before restore; archive entries are checked against
  an allowlist (no absolute paths, no `..`), symlinks and hard links must stay inside the instance, and
  devices/FIFOs are refused, all before extraction; a pre-restore safety backup is taken. The dump is
  rejected if any line is a `mysql` client command (`\!`, `system`), and imported with `--binary-mode`,
  which disables client commands: a table name crafted by a compromised bot cannot run shell commands.
- Control-plane backups (`src/cli.ts`, `bin/fleetpanel`): SQLite online-backup copy of the database plus
  the master key, mode 600, in `/opt/fleetpanel/backups`. They must be stored off the server.

## Panel backups (.fleet)

- Encrypted with AES-256-GCM under a key from X25519 (one-off key per file + the panel's backup public key)
  and HKDF-SHA256; the header (host, version, keys) is authenticated.
- The private key is stored only inside the files, encrypted with a scrypt key (N=2^16, r=8, p=1) from the
  recovery passphrase, which is never stored. The server cannot decrypt backups it already sent.
- Each file is decrypted once right after encryption to verify it; login sessions are removed from the copy.
- Telegram bot token: encrypted with the master key in the panel database. Configuring backups needs the
  Owner-only `settings.manage` permission.

## Database import

- Uploads only through the import path (512 MB limit there; 1 MB elsewhere), streamed to a private scratch
  directory; `.zip` entries are read with `unzip -p` (no extraction to disk).
- Refused: mysql client commands. Removed: `CREATE DATABASE`, `USE`, `DEFINER`. Imported as the bot's
  own database user with `--binary-mode`, after a safety backup.

## Audit log

`src/audit.ts` and the `audit_logs` table: insert-only (triggers abort `UPDATE` and `DELETE`). Entries
record actor, action, resource, client IP, result and masked metadata. Failed logins, permission
denials, CSRF failures are visible through the API's 403s; failed instance and backup operations are
recorded with their error.
