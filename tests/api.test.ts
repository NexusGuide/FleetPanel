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
import { InstanceService } from '../src/services/instances.js';
import type { PrivilegedOps } from '../src/system/helper.js';
import type { TelegramClient } from '../src/services/telegram.js';

const noop = async (): Promise<void> => undefined;
const ops: PrivilegedOps = {
  createDatabase: noop,
  dropDatabase: noop,
  fixPermissions: noop,
  createInstance: noop,
  issueCertificate: noop,
  enableInstance: noop,
  disableInstance: noop,
  removeInstance: noop,
};
const telegram: TelegramClient = {
  getMe: async () => ({ id: 1, username: 'demo_bot' }),
  setWebhook: noop,
  deleteWebhook: noop,
};

const TOKEN = `123456789:${'A'.repeat(35)}`;
let server: http.Server;
let base = '';
let tmp = '';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
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

async function login(username: string, password: string): Promise<{ cookie: string; token: string; csrf: string }> {
  const res = await request('POST', '/api/auth/login', { body: { username, password } });
  expect(res.status).toBe(200);
  const setCookie = res.headers['set-cookie']?.[0] ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  return { cookie, token: cookie.split('=')[1] ?? '', csrf: res.body.csrf_token as string };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetbot-test-'));
  const instancesDir = path.join(tmp, 'instances');
  const backupsDir = path.join(tmp, 'backups');
  fs.mkdirSync(instancesDir);
  fs.mkdirSync(backupsDir);

  const db = openDb(':memory:');
  const insert = db.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)');
  insert.run('owner', await hashPassword('Owner-Password-1'), 'Owner');
  insert.run('viewer', await hashPassword('Viewer-Password-1'), 'Viewer');

  const audit = new AuditLog(db);
  const secrets = new SecretStore(db, SecretBox.fromKey(crypto.randomBytes(32)));
  const backups = new BackupService({ db, audit, secrets, ops, instancesDir, backupsDir, retention: 3 });
  const instances = new InstanceService({
    db,
    audit,
    secrets,
    ops,
    telegram,
    backups,
    instancesDir,
    git: async (_url, _ref, dest) => {
      fs.mkdirSync(dest, { recursive: true });
    },
  });
  const app = createApp({ db, sessions: new SessionStore(db), audit, instances, backups, cookieSecure: false, trustProxy: false });
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

    const config = fs.readFileSync(path.join(tmp, 'instances', 'demo-bot', 'config.php'), 'utf8');
    expect(config).toContain(`$APIKEY = '${TOKEN}';`);
    expect(config).toContain("$adminnumber = '42';");

    const duplicate = await request('POST', '/api/instances', {
      headers: { cookie, 'x-csrf-token': csrf },
      body: { slug: 'demo-bot', provider: 'mirza', domain: 'other.example.com', bot_token: TOKEN, admin_telegram_id: '42' },
    });
    expect(duplicate.status).toBe(409);
  });
});
