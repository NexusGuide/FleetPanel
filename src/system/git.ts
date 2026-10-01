import { run } from './exec.js';

export async function gitClone(repoUrl: string, ref: string | undefined, dest: string): Promise<void> {
  const args = ['clone', '--quiet', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  args.push('--', repoUrl, dest);
  await run('git', args, { timeoutMs: 300_000, env: { GIT_TERMINAL_PROMPT: '0' } });
}
