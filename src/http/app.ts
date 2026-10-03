import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { ZodError } from 'zod';
import './context.js';
import type { AppDeps } from './deps.js';
import { authenticate, csrfProtection, originCheck, requirePermission, securityHeaders } from './middleware.js';
import { rateLimit } from './rateLimit.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admins.js';
import { instanceRoutes } from './routes/instances.js';
import { backupRoutes } from './routes/backups.js';
import { systemRoutes } from './routes/system.js';
import { settingsRoutes } from './routes/settings.js';
import { HttpError } from '../errors.js';
import { CommandError } from '../system/exec.js';
import { log } from '../log.js';
import { VERSION } from '../version.js';

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'validation_failed',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof CommandError) {
    log.error('System command failed', err);
    res.status(502).json({ error: 'system_command_failed', message: err.message });
    return;
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: 'bad_request' });
    return;
  }
  log.error('Unhandled request error', err);
  res.status(500).json({ error: 'internal_error' });
}

export function createApp(d: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', d.trustProxy);

  app.use(securityHeaders);
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());
  app.use(authenticate(d.sessions));
  app.use(originCheck);
  app.use(csrfProtection);
  app.use('/api', rateLimit({ limit: 300, windowMs: 60_000 }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', version: VERSION });
  });

  app.use('/api/auth', authRoutes(d));
  app.use('/api/admins', adminRoutes(d));
  app.use('/api/instances', instanceRoutes(d));
  app.use('/api/backups', backupRoutes(d));
  app.use('/api/system', systemRoutes(d));
  app.use('/api/settings', settingsRoutes(d));

  app.get('/api/audit-logs', requirePermission('audit.read', d.audit), (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);
    const before = Number.parseInt(String(req.query.before ?? ''), 10);
    res.json({ entries: d.audit.list(limit, Number.isFinite(before) && before > 0 ? before : undefined) });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  serveWebUi(app, d.webDir);
  app.use(errorHandler);
  return app;
}

/** Serves the built single-page UI; unknown non-API GETs fall back to index.html. */
function serveWebUi(app: express.Express, webDir: string | undefined): void {
  if (!webDir) return;
  const index = path.join(webDir, 'index.html');
  if (!fs.existsSync(index)) return;
  // Hashed asset names change on every build, so they can be cached forever.
  app.use('/assets', express.static(path.join(webDir, 'assets'), { immutable: true, maxAge: '365d', index: false }));
  app.use(express.static(webDir, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
}
