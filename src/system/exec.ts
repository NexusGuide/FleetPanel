import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { maskSecrets } from '../security/mask.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  input?: string;
  /** Streams this file to stdin instead of `input` (large inputs such as database dumps). */
  inputFile?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

const BASE_ENV: Record<string, string> = {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8',
  HOME: process.env.HOME ?? '/tmp',
};

/**
 * Runs a program with an argument array. There is deliberately no shell variant:
 * nothing in FleetPanel ever builds a command line out of strings.
 */
export function run(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...BASE_ENV, ...opts.env },
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = maskSecrets(String(stderr || error.message))
            .trim()
            .split('\n')
            .slice(-5)
            .join(' | ');
          const exitCode = typeof error.code === 'number' ? error.code : null;
          reject(new CommandError(`${path.basename(cmd)} failed: ${detail}`, exitCode));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (opts.inputFile && child.stdin) {
      // The program may exit before reading everything (e.g. a SQL error); that is reported via its exit code.
      child.stdin.on('error', () => undefined);
      createReadStream(opts.inputFile).pipe(child.stdin);
    } else {
      child.stdin?.end(opts.input ?? '');
    }
  });
}
