# Changelog

## v0.2.0 (2026-10-01)

First release with a web panel. Pre-release: provisioning, the panel and `fleetbot update`
were tested on a real Ubuntu 24.04 server with MirzaBot and Faoxima; backup/restore on a
real server and the bots' cron jobs are still to come.

### Added
- **Web panel**, served by Fleetbot itself under a strict CSP:
  - Dashboard with real server CPU load, memory, disk and recent activity
  - Instances: guided create wizard, start, stop, backup, reprovision/repair, delete
    (with a pre-delete backup); failed installs show the real error and the failing step
  - Backups: list, restore (a safety backup is taken first), delete
  - Administrators (Owner only), audit log with filters, account and session management
- **Operator CLI** (`fleetbot`): interactive menu, `doctor` (host checks with PASS/WARN/FAIL),
  `start`/`stop`/`restart`, `logs -f`, `instances`, `backups`, `version`, `channel` (follow `main` or pin
  a release), and `uninstall` (standard, or full purge with typed confirmation)
- **Control-plane backup and restore** (`fleetbot backup` / `fleetbot restore FILE`): the panel database
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
- `fleetbot update` stopped the panel for the whole build, ignored the installed
  branch/tag, snapshotted the database without its WAL and never updated the CLI. It now
  builds in a staging directory, swaps in a few seconds and rolls back by rename.
- The installer accepted Node.js < 20.19, built without the lockfile, and printed the
  health URL instead of the panel URL.
- Native modules failed to install on Node.js 22+ / npm 11.

### Upgrading from v0.1
Install the new system packages, then update:

```bash
sudo apt-get install -y composer unzip php8.3-intl php8.3-bcmath
sudo fleetbot update
```

Instances created with v0.1 were never fully installed: open each one and press **Repair**.
