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

## Audit log

`src/audit.ts` and the `audit_logs` table: insert-only (triggers abort `UPDATE` and `DELETE`). Entries
record actor, action, resource, client IP, result and masked metadata. Failed logins, permission
denials, CSRF failures are visible through the API's 403s; failed instance and backup operations are
recorded with their error.
