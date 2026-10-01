# Fleetbot

A small, security-first control plane for hosting multiple Telegram bots (MirzaBot, Faoxima)
on one Ubuntu/Debian server. Each bot gets its own Linux user, php-fpm pool, MySQL database,
nginx vhost and Let's Encrypt certificate.

> **Status: v0.2.** Web panel, REST API, installer and CLI are functional.

## Web panel

Open the panel URL the installer prints and sign in with the Owner account it created. The panel shows
only real data from this server:

- **Dashboard**: instance counts, server CPU load, memory and disk, recent activity
- **Instances**: create (guided wizard), start, stop, back up, reprovision after a failure, delete
  (with a pre-delete backup), and the real `last_error` when an install fails
- **Backups**: list, restore (a safety backup is taken first), delete
- **Administrators** (Owner only): create accounts, change roles, disable access
- **Audit log**: every sign-in, change and denied request, including failures and client IP
- **My account**: change password, see and sign out your sessions

Buttons a role is not allowed to use are hidden; the server enforces the same rules on every request.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/NexusGuide/Fleetbot/main/install.sh | sudo bash
```

The installer:

- installs nginx, MariaDB (unless MySQL/MariaDB already exists), PHP-FPM, certbot and Node.js 20 (>= 20.19)
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
                          # (follows the branch/tag you installed from, FLEETBOT_REF)
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
| DELETE | `/api/backups/:id` | `backups.restore` |
| GET | `/api/audit-logs?limit=&before=` | `audit.read` |
| GET | `/api/system`, `/api/system/providers` | `instances.read` |

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
npm ci
npm test
npm run lint        # type-checks the server and the web UI
npm run build       # dist/server.js + dist/public (the web UI)
```

The UI lives in `web/` (React + Vite + Tailwind). For UI work run `npm run dev` (API on :3000) and
`npm run dev:web` (Vite on :5173, proxies `/api`). The production build is served by the Fleetbot
server itself under a strict CSP (`script-src 'self'`), so do not add inline scripts or external assets.

See [SECURITY.md](SECURITY.md) for the security model.

## Roadmap

- Per-instance version pinning and upgrades (git tags) with automatic rollback
- PasarGuard (Python) provider
- Scheduled backups and off-site upload

## License

MIT
