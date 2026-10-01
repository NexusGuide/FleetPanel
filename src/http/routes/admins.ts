import { Router } from 'express';
import type { AppDeps } from '../deps.js';
import { requirePermission } from '../middleware.js';
import { ah, authOf, intParam } from '../util.js';
import { HttpError } from '../../errors.js';
import { createAdminSchema, updateAdminSchema } from '../../security/validation.js';
import { hashPassword, passwordPolicyErrors } from '../../security/passwords.js';
import type { Role } from '../../security/rbac.js';

interface AdminRow {
  id: number;
  username: string;
  role: Role;
  is_active: number;
  created_at: string;
  last_login: string | null;
}

export function adminRoutes(d: AppDeps): Router {
  const r = Router();
  r.use(requirePermission('admins.manage', d.audit));

  const getAdmin = (id: number): AdminRow => {
    const row = d.db.prepare('SELECT id, username, role, is_active, created_at, last_login FROM admins WHERE id = ?').get(id) as AdminRow | undefined;
    if (!row) throw new HttpError(404, 'admin_not_found');
    return row;
  };

  r.get('/', (_req, res) => {
    res.json({ admins: d.db.prepare('SELECT id, username, role, is_active, created_at, last_login FROM admins ORDER BY id').all() });
  });

  r.post(
    '/',
    ah(async (req, res) => {
      const auth = authOf(req);
      const input = createAdminSchema.parse(req.body);
      const problems = passwordPolicyErrors(input.password);
      if (problems.length > 0) throw new HttpError(400, 'weak_password', problems.join(' '));
      let id: number;
      try {
        id = Number(
          d.db
            .prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)')
            .run(input.username, await hashPassword(input.password), input.role).lastInsertRowid,
        );
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HttpError(409, 'username_taken');
        throw err;
      }
      d.audit.write({ actor: auth.username, action: 'ADMIN_CREATE', resource: 'admin', resourceId: id, ip: req.ip ?? null, status: 'SUCCESS', metadata: { username: input.username, role: input.role } });
      res.status(201).json({ admin: getAdmin(id) });
    }),
  );

  r.patch('/:id', (req, res) => {
    const auth = authOf(req);
    const id = intParam(req, 'id');
    const input = updateAdminSchema.parse(req.body);
    const target = getAdmin(id);

    if (id === auth.adminId && input.role !== undefined && input.role !== target.role) {
      throw new HttpError(409, 'cannot_change_own_role', 'You cannot change your own role.');
    }
    // Disabling yourself would end your own session and could lock the panel out.
    if (id === auth.adminId && input.is_active === false) {
      throw new HttpError(409, 'cannot_disable_self', 'You cannot disable your own account.');
    }
    const losesOwner = target.role === 'Owner' && target.is_active === 1 && ((input.role !== undefined && input.role !== 'Owner') || input.is_active === false);
    if (losesOwner) {
      const owners = (d.db.prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'Owner' AND is_active = 1").get() as { n: number }).n;
      if (owners <= 1) throw new HttpError(409, 'last_owner', 'At least one active Owner must remain.');
    }

    if (input.role !== undefined) d.db.prepare('UPDATE admins SET role = ? WHERE id = ?').run(input.role, id);
    if (input.is_active !== undefined) {
      d.db.prepare('UPDATE admins SET is_active = ? WHERE id = ?').run(input.is_active ? 1 : 0, id);
      if (!input.is_active) d.sessions.revokeAllForAdmin(id);
    }
    d.audit.write({ actor: auth.username, action: 'ADMIN_UPDATE', resource: 'admin', resourceId: id, ip: req.ip ?? null, status: 'SUCCESS', metadata: input });
    res.json({ admin: getAdmin(id) });
  });

  return r;
}
