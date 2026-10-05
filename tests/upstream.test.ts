import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { SettingsStore } from '../src/settings.js';
import { SecretBox } from '../src/security/crypto.js';
import { UpstreamWatcher } from '../src/services/upstream.js';
import { PROVIDERS } from '../src/providers/index.js';

function fakeGithub(routes: Record<string, unknown>, failing: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (failing.some((p) => url.includes(p))) return new Response('rate limited', { status: 403 });
    const key = Object.keys(routes).find((p) => url.endsWith(p));
    return key ? new Response(JSON.stringify(routes[key]), { status: 200 }) : new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const settings = () => new SettingsStore(openDb(':memory:'), SecretBox.fromKey(crypto.randomBytes(32)));

describe('upstream version watcher', () => {
  it('reports newer releases and branch commits, and nothing when on the pinned version', async () => {
    const watcher = new UpstreamWatcher(
      settings(),
      fakeGithub({
        'mahdiMGF2/mirzabot/commits/main': { sha: 'f'.repeat(40), html_url: 'https://github.com/x', commit: { committer: { date: '2026-10-09T08:00:00Z' } } },
        'Mmd-Amir/Faoxima/releases/latest': { tag_name: 'v1.1.6', published_at: '2026-10-08T00:00:00Z', html_url: 'https://github.com/y' },
        'AmirKenzo/PasarguardBot/releases/latest': { tag_name: PROVIDERS.pasarguard.version, published_at: '2026-09-27T00:00:00Z', html_url: 'https://github.com/z' },
      }),
    );
    await watcher.check();
    const status = watcher.status();
    expect(status.mirza).toMatchObject({ newer: true, latest: `main @ 2026-10-09 (${'f'.repeat(12)})`, error: null });
    expect(status.faoxima).toMatchObject({ newer: true, latest: 'v1.1.6' });
    expect(status.pasarguard).toMatchObject({ newer: false, latest: PROVIDERS.pasarguard.version });
  });

  it('keeps the last known result when GitHub cannot be reached', async () => {
    const store = settings();
    await new UpstreamWatcher(
      store,
      fakeGithub({ 'Mmd-Amir/Faoxima/releases/latest': { tag_name: 'v1.1.6', published_at: '2026-10-08T00:00:00Z', html_url: 'u' } }),
    ).check();
    const watcher = new UpstreamWatcher(store, fakeGithub({}, ['Faoxima']));
    await watcher.check();
    expect(watcher.status().faoxima).toMatchObject({ latest: 'v1.1.6', newer: true, error: 'GitHub answered HTTP 403' });
  });
});
