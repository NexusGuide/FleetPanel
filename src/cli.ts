import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { openDb, type DB } from './db.js';
import { AuditLog } from './audit.js';
import { SecretStore } from './secrets.js';
import { SecretBox } from './security/crypto.js';
import { hashPassword, passwordPolicyErrors } from './security/passwords.js';
import { ROLES, isRole } from './security/rbac.js';
import { SLUG_RE, USERNAME_RE } from './security/validation.js';
import { BACKUP_ID_RE, BackupService } from './services/backups.js';
import { InstanceService, type InstanceRow } from './services/instances.js';
import { TelegramApi } from './services/telegram.js';
import { SudoHelper } from './system/helper.js';
import { gitCheckout, gitRemovedFiles } from './system/git.js';
import { systemToolchain } from './system/toolchain.js';
import { run } from './system/exec.js';
import { errorMessage } from './errors.js';
import { backupInfo, openBackup } from './security/fleetBackup.js';

// Run by bin/fleetpanel as the fleetpanel service user (never as root).
const USAGE = `Usage: node dist/cli.js <command>

  has-admins                         exit 0 if at least one administrator exists
  list-admins                        list administrators
  create-admin <username> [--role R] create an administrator (default role: Owner)
  reset-password <username>          set a new password and revoke all sessions
  list-instances [--tsv]             list bot instances
  list-backups [slug]                list instance backups
  backup-instance <slug>             back up one instance (files + database)
  restore-instance <backup-id>       restore an instance backup (a safety backup is taken first)
  backup-control-plane <dir>         archive the control-plane database and master key into <dir>
  delete-webhooks                    unregister every instance's Telegram webhook
  decrypt-backup <in.fleet> <out>    decrypt an encrypted backup (asks for the recovery passphrase)

Passwords are read from stdin (one line) or prompted for on a terminal.
`;

function fail(message: string, code = 1): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

async function readLineFromPipe(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (data: Buffer) => {
      for (const ch of data.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readNewPassword(): Promise<string> {
  let password: string;
  if (process.stdin.isTTY) {
    password = await promptHidden('New password: ');
    if ((await promptHidden('Confirm password: ')) !== password) fail('passwords do not match');
  } else {
    password = await readLineFromPipe();
  }
  const problems = passwordPolicyErrors(password);
  if (problems.length > 0) fail(problems.join(' '));
  return password;
}

function withDb<T>(fn: (db: DB) => T): T {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The same services the server uses, for commands that touch instances. */
function services(db: DB) {
  const audit = new AuditLog(db);
  const secrets = new SecretStore(db, SecretBox.fromFile(config.masterKeyFile));
  const ops = new SudoHelper(config.helperPath);
  const backups = new BackupService({
    db,
    audit,
    secrets,
    ops,
    instancesDir: config.instancesDir,
    backupsDir: config.backupsDir,
    retention: config.backupRetention,
  });
  const instances = new InstanceService({
    db,
    audit,
    secrets,
    ops,
    telegram: new TelegramApi(),
    backups,
    git: gitCheckout,
    gitRemovedFiles,
    tools: systemToolchain,
    instancesDir: config.instancesDir,
  });
  return { audit, secrets, backups, instances };
}

function listInstances(db: DB): InstanceRow[] {
  return db.prepare('SELECT * FROM instances ORDER BY slug').all() as InstanceRow[];
}

function formatSize(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'has-admins': {
      const count = withDb((db) => (db.prepare('SELECT COUNT(*) AS n FROM admins').get() as { n: number }).n);
      process.exit(count > 0 ? 0 : 1);
    }
    case 'list-admins': {
      const rows = withDb((db) => db.prepare('SELECT id, username, role, is_active, last_login FROM admins ORDER BY id').all());
      console.table(rows);
      return;
    }
    case 'create-admin': {
      const username = rest[0];
      if (!username || !USERNAME_RE.test(username)) fail(`invalid or missing username\n\n${USAGE}`, 2);
      const roleFlag = rest.indexOf('--role');
      const role = roleFlag >= 0 ? rest[roleFlag + 1] : 'Owner';
      if (!isRole(role)) fail(`role must be one of: ${ROLES.join(', ')}`, 2);
      const hash = await hashPassword(await readNewPassword());
      withDb((db) => {
        try {
          db.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, role);
        } catch (err) {
          if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') fail(`administrator '${username}' already exists`);
          throw err;
        }
        new AuditLog(db).write({ actor: 'cli', action: 'ADMIN_CREATE', resource: 'admin', resourceId: username, status: 'SUCCESS', metadata: { role } });
      });
      console.log(`Created ${role} '${username}'.`);
      return;
    }
    case 'reset-password': {
      const username = rest[0];
      if (!username) fail(`missing username\n\n${USAGE}`, 2);
      const hash = await hashPassword(await readNewPassword());
      withDb((db) => {
        const admin = db.prepare('SELECT id FROM admins WHERE username = ?').get(username) as { id: number } | undefined;
        if (!admin) fail(`administrator '${username}' not found`);
        db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, admin.id);
        db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(admin.id);
        new AuditLog(db).write({ actor: 'cli', action: 'PASSWORD_RESET', resource: 'admin', resourceId: admin.id, status: 'SUCCESS' });
      });
      console.log(`Password updated for '${username}'; all of their sessions were revoked.`);
      return;
    }
    case 'list-instances': {
      const rows = withDb(listInstances);
      if (rest.includes('--tsv')) {
        // slug, provider, domain, status, db_name, db_user (consumed by bin/fleetpanel)
        for (const r of rows) console.log([r.slug, r.provider, r.domain, r.status, r.db_name, r.db_user].join('\t'));
        return;
      }
      if (rows.length === 0) {
        console.log('No instances.');
        return;
      }
      console.table(
        rows.map((r) => ({
          slug: r.slug,
          provider: r.provider,
          domain: r.domain,
          bot: r.bot_username ? `@${r.bot_username}` : '',
          status: r.status,
          error: r.last_error ? r.last_error.slice(0, 60) : '',
        })),
      );
      return;
    }
    case 'list-backups': {
      const slug = rest[0];
      const rows = withDb((db) => {
        const all = services(db).backups.list();
        return slug ? all.filter((b) => b.slug === slug) : all;
      });
      if (rows.length === 0) {
        console.log('No instance backups.');
        return;
      }
      console.table(rows.map((b) => ({ id: b.id, slug: b.slug, kind: b.kind, size: formatSize(b.size_bytes), created: b.created_at })));
      return;
    }
    case 'backup-instance': {
      const slug = rest[0] ?? '';
      if (!SLUG_RE.test(slug)) fail('usage: backup-instance <slug>', 2);
      const db = openDb();
      try {
        const { instances } = services(db);
        const inst = listInstances(db).find((i) => i.slug === slug);
        if (!inst) fail(`instance '${slug}' not found`);
        const backup = await instances.backup(inst.id, 'cli');
        console.log(`Backup ${backup.id} (${formatSize(backup.size_bytes)}) -> ${path.join(config.backupsDir, backup.filename)}`);
      } finally {
        db.close();
      }
      return;
    }
    case 'restore-instance': {
      const id = rest[0] ?? '';
      if (!BACKUP_ID_RE.test(id)) fail('usage: restore-instance <backup-id> (see: fleetpanel backups)', 2);
      const db = openDb();
      try {
        const result = await services(db).instances.restore(id, 'cli');
        console.log(`Restored ${id}. A safety backup of the previous state was taken: ${result.safety_backup_id}`);
      } finally {
        db.close();
      }
      return;
    }
    case 'backup-control-plane': {
      const destDir = rest[0];
      if (!destDir) fail('usage: backup-control-plane <dir>', 2);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const dest = path.join(destDir, `control-plane-${stamp}.tar.gz`);
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetpanel-cp-'));
      const db = openDb();
      try {
        // The SQLite online backup API gives a consistent copy even while the panel is writing.
        await db.backup(path.join(work, 'fleetpanel.db'));
        fs.copyFileSync(config.masterKeyFile, path.join(work, 'master.key'));
        fs.writeFileSync(
          path.join(work, 'manifest.json'),
          JSON.stringify({ format: 1, kind: 'control-plane', created_at: new Date().toISOString() }, null, 2),
        );
        await run('tar', ['-czf', dest, '-C', work, 'fleetpanel.db', 'master.key', 'manifest.json']);
        fs.chmodSync(dest, 0o600);
        new AuditLog(db).write({ actor: 'cli', action: 'CONTROL_PLANE_BACKUP', resource: 'control-plane', resourceId: path.basename(dest), status: 'SUCCESS' });
      } finally {
        db.close();
        fs.rmSync(work, { recursive: true, force: true });
      }
      console.log(dest);
      return;
    }
    case 'delete-webhooks': {
      const db = openDb();
      try {
        const { secrets } = services(db);
        const telegram = new TelegramApi();
        for (const inst of listInstances(db)) {
          try {
            await telegram.deleteWebhook(secrets.get(inst.id, 'bot_token'));
            console.log(`${inst.slug}: webhook removed`);
          } catch (err) {
            console.log(`${inst.slug}: could not remove webhook (${errorMessage(err)})`);
          }
        }
      } finally {
        db.close();
      }
      return;
    }
    case 'decrypt-backup': {
      const [input, output] = rest;
      if (!input || !output) fail('usage: decrypt-backup <in.fleet> <out.tar.gz>', 2);
      const file = fs.readFileSync(input);
      const info = backupInfo(file);
      process.stderr.write(`Backup of ${info.host}, FleetPanel v${info.version}, created ${info.created_at}\n`);
      const passphrase = process.stdin.isTTY ? await promptHidden('Recovery passphrase: ') : await readLineFromPipe();
      const { plain } = openBackup(file, passphrase);
      fs.writeFileSync(output, plain, { mode: 0o600 });
      return;
    }
    default:
      process.stdout.write(USAGE);
      process.exit(command ? 2 : 0);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => fail(errorMessage(err)));
