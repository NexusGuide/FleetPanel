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
import { assertSafeArchiveEntries } from '../src/services/backups.js';

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
    expect(instanceDir('/opt/fleetbot/instances', 'demo-bot')).toBe(path.resolve('/opt/fleetbot/instances/demo-bot'));
    expect(() => instanceDir('/opt/fleetbot/instances', '../x')).toThrow();
    expect(() => instanceDir('/opt/fleetbot/instances', 'a/b')).toThrow();
  });

  it('derives MySQL identifiers that fit the 32-char limit', () => {
    expect(dbIdentFor('demo-bot')).toBe('fb_demo_bot');
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
