import { Router } from 'express';
import type { AppDeps } from '../deps.js';
import { requirePermission } from '../middleware.js';
import { rateLimit } from '../rateLimit.js';
import { actorOf, ah, intParam } from '../util.js';
import { createInstanceSchema } from '../../security/validation.js';
import { HttpError } from '../../errors.js';

export function instanceRoutes(d: AppDeps): Router {
  const r = Router();
  const sensitive = rateLimit({ limit: 10, windowMs: 5 * 60_000, key: (req) => `inst|${req.auth?.adminId ?? req.ip}` });

  r.get('/', requirePermission('instances.read', d.audit), (_req, res) => {
    res.json({ instances: d.instances.list() });
  });

  r.post(
    '/',
    requirePermission('instances.create', d.audit),
    sensitive,
    ah(async (req, res) => {
      const input = createInstanceSchema.parse(req.body);
      const instance = await d.instances.create(input, actorOf(req));
      res.status(202).json({ instance });
    }),
  );

  // Lets the create wizard report a duplicate name, domain or bot before the final step.
  const checks = rateLimit({ limit: 30, windowMs: 5 * 60_000, key: (req) => `check|${req.auth?.adminId ?? req.ip}` });
  r.post(
    '/check',
    requirePermission('instances.create', d.audit),
    checks,
    ah(async (req, res) => {
      const input = createInstanceSchema.parse(req.body);
      res.json(await d.instances.check(input));
    }),
  );

  r.get('/:id', requirePermission('instances.read', d.audit), (req, res) => {
    res.json({ instance: d.instances.get(intParam(req, 'id')) });
  });

  r.post(
    '/:id/start',
    requirePermission('instances.control', d.audit),
    ah(async (req, res) => {
      res.json({ instance: await d.instances.start(intParam(req, 'id'), actorOf(req)) });
    }),
  );

  r.post(
    '/:id/stop',
    requirePermission('instances.control', d.audit),
    ah(async (req, res) => {
      res.json({ instance: await d.instances.stop(intParam(req, 'id'), actorOf(req)) });
    }),
  );

  // Update to the reviewed version this FleetPanel pins (data kept). Queued: one bot at a time.
  const upgrades = rateLimit({ limit: 50, windowMs: 5 * 60_000, key: (req) => `upg|${req.auth?.adminId ?? req.ip}` });
  r.post('/:id/upgrade', requirePermission('instances.create', d.audit), upgrades, (req, res) => {
    res.status(202).json({ instance: d.instances.upgrade(intParam(req, 'id'), actorOf(req)) });
  });

  r.post('/:id/reprovision', requirePermission('instances.create', d.audit), sensitive, (req, res) => {
    res.status(202).json({ instance: d.instances.reprovision(intParam(req, 'id'), actorOf(req)) });
  });

  r.delete(
    '/:id',
    requirePermission('instances.delete', d.audit),
    sensitive,
    ah(async (req, res) => {
      await d.instances.remove(intParam(req, 'id'), actorOf(req), req.query.backup !== 'false');
      res.json({ ok: true });
    }),
  );

  // Body: the raw file (application/octet-stream), streamed to disk; see services/dbImport.ts.
  const imports = rateLimit({ limit: 6, windowMs: 15 * 60_000, key: (req) => `imp|${req.auth?.adminId ?? req.ip}` });
  r.post(
    '/:id/import-db',
    requirePermission('backups.restore', d.audit),
    imports,
    ah(async (req, res) => {
      const id = intParam(req, 'id');
      if (!req.is('application/octet-stream')) throw new HttpError(415, 'unsupported_media_type', 'Send the file as application/octet-stream.');
      res.json(await d.instances.importDatabase(id, req, actorOf(req)));
    }),
  );

  r.get('/:id/backups', requirePermission('backups.read', d.audit), (req, res) => {
    const id = intParam(req, 'id');
    d.instances.get(id);
    res.json({ backups: d.backups.list(id) });
  });

  r.post(
    '/:id/backups',
    requirePermission('backups.create', d.audit),
    sensitive,
    ah(async (req, res) => {
      res.status(201).json({ backup: await d.instances.backup(intParam(req, 'id'), actorOf(req)) });
    }),
  );

  return r;
}
