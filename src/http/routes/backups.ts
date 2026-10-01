import { Router, type Request } from 'express';
import type { AppDeps } from '../deps.js';
import { requirePermission } from '../middleware.js';
import { rateLimit } from '../rateLimit.js';
import { actorOf, ah } from '../util.js';
import { HttpError } from '../../errors.js';
import { BACKUP_ID_RE } from '../../services/backups.js';

function backupId(req: Request): string {
  const id = req.params.id ?? '';
  if (!BACKUP_ID_RE.test(id)) throw new HttpError(400, 'invalid_backup_id');
  return id;
}

export function backupRoutes(d: AppDeps): Router {
  const r = Router();
  const sensitive = rateLimit({ limit: 5, windowMs: 5 * 60_000, key: (req) => `bak|${req.auth?.adminId ?? req.ip}` });

  r.get('/', requirePermission('backups.read', d.audit), (_req, res) => {
    res.json({ backups: d.backups.list() });
  });

  r.post(
    '/:id/restore',
    requirePermission('backups.restore', d.audit),
    sensitive,
    ah(async (req, res) => {
      res.json(await d.instances.restore(backupId(req), actorOf(req)));
    }),
  );

  r.delete(
    '/:id',
    requirePermission('backups.restore', d.audit),
    sensitive,
    ah(async (req, res) => {
      await d.backups.remove(backupId(req), actorOf(req));
      res.json({ ok: true });
    }),
  );

  return r;
}
