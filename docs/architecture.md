# Architecture

FleetPanel is one Node.js process (the *control plane*) plus one small root helper. Bots run as ordinary
PHP sites under nginx and PHP-FPM; FleetPanel creates and manages them but is not in their request path.

```
                    Internet (HTTPS)
                          │
              ┌───────────▼────────────┐
              │  nginx :80 / :443      │  Let's Encrypt certificates (certbot)
              └─────┬─────────────┬────┘
   panel domain     │             │  one site per bot domain
                    ▼             ▼
   ┌──────────────────────┐   ┌───────────────────────────────┐
   │ FleetPanel control     │   │ Bot instance (per slug)       │
   │ plane 127.0.0.1:3000 │   │ PHP-FPM pool  user fp-<slug>  │
   │ user: fleetpanel       │   │ /opt/fleetpanel/instances/<slug>│
   │ REST API + web panel │   │ MySQL database fp_<slug>      │
   └──────┬───────────────┘   └───────────────────────────────┘
          │ sudo (one allowlisted command)
   ┌──────▼───────────────┐
   │ fleetpanel-helper      │  root: users, pools, vhosts, databases, certificates
   └──────────────────────┘
```

## Components

| Component | Runs as | Responsibility |
| --- | --- | --- |
| `dist/server.js` (systemd `fleetpanel.service`) | `fleetpanel` | REST API, web panel, provisioning, backups |
| `dist/public/` | served by the control plane | Web panel (React, built by Vite) |
| `/usr/local/sbin/fleetpanel-helper` | root via one sudoers rule | The only privileged operations, with re-validated arguments |
| `/usr/local/bin/fleetpanel` | root (operator) | CLI: status, doctor, backups, update, uninstall |
| Bot PHP-FPM pool | `fp-<slug>` | Runs one bot, `open_basedir` limited to its directory |

The control plane listens on `127.0.0.1` only. nginx publishes it on the panel domain (or port 8080) and
passes the client address; `trust proxy` is limited to loopback.

## Data

```
/opt/fleetpanel/
├── app/                 FleetPanel code and build (root-owned, replaced by `fleetpanel update`)
├── data/fleetpanel.db     SQLite: admins, sessions, instances, encrypted secrets, backups, audit log (0700)
├── config/master.key    32-byte AES-256-GCM key (0600, fleetpanel) — back it up off the server
├── backups/             Instance backups and control-plane backups (0700)
└── instances/<slug>/    Each bot's files (owned by fp-<slug>; fleetpanel and nginx via ACLs)

/etc/fleetpanel/           php-version, ref (update channel), acme-email
/etc/nginx/sites-*/fleetpanel-*.conf, /etc/php/<v>/fpm/pool.d/fleetpanel-*.conf
```

Schema migrations are an append-only list in `src/db.ts`, applied at startup.

## Provisioning an instance

`POST /api/instances` validates the input, checks the bot token with Telegram (`getMe`), stores the
secrets encrypted and returns `202`. Provisioning then runs in the background; each step's failure is
recorded in `last_error` with the step name:

1. Download the provider's pinned upstream commit (shallow fetch of that exact id, verified after checkout)
2. Fill the project's own `config.php` template
3. Remove the project's web installer directory
4. Create the MySQL database and user (helper)
5. Set ownership and ACLs (helper)
6. `composer install --no-dev --no-scripts --no-plugins` as the bot's Linux user if the project does not
   ship `vendor/` (helper `instance-run`)
7. Run the project's schema script (`table.php`) as the bot's Linux user and verify the result with a query
8. Create the PHP-FPM pool and nginx site, validated with `php-fpm -t` and `nginx -t` (helper)
9. Issue the certificate (helper → certbot)
10. Register the Telegram webhook with the instance's secret

A Python service bot (PasarguardBot) replaces steps 2, 3, 6 and 7 with: prepare the pinned Python runtime
(once per server), write the bot's environment file (helper), `uv sync --frozen`, build the web app with
`bun`, `alembic upgrade head` (each as the bot's user), and in step 8 creates its Redis and bot systemd
services plus an nginx reverse proxy instead of a PHP pool; step 10 deletes any old webhook and waits until
the bot answers on its loopback port. See [providers.md](providers.md#python-service-bots-pasarguardbot).
PGClockBot does the same on PostgreSQL (installed once, helper `runtime-postgres`, then `pg-create`), without
Redis or a web-app build, installing its packages from FleetPanel's hash-pinned lock; see
[providers.md](providers.md#pgclockbot-postgresql).

Only one long-running operation may run per instance at a time; anything interrupted by a restart is
marked `error` at boot instead of being left in a misleading state.

## Request flow for a bot update

Telegram → nginx (`server_name` = bot domain) → secret check in the vhost (header or `?secret=`, matching
what the bot itself checks) → PHP-FPM pool of that instance → the bot's `index.php`.
