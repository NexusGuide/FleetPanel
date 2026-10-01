# Bot providers

A provider describes how to install one bot project. Providers live in `src/providers/index.ts`.

| Provider | Project | Webhook check | Installer directory removed |
| --- | --- | --- | --- |
| `mirza` | [mahdiMGF2/mirzabot](https://github.com/mahdiMGF2/mirzabot) | `?secret=` in the URL, stored in `setting.webhook_secret` | `install/` |
| `faoxima` | [Mmd-Amir/Faoxima](https://github.com/Mmd-Amir/Faoxima) | `X-Telegram-Bot-Api-Secret-Token` header, via `TELEGRAM_WEBHOOK_SECRET` | `installer/` |

Both projects ship `config.php` as a template that their own web installer fills in. FleetPanel does the
installer's work itself, so the web installer is never exposed:

1. **Config:** fills the project's own `config.php` (MirzaBot: its `{placeholders}`; Faoxima: its empty
   assignments) with values escaped as PHP string literals. If the upstream template changes shape,
   provisioning stops with a clear error instead of writing a broken config.
2. **Dependencies:** `composer install --no-dev` when the project has `composer.json` but no `vendor/`
   (MirzaBot does not ship `vendor/`; Faoxima does).
3. **Schema:** runs the project's `table.php` with the PHP CLI after the database exists.
4. **Webhook secret:** makes the bot's own check agree with FleetPanel's. MirzaBot keeps the secret in its
   `setting` table and re-registers its webhook with `?secret=`; FleetPanel stores its secret there.
   Faoxima reads the `TELEGRAM_WEBHOOK_SECRET` constant, which FleetPanel defines in `config.php`.
5. **Ready check:** a query that proves the schema and setup worked (MirzaBot: the secret is stored;
   Faoxima: the admin row exists).
6. **nginx:** the instance's site rejects webhook calls whose secret (header or query, per provider)
   does not match, and does not log the query-string secret.

## The provider interface

```ts
interface BotProvider {
  id: ProviderId;
  displayName: string;
  repoUrl: string;
  ref?: string;                   // branch or tag; default branch if omitted
  webhookPath: string;            // e.g. 'index.php'
  webhookAuth: 'header' | 'query';
  configFile: string;             // the project's config template, relative to the instance
  installerDir: string;           // removed before the site goes live
  schemaScript: string;           // run with the PHP CLI
  renderConfig(template: string, ctx: ProviderContext): string;
  postSchemaSql?(ctx: ProviderContext): string;
  readyCheckSql(ctx: ProviderContext): string;   // must return a number > 0
  webhookUrl(ctx: ProviderContext): string;
}
```

## Adding a provider

1. Read the project's own installer: what it writes to the config, which schema script it runs, how its
   `index.php` verifies Telegram, and where its web installer lives.
2. Add an entry to `PROVIDER_IDS` and `PROVIDERS`. Pass every value through `phpString()`; never
   concatenate raw input into PHP or SQL.
3. Add a fake upstream layout to `tests/fixtures.ts` and a provisioning test in `tests/api.test.ts`.
4. Test on a real server before releasing: create an instance, send `/start`, open its web pages, back it
   up and restore it.

The bots' scheduled tasks (cron jobs) are not installed yet; see the roadmap in the README.
