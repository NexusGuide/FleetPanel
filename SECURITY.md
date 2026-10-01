# Security model

## Privilege separation

| Component | Runs as | Can do |
| --- | --- | --- |
| Control plane (`dist/server.js`) | `fleetbot` | Read/write its own data, instance files (via ACL), backups |
| `fleetbot-helper` | root (via one sudoers rule) | Only the allowlisted commands below, with validated arguments |
| Each bot (php-fpm pool) | `fb-<slug>` | Its own directory only (`open_basedir`) |

Helper commands: `instance-create`, `instance-perms`, `instance-enable`, `instance-disable`,
`instance-remove`, `db-create`, `db-drop`, `cert-issue`. Every argument is re-validated as root.
Secrets are passed on stdin, never argv.

## Controls

- **No default credentials.** The first Owner is created by the installer with a random password shown once.
- **Passwords:** Argon2id (64 MiB, t=3, p=4); unknown usernames take the same time as wrong passwords.
- **Sessions:** stored in SQLite as SHA-256 hashes; `HttpOnly`, `SameSite=Strict`, `Secure` when served over TLS;
  2h idle / 24h absolute expiry. Users can only list and revoke their own sessions, by an opaque public id.
- **CSRF:** per-session token required in `X-CSRF-Token` on every authenticated write, plus an Origin check.
- **Rate limiting:** keyed on the real client IP (`trust proxy` = loopback only).
- **Secrets at rest:** AES-256-GCM with per-record AAD. The server refuses to start if the master key
  is missing or readable by group/others. Decryption failures throw; they never fall back to ciphertext.
- **Injection:** strict allowlist validation of slug, domain, token and ids; generated PHP uses escaped
  single-quoted literals; no shell is ever invoked (`execFile` with argument arrays only).
- **Telegram webhooks:** nginx rejects webhook requests without the per-instance secret token.
- **Audit log:** append-only (UPDATE/DELETE blocked by SQLite triggers).
- **Headers:** strict CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `no-referrer`.

## Known limitations

- Rate-limit counters are in memory and reset on restart.
- Provider config templates follow each upstream project's installer; verify them when upgrading a provider.
- Restoring a backup into a *deleted* instance is not supported yet.

## Reporting a vulnerability

Please open a private security advisory on GitHub rather than a public issue.
