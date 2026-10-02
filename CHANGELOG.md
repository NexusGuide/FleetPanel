# Changelog

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
