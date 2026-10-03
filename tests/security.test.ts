import crypto from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretBox, generatePassword, safeEqual } from '../src/security/crypto.js';
import { phpString } from '../src/security/php.js';
import { createInstanceSchema } from '../src/security/validation.js';
import { can, permissionsFor } from '../src/security/rbac.js';
import { maskSecrets } from '../src/security/mask.js';
import { passwordPolicyErrors } from '../src/security/passwords.js';
import { dbIdentFor, instanceDir } from '../src/services/instances.js';
import { assertSafeArchiveEntries, assertSafeArchiveLinks, assertSafeSqlDump, backupExcludes } from '../src/services/backups.js';
import { clientKey } from '../src/http/rateLimit.js';
import { gitCheckout } from '../src/system/git.js';
import { PROVIDERS, PROVIDER_IDS } from '../src/providers/index.js';
import type { Request } from 'express';
import { openDb } from '../src/db.js';
import { AuditLog } from '../src/audit.js';
import { backupInfo, createRecipient, openBackup, sealBackup } from '../src/security/fleetBackup.js';

const TOKEN = `123456789:${'A'.repeat(35)}`;
const valid = { slug: 'demo-bot', provider: 'mirza', domain: 'bot.example.com', bot_token: TOKEN, admin_telegram_id: '42' };

describe('SecretBox', () => {
  const box = SecretBox.fromKey(crypto.randomBytes(32));

  it('round-trips', () => {
    expect(box.decrypt(box.encrypt('s3cret', 'a'), 'a')).toBe('s3cret');
  });

  it('rejects a ciphertext moved to another record (AAD mismatch)', () => {
    expect(() => box.decrypt(box.encrypt('s3cret', 'instance:1:bot_token'), 'instance:2:bot_token')).toThrow();
  });

  it('rejects tampered ciphertext instead of returning it', () => {
    const ct = box.encrypt('s3cret', 'a');
    const raw = Buffer.from(ct.slice(3), 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => box.decrypt(`v1:${raw.toString('base64')}`, 'a')).toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(() => SecretBox.fromKey(Buffer.alloc(16))).toThrow();
  });
});

describe('phpString', () => {
  it('cannot be broken out of', () => {
    expect(phpString("x'; system('id'); //")).toBe("'x\\'; system(\\'id\\'); //'");
  });

  it('escapes backslashes before quotes', () => {
    expect(phpString('a\\')).toBe("'a\\\\'");
    expect(phpString("\\'")).toBe("'\\\\\\''");
  });

  it('rejects control characters', () => {
    expect(() => phpString('a\nb')).toThrow();
    expect(() => phpString('a\u0000b')).toThrow();
    expect(() => phpString('a\u007fb')).toThrow();
  });

  it('accepts hyphenated domains and slugs', () => {
    expect(phpString('shop-bot.example.com')).toBe("'shop-bot.example.com'");
  });
});

describe('createInstanceSchema', () => {
  it('accepts a valid request and normalises the domain', () => {
    const parsed = createInstanceSchema.parse({ ...valid, domain: ' Bot.Example.COM ' });
    expect(parsed.domain).toBe('bot.example.com');
  });

  it.each([
    ['nginx injection in domain', { domain: 'a.com; include /etc/passwd' }],
    ['newline in domain', { domain: 'a.com\nserver_name x' }],
    ['path traversal slug', { slug: '../etc' }],
    ['uppercase slug', { slug: 'Demo' }],
    ['PHP injection in token', { bot_token: "1:abc'; system('id'); //" }],
    ['non-numeric admin id', { admin_telegram_id: "1' OR '1" }],
    ['unknown provider', { provider: 'evil' }],
    ['unknown field', { extra: true }],
  ])('rejects %s', (_label, patch) => {
    expect(createInstanceSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe('paths and identifiers', () => {
  it('keeps instance directories inside the instances root', () => {
    expect(instanceDir('/opt/fleetpanel/instances', 'demo-bot')).toBe(path.resolve('/opt/fleetpanel/instances/demo-bot'));
    expect(() => instanceDir('/opt/fleetpanel/instances', '../x')).toThrow();
    expect(() => instanceDir('/opt/fleetpanel/instances', 'a/b')).toThrow();
  });

  it('derives MySQL identifiers that fit the 32-char limit', () => {
    expect(dbIdentFor('demo-bot')).toBe('fp_demo_bot');
    expect(dbIdentFor(`a${'b'.repeat(28)}`).length).toBeLessThanOrEqual(32);
  });

  it('rejects unexpected archive entries', () => {
    expect(() => assertSafeArchiveEntries(['demo/', 'demo/index.php', 'database.sql', 'manifest.json'], 'demo')).not.toThrow();
    expect(() => assertSafeArchiveEntries(['../etc/passwd'], 'demo')).toThrow();
    expect(() => assertSafeArchiveEntries(['/etc/passwd'], 'demo')).toThrow();
    expect(() => assertSafeArchiveEntries(['other/index.php'], 'demo')).toThrow();
  });
});

describe('RBAC', () => {
  it('enforces the role matrix', () => {
    expect(can('Viewer', 'instances.create')).toBe(false);
    expect(can('Support', 'instances.control')).toBe(true);
    expect(can('Support', 'instances.delete')).toBe(false);
    expect(can('Admin', 'admins.manage')).toBe(false);
    expect(can('Owner', 'admins.manage')).toBe(true);
    // Backup destination and recovery key decide where copies of the master key go: Owner only.
    expect(can('Admin', 'settings.manage')).toBe(false);
    expect(can('Owner', 'settings.manage')).toBe(true);
    expect(permissionsFor('Viewer')).toEqual(['instances.read', 'backups.read']);
  });
});

describe('misc', () => {
  it('masks bot tokens and passwords', () => {
    const masked = maskSecrets(`token ${TOKEN} password=hunter2`);
    expect(masked).not.toContain('AAAA');
    expect(masked).not.toContain('hunter2');
  });

  it('generates alphanumeric passwords', () => {
    expect(generatePassword(32)).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  it('compares in constant time and handles length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('enforces password policy', () => {
    expect(passwordPolicyErrors('short')).not.toHaveLength(0);
    expect(passwordPolicyErrors('Correct-Horse-Battery-9')).toHaveLength(0);
  });
});

describe('restore hardening', () => {
  it('refuses mysql client commands smuggled into a dump (e.g. via a table name)', () => {
    const header = '/*M!999999\- enable the sandbox mode */\n-- MariaDB dump\nCREATE TABLE `t` (`id` int);\n';
    expect(() => assertSafeSqlDump(`${header}INSERT INTO \`t\` VALUES (1);\n`)).not.toThrow();
    expect(() => assertSafeSqlDump(`${header}-- Table structure for table \`x\n\\! id\n`)).toThrow(/client command on line 5/);
    expect(() => assertSafeSqlDump(`${header}  system touch /tmp/pwned\n`)).toThrow();
  });

  it('refuses archive links that leave the instance directory', () => {
    const ok = ['drwxr-x--- u/g 0 2026-10-01 12:00 demo/', 'lrwxrwxrwx u/g 0 2026-10-01 12:00 demo/latest -> img/a.png'];
    expect(() => assertSafeArchiveLinks(ok, 'demo')).not.toThrow();
    expect(() => assertSafeArchiveLinks(['lrwxrwxrwx u/g 0 2026-10-01 12:00 demo/x -> /etc/passwd'], 'demo')).toThrow();
    expect(() => assertSafeArchiveLinks(['lrwxrwxrwx u/g 0 2026-10-01 12:00 demo/x -> ../other/config.php'], 'demo')).toThrow();
    expect(() => assertSafeArchiveLinks(['hrw-r--r-- u/g 0 2026-10-01 12:00 demo/b link to other/a'], 'demo')).toThrow();
    expect(() => assertSafeArchiveLinks(['crw-r--r-- u/g 1,3 2026-10-01 12:00 demo/null'], 'demo')).toThrow();
  });
});

describe('upstream pinning', () => {
  it('pins every provider to a full commit id', () => {
    for (const id of PROVIDER_IDS) expect(PROVIDERS[id].commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each([['a branch', 'main'], ['a tag', 'v1.1.5'], ['a short id', '8ae4bd6'], ['an option', '--upload-pack=x']])(
    'refuses to check out %s',
    async (_label, ref) => {
      await expect(gitCheckout('https://example.invalid/x.git', ref, '/nonexistent')).rejects.toThrow(/invalid pinned commit/);
    },
  );
});

describe('service bots', () => {
  it('requires and validates the Telegram API credentials', () => {
    const pasar = { ...valid, provider: 'pasarguard' };
    expect(createInstanceSchema.safeParse(pasar).success).toBe(false);
    expect(createInstanceSchema.safeParse({ ...pasar, api_id: '12345', api_hash: 'a'.repeat(32) }).success).toBe(true);
    expect(createInstanceSchema.safeParse({ ...pasar, api_id: '1; id', api_hash: 'a'.repeat(32) }).success).toBe(false);
    expect(createInstanceSchema.safeParse({ ...pasar, api_id: '12345', api_hash: `${'a'.repeat(31)}$` }).success).toBe(false);
  });

  it('masks database URL passwords and API hashes in errors', () => {
    const text = 'connect mysql+asyncmy://fp_demo:S3cretPass@localhost/fp_demo failed; API_HASH=0123456789abcdef0123456789abcdef';
    expect(maskSecrets(text)).not.toContain('S3cretPass');
    expect(maskSecrets(text)).not.toContain('0123456789abcdef0123456789abcdef');
  });

  it('keeps virtualenvs and package caches out of backups', () => {
    expect(backupExcludes('demo')).toEqual([
      '--exclude=demo/.venv',
      '--exclude=demo/.cache',
      '--exclude=demo/frontend/node_modules',
      '--exclude=demo/data/redis/redis.sock',
    ]);
  });
});

describe('encrypted backups (.fleet)', () => {
  const recipient = createRecipient('correct horse battery staple');
  const meta = { created_at: '2026-10-03T00:00:00.000Z', host: 'vps-1', version: '0.4.0' };
  const plain = Buffer.from('control-plane archive bytes');

  it('round-trips with the passphrase and nothing else', () => {
    const file = sealBackup(plain, recipient, meta);
    expect(file.includes(plain)).toBe(false);
    expect(backupInfo(file)).toEqual(meta);
    expect(openBackup(file, 'correct horse battery staple').plain.equals(plain)).toBe(true);
  });

  it('refuses a wrong passphrase, tampering and weak passphrases', () => {
    const file = sealBackup(plain, recipient, meta);
    expect(() => openBackup(file, 'correct horse battery stapler')).toThrow(/Wrong recovery passphrase/);
    const tampered = Buffer.from(file);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => openBackup(tampered, 'correct horse battery staple')).toThrow(/damaged or was modified/);
    // The header (host, version, keys) is authenticated too.
    const relabeled = Buffer.from(file.toString('latin1').replace('vps-1', 'vps-2'), 'latin1');
    expect(() => openBackup(relabeled, 'correct horse battery staple')).toThrow();
    expect(() => createRecipient('short')).toThrow();
    expect(() => openBackup(Buffer.from('not a backup'), 'x')).toThrow(/Not a FleetPanel backup/);
  });
});

describe('audit log', () => {
  it('masks secrets in metadata and still lists entries whose masked JSON is no longer valid', () => {
    const audit = new AuditLog(openDb(':memory:'));
    audit.write({ actor: 'cli', action: 'TEST', resource: 'x', status: 'SUCCESS', metadata: { api_hash: '0123456789abcdef0123456789abcdef' } });
    const [entry] = audit.list(10);
    expect(JSON.stringify(entry?.metadata)).not.toContain('0123456789abcdef');
  });
});

describe('rate-limit client keys', () => {
  const key = (ip: string) => clientKey({ ip } as Request);

  it('groups an IPv6 /64 so rotating addresses does not reset limits', () => {
    expect(key('2001:db8:1:2:aaaa::1')).toBe(key('2001:db8:1:2:ffff:1:2:3'));
    expect(key('2001:db8:1:2::5')).toBe('2001:db8:1:2::/64');
    expect(key('2001:db8:1:3::5')).not.toBe(key('2001:db8:1:2::5'));
    expect(key('::1')).toBe('0:0:0:0::/64');
  });

  it('keeps IPv4 addresses (also when IPv4-mapped) as they are', () => {
    expect(key('203.0.113.7')).toBe('203.0.113.7');
    expect(key('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });
});
