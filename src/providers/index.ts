import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phpString } from '../security/php.js';

export const PROVIDER_IDS = ['mirza', 'faoxima', 'pasarguard', 'pgclock'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderContext {
  domain: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  botToken: string;
  botUsername: string;
  adminTelegramId: string;
  /** FleetPanel's per-instance webhook secret ([A-Za-z0-9_-], 32+ chars). */
  webhookSecret: string;
  /** Absolute instance directory. */
  instanceDir: string;
  /** Telegram API credentials from my.telegram.org (providers that log in over MTProto). */
  apiId?: string;
  apiHash?: string;
  /** Loopback port of the bot's own web server (service providers). */
  appPort?: number;
  /** First password of the bot's own web panel, and the key it signs its sessions with (providers with webLogin). */
  webPassword?: string;
  webSecret?: string;
}

/** Inputs a provider needs on top of the common ones (bot token, admin id, domain). */
export type ExtraField = 'api_id' | 'api_hash';

/**
 * How Telegram proves a webhook call is genuine. It must match what the bot checks
 * itself, because the bot also re-registers its own webhook from its admin panel:
 * - header: X-Telegram-Bot-Api-Secret-Token (Telegram's secret_token)
 * - query:  ?secret=… in the webhook URL
 */
export type WebhookAuth = 'header' | 'query';

/** Each bot gets its own database and user on the server's MariaDB, or on PostgreSQL (installed on first use). */
export type DbEngine = 'mysql' | 'postgres';

interface ProviderBase {
  id: ProviderId;
  displayName: string;
  repoUrl: string;
  /**
   * The exact upstream commit FleetPanel installs (40-hex id). Never a branch or tag: those can be
   * moved by whoever controls the upstream repository. Bump it only after reviewing the upstream
   * changes, in a FleetPanel release (see docs/providers.md).
   */
  commit: string;
  /** Human-readable label for that commit, shown in the panel. */
  version: string;
  /** How the upstream publishes versions: GitHub releases, or commits to a branch. */
  track: { kind: 'release' } | { kind: 'branch'; branch: string };
  extraFields: ExtraField[];
  database: DbEngine;
  /**
   * The bot's own web page the panel links to. Not the site root: for the PHP bots that is the
   * Telegram webhook, which nginx answers with 403 unless the request carries the secret.
   */
  webPath: string;
}

/** A PHP bot served by PHP-FPM; Telegram delivers updates to its webhook. */
export interface PhpProvider extends ProviderBase {
  runtime: 'php';
  /** Path (relative to the web root) Telegram posts updates to. */
  webhookPath: string;
  webhookAuth: WebhookAuth;
  /** The project's config file, relative to the instance directory. Its shipped template is patched in place. */
  configFile: string;
  /** Upstream web installer directory. Removed before the site goes live: it must never be reachable. */
  installerDir: string;
  /** Schema/bootstrap script run with the PHP CLI once the database exists. */
  schemaScript: string;
  /** The bot's own cron dispatcher; FleetPanel runs it every minute as the bot's user. */
  cronScript: string;
  /** Fills the upstream config template. Throws if the template no longer has the expected shape. */
  renderConfig(template: string, ctx: ProviderContext): string;
  /** Optional SQL run after the schema script (values are validated, so they are safe to inline). */
  postSchemaSql?(ctx: ProviderContext): string;
  /** A query returning one number; provisioning fails unless it is > 0 (proves the schema and setup took). */
  readyCheckSql(ctx: ProviderContext): string;
  webhookUrl(ctx: ProviderContext): string;
}

/**
 * A Python bot that runs as a long-lived systemd service (it connects to Telegram itself),
 * with its own Redis and its web server reachable only through nginx.
 */
export interface PythonProvider extends ProviderBase {
  runtime: 'python';
  /** The script systemd starts (relative to the instance directory). */
  entry: string;
  /** Whether the bot needs its own Redis (a second service on a Unix socket). */
  redis: boolean;
  /**
   * How its Python packages are installed, always at exact versions with checked hashes:
   * - uv-lock: the project's own uv.lock (uv sync --frozen);
   * - requirements: a hash-pinned lock FleetPanel ships in deploy/locks (the project has only ranges).
   */
  deps: { kind: 'uv-lock' } | { kind: 'requirements'; lockFile: string; python: string };
  /** Whether a web app in frontend/ is built with bun. */
  webappBuild: boolean;
  /** Empty .env files the bot insists on (its settings come from the service environment). */
  envPlaceholders: string[];
  /** The bot has its own web panel with a login; FleetPanel sets the first password and shows it. */
  webLogin: boolean;
  /**
   * Project files the bot reads relative to its working directory. The service runs in a separate
   * working directory (downloads land there, not over the code), so these are copied into it.
   */
  workdirFiles: string[];
  /** The service's environment. Keys must be on the helper's allowlist, values in its charset. */
  renderEnv(ctx: ProviderContext): Record<string, string>;
  /** A query returning one number; provisioning fails unless it is > 0. */
  readyCheckSql(ctx: ProviderContext): string;
}

export type BotProvider = PhpProvider | PythonProvider;

/** First loopback port for service bots; an instance uses APP_PORT_BASE + its id. */
export const APP_PORT_BASE = 20000;

/** Where a bot's Python packages lock is copied inside its instance directory (read by the helper). */
export const REQUIREMENTS_LOCK = 'fleetpanel-requirements.txt';

/** deploy/locks/<file> in the FleetPanel tree (same relative path from src/providers and dist/providers). */
export function lockFilePath(file: string): string {
  if (!/^[a-z0-9-]+\.txt$/.test(file)) throw new Error('invalid lock file name');
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'locks', file);
}

/** The helper's instance-run task (and its argument) that installs a Python bot's packages. */
export function depsTask(provider: PythonProvider): { task: 'python-deps' | 'python-reqs'; arg?: string } {
  return provider.deps.kind === 'uv-lock' ? { task: 'python-deps' } : { task: 'python-reqs', arg: provider.deps.python };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is missing`);
  return value;
}

const GENERATED = '// Generated by FleetPanel. Manual edits are overwritten when the instance is reprovisioned.';
const SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;

function checkedSecret(secret: string): string {
  if (!SECRET_RE.test(secret)) throw new Error('invalid webhook secret');
  return secret;
}

function checkedId(id: string): string {
  if (!/^\d{1,20}$/.test(id)) throw new Error('invalid Telegram id');
  return id;
}

function addHeader(source: string): string {
  if (!source.startsWith('<?php')) throw new Error('provider config template does not start with <?php');
  return source.replace('<?php', `<?php\n${GENERATED}`);
}

/** Replaces each quoted placeholder ('{name}') with a safely escaped PHP literal. */
function fillPlaceholders(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [name, value] of Object.entries(values)) {
    const token = `'{${name}}'`;
    if (!out.includes(token)) {
      throw new Error(`provider config template has no ${token} placeholder; the upstream project changed its config format`);
    }
    out = out.split(token).join(phpString(value));
  }
  return out;
}

/** Sets `$name = '';` (first occurrence, at line start) to a safely escaped PHP literal. */
function fillEmptyAssignments(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [name, value] of Object.entries(values)) {
    const re = new RegExp(`^(\\$${name}\\s*=\\s*)''(\\s*;)`, 'm');
    if (!re.test(out)) {
      throw new Error(`provider config template has no empty $${name} assignment; the upstream project changed its config format`);
    }
    out = out.replace(re, (_m, lhs: string, end: string) => `${lhs}${phpString(value)}${end}`);
  }
  return out;
}

// Both projects ship config.php as a template and expect their web installer to fill it,
// create the schema (table.php) and register the webhook. FleetPanel performs those steps
// itself and removes the installer. Re-check these when bumping a provider version.
export const PROVIDERS: Record<ProviderId, BotProvider> = {
  mirza: {
    id: 'mirza',
    displayName: 'MirzaBot',
    repoUrl: 'https://github.com/mahdiMGF2/mirzabot.git',
    commit: '8e551ecf73d18dac8cb4b0cbada64c041e660f32',
    version: 'main @ 2026-10-02',
    track: { kind: 'branch', branch: 'main' },
    extraFields: [],
    database: 'mysql',
    webPath: 'panel/',
    runtime: 'php',
    webhookPath: 'index.php',
    // index.php compares ?secret= with setting.webhook_secret and re-registers the
    // webhook with that query string, never with a secret_token header.
    webhookAuth: 'query',
    configFile: 'config.php',
    installerDir: 'install',
    schemaScript: 'table.php',
    // run.php checks each job's own schedule (cronbot/jobs.php) and holds a lock.
    cronScript: 'cronbot/run.php',
    renderConfig: (template, c) =>
      addHeader(
        fillPlaceholders(template, {
          database_url: 'localhost',
          database_name: c.dbName,
          username_db: c.dbUser,
          password_db: c.dbPassword,
          API_KEY: c.botToken,
          admin_number: c.adminTelegramId,
          domain_name: c.domain,
          username_bot: c.botUsername,
        }),
      ),
    postSchemaSql: (c) => `UPDATE setting SET webhook_secret = '${checkedSecret(c.webhookSecret)}';`,
    readyCheckSql: (c) => `SELECT COUNT(*) FROM setting WHERE webhook_secret = '${checkedSecret(c.webhookSecret)}';`,
    webhookUrl: (c) => `https://${c.domain}/index.php?secret=${checkedSecret(c.webhookSecret)}`,
  },
  faoxima: {
    id: 'faoxima',
    displayName: 'Faoxima',
    repoUrl: 'https://github.com/Mmd-Amir/Faoxima.git',
    commit: '68eccf1981f1bd7f21c8000ad5fff198a0f6c175',
    version: 'v1.1.5',
    track: { kind: 'release' },
    extraFields: [],
    database: 'mysql',
    webPath: 'panel/',
    runtime: 'php',
    webhookPath: 'index.php',
    // FaoximaWebhookAuth checks the secret_token header against TELEGRAM_WEBHOOK_SECRET.
    webhookAuth: 'header',
    configFile: 'config.php',
    installerDir: 'installer',
    schemaScript: 'table.php',
    // From the CLI, cron.php runs the due cronbot/ jobs as processes (HTTP only as a fallback).
    cronScript: 'cron/cron.php',
    renderConfig: (template, c) => {
      const filled = fillEmptyAssignments(template, {
        dbname: c.dbName,
        usernamedb: c.dbUser,
        passworddb: c.dbPassword,
        dbhost: 'localhost',
        APIKEY: c.botToken,
        adminnumber: c.adminTelegramId,
        domainhosts: c.domain,
        usernamebot: c.botUsername,
      });
      const secret = phpString(checkedSecret(c.webhookSecret));
      return filled.replace(
        '<?php',
        `<?php\n${GENERATED}\nif (!defined('TELEGRAM_WEBHOOK_SECRET')) {\n    define('TELEGRAM_WEBHOOK_SECRET', ${secret});\n}`,
      );
    },
    // table.php creates the admin row for $adminnumber; fail provisioning if it did not.
    readyCheckSql: (c) => `SELECT COUNT(*) FROM admin WHERE id_admin = '${checkedId(c.adminTelegramId)}';`,
    webhookUrl: (c) => `https://${c.domain}/index.php`,
  },
  pasarguard: {
    id: 'pasarguard',
    displayName: 'PasarguardBot',
    repoUrl: 'https://github.com/AmirKenzo/PasarguardBot.git',
    commit: 'f9c7c28c99bd9c5d394e68c6e27ae545fa6762aa',
    version: 'v2.1.4',
    track: { kind: 'release' },
    // Telethon logs in over MTProto, which needs an API id/hash besides the bot token.
    extraFields: ['api_id', 'api_hash'],
    database: 'mysql',
    webPath: 'webapp/',
    // app/version.py reads Path("pyproject.toml") when the package metadata is missing.
    workdirFiles: ['pyproject.toml'],
    runtime: 'python',
    entry: 'main.py',
    redis: true,
    deps: { kind: 'uv-lock' },
    webappBuild: true,
    // python-decouple's RepositoryEnv(".env") refuses to start without the file.
    envPlaceholders: ['.env', 'workdir/.env'],
    webLogin: false,
    renderEnv: (c) => ({
      BOT_TOKEN: c.botToken,
      API_ID: required(c.apiId, 'API id'),
      API_HASH: required(c.apiHash, 'API hash'),
      ADMIN_ID: checkedId(c.adminTelegramId),
      // MySQL's local socket, like the PHP bots: the database user exists for 'localhost' only.
      SQLALCHEMY_DATABASE_URL: `mysql+asyncmy://${c.dbUser}:${c.dbPassword}@localhost/${c.dbName}?unix_socket=/run/mysqld/mysqld.sock`,
      FASTAPI_PORT: required(c.appPort ? String(c.appPort) : undefined, 'app port'),
      REDIS_URL: `unix://${c.instanceDir}/data/redis/redis.sock`,
      REDIS_NAMESPACE_PREFIX: `fleetpanel:${c.dbName}`,
      LOG_DIR: `${c.instanceDir}/logs`,
      TELETHON_SESSION_PATH: `${c.instanceDir}/sessions/bot`,
      WEBAPP_URL: `https://${c.domain}/webapp`,
    }),
    // Alembic records the applied revision once the schema exists.
    readyCheckSql: () => 'SELECT COUNT(*) FROM alembic_version;',
  },
  pgclock: {
    id: 'pgclock',
    displayName: 'PGClockBot',
    repoUrl: 'https://github.com/Mrclocks/PGClockBot.git',
    commit: 'f889beef1ae45fb23642f75f1874690b9d5e6ec7',
    version: 'v0.1.9',
    track: { kind: 'release' },
    // The PasarGuard panel address and login are entered in the bot's own web panel.
    extraFields: [],
    // Its installer provisions PostgreSQL; SQLite is only used by its tests.
    database: 'postgres',
    webPath: '',
    workdirFiles: [],
    runtime: 'python',
    entry: 'run.py',
    redis: false,
    // Its CI runs on Python 3.12; requirements.txt has only version ranges.
    deps: { kind: 'requirements', lockFile: 'pgclock.txt', python: '3.12' },
    webappBuild: false,
    // It keeps what is edited in its web panel (PasarGuard login, ...) in .env and data/, which
    // FleetPanel never overwrites. The values below come from the environment and win over .env.
    envPlaceholders: [],
    webLogin: true,
    renderEnv: (c) => ({
      BOT_TOKEN: c.botToken,
      BOT_USERNAME: c.botUsername,
      ADMIN_IDS: checkedId(c.adminTelegramId),
      // TCP on loopback with a password: the database role is not the bot's Linux user (no peer auth).
      DATABASE_URL: `postgresql+asyncpg://${c.dbUser}:${c.dbPassword}@127.0.0.1:5432/${c.dbName}`,
      WEB_HOST: '127.0.0.1',
      WEB_PORT: required(c.appPort ? String(c.appPort) : undefined, 'app port'),
      WEB_SECRET: required(c.webSecret, 'web secret'),
      // Copied into data/web_admin.json (bcrypt) on first start; a password changed in its panel wins.
      WEB_ADMIN_USER: 'admin',
      WEB_ADMIN_PASSWORD: required(c.webPassword, 'web password'),
      WEBHOOK_URL: `https://${c.domain}`,
      WEBHOOK_PATH: '/telegram/webhook',
      // The bot registers its webhook itself and checks this secret_token header.
      WEBHOOK_SECRET_TOKEN: checkedSecret(c.webhookSecret),
      PUBLIC_BASE_URL: `https://${c.domain}`,
      // Behind nginx: client addresses (login limits, the first-run check) come from X-Forwarded-For.
      TRUST_PROXY: '1',
      TRUST_PROXY_HOPS: '1',
    }),
    readyCheckSql: () => 'SELECT COUNT(*) FROM alembic_version;',
  },
};
