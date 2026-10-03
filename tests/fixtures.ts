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
  if (url.includes('PasarguardBot')) {
    // A Python project: no config template or installer, an Alembic schema and a web app.
    fs.mkdirSync(path.join(dest, 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'main.py'), '');
    fs.writeFileSync(path.join(dest, 'pyproject.toml'), '');
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
    async writeEnv(slug: string, env: string): Promise<void> {
      calls.env[slug] = env;
    },
    async runTask(slug: string, task: string): Promise<void> {
      calls.service.push(`${slug}:${task}`);
    },
    async createService(slug: string, domain: string, port: number): Promise<void> {
      calls.service.push(`${slug}:service:${domain}:${port}`);
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
  /** Service-bot helper calls in order ("runtime", "slug:task", "slug:service:domain:port", ...). */
  service: string[];
  env: Record<string, string>;
}

export const newToolCalls = (): ToolCalls => ({ composer: [], php: [], sql: [], service: [], env: {} });

export function fakeToolchain(calls: ToolCalls = newToolCalls()): Toolchain & { calls: ToolCalls } {
  return {
    calls,
    async sql(_db, sql) {
      calls.sql.push(sql);
      return '1\n';
    },
  };
}
