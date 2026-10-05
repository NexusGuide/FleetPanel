import { PROVIDERS, PROVIDER_IDS, type ProviderId } from '../providers/index.js';
import type { SettingsStore } from '../settings.js';
import { errorMessage } from '../errors.js';
import { log } from '../log.js';

/** What the bot's own project has published, compared with the version this FleetPanel pins. */
export interface UpstreamStatus {
  checked_at: string;
  /** Newest published version: a release tag, or "main @ date" for projects tracked by branch. */
  latest: string | null;
  latest_date: string | null;
  url: string | null;
  /** True when that is newer than the pinned (reviewed) version. */
  newer: boolean;
  error: string | null;
}

const KEY = 'upstream.status';
const CHECK_MS = 6 * 3_600_000;

type Fetch = typeof fetch;

function repoPath(repoUrl: string): string {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repoUrl);
  if (!m?.[1]) throw new Error(`not a GitHub repository: ${repoUrl}`);
  return m[1];
}

/**
 * Watches the bots' upstream projects for new versions. It only informs: new versions are installed
 * after they are reviewed and pinned in a FleetPanel release (see docs/providers.md).
 */
export class UpstreamWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  status(): Partial<Record<ProviderId, UpstreamStatus>> {
    return this.settings.getJson<Partial<Record<ProviderId, UpstreamStatus>>>(KEY) ?? {};
  }

  private async github<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${path}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'FleetPanel' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async checkOne(id: ProviderId): Promise<UpstreamStatus> {
    const provider = PROVIDERS[id];
    const repo = repoPath(provider.repoUrl);
    const checked_at = new Date().toISOString();
    if (provider.track.kind === 'release') {
      const rel = await this.github<{ tag_name: string; published_at: string; html_url: string }>(`${repo}/releases/latest`);
      return { checked_at, latest: rel.tag_name, latest_date: rel.published_at, url: rel.html_url, newer: rel.tag_name !== provider.version, error: null };
    }
    const branch = provider.track.branch;
    const head = await this.github<{ sha: string; html_url: string; commit: { committer: { date: string } } }>(
      `${repo}/commits/${encodeURIComponent(branch)}`,
    );
    const date = head.commit.committer.date;
    return {
      checked_at,
      latest: `${branch} @ ${date.slice(0, 10)} (${head.sha.slice(0, 12)})`,
      latest_date: date,
      url: head.html_url,
      newer: head.sha !== provider.commit,
      error: null,
    };
  }

  /** Checks every provider; failures are recorded per provider. Concurrent calls share one run. */
  check(): Promise<void> {
    this.running ??= (async () => {
      const next = { ...this.status() };
      for (const id of PROVIDER_IDS) {
        try {
          next[id] = await this.checkOne(id);
        } catch (err) {
          const previous = next[id];
          next[id] = {
            checked_at: new Date().toISOString(),
            latest: previous?.latest ?? null,
            latest_date: previous?.latest_date ?? null,
            url: previous?.url ?? null,
            newer: previous?.newer ?? false,
            error: errorMessage(err).slice(0, 200),
          };
        }
      }
      this.settings.setJson(KEY, next);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  start(): void {
    if (this.timer) return;
    const run = () => {
      this.check().catch((err: unknown) => log.warn('Checking for new bot versions failed', err));
    };
    this.timer = setInterval(run, CHECK_MS);
    this.timer.unref();
    setTimeout(run, 2 * 60_000).unref();
  }
}
