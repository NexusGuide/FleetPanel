# Contributing

Thanks for helping. Bug reports, fixes and new providers are welcome.

## Reporting bugs

Open an issue with:

- `fleetbot version` and the output of `sudo fleetbot doctor`
- what you did, what you expected and what happened
- for instance problems, the `last_error` shown in the panel and `sudo fleetbot logs 100`

Remove bot tokens, passwords and domains you do not want public. Security issues: see
[SECURITY.md](SECURITY.md) and do **not** open a public issue.

## Development setup

Requirements: Node.js 20.19+ and npm.

```bash
npm ci
npm test            # vitest: API, security and provisioning tests
npm run lint        # tsc for the server (src/) and the web UI (web/)
npm run build       # dist/server.js and dist/public
```

UI work: run the API with `npm run dev` (needs `FLEET_DIR`, a 32-byte master key with mode 600 and an
administrator created with `node dist/cli.js create-admin`) and the UI with `npm run dev:web`
(Vite on :5173, proxies `/api` to :3000).

## Project layout

```
src/            control plane (Express, SQLite) — see docs/architecture.md
  http/         routes, middleware, sessions
  services/     instances (provisioning), backups, telegram
  providers/    MirzaBot / Faoxima install recipes
  security/     validation, crypto, passwords, RBAC, PHP escaping
  system/       exec, root-helper client, composer/php/mysql toolchain
web/            React panel (Vite + Tailwind)
deploy/         fleetbot-helper (the only root component)
bin/fleetbot    operator CLI
install.sh      installer
tests/          vitest suites and fixtures
```

## Guidelines

- **No shell strings.** Run programs only through `src/system/exec.ts` with argument arrays.
- **Validate twice.** Inputs are validated in `src/security/validation.ts` and again in
  `deploy/fleetbot-helper`; keep the regexes in sync.
- **Never show fake data.** The panel must only display values that come from the server.
- **Database changes** are new entries appended to `MIGRATIONS` in `src/db.ts`; never edit a released one.
- **Shell scripts** must pass `bash -n` and `shellcheck -S error` and keep LF line endings
  (`.gitattributes` enforces this).
- Add or update tests with every behaviour change, and update the docs and `CHANGELOG.md`.
- Anything touching provisioning, the helper, the installer or `fleetbot update` should also be tried
  on a real Ubuntu/Debian server; say in the pull request what you tested there.

## Pull requests

1. Branch from `main`.
2. Keep commits focused; describe *why* in the message.
3. Make sure CI is green.
4. Describe how you tested, including on a real server where relevant.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
