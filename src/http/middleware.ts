import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuditLog } from '../audit.js';
import { safeEqual } from '../security/crypto.js';
import { can, type Permission } from '../security/rbac.js';
import { SESSION_COOKIE, type SessionStore } from './sessions.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

export function authenticate(sessions: SessionStore): RequestHandler {
  return (req, _res, next) => {
    const auth = sessions.resolve(req.cookies?.[SESSION_COOKIE]);
    if (auth) req.auth = auth;
    next();
  };
}

/** Rejects state-changing requests whose Origin does not match the Host they were sent to. */
export function originCheck(req: Request, res: Response, next: NextFunction): void {
  if (!UNSAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin !== undefined) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost === null || originHost !== req.get('host')) {
      res.status(403).json({ error: 'cross_origin_blocked' });
      return;
    }
  }
  next();
}

/** Every authenticated state-changing request must echo the session's CSRF token. */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (!UNSAFE_METHODS.has(req.method) || !req.auth || req.path === '/api/auth/login') return next();
  if (!safeEqual(req.get('x-csrf-token') ?? '', req.auth.csrfToken)) {
    res.status(403).json({ error: 'csrf_token_invalid' });
    return;
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'authentication_required' });
    return;
  }
  next();
}

export function requirePermission(permission: Permission, audit: AuditLog): RequestHandler {
  return (req, res, next) => {
    if (!req.auth) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }
    if (!can(req.auth.role, permission)) {
      audit.write({
        actor: req.auth.username,
        action: 'PERMISSION_DENIED',
        resource: 'api',
        resourceId: `${req.method} ${req.originalUrl.split('?')[0]}`,
        ip: req.ip ?? null,
        status: 'FAILED',
        metadata: { permission, role: req.auth.role },
      });
      res.status(403).json({ error: 'permission_denied', required: permission });
      return;
    }
    next();
  };
}
