# Installation

## Requirements

- Ubuntu 24.04+ or Debian 12+ (PHP 8.2+ is required by the bots)
- Root access, 1 GB RAM or more, a few GB of free disk
- Ports 80 and 443 reachable from the internet
- For each bot: a domain or subdomain whose DNS `A`/`AAAA` record points to the server
- Optionally a domain for the panel itself (recommended: it gets TLS)

The installer adds packages but never edits or deletes existing nginx sites, databases or certificates.
An existing MySQL/MariaDB server is reused (root must be able to log in over the local socket).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/NexusGuide/FleetPanel/main/install.sh | sudo bash
```

The installer:

1. Installs nginx, MariaDB (unless MySQL/MariaDB exists), PHP-FPM with the extensions the bots need,
   Composer, certbot and Node.js 20 (if Node.js >= 20.19 is not present)
2. Creates the `fleetpanel` user and `/opt/fleetpanel` with private permissions
3. Downloads and builds FleetPanel, generates the master key
4. Installs the root helper, its sudoers rule and the `fleetpanel` CLI
5. Creates the first **Owner** with a random password, **printed once**
6. Configures nginx for the panel and, with a domain, requests a certificate
7. Installs and starts `fleetpanel.service` and waits for its health check

Save the printed password, sign in, then change it under **My account**.

### Non-interactive options

| Variable | Meaning |
| --- | --- |
| `FLEETPANEL_DOMAIN` | Panel domain (empty: serve on the server IP, port `FLEETPANEL_PANEL_PORT`) |
| `FLEETPANEL_PANEL_PORT` | Panel port in IP mode (default `8080`) |
| `FLEETPANEL_ADMIN_USER` | First administrator's username (default `admin`) |
| `FLEETPANEL_ACME_EMAIL` | Email for Let's Encrypt expiry notices |
| `FLEETPANEL_REF` | Branch or tag to install (default `main`); also becomes the update channel |

Example, pinned to a release:

```bash
curl -fsSL https://raw.githubusercontent.com/NexusGuide/FleetPanel/v0.3.0/install.sh \
  | sudo FLEETPANEL_REF=v0.3.0 FLEETPANEL_DOMAIN=panel.example.com bash
```

## After installing

```bash
sudo fleetpanel doctor    # everything should PASS
sudo fleetpanel backup    # back up the database and master key, then copy the file off the server
```

## Updating

```bash
sudo fleetpanel update
```

See [cli.md](cli.md#update) for how updates and rollback work, and `fleetpanel channel` to switch between
`main` and a pinned release. Updates do not install new system packages; the [changelog](../CHANGELOG.md)
lists any that a release needs.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Instance stuck in **error** | The panel shows the failing step. Fix the cause (often DNS or port 80), then press **Reprovision**. |
| Bot shows *running* but does not answer | Press **Repair** on the instance; check `/opt/fleetpanel/instances/<slug>/php-error.log`. |
| Panel unreachable | `sudo fleetpanel status`, `sudo fleetpanel logs 100`, `sudo fleetpanel doctor` |
| Forgot the panel password | `sudo fleetpanel reset-password <username>` |
| `nginx -t` fails after adding domains | FleetPanel sets `server_names_hash_bucket_size 128` in `/etc/nginx/conf.d/fleetpanel.conf` unless you already set it |

## Uninstalling

```bash
sudo fleetpanel uninstall
```

The standard mode keeps bots running and keeps all data; full purge deletes everything. See
[cli.md](cli.md#uninstall).
