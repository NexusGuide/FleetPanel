import { maskSecrets } from './security/mask.js';

type Level = 'info' | 'warn' | 'error';

function describe(extra: unknown): string {
  if (extra instanceof Error) return extra.message;
  if (typeof extra === 'string') return extra;
  try {
    return JSON.stringify(extra);
  } catch {
    return String(extra);
  }
}

// Structured JSON lines on stdout/stderr; systemd ships them to journald.
function write(level: Level, msg: string, extra?: unknown): void {
  const entry: Record<string, string> = { ts: new Date().toISOString(), level, msg: maskSecrets(msg) };
  if (extra !== undefined) entry.detail = maskSecrets(describe(extra));
  (level === 'error' ? process.stderr : process.stdout).write(`${JSON.stringify(entry)}\n`);
}

export const log = {
  info: (msg: string, extra?: unknown) => write('info', msg, extra),
  warn: (msg: string, extra?: unknown) => write('warn', msg, extra),
  error: (msg: string, extra?: unknown) => write('error', msg, extra),
};
