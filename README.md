# Fleetbot

A small, security-first control plane for hosting multiple Telegram bots (MirzaBot, Faoxima)
on one Ubuntu/Debian server. Each bot gets its own Linux user, php-fpm pool, MySQL database,
nginx vhost and Let's Encrypt certificate.

> **Status: v0.1, API only.** The REST API, installer and CLI are functional. The web UI is the next milestone.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/NexusGuide/Fleetbot/main/install.sh | sudo bash
```

The installer:

- installs nginx, MariaDB (unless MySQL/MariaDB already exists), PHP-FPM, certbot and Node.js 20
- creates an unprivileged `fleetbot` service user and a single allowlisted root helper
- creates the first **Owner** account with a random password that is printed once
- adds only its own files; it never deletes or edits existing nginx sites, databases or certificates

In IP mode the panel listens on port `8080` (override with `FLEETBOT_PANEL_PORT`). Use a domain
(`FLEETBOT_DOMAIN=panel.example.com`) to get TLS; plain HTTP is for testing only.

## Operate

```bash
sudo fleetbot status
sudo fleetbot logs 200
sudo fleetbot create-admin alice --role Manager
sudo fleetbot reset-password alice
sudo fleetbot update      # snapshots the DB, rebuilds, rolls back on a failed health check
```

## API overview

All writes need the session cookie plus the `X-CSRF-Token` returned by `/api/auth/login` or `/api/auth/me`.

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/api/auth/login` | none |
| GET | `/api/auth/me` | none |
| GET / DELETE | `/api/auth/sessions[/:publicId]` | own sessions |
| POST | `/api/auth/password` | authenticated |
| GET / POST | `/api/instances` | `instances.read` / `instances.create` |
| POST | `/api/instances/:id/start`, `/stop` | `instances.control` |
| POST | `/api/instances/:id/reprovision` | `instances.create` |
| DELETE | `/api/instances/:id?backup=false` | `instances.delete` |
| GET / POST | `/api/instances/:id/backups` | `backups.read` / `backups.create` |
| POST | `/api/backups/:id/restore` | `backups.restore` |
| GET / POST / PATCH | `/api/admins[/:id]` | `admins.manage` (Owner) |
| GET | `/api/audit-logs` | `audit.read` |

Creating an instance:

```json
POST /api/instances
{ "slug": "shop-bot", "provider": "mirza", "domain": "shop.example.com",
  "bot_token": "123456:ABC...", "admin_telegram_id": "123456789" }
```

The request returns `202` immediately; poll `GET /api/instances/:id` until `status` is `running`
or `error` (with the real reason in `last_error`). Point the domain's DNS at the server first,
because provisioning issues a certificate and registers the Telegram webhook over HTTPS.

## Roles

| Role | Can |
| --- | --- |
| Owner | everything, including managing admins |
| Admin | everything except managing admins |
| Manager | create/control instances, create backups, read audit log |
| Support | start/stop instances, read |
| Viewer | read instances and backups |

## Development

```bash
npm install
npm test
npm run lint
```

To enable CI, move `docs/ci.yml` to `.github/workflows/ci.yml`.
See [SECURITY.md](SECURITY.md) for the security model.

## Roadmap

- Web UI
- Per-instance version pinning and upgrades (git tags) with automatic rollback
- PasarGuard (Python) provider
- Scheduled backups and off-site upload

## License

MIT
