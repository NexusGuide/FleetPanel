import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.js';

export interface DbCredentials {
  dbName: string;
  dbUser: string;
  password: string;
}

/** Unprivileged commands provisioning runs as the fleetpanel user (no root needed). */
export interface Toolchain {
  /** `composer install` for projects that do not ship vendor/. */
  composerInstall(dir: string): Promise<void>;
  /** Runs a PHP script with the CLI, from inside the instance directory. */
  runPhp(dir: string, script: string): Promise<void>;
  /** Runs SQL as the instance's own database user and returns tab-separated output without headers. */
  sql(db: DbCredentials, sql: string): Promise<string>;
}

/** Writes a throwaway my.cnf so the DB password never appears in argv. */
export async function withClientConfig<T>(db: Omit<DbCredentials, 'dbName'>, fn: (cnfPath: string) => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9]{1,128}$/.test(db.password)) throw new Error('unexpected characters in database password');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleetpanel-'));
  const cnf = path.join(dir, 'client.cnf');
  try {
    await fs.writeFile(cnf, `[client]\nuser=${db.dbUser}\npassword=${db.password}\nhost=localhost\n`, { mode: 0o600 });
    return await fn(cnf);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export const systemToolchain: Toolchain = {
  async composerInstall(dir) {
    // The service user's home is not writable, so Composer gets a private scratch home.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fleetpanel-composer-'));
    try {
      await run(
        'composer',
        ['install', '--no-dev', '--optimize-autoloader', '--prefer-dist', '--no-progress', '--no-interaction', `--working-dir=${dir}`],
        { timeoutMs: 900_000, env: { HOME: home, COMPOSER_HOME: home, COMPOSER_NO_INTERACTION: '1' } },
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  },

  async runPhp(dir, script) {
    await run('php', [script], { cwd: dir, timeoutMs: 300_000 });
  },

  async sql(db, sql) {
    const { stdout } = await withClientConfig(db, (cnf) =>
      run('mysql', [`--defaults-extra-file=${cnf}`, '--batch', '--skip-column-names', db.dbName], { input: sql, timeoutMs: 120_000 }),
    );
    return stdout;
  },
};
