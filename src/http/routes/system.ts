import fs from 'node:fs/promises';
import os from 'node:os';
import { Router } from 'express';
import type { AppDeps } from '../deps.js';
import { requirePermission } from '../middleware.js';
import { ah } from '../util.js';
import { PROVIDERS, PROVIDER_IDS } from '../../providers/index.js';
import { VERSION } from '../../version.js';

interface DiskUsage {
  path: string;
  total_bytes: number;
  free_bytes: number;
}

async function diskUsage(target: string): Promise<DiskUsage | null> {
  try {
    const s = await fs.statfs(target);
    return { path: target, total_bytes: s.blocks * s.bsize, free_bytes: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

/** Read-only host facts for the dashboard. Every number comes from the OS; nothing is estimated. */
export function systemRoutes(d: AppDeps): Router {
  const r = Router();
  r.use(requirePermission('instances.read', d.audit));

  r.get(
    '/',
    ah(async (_req, res) => {
      const counts = d.db.prepare('SELECT status, COUNT(*) AS n FROM instances GROUP BY status').all() as Array<{
        status: string;
        n: number;
      }>;
      const backups = d.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM backups').get() as {
        n: number;
        bytes: number;
      };
      res.json({
        version: VERSION,
        node: process.version,
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()}`,
        uptime_seconds: Math.round(os.uptime()),
        process_uptime_seconds: Math.round(process.uptime()),
        cpu: { cores: os.cpus().length, model: os.cpus()[0]?.model ?? null, load_avg: os.loadavg() },
        memory: { total_bytes: os.totalmem(), free_bytes: os.freemem() },
        disk: await diskUsage(d.dataRoot),
        instances: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        backups: { count: backups.n, total_bytes: backups.bytes },
      });
    }),
  );

  r.get('/providers', (_req, res) => {
    res.json({
      providers: PROVIDER_IDS.map((id) => ({
        id,
        name: PROVIDERS[id].displayName,
        repo_url: PROVIDERS[id].repoUrl,
        version: PROVIDERS[id].version,
        commit: PROVIDERS[id].commit,
        runtime: PROVIDERS[id].runtime,
        extra_fields: PROVIDERS[id].extraFields,
        web_path: PROVIDERS[id].webPath,
      })),
    });
  });

  return r;
}
