# Architecture

Fleetbot is one Node.js process (the *control plane*) plus one small root helper. Bots run as ordinary
PHP sites under nginx and PHP-FPM; Fleetbot creates and manages them but is not in their request path.

```
                    Internet (HTTPS)
                          │
              ┌───────────▼────────────┐
              │  nginx :80 / :443      │  Let's Encrypt certificates (certbot)
              └─────┬─────────────┬────┘
   panel domain     │             │  one site per bot domain
                    ▼             ▼
   ┌──────────────────────┐   ┌───────────────────────────────┐
   │ Fleetbot control     │   │ Bot instance (per slug)       │
   │ plane 127.0.0.1:3000 │   │ PHP-FPM pool  user fb-<slug>  │
   │ user: fleetbot       │   │ /opt/fleetbot/instances/<slug>│
   │ REST API + web panel │   │ MySQL database fb_<slug>      │
   └──────┬───────────────┘   └───────────────────────────────┘
          │ sudo (one allowlisted command)
   ┌──────▼───────────────┐
   │ fleetbot-helper      │  root: users, pools, vhosts, databases, certificates
   └──────────────────────┘
```

## Components

| Component | Runs as | Responsibility |
| --- | --- | --- |
| `dist/server.js` (systemd `fleetbot.service`) | `fleetbot` | REST API, web panel, provisioning, backups |
| `dist/public/` | served by the control plane | Web panel (React, built by Vite) |
| `/usr/local/sbin/fleetbot-helper` | root via one sudoers rule | The only privileged operations, with re-validated arguments |
| `/usr/local/bin/fleetbot` | root (operator) | CLI: status, doctor, backups, update, uninstall |
| Bot PHP-FPM pool | `fb-<slug>` | Runs one bot, `open_basedir` limited to its directory |

The control plane listens on `127.0.0.1` only. nginx publishes it on the panel domain (or port 8080) and
passes the client address; `trust proxy` is limited to loopback.

## Data

```
/opt/fleetbot/
├── app/                 Fleetbot code and build (root-owned, replaced by `fleetbot update`)
├── data/fleetbot.db     SQLite: admins, sessions, instances, encrypted secrets, backups, audit log (0700)
├── config/master.key    32-byte AES-256-GCM key (0600, fleetbot) — back it up off the server
├── backups/             Instance backups and control-plane backups (0700)
└── instances/<slug>/    Each bot's files (owned by fb-<slug>; fleetbot and nginx via ACLs)

/etc/fleetbot/           php-version, ref (update channel), acme-email
/etc/nginx/sites-*/fleetbot-*.conf, /etc/php/<v>/fpm/pool.d/fleetbot-*.conf
```

Schema migrations are an append-only list in `src/db.ts`, applied at startup.

## Provisioning an instance

`POST /api/instances` validates the input, checks the bot token with Telegram (`getMe`), stores the
secrets encrypted and returns `202`. Provisioning then runs in the background; each step's failure is
recorded in `last_error` with the step name:

1. Download the bot (`git clone --depth 1`)
2. Fill the project's own `config.php` template
3. `composer install --no-dev` if the project does not ship `vendor/`
4. Remove the project's web installer directory
5. Create the MySQL database and user (helper)
6. Run the project's schema script (`table.php`) with the PHP CLI and verify the result with a query
7. Set ownership and ACLs (helper)
8. Create the PHP-FPM pool and nginx site, validated with `php-fpm -t` and `nginx -t` (helper)
9. Issue the certificate (helper → certbot)
10. Register the Telegram webhook with the instance's secret

Only one long-running operation may run per instance at a time; anything interrupted by a restart is
marked `error` at boot instead of being left in a misleading state.

## Request flow for a bot update

Telegram → nginx (`server_name` = bot domain) → secret check in the vhost (header or `?secret=`, matching
what the bot itself checks) → PHP-FPM pool of that instance → the bot's `index.php`.
