# REST API

The web panel uses this API; you can script against it too. All responses are JSON.

## Authentication

1. `POST /api/auth/login` with `{"username": "...", "password": "..."}`. The response sets the
   `fp_session` cookie (HttpOnly) and returns `csrf_token`.
2. Send the cookie with every request, and `X-CSRF-Token: <csrf_token>` with every `POST`, `PATCH` and
   `DELETE`. Requests with a foreign `Origin` header are rejected.
3. `GET /api/auth/me` returns the current user and a fresh `csrf_token` (or `{"authenticated": false}`).

Sessions expire after 2 hours of inactivity or 24 hours in total.

## Errors

```json
{ "error": "instance_busy", "message": "Another operation is running on this instance. Try again shortly." }
```

Validation errors return `400` with `"error": "validation_failed"` and an `issues` array. Other common
codes: `401 authentication_required`, `403 permission_denied` / `csrf_token_invalid` /
`cross_origin_blocked`, `404 *_not_found`, `409` conflicts, `429 rate_limited` (with `Retry-After`).

## Endpoints

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | none | `{"status":"ok","version":"…"}` |
| POST | `/api/auth/login` | none | Rate limited per IP and per username |
| POST | `/api/auth/logout` | authenticated | |
| GET | `/api/auth/me` | none | |
| GET | `/api/auth/sessions` | authenticated | Own sessions only |
| DELETE | `/api/auth/sessions/:publicId` | authenticated | Revoke one of your sessions |
| POST | `/api/auth/password` | authenticated | `{current_password, new_password}`; signs out other sessions |
| GET | `/api/instances` | `instances.read` | |
| POST | `/api/instances` | `instances.create` | Returns `202`; see below |
| GET | `/api/instances/:id` | `instances.read` | Poll this while `status` is `provisioning` |
| POST | `/api/instances/:id/start` | `instances.control` | |
| POST | `/api/instances/:id/stop` | `instances.control` | |
| POST | `/api/instances/:id/reprovision` | `instances.create` | Rebuilds files and config; keeps database and secrets |
| DELETE | `/api/instances/:id` | `instances.delete` | Takes a pre-delete backup; `?backup=false` skips it |
| GET | `/api/instances/:id/backups` | `backups.read` | |
| POST | `/api/instances/:id/backups` | `backups.create` | |
| GET | `/api/backups` | `backups.read` | |
| POST | `/api/backups/:id/restore` | `backups.restore` | Returns `safety_backup_id` |
| DELETE | `/api/backups/:id` | `backups.restore` | |
| GET / POST | `/api/admins` | `admins.manage` | Owner only |
| PATCH | `/api/admins/:id` | `admins.manage` | `{role?, is_active?}`; cannot change your own role or disable yourself; one active Owner must remain |
| GET | `/api/audit-logs?limit=&before=` | `audit.read` | Newest first; page with `before=<id>` |
| GET | `/api/system` | `instances.read` | Host CPU load, memory, disk, uptime, versions, counts |
| GET | `/api/system/providers` | `instances.read` | Available bot providers |

## Creating an instance

```http
POST /api/instances
Content-Type: application/json
X-CSRF-Token: …

{ "slug": "shop-bot", "provider": "mirza", "domain": "shop.example.com",
  "bot_token": "123456789:AA…", "admin_telegram_id": "123456789" }
```

- `slug`: 3–29 characters, lowercase letters, digits and `-`, starting with a letter
- `provider`: `mirza`, `faoxima` or `pasarguard`
- `api_id`, `api_hash`: required for `pasarguard` (Telegram API credentials from my.telegram.org)
- `domain`: must already resolve to the server (a certificate is issued and the webhook uses HTTPS)

The bot token is checked with Telegram first. Duplicates are rejected with a message naming the existing
bot: `409 slug_in_use` (same name, case-insensitive), `409 domain_in_use`, or `409 bot_in_use` (the same
Telegram bot, even with a new token). The response is `202` with `status: "provisioning"`. Poll
`GET /api/instances/:id` until `status` is `running`, or `error` with the failing step in `last_error`.

`POST /api/instances/check` takes the same body, changes nothing and returns
`{ "bot_username": "…", "conflicts": { "slug"?: "…", "domain"?: "…", "bot_token"?: "…" } }`; the create
wizard calls it before the review step.

## Roles

| Role | Permissions |
| --- | --- |
| Owner | everything, including `admins.manage` |
| Admin | everything except `admins.manage` |
| Manager | `instances.read`, `instances.create`, `instances.control`, `backups.read`, `backups.create`, `audit.read` |
| Support | `instances.read`, `instances.control`, `backups.read` |
| Viewer | `instances.read`, `backups.read` |
