import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { AuditLog } from '../src/audit.js';
import { SecretStore } from '../src/secrets.js';
import { SecretBox } from '../src/security/crypto.js';
import { hashPassword } from '../src/security/passwords.js';
import { SessionStore } from '../src/http/sessions.js';
import { createApp } from '../src/http/app.js';
import { BackupService } from '../src/services/backups.js';
import { ControlBackupService } from '../src/services/controlBackup.js';
import { SettingsStore } from '../src/settings.js';
import { openBackup } from '../src/security/fleetBackup.js';
import { InstanceService } from '../src/services/instances.js';
import type { PrivilegedOps } from '../src/system/helper.js';
import type { TelegramClient } from '../src/services/telegram.js';
import { clonedCommits, fakeClone, fakeRunner, fakeToolchain } from './fixtures.js';
import { PROVIDERS } from '../src/providers/index.js';

const noop = async (): Promise<void> => undefined;
const tools = fakeToolchain();
const createdSites: Array<{ slug: string; auth: string }> = [];
const webhooks: string[] = [];
const clearedWebhooks: string[] = [];
const createdDatabases: string[] = [];
const ops: PrivilegedOps = {
  createDatabase: async (db, _user, _password, engine = 'mysql') => {
    createdDatabases.push(`${db}:${engine}`);
  },
  dropDatabase: noop,
  fixPermissions: noop,
  createInstance: async (slug, _domain, _hook, auth) => {
    createdSites.push({ slug, auth });
  },
  issueCertificate: noop,
  enableInstance: noop,
  disableInstance: noop,
  removeInstance: noop,
  ...fakeRunner(tools.calls, () => path.join(tmp, 'instances')),
};
const telegram: TelegramClient = {
  getMe: async () => ({ id: 1, username: 'demo_bot' }),
  setWebhook: async (_token, url) => {
    webhooks.push(url);
  },
  deleteWebhook: async (token) => {
    clearedWebhooks.push(token);
  },
  sendMessage: async (_target, text) => {
    sentMessages.push(text);
  },
  sendDocument: async (_target, file) => {
    sentDocuments.push(file);
  },
};
const sentMessages: string[] = [];
const sentDocuments: Array<{ name: string; data: Buffer }> = [];
let backups: BackupService;
let controlBackup: ControlBackupService;

const TOKEN = `123456789:${'A'.repeat(35)}`;
let server: http.Server;
let base = '';
let tmp = '';
let db: ReturnType<typeof openDb>;
let removedFilesFails = false;

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function rawRequest(method: string, url: string, headers: Record<string, string>, body: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${url}`, { method, headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed: unknown = data;
        try {
          parsed = JSON.parse(data);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function request(method: string, url: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(`${base}${url}`, { method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => {
        let body: unknown = data;
        try {
          body = JSON.parse(data);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

type Login = { cookie: string; token: string; csrf: string };
const logins = new Map<string, Login>();

/** One session per user: the login endpoint is rate limited to 5 attempts per user and IP. */
async function login(username: string, password: string): Promise<Login> {
  const cached = logins.get(username);
  if (cached) return cached;
  const fresh = await freshLogin(username, password);
  logins.set(username, fresh);
  return fresh;
}

async function freshLogin(username: string, password: string): Promise<Login> {
  const res = await request('POST', '/api/auth/login', { body: { username, password } });
  expect(res.status).toBe(200);
  const setCookie = res.headers['set-cookie']?.[0] ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  return { cookie, token: cookie.split('=')[1] ?? '', csrf: res.body.csrf_token as string };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetpanel-test-'));
  const instancesDir = path.join(tmp, 'instances');
  const backupsDir = path.join(tmp, 'backups');
  fs.mkdirSync(instancesDir);
  fs.mkdirSync(backupsDir);

  db = openDb(':memory:');
  const insert = db.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)');
  insert.run('owner', await hashPassword('Owner-Password-1'), 'Owner');
  insert.run('viewer', await hashPassword('Viewer-Password-1'), 'Viewer');
  insert.run('manager', await hashPassword('Manager-Password-1'), 'Manager');

  const audit = new AuditLog(db);
  const secrets = new SecretStore(db, SecretBox.fromKey(crypto.randomBytes(32)));
  backups = new BackupService({ db, audit, secrets, ops, instancesDir, backupsDir, retention: 3 });
  const masterKeyFile = path.join(tmp, 'master.key');
  fs.writeFileSync(masterKeyFile, crypto.randomBytes(32), { mode: 0o600 });
  controlBackup = new ControlBackupService({
    db,
    settings: new SettingsStore(db, SecretBox.fromKey(crypto.randomBytes(32))),
    telegram,
    audit,
    masterKeyFile,
    version: 'test',
    host: 'test-host',
  });
  const instances = new InstanceService({
    db,
    audit,
    secrets,
    ops,
    telegram,
    backups,
    instancesDir,
    git: fakeClone,
    gitRemovedFiles: async () => {
      if (removedFilesFails) throw new Error('fatal: remote error: upload-pack: not our ref');
      return ['old/legacy.php'];
    },
    tools,
  });
  const app = createApp({ db, sessions: new SessionStore(db), audit, instances, backups, controlBackup, cookieSecure: false, trustProxy: false, dataRoot: tmp });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('API security', () => {
  it('serves health without auth', async () => {
    expect((await request('GET', '/api/health')).status).toBe(200);
  });

  it('rejects bad credentials', async () => {
    const res = await request('POST', '/api/auth/login', { body: { username: 'owner', password: 'wrong' } });
    expect(res.status).toBe(401);
  });

  it('requires authentication for instances', async () => {
    expect((await request('GET', '/api/instances')).status).toBe(401);
  });

  it('never exposes session tokens when listing sessions', async () => {
    const { cookie, token } = await login('owner', 'Owner-Password-1');
    const res = await request('GET', '/api/auth/sessions', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.body.sessions.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('enforces CSRF tokens on state-changing requests', async () => {
    const { cookie } = await login('viewer', 'Viewer-Password-1');
    const res = await request('POST', '/api/auth/logout', { headers: { cookie } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_token_invalid');
  });

  it('blocks cross-origin writes', async () => {
    const { cookie, csrf } = await login('viewer', 'Viewer-Password-1');
    const res = await request('POST', '/api/auth/logout', {
      headers: { cookie, 'x-csrf-token': csrf, origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('cross_origin_blocked');
  });

  it('enforces RBAC', async () => {
    const { cookie, csrf } = await login('viewer', 'Viewer-Password-1');
    const create = await request('POST', '/api/instances', {
      headers: { cookie, 'x-csrf-token': csrf },
      body: { slug: 'demo-bot', provider: 'mirza', domain: 'bot.example.com', bot_token: TOKEN, admin_telegram_id: '42' },
    });
    expect(create.status).toBe(403);
    expect((await request('GET', '/api/admins', { headers: { cookie } })).status).toBe(403);
    expect((await request('GET', '/api/instances', { headers: { cookie } })).status).toBe(200);
  });

  it('rejects injection attempts with a validation error', async () => {
    const { cookie, csrf } = await login('owner', 'Owner-Password-1');
    const res = await request('POST', '/api/instances', {
      headers: { cookie, 'x-csrf-token': csrf },
      body: { slug: 'demo-bot', provider: 'mirza', domain: 'a.com; include /etc/passwd', bot_token: TOKEN, admin_telegram_id: '42' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('provisions an instance and writes an escaped config', async () => {
    const { cookie, csrf } = await login('owner', 'Owner-Password-1');
    const res = await request('POST', '/api/instances', {
      headers: { cookie, 'x-csrf-token': csrf },
      body: { slug: 'demo-bot', provider: 'mirza', domain: 'bot.example.com', bot_token: TOKEN, admin_telegram_id: '42' },
    });
    expect(res.status).toBe(202);
    const id = res.body.instance.id as number;

    let status = '';
    for (let i = 0; i < 50 && status !== 'running' && status !== 'error'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = (await request('GET', `/api/instances/${id}`, { headers: { cookie } })).body.instance.status;
    }
    expect(status).toBe('running');

    // The exact pinned upstream commit was installed and recorded, never a moving branch.
    expect(clonedCommits).toContain(PROVIDERS.mirza.commit);
    const created = (await request('GET', `/api/instances/${id}`, { headers: { cookie } })).body.instance;
    expect(created.source_commit).toBe(PROVIDERS.mirza.commit);

    const dir = path.join(tmp, 'instances', 'demo-bot');
    const config = fs.readFileSync(path.join(dir, 'config.php'), 'utf8');
    expect(config).toContain(`$APIKEY = '${TOKEN}';`);
    expect(config).toContain("$adminnumber = '42';");
    expect(config).toContain("$dbhost = 'localhost';");
    expect(config).not.toMatch(/\{[a-z_]+\}/i);

    // MirzaBot's full install: dependencies, no reachable web installer, schema, matching webhook secret.
    expect(tools.calls.composer).toContain(dir);
    expect(fs.existsSync(path.join(dir, 'install'))).toBe(false);
    expect(tools.calls.php).toContain(path.join(dir, 'table.php'));
    const secretUpdate = tools.calls.sql.find((q) => q.startsWith('UPDATE setting SET webhook_secret'));
    const secret = /webhook_secret = '([A-Za-z0-9_-]+)'/.exec(secretUpdate ?? '')?.[1];
    expect(secret).toBeTruthy();
    expect(webhooks).toContain(`https://bot.example.com/index.php?secret=${secret}`);
    // Its own cron dispatcher runs from a FleetPanel timer.
    expect(tools.calls.service).toContain('demo-bot:cron:cronbot/run.php');
    expect(createdSites).toContainEqual({ slug: 'demo-bot', auth: 'query' });

    const duplicate = await request('POST', '/api/instances', {
      headers: { cookie, 'x-csrf-token': csrf },
      body: { slug: 'demo-bot', provider: 'mirza', domain: 'other.example.com', bot_token: TOKEN, admin_telegram_id: '42' },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('slug_in_use');
    expect(duplicate.body.message).toContain("A bot named 'demo-bot' already exists");

    // The wizard's pre-check reports every duplicate field without creating anything.
    const check = await request('POST', '/api/instances/check', {
      headers: { cookie, 'x-csrf-token': csrf },
      body: { slug: 'demo-bot', provider: 'faoxima', domain: 'BOT.example.com', bot_token: TOKEN, admin_telegram_id: '42' },
    });
    expect(check.status).toBe(200);
    expect(check.body.bot_username).toBe('demo_bot');
    expect(Object.keys(check.body.conflicts).sort()).toEqual(['bot_token', 'domain', 'slug']);
    const free = await request('POST', '/api/instances/check', {
      headers: { cookie, 'x-csrf-token': csrf },
      body: { slug: 'free-bot', provider: 'mirza', domain: 'free.example.com', bot_token: TOKEN, admin_telegram_id: '42' },
    });
    expect(free.body.conflicts).toEqual({ bot_token: "Bot @demo_bot is already used by bot 'demo-bot'." });
    const listed = await request('GET', '/api/instances', { headers: { cookie } });
    expect(listed.body.instances.map((i: { slug: string }) => i.slug)).not.toContain('free-bot');

    const sameBot = await request('POST', '/api/instances', {
      headers: { cookie, 'x-csrf-token': csrf },
      body: { slug: 'other-bot', provider: 'faoxima', domain: 'other.example.com', bot_token: TOKEN, admin_telegram_id: '42' },
    });
    expect(sameBot.status).toBe(409);
    expect(sameBot.body.error).toBe('bot_in_use');
  });

  it('accepts hyphenated domains end to end', async () => {
    const { cookie, csrf } = await login('owner', 'Owner-Password-1');
    telegram.getMe = async () => ({ id: 2, username: 'second_bot' });
    const res = await request('POST', '/api/instances', {
      headers: { cookie, 'x-csrf-token': csrf },
      body: { slug: 'shop-bot', provider: 'faoxima', domain: 'my-shop.example.com', bot_token: TOKEN, admin_telegram_id: '7' },
    });
    expect(res.status).toBe(202);
    const id = res.body.instance.id as number;
    let instance = res.body.instance;
    for (let i = 0; i < 50 && instance.status === 'provisioning'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      instance = (await request('GET', `/api/instances/${id}`, { headers: { cookie } })).body.instance;
    }
    expect(instance.last_error).toBeNull();
    expect(instance.status).toBe('running');

    // Faoxima: config filled in place, secret via TELEGRAM_WEBHOOK_SECRET + header check, installer removed.
    const dir = path.join(tmp, 'instances', 'shop-bot');
    const config = fs.readFileSync(path.join(dir, 'config.php'), 'utf8');
    expect(config).toContain("$domainhosts                = 'my-shop.example.com';");
    expect(config).toContain("$dbhost     = 'localhost';");
    expect(config).toMatch(/define\('TELEGRAM_WEBHOOK_SECRET', '[A-Za-z0-9_-]{32,}'\);/);
    expect(fs.existsSync(path.join(dir, 'installer'))).toBe(false);
    expect(tools.calls.composer).not.toContain(dir);
    expect(createdSites).toContainEqual({ slug: 'shop-bot', auth: 'header' });
    expect(webhooks).toContain('https://my-shop.example.com/index.php');
  });

  it('names the failing step and allows reprovisioning a running instance', async () => {
    const { cookie, csrf } = await login('owner', 'Owner-Password-1');
    const list = await request('GET', '/api/instances', { headers: { cookie } });
    const target = list.body.instances.find((i: { slug: string }) => i.slug === 'shop-bot');

    const original = ops.runPhp;
    ops.runPhp = async () => {
      throw new Error('PHP Fatal error: boom');
    };
    try {
      const res = await request('POST', `/api/instances/${target.id}/reprovision`, { headers: { cookie, 'x-csrf-token': csrf } });
      expect(res.status).toBe(202);
      let instance = res.body.instance;
      for (let i = 0; i < 50 && instance.status === 'provisioning'; i++) {
        await new Promise((r) => setTimeout(r, 20));
        instance = (await request('GET', `/api/instances/${target.id}`, { headers: { cookie } })).body.instance;
      }
      expect(instance.status).toBe('error');
      expect(instance.last_error).toBe('Creating database tables (table.php): PHP Fatal error: boom');
    } finally {
      ops.runPhp = original;
    }
  });

  it('refuses to let an administrator disable their own account', async () => {
    const { cookie, csrf } = await login('owner', 'Owner-Password-1');
    const admins = await request('GET', '/api/admins', { headers: { cookie } });
    const self = admins.body.admins.find((a: { username: string }) => a.username === 'owner');
    const res = await request('PATCH', `/api/admins/${self.id}`, {
      headers: { cookie, 'x-csrf-token': csrf },
      body: { is_active: false },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_disable_self');
  });

  it('audits failed operations with the client IP', async () => {
    const { cookie, csrf } = await login('owner', 'Owner-Password-1');
    const list = await request('GET', '/api/instances', { headers: { cookie } });
    const id = list.body.instances.find((i: { status: string }) => i.status === 'running').id as number;
    // mysqldump is not available in the test environment, so the backup fails for real.
    const backup = await request('POST', `/api/instances/${id}/backups`, { headers: { cookie, 'x-csrf-token': csrf } });
    expect(backup.status).toBeGreaterThanOrEqual(400);
    const audit = await request('GET', '/api/audit-logs?limit=20', { headers: { cookie } });
    const failed = audit.body.entries.find((e: { action: string; status: string }) => e.action === 'BACKUP_CREATE' && e.status === 'FAILED');
    expect(failed).toBeDefined();
    expect(failed.ip).toBe('127.0.0.1');
    const created = audit.body.entries.find((e: { action: string }) => e.action === 'INSTANCE_CREATE');
    expect(created.ip).toBe('127.0.0.1');
  });

  it('installs a Python service bot (PasarguardBot) with its own service and no webhook', async () => {
    const { cookie, csrf } = await login('owner', 'Owner-Password-1');
    telegram.getMe = async () => ({ id: 3, username: 'pasar_bot' });
    const body = { slug: 'pasar-bot', provider: 'pasarguard', domain: 'pasar.example.com', bot_token: TOKEN, admin_telegram_id: '42' };

    // MTProto needs the API id/hash: refused before anything is created.
    const missing = await request('POST', '/api/instances', { headers: { cookie, 'x-csrf-token': csrf }, body });
    expect(missing.status).toBe(400);
    expect(missing.body.issues.map((i: { path: string }) => i.path).sort()).toEqual(['api_hash', 'api_id']);
    const badHash = await request('POST', '/api/instances', {
      headers: { cookie, 'x-csrf-token': csrf },
      body: { ...body, api_id: '12345', api_hash: "abc'; rm -rf /" },
    });
    expect(badHash.status).toBe(400);

    const res = await request('POST', '/api/instances', {
      headers: { cookie, 'x-csrf-token': csrf },
      body: { ...body, api_id: '12345', api_hash: 'A'.repeat(32) },
    });
    expect(res.status).toBe(202);
    const id = res.body.instance.id as number;
    let inst = res.body.instance;
    for (let i = 0; i < 50 && inst.status === 'provisioning'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      inst = (await request('GET', `/api/instances/${id}`, { headers: { cookie } })).body.instance;
    }
    expect(inst.last_error).toBeNull();
    expect(inst.status).toBe('running');
    expect(inst.app_port).toBe(20000 + id);
    expect(inst.source_commit).toBe(PROVIDERS.pasarguard.commit);

    // The bot's own code runs only through the helper's steps, in this order.
    const steps = tools.calls.service.filter((c) => c === 'runtime' || c.startsWith('pasar-bot:'));
    expect(steps).toEqual([
      'runtime',
      'pasar-bot:python-deps',
      'pasar-bot:webapp-build',
      'pasar-bot:python-migrate',
      `pasar-bot:service:pasar.example.com:${20000 + id}:main.py:redis`,
      `pasar-bot:wait:${20000 + id}`,
    ]);
    const dir = path.join(tmp, 'instances', 'pasar-bot');
    const env = Object.fromEntries((tools.calls.env['pasar-bot'] ?? '').split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(env).toMatchObject({
      BOT_TOKEN: TOKEN,
      API_ID: '12345',
      API_HASH: 'a'.repeat(32),
      ADMIN_ID: '42',
      FASTAPI_PORT: String(20000 + id),
      REDIS_URL: `unix://${dir}/data/redis/redis.sock`,
      WEBAPP_URL: 'https://pasar.example.com/webapp',
    });
    expect(env.SQLALCHEMY_DATABASE_URL).toMatch(/^mysql\+asyncmy:\/\/fp_pasar_bot:[A-Za-z0-9]+@localhost\/fp_pasar_bot\?unix_socket=\/run\/mysqld\/mysqld\.sock$/);
    // Every line must pass the helper's own checks (allowlisted key, shell-safe value). The test
    // runs in a temp dir; on a server the instance lives under /opt/fleetpanel/instances.
    const serverEnv = (tools.calls.env['pasar-bot'] ?? '').replaceAll(dir, '/opt/fleetpanel/instances/pasar-bot');
    for (const line of serverEnv.split('\n')) {
      expect(line).toMatch(/^(BOT_TOKEN|API_ID|API_HASH|ADMIN_ID|SQLALCHEMY_DATABASE_URL|FASTAPI_PORT|REDIS_URL|REDIS_NAMESPACE_PREFIX|LOG_DIR|TELETHON_SESSION_PATH|WEBAPP_URL)=[A-Za-z0-9_.:/@+%=?,-]{0,255}$/);
    }
    for (const sub of ['workdir', 'logs', 'sessions', 'data/redis']) expect(fs.existsSync(path.join(dir, sub))).toBe(true);
    // Read relative to the working directory by the bot (app/version.py).
    expect(fs.readFileSync(path.join(dir, 'workdir', 'pyproject.toml'), 'utf8')).toContain('version = "2.1.4"');
    // The bot needs a .env to exist; it must stay free of secrets (the bot zips it into its own backups).
    for (const rel of ['.env', 'workdir/.env']) {
      const text = fs.readFileSync(path.join(dir, rel), 'utf8');
      expect(text).not.toContain(TOKEN);
      expect(text.split('\n').every((l) => l === '' || l.startsWith('#'))).toBe(true);
    }
    expect(tools.calls.sql).toContain('SELECT COUNT(*) FROM alembic_version;');
    // No webhook: an old one is cleared instead, and no PHP site is created.
    expect(clearedWebhooks).toContain(TOKEN);
    expect(webhooks.some((u) => u.includes('pasar.example.com'))).toBe(false);
    expect(createdSites.some((s) => s.slug === 'pasar-bot')).toBe(false);
  });

  it('installs PGClockBot on PostgreSQL with pinned packages and a first web login', async () => {
    // A Manager can install bots and see their first web login.
    const { cookie, csrf } = await login('manager', 'Manager-Password-1');
    telegram.getMe = async () => ({ id: 4, username: 'clock_bot' });
    const callsBefore = tools.calls.service.length;
    const res = await request('POST', '/api/instances', {
      headers: { cookie, 'x-csrf-token': csrf },
      body: { slug: 'clock-bot', provider: 'pgclock', domain: 'clock.example.com', bot_token: TOKEN, admin_telegram_id: '42' },
    });
    expect(res.status).toBe(202);
    const id = res.body.instance.id as number;
    let inst = res.body.instance;
    for (let i = 0; i < 50 && inst.status === 'provisioning'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      inst = (await request('GET', `/api/instances/${id}`, { headers: { cookie } })).body.instance;
    }
    expect(inst.last_error).toBeNull();
    expect(inst.status).toBe('running');
    expect(inst.source_commit).toBe(PROVIDERS.pgclock.commit);
    expect(createdDatabases).toContain('fp_clock_bot:postgres');

    // PostgreSQL first, packages from FleetPanel's lock on Python 3.12, no Redis and no web-app build.
    const steps = tools.calls.service.slice(callsBefore);
    expect(steps).toEqual([
      'postgres',
      'runtime',
      'clock-bot:python-reqs:3.12',
      'clock-bot:python-migrate',
      `clock-bot:service:clock.example.com:${20000 + id}:run.py:no-redis`,
      `clock-bot:wait:${20000 + id}`,
    ]);
    const dir = path.join(tmp, 'instances', 'clock-bot');
    const lock = fs.readFileSync(path.join(dir, 'fleetpanel-requirements.txt'), 'utf8');
    expect(lock).toBe(fs.readFileSync(path.join(__dirname, '..', 'deploy', 'locks', 'pgclock.txt'), 'utf8'));
    // Every package is pinned to one version and carries hashes.
    const pins = lock.split('\n').filter((l) => /^[a-z0-9]/i.test(l));
    expect(pins.length).toBeGreaterThan(20);
    for (const pin of pins) expect(pin).toMatch(/^[a-z0-9._-]+==[0-9][^ ]* (; .+ )?\\$/i);
    expect(lock.split('--hash=sha256:').length - 1).toBeGreaterThanOrEqual(pins.length);
    // Its .env holds what is edited in its own panel: FleetPanel writes none.
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);

    const env = Object.fromEntries((tools.calls.env['clock-bot'] ?? '').split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(env).toMatchObject({
      BOT_TOKEN: TOKEN,
      BOT_USERNAME: 'clock_bot',
      ADMIN_IDS: '42',
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(20000 + id),
      WEB_ADMIN_USER: 'admin',
      WEBHOOK_URL: 'https://clock.example.com',
      WEBHOOK_PATH: '/telegram/webhook',
      PUBLIC_BASE_URL: 'https://clock.example.com',
      TRUST_PROXY: '1',
    });
    expect(env.DATABASE_URL).toMatch(/^postgresql\+asyncpg:\/\/fp_clock_bot:[A-Za-z0-9]{32}@127\.0\.0\.1:5432\/fp_clock_bot$/);
    expect(env.WEBHOOK_SECRET_TOKEN).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(env.WEB_SECRET).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(tools.calls.sqlEngines.at(-1)).toBe('postgres');

    // The first web login: Owner/Admin/Manager only, audited, and none for bots without one.
    const viewer = await login('viewer', 'Viewer-Password-1');
    expect((await request('GET', `/api/instances/${id}/web-login`, { headers: { cookie: viewer.cookie } })).status).toBe(403);
    const web = await request('GET', `/api/instances/${id}/web-login`, { headers: { cookie } });
    expect(web.status).toBe(200);
    expect(web.body.username).toBe('admin');
    expect(web.body.password).toBe(env.WEB_ADMIN_PASSWORD);
    // Meets the bot's own rules: 12+ characters, 2+ digits, upper- and lowercase letters, a special character.
    expect(web.body.password).toMatch(/^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){3}$/);
    expect(web.body.password.replace(/\D/g, '').length).toBeGreaterThanOrEqual(2);
    const audit = await request('GET', '/api/audit-logs', { headers: { cookie } });
    expect(audit.body.entries.some((e: { action: string; actor: string }) => e.action === 'INSTANCE_WEB_LOGIN_VIEW' && e.actor.includes('manager'))).toBe(true);
    const list = (await request('GET', '/api/instances', { headers: { cookie } })).body.instances as Array<{ id: number; slug: string }>;
    const pasar = list.find((i) => i.slug === 'pasar-bot')?.id;
    expect((await request('GET', `/api/instances/${pasar}/web-login`, { headers: { cookie } })).status).toBe(404);

    // Database import (Owner/Admin): pg_dump custom-format files only (plain SQL would need psql,
    // which runs client-side commands found in its input).
    const owner = await login('owner', 'Owner-Password-1');
    const realCreate = backups.create.bind(backups);
    backups.create = async () => ({ id: '20261005T000000Z-safe0002' }) as Awaited<ReturnType<BackupService['create']>>;
    const upload = (body: string) =>
      rawRequest('POST', `/api/instances/${id}/import-db`, { cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'content-type': 'application/octet-stream' }, body);
    try {
      const sql = await upload('CREATE TABLE t (id int);\n\\! touch /tmp/pwned\n');
      expect(sql.status).toBe(400);
      expect(sql.body.error).toBe('not_a_dump');
      const ok = await upload('PGDMP\u0001\u000e\u0000 custom dump');
      expect(ok.status).toBe(200);
      expect(tools.calls.imports.at(-1)).toMatch(/^postgres:PGDMP/);
      // Schema brought up to date afterwards.
      expect(tools.calls.service.at(-1)).toBe('clock-bot:python-migrate');
    } finally {
      backups.create = realCreate;
    }
  });

  it('imports a bot database backup safely and reapplies FleetPanel settings', async () => {
    const { cookie, csrf } = await login('owner', 'Owner-Password-1');
    const list = (await request('GET', '/api/instances', { headers: { cookie } })).body.instances as Array<{ id: number; slug: string }>;
    const mirza = list.find((i) => i.slug === 'demo-bot');
    expect(mirza).toBeTruthy();
    // Safety backups need mysqldump; stand in for it here.
    const realCreate = backups.create.bind(backups);
    backups.create = async () => ({ id: '20261003T000000Z-safe0001' }) as Awaited<ReturnType<BackupService['create']>>;
    const upload = (body: string, type = 'application/octet-stream') =>
      rawRequest('POST', `/api/instances/${mirza?.id}/import-db`, { cookie, 'x-csrf-token': csrf, 'content-type': type }, body);
    try {
      expect((await upload('x', 'text/plain')).status).toBe(415);

      const importsBefore = tools.calls.imports.length;
      const unsafe = await upload('CREATE TABLE t (id int);\n\\! touch /tmp/pwned\n');
      expect(unsafe.status).toBe(400);
      expect(unsafe.body.error).toBe('unsafe_dump');
      expect(tools.calls.imports).toHaveLength(importsBefore);

      const dump = [
        '-- MariaDB dump',
        'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `mirza_old` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;',
        'USE `mirza_old`;',
        'CREATE TABLE `user` (`id` bigint);',
        'INSERT INTO `user` VALUES (1),(2);',
        '/*!50003 CREATE*/ /*!50017 DEFINER=`mirza`@`localhost`*/ /*!50003 TRIGGER t1 BEFORE INSERT ON `user` FOR EACH ROW SET @x = 1 */;;',
      ].join('\n');
      const sqlBefore = tools.calls.sql.length;
      const ok = await upload(dump);
      expect(ok.status).toBe(200);
      expect(ok.body.safety_backup_id).toBe('20261003T000000Z-safe0001');
      const imported = tools.calls.imports.at(-1) ?? '';
      expect(imported).toContain('INSERT INTO `user` VALUES (1),(2);');
      expect(imported).not.toMatch(/CREATE DATABASE|USE `mirza_old`|DEFINER/);
      // MirzaBot keeps the webhook secret in its database: FleetPanel's is written back.
      expect(tools.calls.sql.slice(sqlBefore).some((q) => q.startsWith('UPDATE setting SET webhook_secret'))).toBe(true);

      const notSql = await upload('hello world');
      expect(notSql.status).toBe(400);
      expect(notSql.body.error).toBe('not_a_dump');
    } finally {
      backups.create = realCreate;
    }
  });

  it('keeps backup settings Owner-only and sends encrypted backups to Telegram', async () => {
    const viewer = await login('viewer', 'Viewer-Password-1');
    expect((await request('GET', '/api/settings/backup', { headers: { cookie: viewer.cookie } })).status).toBe(403);

    const { cookie, csrf } = await login('owner', 'Owner-Password-1');
    const put = (body: unknown) => request('PUT', '/api/settings/backup', { headers: { cookie, 'x-csrf-token': csrf }, body });
    const base = { enabled: true, chat_id: '-1001234567890', schedule: 'daily', bot_token: TOKEN };
    expect((await put(base)).body.error).toBe('passphrase_required');
    expect((await put({ ...base, passphrase: 'short' })).body.error).toBe('weak_passphrase');
    expect((await put({ ...base, chat_id: '1; DROP' })).status).toBe(400);

    const saved = await put({ ...base, passphrase: 'correct horse battery staple' });
    expect(saved.status).toBe(200);
    expect(saved.body.backup).toMatchObject({ enabled: true, has_token: true, has_passphrase: true, schedule: 'daily' });
    expect(JSON.stringify(saved.body)).not.toContain(TOKEN);

    expect((await request('POST', '/api/settings/backup/test', { headers: { cookie, 'x-csrf-token': csrf } })).status).toBe(200);
    expect(sentMessages.at(-1)).toContain('test-host');

    // The real archive needs tar and the SQLite backup API; a stand-in keeps this platform-independent.
    const realCreate = controlBackup.create.bind(controlBackup);
    if (process.platform === 'win32') {
      controlBackup.create = async () => ({ name: 'fleetpanel-test-host-x.fleet', data: Buffer.from('stub'), instances: 0 });
    }
    try {
      const run = await request('POST', '/api/settings/backup/run', { headers: { cookie, 'x-csrf-token': csrf } });
      expect(run.status).toBe(200);
      const doc = sentDocuments.at(-1);
      expect(doc?.name).toMatch(/^fleetpanel-test-host-.*\.fleet$/);
      if (process.platform !== 'win32' && doc) {
        expect(() => openBackup(doc.data, 'wrong passphrase!!')).toThrow(/Wrong recovery passphrase/);
        const { plain } = openBackup(doc.data, 'correct horse battery staple');
        expect(plain.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
      }
      const view = (await request('GET', '/api/settings/backup', { headers: { cookie } })).body.backup;
      expect(view.last_error).toBeNull();
      expect(view.last_file).toBe(doc?.name);

      // Scheduler: nothing to do right after a send; once the interval passes an unchanged panel is skipped.
      expect(await controlBackup.tick()).toBe('idle');
      expect(await controlBackup.tick(Date.now() + 25 * 3_600_000)).toBe('sent');
    } finally {
      controlBackup.create = realCreate;
    }
  });

  it('updates an outdated bot to the reviewed version, keeping its data', async () => {
    const { cookie, csrf } = await login('owner', 'Owner-Password-1');
    const headers = { cookie, 'x-csrf-token': csrf };
    const list = (await request('GET', '/api/instances', { headers: { cookie } })).body.instances as Array<{ id: number; slug: string }>;
    const bot = list.find((i) => i.slug === 'demo-bot');
    expect(bot).toBeTruthy();
    const id = bot?.id as number;

    // Already on the pinned version: nothing to do.
    expect((await request('POST', `/api/instances/${id}/upgrade`, { headers })).body.error).toBe('up_to_date');

    // A failure before the bot is touched (here: the safety backup) leaves it running.
    db.prepare('UPDATE instances SET source_commit = ? WHERE id = ?').run('a'.repeat(40), id);
    const failing = backups.create.bind(backups);
    backups.create = async () => {
      throw new Error('mysqldump failed: disk full');
    };
    try {
      await request('POST', `/api/instances/${id}/upgrade`, { headers });
      let early = (await request('GET', `/api/instances/${id}`, { headers: { cookie } })).body.instance;
      for (let i = 0; i < 50 && early.status === 'provisioning'; i++) {
        await new Promise((r) => setTimeout(r, 20));
        early = (await request('GET', `/api/instances/${id}`, { headers: { cookie } })).body.instance;
      }
      expect(early.status).toBe('running');
      expect(early.last_error).toMatch(/^Update not applied \(the bot was not changed\): Taking a safety backup: mysqldump failed: disk full/);
      expect(early.source_commit).toBe('a'.repeat(40));
    } finally {
      backups.create = failing;
    }

    // Pretend it was installed from an older pin, with data of its own and a file the upstream later removed.
    db.prepare('UPDATE instances SET source_commit = ? WHERE id = ?').run('a'.repeat(40), id);
    const dir = path.join(tmp, 'instances', 'demo-bot');
    fs.mkdirSync(path.join(dir, 'storage'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'storage', 'receipt.jpg'), 'customer data');
    fs.mkdirSync(path.join(dir, 'old'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'old', 'legacy.php'), '<?php // removed upstream');

    const realCreate = backups.create.bind(backups);
    backups.create = async () => ({ id: '20261005T000000Z-upgr0001' }) as Awaited<ReturnType<BackupService['create']>>;
    try {
      const res = await request('POST', `/api/instances/${id}/upgrade`, { headers });
      expect(res.status).toBe(202);
      expect(res.body.instance.status).toBe('provisioning');
      let inst = res.body.instance;
      for (let i = 0; i < 100 && inst.status === 'provisioning'; i++) {
        await new Promise((r) => setTimeout(r, 20));
        inst = (await request('GET', `/api/instances/${id}`, { headers: { cookie } })).body.instance;
      }
      expect(inst.last_error).toBeNull();
      expect(inst.status).toBe('running');
      expect(inst.source_commit).toBe(PROVIDERS.mirza.commit);

      expect(fs.readFileSync(path.join(dir, 'storage', 'receipt.jpg'), 'utf8')).toBe('customer data');
      expect(fs.existsSync(path.join(dir, 'old', 'legacy.php'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'install'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'config.php'), 'utf8')).toContain(`$APIKEY = '${TOKEN}';`);
      // The staging copy is gone.
      expect(fs.readdirSync(path.join(tmp, 'instances')).filter((n) => n.startsWith('.upgrade-'))).toEqual([]);
      const steps = tools.calls.service.filter((c) => c.startsWith('demo-bot:'));
      expect(steps.slice(-2)).toEqual(['demo-bot:upgrade-sync', 'demo-bot:cron:cronbot/run.php']);
    } finally {
      backups.create = realCreate;
    }
  });

  it('keeps stopped bots stopped through an update and schedules cron jobs when a PHP bot starts', async () => {
    const { cookie, csrf } = await login('owner', 'Owner-Password-1');
    const headers = { cookie, 'x-csrf-token': csrf };
    const list = (await request('GET', '/api/instances', { headers: { cookie } })).body.instances as Array<{ id: number; slug: string }>;
    const id = list.find((i) => i.slug === 'demo-bot')?.id as number;
    const wait = async () => {
      let inst = (await request('GET', `/api/instances/${id}`, { headers: { cookie } })).body.instance;
      for (let i = 0; i < 100 && inst.status === 'provisioning'; i++) {
        await new Promise((r) => setTimeout(r, 20));
        inst = (await request('GET', `/api/instances/${id}`, { headers: { cookie } })).body.instance;
      }
      return inst;
    };
    expect((await request('POST', `/api/instances/${id}/stop`, { headers })).status).toBe(200);

    // Installed before versions were recorded (null) counts as outdated; the old commit cannot be
    // compared (gone upstream), which must not block the update.
    db.prepare('UPDATE instances SET source_commit = NULL WHERE id = ?').run(id);
    removedFilesFails = true;
    const realCreate = backups.create.bind(backups);
    backups.create = async () => ({ id: '20261005T000000Z-upgr0002' }) as Awaited<ReturnType<BackupService['create']>>;
    const cronBefore = tools.calls.service.filter((c) => c === 'demo-bot:cron:cronbot/run.php').length;
    try {
      expect((await request('POST', `/api/instances/${id}/upgrade`, { headers })).status).toBe(202);
      const inst = await wait();
      expect(inst.last_error).toBeNull();
      expect(inst.status).toBe('stopped');
      expect(inst.source_commit).toBe(PROVIDERS.mirza.commit);
      // A stopped bot's cron timer is not started by the update...
      expect(tools.calls.service.filter((c) => c === 'demo-bot:cron:cronbot/run.php').length).toBe(cronBefore);
    } finally {
      backups.create = realCreate;
      removedFilesFails = false;
    }
    // ...but when the bot is started.
    expect((await request('POST', `/api/instances/${id}/start`, { headers })).status).toBe(200);
    expect(tools.calls.service.filter((c) => c === 'demo-bot:cron:cronbot/run.php').length).toBe(cronBefore + 1);
  });

  it('reports real host stats and providers', async () => {
    const { cookie } = await login('viewer', 'Viewer-Password-1');
    const sys = await request('GET', '/api/system', { headers: { cookie } });
    expect(sys.status).toBe(200);
    expect(sys.body.memory.total_bytes).toBeGreaterThan(0);
    expect(sys.body.instances.running).toBeGreaterThanOrEqual(1);
    const providers = await request('GET', '/api/system/providers', { headers: { cookie } });
    expect(providers.body.providers.map((p: { id: string }) => p.id)).toEqual(['mirza', 'faoxima', 'pasarguard', 'pgclock']);
    expect(providers.body.providers[2]).toMatchObject({ runtime: 'python', extra_fields: ['api_id', 'api_hash'], web_path: 'webapp/', database: 'mysql', web_login: false });
    expect(providers.body.providers[3]).toMatchObject({ runtime: 'python', extra_fields: [], database: 'postgres', web_login: true });
    // The panel links to the bots' own pages, never a PHP bot's webhook at the site root.
    expect(providers.body.providers.map((p: { web_path: string }) => p.web_path)).toEqual(['panel/', 'panel/', 'webapp/', '']);
    for (const p of providers.body.providers as Array<{ commit: string; version: string }>) {
      expect(p.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(p.version).toBeTruthy();
    }
    expect((await request('GET', '/api/system')).status).toBe(401);
  });
});
