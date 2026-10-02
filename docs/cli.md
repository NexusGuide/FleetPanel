# CLI reference

`/usr/local/bin/fleetpanel` is the operator CLI. Most commands need root (`sudo fleetpanel …`). Run it
without arguments for an interactive menu with the same actions.

Commands that touch the database run the Node.js part of the CLI (`dist/cli.js`) as the `fleetpanel` user,
never as root. Actions taken from the CLI are written to the audit log with the actor `cli`.

## Service

| Command | Description |
| --- | --- |
| `fleetpanel status` | Service state, health check, version, update channel and instance list. Exits non-zero if the service is not running. |
| `fleetpanel doctor` | Runs the checks below and prints `[PASS]`, `[WARN]` or `[FAIL]` for each. Exits non-zero if anything failed. |
| `fleetpanel start` / `stop` / `restart` | Controls `fleetpanel.service`. Bots keep running when the panel is stopped. |
| `fleetpanel logs [N] [-f]` | The last N lines (default 100) of the panel's journal; `-f` follows. Secrets are masked before they are logged. |

### Doctor checks

| Check | Fails / warns when |
| --- | --- |
| Panel service | `fleetpanel.service` is not active |
| API | `GET /api/health` on 127.0.0.1:3000 does not answer |
| nginx | `nginx -t` fails (the message is shown); *warn* when a domain is served by more than one site |
| php-fpm | `php-fpm<version> -t` fails |
| MySQL/MariaDB | `mysqladmin ping` over the local socket fails |
| Master key | missing, not mode 600, not owned by `fleetpanel`, or not 32 bytes |
| Control-plane backup | *warn* when none exists in `/opt/fleetpanel/backups` |
| Privileged helper | helper missing or `/etc/sudoers.d/fleetpanel` invalid |
| Disk | *warn* under 2 GB free, *fail* under 512 MB |
| Memory | *warn* under ~1 GB |
| Node.js | older than 20.19 |
| PHP | older than 8.2, or missing one of mbstring, dom, pdo_mysql, mysqli, curl, zip, gd, intl, bcmath |
| Composer | not installed |
| Certificate renewal | *warn* when no certbot timer or cron job exists |
| Firewall | *warn* when no firewall is active (optional), or ufw is active but ports 80/443 are not allowed |
| Instances | *warn* for every instance in the error state |

## Instances and backups

| Command | Description |
| --- | --- |
| `fleetpanel instances` | Lists instances with provider, domain, bot and status (and the start of `last_error`). |
| `fleetpanel backups [SLUG]` | Lists instance backups (all, or one instance) and control-plane backup files. |
| `fleetpanel backup` | **Control-plane backup:** a consistent copy of the panel database plus the master key, as `/opt/fleetpanel/backups/control-plane-<time>.tar.gz` (mode 600). Copy it off the server: anyone holding it can decrypt the stored bot tokens. |
| `fleetpanel backup SLUG` | Backs up one instance: its files and a `mysqldump` of its database. Same format as backups taken in the panel. |
| `fleetpanel restore FILE.tar.gz` | Restores a control-plane backup. Asks you to type `RESTORE`, takes a safety backup of the current state, replaces the database and master key, and starts the panel; if it does not become healthy, the safety backup is put back. Bot files and databases are not touched. |
| `fleetpanel restore BACKUP_ID` | Restores an instance backup (IDs from `fleetpanel backups`). A pre-restore safety backup is taken first; files are rolled back if the restore fails. |

Prefer the panel for instance restores while the panel is in use: the CLI and the panel do not share the
per-instance "busy" lock.

## Administrators

| Command | Description |
| --- | --- |
| `fleetpanel admins` | Lists administrators. |
| `fleetpanel create-admin USER [--role ROLE]` | Creates an administrator (default role Owner). The password is prompted for, or read from stdin. |
| `fleetpanel reset-password USER` | Sets a new password and signs the user out everywhere. Use this if you are locked out. |

## Versions

| Command | Description |
| --- | --- |
| `fleetpanel version` | Installed version, commit and update channel. |
| `fleetpanel channel` | Shows the update channel and the latest released tags. |
| `fleetpanel channel REF` | Sets the channel to a branch (`main`) or a release tag (`v0.3.0`). Takes effect on the next update. |
| `fleetpanel update` | Updates to the latest commit of the channel (see below). |

### Update

1. Clones the channel into `/opt/fleetpanel/app.new` and builds it there while the panel keeps running.
   If the build fails, nothing changes.
2. Stops the panel and snapshots the database (with its WAL) to `/opt/fleetpanel/backups/control-plane-<time>.db`.
3. Moves the current build to `app.prev`, the new one to `app`, and installs the new root helper and CLI.
4. Starts the panel and waits for its health check.
5. On failure it moves the previous build back, restores the snapshot and keeps the failed build in
   `app.failed` for inspection.

Downtime is a few seconds. Bots are not affected. Updates do not install new system packages; check the
[changelog](../CHANGELOG.md) when upgrading.

## Firewall

An optional host firewall using `ufw` (installed on request). Run `sudo fleetpanel firewall enable`:

1. Allows the SSH port(s) from `sshd -T` and the port of your current SSH session, so you cannot lock
   yourself out; then 80 and 443 (certificates, bot sites, Telegram webhooks) and the panel's port in IP mode.
2. For every other port that listens on a public address, asks whether to keep it open. Database ports
   (3306, 5432, 6379, ...) default to **closed**, anything else to open.
3. Optionally blocks ping (ICMP echo requests only; the originals of `/etc/ufw/before.rules` and
   `before6.rules` are saved as `*.fleetpanel.bak`).
4. Shows the summary and asks before applying. Existing ufw rules are kept; incoming traffic is denied by
   default and outgoing traffic stays allowed.

| Command | Description |
| --- | --- |
| `fleetpanel firewall` | Shows the ufw rules and whether ping is blocked. |
| `fleetpanel firewall enable [--block-ping\|--allow-ping] [--yes]` | Sets up or updates the firewall as described above. `--yes` skips the questions (other public ports stay open, database ports close). |
| `fleetpanel firewall disable [--yes]` | Turns ufw off. |

If the server already uses `firewalld`, the command refuses; open 80 and 443 there. A cloud provider's
firewall (security group) is separate and must also allow 80 and 443.

## Uninstall

`fleetpanel uninstall` asks which mode to use:

- **Standard:** takes a final control-plane backup, then removes the systemd service, the panel's nginx
  site, the root helper and its sudoers rule, the CLI and `/opt/fleetpanel/app`. Bots keep running; their
  files, databases, `/opt/fleetpanel/{data,config,backups,instances}` and `/etc/fleetpanel` are kept, so a
  later reinstall picks everything up again.
- **Full purge:** requires typing `PERMANENTLY DELETE INSTANCES`. Additionally unregisters every bot's
  Telegram webhook, removes every instance (files, nginx site, PHP pool, Linux user) and its database,
  deletes `/opt/fleetpanel` including all backups, `/etc/fleetpanel` and the `fleetpanel` user. Let's Encrypt
  certificates are left in `/etc/letsencrypt`.
