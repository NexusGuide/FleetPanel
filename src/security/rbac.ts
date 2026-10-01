export const ROLES = ['Owner', 'Admin', 'Manager', 'Support', 'Viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'instances.read',
  'instances.create',
  'instances.control',
  'instances.delete',
  'backups.read',
  'backups.create',
  'backups.restore',
  'admins.manage',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  Owner: new Set<Permission>(PERMISSIONS),
  Admin: new Set<Permission>(PERMISSIONS.filter((p) => p !== 'admins.manage')),
  Manager: new Set<Permission>([
    'instances.read',
    'instances.create',
    'instances.control',
    'backups.read',
    'backups.create',
    'audit.read',
  ]),
  Support: new Set<Permission>(['instances.read', 'instances.control', 'backups.read']),
  Viewer: new Set<Permission>(['instances.read', 'backups.read']),
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role]?.has(permission) ?? false;
}

export function permissionsFor(role: Role): Permission[] {
  return PERMISSIONS.filter((p) => can(role, p));
}
