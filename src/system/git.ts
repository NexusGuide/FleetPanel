import fs from 'node:fs/promises';
import { run } from './exec.js';

export const COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * Downloads exactly one commit of a repository and proves that is what was checked out.
 * Branches and tags can be moved by whoever controls the upstream repository; a commit id
 * cannot, so a compromised upstream cannot slip new code into an install or a repair.
 */
export async function gitCheckout(repoUrl: string, commit: string, dest: string): Promise<void> {
  if (!COMMIT_RE.test(commit)) throw new Error(`invalid pinned commit '${commit}'`);
  const env = { GIT_TERMINAL_PROMPT: '0' };
  const git = (args: string[], timeoutMs = 120_000) => run('git', ['-C', dest, ...args], { timeoutMs, env });
  await fs.mkdir(dest, { recursive: true });
  await git(['init', '--quiet']);
  await git(['remote', 'add', 'origin', '--', repoUrl]);
  await git(['fetch', '--quiet', '--depth', '1', 'origin', commit], 300_000);
  await git(['checkout', '--quiet', '--detach', commit]);
  const { stdout } = await git(['rev-parse', 'HEAD']);
  if (stdout.trim() !== commit) {
    throw new Error(`checked out ${stdout.trim().slice(0, 12)} instead of the pinned commit ${commit.slice(0, 12)}`);
  }
}

/**
 * Paths the upstream project removed between two commits, for a checkout of `newCommit` made by
 * gitCheckout in `dest`. An upgrade deletes them from the instance; everything else not in the
 * new commit (the bot's own data) is left alone.
 */
export async function gitRemovedFiles(dest: string, oldCommit: string, newCommit: string): Promise<string[]> {
  if (!COMMIT_RE.test(oldCommit) || !COMMIT_RE.test(newCommit)) throw new Error('invalid commit');
  const env = { GIT_TERMINAL_PROMPT: '0' };
  const git = (args: string[], timeoutMs = 120_000) => run('git', ['-C', dest, ...args], { timeoutMs, env });
  await git(['fetch', '--quiet', '--depth', '1', 'origin', oldCommit], 300_000);
  const files = async (commit: string) =>
    new Set((await git(['ls-tree', '-r', '--name-only', '-z', commit])).stdout.split('\0').filter(Boolean));
  const [before, after] = await Promise.all([files(oldCommit), files(newCommit)]);
  return [...before].filter((p) => !after.has(p));
}
