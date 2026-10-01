import { openDb, type DB } from './db.js';
import { AuditLog } from './audit.js';
import { hashPassword, passwordPolicyErrors } from './security/passwords.js';
import { ROLES, isRole } from './security/rbac.js';
import { USERNAME_RE } from './security/validation.js';

const USAGE = `Usage: node dist/cli.js <command>

  has-admins                         exit 0 if at least one administrator exists
  list-admins                        list administrators
  create-admin <username> [--role R] create an administrator (default role: Owner)
  reset-password <username>          set a new password and revoke all sessions

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
    default:
      process.stdout.write(USAGE);
      process.exit(command ? 2 : 0);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
