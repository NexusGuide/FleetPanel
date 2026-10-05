import fs from 'node:fs';
import path from 'node:path';
import type { Toolchain } from '../src/system/toolchain.js';

// Minimal stand-ins for each upstream repository: the same config template shape,
// a composer.json without vendor/, and the web installer directory.
export const MIRZA_CONFIG = `<?php
$request_exec_timeout = null;
$dbhost = '{database_url}';
$dbname = '{database_name}';
$usernamedb = '{username_db}';
$passworddb = '{password_db}';
$dsn = "mysql:host=$dbhost;dbname=$dbname;charset=utf8mb4";
$APIKEY = '{API_KEY}';
$adminnumber = '{admin_number}';
$domainhosts = '{domain_name}';
$usernamebot = '{username_bot}';
`;

export const FAOXIMA_CONFIG = `<?php

if (!defined('_FX_SHARD')) {
    define('_FX_SHARD','b08d416dac363b09');
}

$dbname     = '';
$usernamedb = '';
$passworddb = '';
$dbhost     = '';

$APIKEY                     = '';
$adminnumber                = '';
$domainhosts                = '';
$usernamebot                = '';
$domainhosts                = rtrim(preg_replace('#^https?://#', '', $domainhosts), '/');
`;

export const clonedCommits: string[] = [];

export async function fakeClone(url: string, commit: string, dest: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`invalid pinned commit '${commit}'`);
  clonedCommits.push(commit);
  if (url.includes('PGClockBot')) {
    // A Python project with only version ranges (requirements.txt) and run.py as its entry point.
    fs.mkdirSync(path.join(dest, 'app'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'run.py'), 'from app.main import main\n');
    fs.writeFileSync(path.join(dest, 'requirements.txt'), 'aiogram>=3.15,<4\n');
    fs.writeFileSync(path.join(dest, 'alembic.ini'), '[alembic]\n');
    return;
  }
  if (url.includes('PasarguardBot')) {
    // A Python project: no config template or installer, an Alembic schema and a web app.
    fs.mkdirSync(path.join(dest, 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'main.py'), '');
    fs.writeFileSync(path.join(dest, 'pyproject.toml'), '[project]\nversion = "2.1.4"\n');
    fs.writeFileSync(path.join(dest, 'uv.lock'), '');
    return;
  }
  const faoxima = url.includes('Faoxima');
  fs.mkdirSync(path.join(dest, faoxima ? 'installer' : 'install'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'config.php'), faoxima ? FAOXIMA_CONFIG : MIRZA_CONFIG);
  fs.writeFileSync(path.join(dest, 'composer.json'), '{}');
  fs.writeFileSync(path.join(dest, 'table.php'), '<?php');
  if (faoxima) {
    // Faoxima ships vendor/ in the repository.
    fs.mkdirSync(path.join(dest, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'vendor', 'autoload.php'), '<?php');
  }
}

/** Stand-ins for the helper's instance-run commands (Composer and PHP run as the bot's user). */
export function fakeRunner(calls: ToolCalls, instancesDir: () => string) {
  return {
    async runComposer(slug: string): Promise<void> {
      const dir = path.join(instancesDir(), slug);
      calls.composer.push(dir);
      fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'vendor', 'autoload.php'), '<?php');
    },
    async runPhp(slug: string, script: string): Promise<void> {
      calls.php.push(path.join(instancesDir(), slug, script));
    },
    async prepareRuntime(): Promise<void> {
      calls.service.push('runtime');
    },
    async preparePostgres(): Promise<void> {
      calls.service.push('postgres');
    },
    /** Same effect as the helper's instance-upgrade-sync (which runs as the bot's user). */
    async upgradeSync(slug: string, staging: string, removed: string[]): Promise<void> {
      calls.service.push(`${slug}:upgrade-sync`);
      const dir = path.join(instancesDir(), slug);
      for (const rel of removed) fs.rmSync(path.join(dir, rel), { force: true });
      fs.cpSync(staging, dir, { recursive: true });
    },
    async refreshInstance(slug: string, cronScript: string): Promise<void> {
      calls.service.push(`${slug}:cron:${cronScript}`);
    },
    async writeEnv(slug: string, env: string): Promise<void> {
      calls.env[slug] = env;
    },
    async runTask(slug: string, task: string, arg?: string): Promise<void> {
      calls.service.push(arg === undefined ? `${slug}:${task}` : `${slug}:${task}:${arg}`);
    },
    async createService(slug: string, domain: string, port: number, entry: string, redis: boolean): Promise<void> {
      calls.service.push(`${slug}:service:${domain}:${port}:${entry}:${redis ? 'redis' : 'no-redis'}`);
    },
    async waitForService(slug: string, port: number): Promise<void> {
      calls.service.push(`${slug}:wait:${port}`);
    },
  };
}

export interface ToolCalls {
  composer: string[];
  php: string[];
  sql: string[];
  /** Database engine of each sql() call, in order. */
  sqlEngines: string[];
  /** Service-bot helper calls in order ("runtime", "slug:task", "slug:service:domain:port", ...). */
  service: string[];
  env: Record<string, string>;
  /** Contents of each imported (sanitized) dump, prefixed with the engine ("postgres:..."). */
  imports: string[];
}

export const newToolCalls = (): ToolCalls => ({ composer: [], php: [], sql: [], sqlEngines: [], service: [], env: {}, imports: [] });

export function fakeToolchain(calls: ToolCalls = newToolCalls()): Toolchain & { calls: ToolCalls } {
  return {
    calls,
    async sql(db, sql) {
      calls.sql.push(sql);
      calls.sqlEngines.push(db.engine ?? 'mysql');
      return '1\n';
    },
    async importDump(db, file) {
      const text = fs.readFileSync(file, 'utf8');
      calls.imports.push(db.engine === 'postgres' ? `postgres:${text}` : text);
    },
  };
}
