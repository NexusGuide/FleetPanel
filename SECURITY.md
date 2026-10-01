# Security policy

## Supported versions

Security fixes go to the latest release and to `main`. Update with `sudo fleetpanel update`.

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/NexusGuide/FleetPanel/security/advisories/new)
on GitHub rather than a public issue. Include the version (`fleetpanel version`), what an attacker needs
(network access, a panel role, a shell on the server) and steps to reproduce.

## Security model in brief

### Privilege separation

| Component | Runs as | Can do |
| --- | --- | --- |
| Control plane (`dist/server.js`) | `fleetpanel` | Its own data, instance files (via ACL), backups |
| `fleetpanel-helper` | root (via one sudoers rule) | Only the allowlisted commands below, with re-validated arguments |
| Each bot (PHP-FPM pool) | `fb-<slug>` | Its own directory only (`open_basedir`) |
| nginx | `www-data` | Reads bot files to serve static assets; `config.php` is unreadable to it |

Helper commands: `instance-create`, `instance-perms`, `instance-enable`, `instance-disable`,
`instance-remove`, `db-create`, `db-drop`, `cert-issue`. Every argument is re-validated as root.
Secrets are passed on stdin, never argv.

### Controls

- **No default credentials.** The first Owner gets a random password, shown once.
- **Passwords:** Argon2id (64 MiB, t=3, p=4); unknown usernames take as long as wrong passwords.
- **Sessions:** stored as SHA-256 hashes; `HttpOnly`, `SameSite=Strict`, `Secure` over TLS; 2 h idle /
  24 h absolute. Users can only list and revoke their own sessions.
- **CSRF:** per-session token on every authenticated write, plus an `Origin` check.
- **Rate limiting:** keyed on the real client IP (`trust proxy` = loopback only).
- **Secrets at rest:** AES-256-GCM with per-record AAD. The server refuses to start if the master key is
  missing or readable by group/others. Decryption failures throw; they never fall back to ciphertext.
- **Injection:** allowlist validation of slugs, domains, tokens and ids; generated PHP uses escaped
  single-quoted literals; no shell is ever invoked (`execFile` with argument arrays only).
- **Telegram webhooks:** nginx rejects webhook calls without the instance's secret.
- **Web installers** of the bot projects are deleted before a site goes live.
- **Audit log:** append-only (UPDATE/DELETE blocked by SQLite triggers), including failures and client IP.
- **Headers:** strict CSP (`script-src 'self'`), `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `no-referrer`, HSTS over TLS.

Implementation details: [docs/security.md](docs/security.md).

## Operator responsibilities

- Use a panel domain with TLS. Plain HTTP (IP mode) is for testing only.
- Back up the control plane (`sudo fleetpanel backup`) and keep the file **off** the server: it contains
  the master key, so treat it like a password.
- Change the initial administrator password after the first sign-in.
- Keep the OS updated (unattended-upgrades) and run `sudo fleetpanel doctor` after changes.

## Known limitations

- Rate-limit counters are in memory and reset on restart.
- Provider config templates follow each upstream project; FleetPanel fails provisioning loudly if they change.
- The bots themselves (MirzaBot, Faoxima) are third-party code: FleetPanel isolates them from each other and
  from the panel, but cannot fix vulnerabilities inside them.
- Restoring a backup into a *deleted* instance is not supported yet.
