import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { requirePermission } from '../middleware.js';
import { rateLimit } from '../rateLimit.js';
import { actorOf, ah } from '../util.js';
import { BOT_TOKEN_RE } from '../../security/validation.js';
import { BACKUP_SCHEDULES } from '../../services/controlBackup.js';
import { passphraseProblems } from '../../security/fleetBackup.js';
import { HttpError } from '../../errors.js';

const backupSettingsSchema = z
  .object({
    enabled: z.boolean(),
    // A numeric chat id (users, groups, channels: -100…) or a public @channel name.
    chat_id: z
      .string()
      .trim()
      .regex(/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/, 'chat_id must be a numeric chat id or an @channel name'),
    thread_id: z
      .string()
      .trim()
      .regex(/^(\d{1,10})?$/, 'thread_id must be a numeric topic id')
      .optional(),
    schedule: z.enum(BACKUP_SCHEDULES),
    bot_token: z.string().trim().regex(BOT_TOKEN_RE, 'bot_token is not a valid Telegram bot token').optional(),
    passphrase: z.string().max(512).optional(),
  })
  .strict();

export function settingsRoutes(d: AppDeps): Router {
  const r = Router();
  r.use(requirePermission('settings.manage', d.audit));
  const sensitive = rateLimit({ limit: 10, windowMs: 5 * 60_000, key: (req) => `set|${req.auth?.adminId ?? req.ip}` });

  r.get('/backup', (_req, res) => {
    res.json({ backup: d.controlBackup.view() });
  });

  r.put(
    '/backup',
    sensitive,
    ah(async (req, res) => {
      const input = backupSettingsSchema.parse(req.body);
      if (input.passphrase !== undefined && input.passphrase !== '') {
        const problems = passphraseProblems(input.passphrase);
        if (problems.length > 0) throw new HttpError(400, 'weak_passphrase', problems.join(' '));
      }
      const backup = await d.controlBackup.configure(
        { ...input, passphrase: input.passphrase || undefined, thread_id: input.thread_id || undefined },
        actorOf(req),
      );
      res.json({ backup });
    }),
  );

  r.post(
    '/backup/test',
    sensitive,
    ah(async (_req, res) => {
      await d.controlBackup.sendTest();
      res.json({ ok: true });
    }),
  );

  r.post(
    '/backup/run',
    sensitive,
    ah(async (req, res) => {
      res.json(await d.controlBackup.sendNow(actorOf(req)));
    }),
  );

  // A fresh encrypted backup straight to the browser (no Telegram needed).
  r.get(
    '/backup/download',
    sensitive,
    ah(async (req, res) => {
      const backup = await d.controlBackup.create();
      d.audit.write({ actor: actorOf(req), action: 'CONTROL_PLANE_BACKUP', resource: 'control-plane', resourceId: backup.name, status: 'SUCCESS', metadata: { destination: 'download' } });
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${backup.name}"`);
      res.send(backup.data);
    }),
  );

  return r;
}
