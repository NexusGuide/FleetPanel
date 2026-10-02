<div align="center">

# FleetPanel

### A secure control plane for hosting many Telegram bots on one Linux server

Deploy and run isolated **MirzaBot** and **Faoxima** instances on a single Ubuntu/Debian VPS: each bot gets
its own Linux user, PHP-FPM pool, MySQL database, nginx site and Let's Encrypt certificate, managed from a
web panel and a CLI.

[![CI](https://github.com/NexusGuide/FleetPanel/actions/workflows/ci.yml/badge.svg)](https://github.com/NexusGuide/FleetPanel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Platform: Ubuntu | Debian](https://img.shields.io/badge/Platform-Ubuntu%20%7C%20Debian-orange?style=flat-square&logo=ubuntu)](docs/installation.md)
[![Security: Argon2id + AES-256-GCM](https://img.shields.io/badge/Security-Argon2id%20%2B%20AES--256--GCM-red?style=flat-square)](SECURITY.md)
[![Node.js 20.19+](https://img.shields.io/badge/Node.js-20.19%2B-green?style=flat-square&logo=node.js)](https://nodejs.org)
[![PHP 8.2+](https://img.shields.io/badge/PHP-8.2%2B-777bb4?style=flat-square&logo=php)](https://www.php.net)

</div>

> **Status: v0.3 (pre-release).** Web panel, provisioning, CLI and updates are tested on a real
> Ubuntu 24.04 server with MirzaBot and Faoxima. See the [changelog](CHANGELOG.md) and the [roadmap](#roadmap).

---

## ⚡ One-line installer

On a fresh or existing Ubuntu 24.04+ / Debian 12+ server, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/NexusGuide/FleetPanel/main/install.sh | sudo bash
```

It asks for an optional Let's Encrypt email, the first administrator's name and an optional panel domain,
then prints the panel URL and a one-time password. Details and non-interactive options:
[installation guide](docs/installation.md).

### What the installer does (and does not do)

- **Re-runnable:** running it again updates packages and configuration without losing data.
- **Leaves existing services alone:** it never edits or deletes existing nginx sites, databases or
  certificates; FleetPanel only adds its own `fleetpanel-*` files and `fp_*` databases. An existing
  MySQL/MariaDB server is reused.
- **No default passwords:** the first Owner gets a random password that is shown once and not stored.
- **Privilege separation:** the panel runs as the unprivileged `fleetpanel` user; a single allowlisted
  root helper does the few things that need root.
- **TLS:** with a panel domain it requests a certificate; without one the panel listens on port `8080`
  over plain HTTP (for testing only).

---

## 🖥️ Web panel

Every number and state in the panel comes from the server; nothing is simulated.

- **Dashboard:** instance counts, server CPU load, memory and disk, recent activity
- **Instances:** a guided create wizard, start, stop, backup, **repair/reprovision**, delete (with a
  pre-delete backup). If an install fails, the panel shows the failing step and the real error.
- **Backups:** list, restore (a safety backup is taken first), delete
- **Administrators** (Owner only), **audit log** and **my account** (password, sessions)

Creating a bot: point its domain's DNS at the server, then *New instance* → choose MirzaBot or Faoxima →
domain, bot token from @BotFather and your numeric Telegram id. FleetPanel then downloads the bot, writes its
config, runs `composer install` and the bot's own schema script, creates the database, the PHP pool and
nginx site, issues the certificate and registers the webhook.

---

## 🛡️ Security model

- **Argon2id** password hashing (RFC 9106: 64 MiB, t=3, p=4); unknown usernames take as long as wrong passwords
- **AES-256-GCM** encryption at rest for bot tokens, database passwords and webhook secrets, with
  per-record associated data; the server refuses to start if the master key is readable by others
- **Sessions** stored hashed in SQLite, `HttpOnly`, `SameSite=Strict`, `Secure` over TLS, 2 h idle / 24 h absolute
- **CSRF** token on every authenticated write plus an `Origin` check; **rate limiting** on login and sensitive actions
- **RBAC** with five roles enforced on every API route; **append-only audit log** (including failures and client IP)
- **No shell:** every command runs with an argument array; all inputs are allowlist-validated, again as root in the helper
- **Webhook protection:** nginx rejects Telegram webhook calls without the instance's secret
- **Strict CSP** for the panel: `script-src 'self'`, no inline code, no third-party assets

Full details: [SECURITY.md](SECURITY.md) and [docs/security.md](docs/security.md).

---

## 💻 FleetPanel CLI & diagnostics

`fleetpanel` is installed at `/usr/local/bin/fleetpanel`. Run it without arguments for the interactive menu:

```text
╭──────────────────────────────────────────╮
│ FleetPanel v0.3.3  ·  channel main       │
╰──────────────────────────────────────────╯
  Panel: ● running

  1) Status            7) Restore a backup
  2) Doctor            8) Update
  3) Logs              9) Version / update channel
  4) Instances        10) Restart panel
  5) Backups          11) Firewall
  6) Back up panel    12) Uninstall
  0) Exit
```

| Command | Description |
| :--- | :--- |
| `fleetpanel status` | Panel service state, health check, version and instances |
| `fleetpanel doctor` | Checks the whole host and reports `[PASS]` / `[WARN]` / `[FAIL]` |
| `fleetpanel start` / `stop` / `restart` | Control the panel service (bots keep running) |
| `fleetpanel logs [N] [-f]` | Last N log lines (secrets are masked); `-f` follows |
| `fleetpanel instances` | List bot instances with provider, domain, bot and status |
| `fleetpanel backups [SLUG]` | List instance backups and control-plane backups |
| `fleetpanel backup` | Back up the control plane: panel database **and master key** |
| `fleetpanel backup SLUG` | Back up one instance (files + database dump) |
| `fleetpanel restore FILE.tar.gz` | Restore a control-plane backup (safety backup first) |
| `fleetpanel restore BACKUP_ID` | Restore an instance backup (safety backup first) |
| `fleetpanel admins` / `create-admin` / `reset-password` | Manage administrators from the server |
| `fleetpanel version` / `channel [REF]` | Show the version; follow `main` or pin a release such as `v0.3.0` |
| `fleetpanel update` | Build the channel's latest version and switch, with automatic rollback |
| `fleetpanel firewall [enable\|disable]` | Optional ufw firewall: SSH, HTTP, HTTPS and the panel port stay open; `--block-ping` blocks ping |
| `fleetpanel uninstall` | Remove FleetPanel; bots keep running unless you choose full purge |

Full reference: [docs/cli.md](docs/cli.md).

### 🩺 System doctor

```text
FleetPanel doctor — v0.3.3, channel main

  [PASS] Panel service is running
  [PASS] API answers on 127.0.0.1:3000 ({"status":"ok","version":"0.3.3"})
  [PASS] nginx configuration is valid
  [PASS] php-fpm 8.3 configuration is valid
  [PASS] MySQL/MariaDB is reachable
  [PASS] Master key is private (600, fleetpanel, 32 bytes)
  [WARN] No control-plane backup yet: run 'sudo fleetpanel backup' and keep the file off this server
  [PASS] Privileged helper and sudoers rule are installed
  [PASS] 41 GB free on /opt/fleetpanel
  [PASS] 3911 MB RAM
  [PASS] Node.js v20.19.5
  [PASS] PHP 8.3.6 with required extensions
  [PASS] Composer is installed
  [PASS] Certificate auto-renewal is scheduled
  [PASS] Firewall (ufw) is active and allows ports 80 and 443
  [PASS] 2 instance(s), none in the error state

Summary: 15 passed, 1 warnings, 0 failed
```

*(Example output; your values will differ.)*

> **Back up the master key.** Without `/opt/fleetpanel/config/master.key`, stored bot tokens and database
> passwords cannot be decrypted. Run `sudo fleetpanel backup` and copy the file off the server.

---

## 🔄 Updates and rollback

`sudo fleetpanel update`:

1. Clones the update channel (`main` or a pinned tag) into a staging directory
2. Installs dependencies and builds it **while the panel keeps running**
3. Stops the panel, snapshots the control-plane database (with its WAL)
4. Swaps the new build in and updates the root helper and CLI
5. Starts the panel and checks its health
6. If the health check fails, it **swaps the previous build back** and restores the database snapshot

Bots are never stopped by a panel update.

## 🗑️ Uninstall

`sudo fleetpanel uninstall` offers two modes:

1. **Standard** (default): takes a final control-plane backup, then removes the panel, service, CLI and
   root helper. Bots keep running; their files, databases and all backups stay in `/opt/fleetpanel`.
2. **Full purge**: requires typing `PERMANENTLY DELETE INSTANCES`; also unregisters webhooks and deletes
   every bot's files, database and Linux user, and all backups.

---

## 🧪 Development and tests

```bash
npm ci
npm test            # API, security and provisioning tests
npm run lint        # type-checks the server and the web UI
npm run build       # dist/server.js + dist/public (the web UI)
bash -n install.sh bin/fleetpanel deploy/fleetpanel-helper
```

Tests cover authentication, CSRF and origin checks, RBAC, injection attempts, encryption at rest, the
provisioning steps of both providers (with the system calls stubbed), audit logging and backups.
CI runs type-checking, tests, the build and `shellcheck`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- Cron jobs for the bots' scheduled tasks (expiry reminders, built-in bot backups)
- Restoring a backup into a deleted instance
- Per-instance version pinning and upgrades
- PasarGuard provider
- Scheduled backups and off-site upload

## 📖 Documentation

- [System architecture](docs/architecture.md)
- [Installation guide](docs/installation.md)
- [Security policy](SECURITY.md) and [implementation details](docs/security.md)
- [CLI reference](docs/cli.md)
- [REST API](docs/api.md)
- [Bot providers](docs/providers.md)
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## 📄 License

FleetPanel is open-source software licensed under the [MIT License](LICENSE). MirzaBot and Faoxima are
separate projects with their own licenses; FleetPanel downloads them from their repositories at install time.
