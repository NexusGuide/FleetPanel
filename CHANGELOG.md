# Changelog

## v0.4.2 (dev channel)

### Added
- **Cron jobs for MirzaBot and Faoxima.** Their own dispatcher (`cronbot/run.php`, `cron/cron.php`) now runs
  every minute from a sandboxed systemd timer as the bot's user, so expiry and activation of services,
  payment checks, notifications, broadcasts and the bots' own backups work. Existing bots get it when the
  panel starts after `fleetpanel update`; `doctor` checks the timers and `fleetpanel logs <slug>` shows them.

### Security
- Bot users may not install crontab entries of their own (`/etc/cron.deny`): one supervised scheduler, and
  no persistent cron job for a compromised bot.
- `/cron/` and `/cronbot/` are reachable from the server itself only, and the PHP bots' sites also deny
  `storage/`, `api/handlers/`, `api/lib/`, `panel/lib/` and Faoxima's cronbot state files, like the
  projects' own nginx configurations. Applied to existing bots at panel start (checked with `nginx -t`).

### Changed
- A shorter CLI menu: 8 items instead of 12. *Status* already lists the bots (no separate *Instances*);
  *Logs* offers the panel's log or any Python bot's log; *Backups* lists, backs up the panel and restores;
  *Update* updates now or first switches the channel. The direct commands (`fleetpanel instances`,
  `channel`, `backup`, …) are unchanged.
- *Restart panel* in the menu waits for the panel to be healthy and says so if it is not.

## v0.4.1 (dev channel)

### Added
- **Encrypted Telegram backups of the panel** (*Settings → Telegram backup*, Owner only): the panel database
  and master key as an encrypted `.fleet` file, sent to a chat, group, channel or forum topic every hour,
  6 hours or day, only when something changed and at least daily. *Download* gives a fresh file.
  Encryption: X25519 + AES-256-GCM; the private key is protected by a recovery passphrase (scrypt) that the
  server never stores, so neither the chat nor a compromised server can open the backups.
- `sudo fleetpanel restore FILE.fleet` restores such a backup (asks for the passphrase). Bots whose files
  are missing on the server are then marked *"not installed on this server"* for **Repair**.
- **Import database** in a bot's details: replace its database with one of the bot's own backups
  (`.sql`, `.sql.gz` or a `.zip` with one `.sql`, up to 512 MB). A safety backup is taken first; the dump
  is checked (no mysql client commands) and rewritten (no `CREATE DATABASE`/`USE`/`DEFINER`) and imported
  as the bot's own database user; FleetPanel's schema, webhook secret and webhook are reapplied.
- [Disaster recovery guide](docs/backup.md).

### Changed
- New permission `settings.manage` (Owner only).
- The panel's nginx site accepts large uploads on the database-import path only (`fleetpanel update`
  adds it to existing installs and keeps the old file if `nginx -t` rejects the change).

## v0.4.0-beta.1 (dev channel)

Test build: follow it with `sudo fleetpanel channel dev && sudo fleetpanel update`. It moves to the stable
`main` channel as v0.4.0 once testers have had a go at it.

### Added
- **PasarguardBot** ([AmirKenzo/PasarguardBot](https://github.com/AmirKenzo/PasarguardBot) `v2.1.4`), the
  first Python bot. It runs as its own sandboxed systemd service (`fleetpanel-bot-<slug>`) with its own
  Redis on a private Unix socket, behind nginx with TLS. The create wizard asks for the Telegram API id
  and hash it needs (my.telegram.org). The first one on a server installs a pinned, checksum-verified
  Python runtime (uv `0.11.31`, Python 3.14, bun `1.4.2`) and Redis.
- `fleetpanel logs SLUG` shows a Python bot's log; `fleetpanel doctor` checks that running Python bots'
  services are active.
- Installing a Python bot only succeeds once its web server answers and its Telegram client has not
  failed; otherwise the panel shows the bot's error (for example a wrong API id/hash).
- Menu item 9 (*Version / update channel*) lets you pick the channel from a list (stable `main`, test
  builds on `dev`, or one released version) and update right away, instead of typing a ref.
- `fleetpanel update` warns before restarting the panel while a bot is being installed or deleted, and
  bot install steps are the first to go if memory runs out, never the panel or other bots.

### Security
- Reviewed PasarguardBot `v2.1.4` before pinning it. FleetPanel works around what it can: the bot's web
  server is forced onto 127.0.0.1 (upstream binds 0.0.0.0, which would expose its API without TLS) and
  provisioning stops it if it listens elsewhere; its API documentation is hidden; it runs from a separate
  working directory; its secrets live in a root-only environment file with allowlisted keys.
- Provisioning errors and stored `last_error` texts mask database URL passwords and API hashes, as well
  as bot tokens.

### Changed
- Backups leave out virtualenvs, package caches and Redis sockets; restoring a Python bot rebuilds its
  virtualenv from `uv.lock`.

### Fixed
- The "open" buttons in the instance list and details opened the site root, which for MirzaBot and Faoxima
  is the Telegram webhook (nginx answers 403 without the secret). They now open the bot's own web panel
  (`/panel/`; PasarguardBot: `/webapp/`), shown as its own *Web panel* row in the details.
- The audit log page failed (500) when secret masking had turned a stored entry into invalid JSON; such an
  entry is now shown as text.
- `fleetpanel update` kept every pre-update database snapshot forever; only the three newest are kept.
- Shorter, clearer CLI output: `update` shows the build log only when the build fails, `version` is one line,
  and the menu's channel picker no longer repeats itself. The panel's install hints no longer list
  PHP-only steps for Python bots.

### Upgrading
`sudo fleetpanel update`. Existing MirzaBot and Faoxima bots are not changed.

## v0.3.3

### Security
- **Bot code is pinned to reviewed upstream commits.** Installs and **Repair** used to download whatever
  was on the MirzaBot / Faoxima default branch, so anyone who took over one of those repositories could push
  code onto every FleetPanel server. Each provider now names one exact commit (MirzaBot `main` @
  `8e551ecf73d1`, Faoxima `v1.1.5`); FleetPanel fetches exactly that commit and verifies it after
  checkout. The MirzaBot pin includes its fix that re-enables an S-UI user on renewal or extra volume/time.
  Newer upstream versions arrive only through a reviewed FleetPanel release
  ([how pins are updated](docs/providers.md#pinned-upstream-versions)).

### Added
- `fleetpanel firewall` (also in the menu): optional ufw setup that keeps SSH (detected from `sshd` and
  your session), 80, 443 and the panel port open, asks about every other public port (database ports
  default to closed), keeps existing rules and can block ping (`--block-ping`).
- `fleetpanel doctor` reports whether a firewall is active and warns when ufw blocks 80/443.
- The create wizard checks for duplicates before the review step: an existing bot name (also in other
  letter case, e.g. `MIRZA1` = `mirza1`), domain or Telegram bot is reported on its field, naming the bot
  that already uses it, and the bot's @username is shown on the review step. The API returns
  `slug_in_use` / `domain_in_use` / `bot_in_use` instead of a generic conflict.
- The instance details show the upstream commit the bot was installed from; the create wizard shows each
  provider's pinned version.

### Upgrading
`sudo fleetpanel update`. Existing bots keep their current code until you press **Repair**, which
reinstalls their code from the pinned commit (the database and the panel's settings for the bot are kept).

## v0.3.2

Security release from a line-by-line audit. Upgrading is recommended; afterwards press **Repair** on each
bot so its nginx site gets the new rules.

### Security
- **High:** restoring a backup fed the database dump to the `mysql` client, which runs its own commands
  (`\!`, `system`). A table name crafted by a compromised bot could inject such a command into the dump
  and run shell commands as the control-plane user on restore. Dumps containing client commands are now
  refused, and imports use `--binary-mode`, which disables client commands.
- **High:** a bot's install steps (`composer install` including dependency scripts, and its schema
  script) ran as the control-plane user, so a compromised upstream project or package could take over the
  panel. They now run as the bot's own Linux user through the root helper (`instance-run`), and Composer
  runs with `--no-scripts --no-plugins`.
- **High:** bot sites could serve files the bots write inside their folder, including MirzaBot's zipped
  database backups and spreadsheet exports, to anyone guessing the name. Archives, exports and data files
  are now denied.
- **Medium:** a bot could plant a symlink to another bot's files and have nginx serve them. Bot sites now
  use `disable_symlinks if_not_owner`, and restores refuse archive links leaving the instance.
- **Medium:** `instance-perms` checked the instance path and then ran `chmod -R` on it; swapping the path
  for a symlink in between could change permissions elsewhere on the system. It now works from inside the
  directory.
- **Medium:** login limits were keyed on the full client address, so rotating IPv6 addresses bypassed
  them. IPv6 clients are grouped per /64 and each username has its own limit (50 attempts / 15 min).
- **Medium:** install and update ran every npm package's install scripts as root. Only the three native
  modules that need them (argon2, better-sqlite3, esbuild) are rebuilt now.
- **Low:** `fleetpanel restore` (as root) did not check that the files in a control-plane backup were
  regular files; a crafted archive could make it copy any file (e.g. via a symlink to /etc/shadow).

## v0.3.1

### Fixed
- Creating an instance for a domain that another nginx site already serves (for example a leftover
  instance from an earlier install) succeeded, but nginx only warns about duplicate server names and
  routed the bot's traffic to the other site: Telegram got 403 and the bot never answered. The helper now
  refuses such a domain with a clear error.
- `fleetpanel doctor` warns about domains served by more than one nginx site.

## v0.3.0

### Renamed to FleetPanel

The project (formerly Fleetbot) is now **FleetPanel**, at
[NexusGuide/FleetPanel](https://github.com/NexusGuide/FleetPanel). Every name follows: the `fleetpanel`
command, `fleetpanel.service`, `/opt/fleetpanel`, `/etc/fleetpanel`, the `fleetpanel` service user,
`fleetpanel-helper`, `fleetpanel-*` nginx/PHP-FPM files and `FLEETPANEL_*` installer variables. Bot
databases are now `fp_<slug>` and bot Linux users `fp-<slug>`.

There is no automatic upgrade from v0.2: install v0.3 on a fresh server (or uninstall v0.2 with full purge
first) and recreate the bots.

### Changed
- Re-running the installer offers the current panel domain as the default.
- The installer header states the real requirement (Ubuntu 24.04+ / Debian 12+, for PHP 8.2).

## v0.2.0 (2026-10-01)

First release with a web panel. Pre-release: provisioning, the panel and `fleetpanel update`
were tested on a real Ubuntu 24.04 server with MirzaBot and Faoxima; backup/restore on a
real server and the bots' cron jobs are still to come.

### Added
- **Web panel**, served by FleetPanel itself under a strict CSP:
  - Dashboard with real server CPU load, memory, disk and recent activity
  - Instances: guided create wizard, start, stop, backup, reprovision/repair, delete
    (with a pre-delete backup); failed installs show the real error and the failing step
  - Backups: list, restore (a safety backup is taken first), delete
  - Administrators (Owner only), audit log with filters, account and session management
- **Operator CLI** (`fleetpanel`): interactive menu, `doctor` (host checks with PASS/WARN/FAIL),
  `start`/`stop`/`restart`, `logs -f`, `instances`, `backups`, `version`, `channel` (follow `main` or pin
  a release), and `uninstall` (standard, or full purge with typed confirmation)
- **Control-plane backup and restore** (`fleetpanel backup` / `fleetpanel restore FILE`): the panel database
  and the master key, which previously had no backup at all; instance backup/restore from the CLI too
- Documentation: architecture, installation, CLI, REST API, providers, security details, contributing
- `GET /api/system` and `GET /api/system/providers`
- CI (type-check, tests, build, shell checks)

### Fixed
- Provisioned bots never answered: providers only cloned the code. Each provider now runs
  its project's real install steps (`composer install`, `table.php`, the project's own
  config template, a webhook secret that matches the bot's own check) and removes the
  upstream web installer.
- Faoxima's config was written to the wrong file in the wrong format.
- Any domain containing `-` failed provisioning; control characters were not rejected in
  generated PHP config values.
- Bots' static files (CSS, JS, images) returned 403.
- A third hosted domain broke nginx (`server_names_hash_bucket_size`).
- Two instances could share one bot token and steal each other's webhook.
- Failed operations were missing from the audit log, and service actions did not record
  the client IP.
- An administrator could disable their own account.
- `fleetpanel update` stopped the panel for the whole build, ignored the installed
  branch/tag, snapshotted the database without its WAL and never updated the CLI. It now
  builds in a staging directory, swaps in a few seconds and rolls back by rename.
- The installer accepted Node.js < 20.19, built without the lockfile, and printed the
  health URL instead of the panel URL.
- Native modules failed to install on Node.js 22+ / npm 11.

### Upgrading from v0.1
Install the new system packages, then update:

```bash
sudo apt-get install -y composer unzip php8.3-intl php8.3-bcmath
sudo fleetpanel update
```

Instances created with v0.1 were never fully installed: open each one and press **Repair**.
