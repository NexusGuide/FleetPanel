import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.js';

export interface DbCredentials {
  dbName: string;
  dbUser: string;
  password: string;
}

/** SQL the control plane runs against an instance's own database. */
export interface Toolchain {
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
  async sql(db, sql) {
    const { stdout } = await withClientConfig(db, (cnf) =>
      run('mysql', [`--defaults-extra-file=${cnf}`, '--batch', '--skip-column-names', db.dbName], { input: sql, timeoutMs: 120_000 }),
    );
    return stdout;
  },
};
