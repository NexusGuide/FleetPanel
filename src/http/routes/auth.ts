import { Router } from 'express';
import type { AppDeps } from '../deps.js';
import { requireAuth } from '../middleware.js';
import { rateLimit } from '../rateLimit.js';
import { SESSION_ABSOLUTE_MS, SESSION_COOKIE } from '../sessions.js';
import { ah, authOf } from '../util.js';
import { HttpError } from '../../errors.js';
import { changePasswordSchema, loginSchema } from '../../security/validation.js';
import { hashPassword, passwordPolicyErrors, verifyPassword } from '../../security/passwords.js';
import { permissionsFor, type Role } from '../../security/rbac.js';

interface AdminAuthRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  is_active: number;
}

export function authRoutes(d: AppDeps): Router {
  const r = Router();
  const loginPerIp = rateLimit({ limit: 30, windowMs: 15 * 60_000 });
  const loginPerUser = rateLimit({
    limit: 5,
    windowMs: 15 * 60_000,
    key: (req) => {
      const username = (req.body as { username?: unknown } | undefined)?.username;
      return `${req.ip}|${typeof username === 'string' ? username.toLowerCase().slice(0, 64) : ''}`;
    },
  });
  const sensitive = rateLimit({ limit: 10, windowMs: 5 * 60_000, key: (req) => `pw|${req.auth?.adminId ?? req.ip}` });

  r.post(
    '/login',
    loginPerIp,
    loginPerUser,
    ah(async (req, res) => {
      const { username, password } = loginSchema.parse(req.body);
      const admin = d.db
        .prepare('SELECT id, username, password_hash, role, is_active FROM admins WHERE username = ?')
        .get(username) as AdminAuthRow | undefined;
      const valid = await verifyPassword(admin && admin.is_active ? admin.password_hash : null, password);
      if (!admin || !valid) {
        d.audit.write({ actor: username, action: 'LOGIN', resource: 'auth', ip: req.ip ?? null, status: 'FAILED' });
        throw new HttpError(401, 'invalid_credentials', 'Invalid username or password.');
      }

      // Session fixation defence: always issue a fresh session.
      if (req.auth) d.sessions.revokeByHash(req.auth.tokenHash);
      const session = d.sessions.create(admin.id, req.ip, req.get('user-agent'));
      d.db.prepare('UPDATE admins SET last_login = ? WHERE id = ?').run(new Date().toISOString(), admin.id);

      res.cookie(SESSION_COOKIE, session.token, {
        httpOnly: true,
        secure: d.cookieSecure,
        sameSite: 'strict',
        path: '/',
        maxAge: SESSION_ABSOLUTE_MS,
      });
      d.audit.write({ actor: admin.username, action: 'LOGIN', resource: 'auth', ip: req.ip ?? null, status: 'SUCCESS' });
      res.json({
        username: admin.username,
        role: admin.role,
        permissions: permissionsFor(admin.role),
        csrf_token: session.csrfToken,
      });
    }),
  );

  r.post('/logout', requireAuth, (req, res) => {
    const auth = authOf(req);
    d.sessions.revokeByHash(auth.tokenHash);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    d.audit.write({ actor: auth.username, action: 'LOGOUT', resource: 'auth', ip: req.ip ?? null, status: 'SUCCESS' });
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    if (!req.auth) {
      res.json({ authenticated: false });
      return;
    }
    res.json({
      authenticated: true,
      username: req.auth.username,
      role: req.auth.role,
      permissions: permissionsFor(req.auth.role),
      csrf_token: req.auth.csrfToken,
    });
  });

  r.get('/sessions', requireAuth, (req, res) => {
    const auth = authOf(req);
    const sessions = d.sessions.listForAdmin(auth.adminId).map((s) => ({ ...s, current: s.public_id === auth.publicId }));
    res.json({ sessions });
  });

  r.delete('/sessions/:publicId', requireAuth, (req, res) => {
    const auth = authOf(req);
    const publicId = req.params.publicId ?? '';
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(publicId)) throw new HttpError(400, 'invalid_session_id');
    if (!d.sessions.revokeByPublicId(auth.adminId, publicId)) throw new HttpError(404, 'session_not_found');
    d.audit.write({ actor: auth.username, action: 'SESSION_REVOKE', resource: 'session', resourceId: publicId, ip: req.ip ?? null, status: 'SUCCESS' });
    res.json({ ok: true });
  });

  r.post(
    '/password',
    requireAuth,
    sensitive,
    ah(async (req, res) => {
      const auth = authOf(req);
      const { current_password, new_password } = changePasswordSchema.parse(req.body);
      const row = d.db.prepare('SELECT password_hash FROM admins WHERE id = ?').get(auth.adminId) as { password_hash: string } | undefined;
      if (!row || !(await verifyPassword(row.password_hash, current_password))) {
        throw new HttpError(400, 'current_password_incorrect', 'Current password is incorrect.');
      }
      const problems = passwordPolicyErrors(new_password);
      if (problems.length > 0) throw new HttpError(400, 'weak_password', problems.join(' '));
      d.db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(await hashPassword(new_password), auth.adminId);
      d.sessions.revokeAllForAdmin(auth.adminId, auth.tokenHash);
      d.audit.write({ actor: auth.username, action: 'PASSWORD_CHANGE', resource: 'admin', resourceId: auth.adminId, ip: req.ip ?? null, status: 'SUCCESS' });
      res.json({ ok: true });
    }),
  );

  return r;
}
