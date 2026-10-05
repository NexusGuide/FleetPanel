import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DbEngine } from '../providers/index.js';
import { run } from './exec.js';

export interface DbCredentials {
  /** Defaults to mysql (MariaDB). */
  engine?: DbEngine;
  dbName: string;
  dbUser: string;
  password: string;
}

/** SQL the control plane runs against an instance's own database. */
export interface Toolchain {
  /** Runs SQL as the instance's own database user and returns tab-separated output without headers. */
  sql(db: DbCredentials, sql: string): Promise<string>;
  /**
   * Imports a dump file into the instance's database as its own database user: a sanitized SQL dump
   * (MariaDB), or a pg_dump custom-format archive (PostgreSQL, replaces the whole schema).
   */
  importDump(db: DbCredentials, file: string): Promise<void>;
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

/**
 * libpq connection for the PostgreSQL tools: TCP on loopback (the database role is not a Linux user,
 * so no peer authentication) and the password in the environment, never in argv.
 */
function pgConnection(db: DbCredentials): { args: string[]; env: Record<string, string> } {
  if (!/^[A-Za-z0-9]{1,128}$/.test(db.password)) throw new Error('unexpected characters in database password');
  if (!/^fp_[a-z0-9_]{3,29}$/.test(db.dbName) || !/^fp_[a-z0-9_]{3,29}$/.test(db.dbUser)) throw new Error('invalid database identifier');
  return {
    args: ['--host=127.0.0.1', '--port=5432', `--username=${db.dbUser}`, '--no-password'],
    env: { PGPASSWORD: db.password, PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'fleetpanel' },
  };
}

/** Custom-format dump of a bot's PostgreSQL database (objects owned by whoever restores it). */
export async function pgDump(db: DbCredentials, file: string): Promise<void> {
  const conn = pgConnection(db);
  await run('pg_dump', [...conn.args, '--format=custom', '--no-owner', '--no-acl', `--file=${file}`, db.dbName], {
    env: conn.env,
    timeoutMs: 900_000,
  });
}

/** True when the file starts like a pg_dump custom-format archive. */
export async function isPgCustomDump(file: string): Promise<boolean> {
  const handle = await fs.open(file, 'r');
  try {
    const magic = Buffer.alloc(5);
    await handle.read(magic, 0, 5, 0);
    return magic.toString('latin1') === 'PGDMP';
  } finally {
    await handle.close();
  }
}

/**
 * Replaces a bot's PostgreSQL schema with a custom-format dump. pg_restore talks to the server
 * directly, so unlike a plain SQL script fed to psql nothing in the file can run client-side
 * commands; everything runs with the bot's own (unprivileged) database role.
 */
export async function pgRestore(db: DbCredentials, file: string): Promise<void> {
  if (!(await isPgCustomDump(file))) throw new Error('not a pg_dump custom-format file');
  const conn = pgConnection(db);
  // Readable at all? Checked before the current data is dropped.
  await run('pg_restore', ['--list', file], { timeoutMs: 300_000 });
  // The role owns schema public (helper pg-create), so it can start from an empty one: tables a
  // newer version added must not survive a restore of an older backup.
  await run('psql', [...conn.args, '-X', '-q', '-v', 'ON_ERROR_STOP=1', `--dbname=${db.dbName}`, '-c', 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'], {
    env: conn.env,
    timeoutMs: 300_000,
  });
  await run('pg_restore', [...conn.args, '--no-owner', '--no-acl', '--single-transaction', '--exit-on-error', `--dbname=${db.dbName}`, file], {
    env: conn.env,
    timeoutMs: 3_600_000,
  });
}

export const systemToolchain: Toolchain = {
  async sql(db, sql) {
    if (db.engine === 'postgres') {
      const conn = pgConnection(db);
      const { stdout } = await run('psql', [...conn.args, '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', `--dbname=${db.dbName}`, '-c', sql], {
        env: conn.env,
        timeoutMs: 120_000,
      });
      return stdout;
    }
    const { stdout } = await withClientConfig(db, (cnf) =>
      run('mysql', [`--defaults-extra-file=${cnf}`, '--batch', '--skip-column-names', db.dbName], { input: sql, timeoutMs: 120_000 }),
    );
    return stdout;
  },
  async importDump(db, file) {
    if (db.engine === 'postgres') return pgRestore(db, file);
    await withClientConfig(db, (cnf) =>
      // --binary-mode turns off mysql client commands (\!, system, ...) in the input.
      run('mysql', [`--defaults-extra-file=${cnf}`, '--binary-mode', '--default-character-set=utf8mb4', db.dbName], {
        inputFile: file,
        timeoutMs: 3_600_000,
      }),
    );
  },
};
