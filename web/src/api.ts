// Typed client for the FleetPanel REST API. Same origin only: the session lives in an
// HttpOnly cookie and every write echoes the per-session CSRF token.

export type Role = 'Owner' | 'Admin' | 'Manager' | 'Support' | 'Viewer';
export const ROLES: Role[] = ['Owner', 'Admin', 'Manager', 'Support', 'Viewer'];

export type Permission =
  | 'instances.read'
  | 'instances.create'
  | 'instances.control'
  | 'instances.delete'
  | 'backups.read'
  | 'backups.create'
  | 'backups.restore'
  | 'admins.manage'
  | 'settings.manage'
  | 'audit.read';

export interface Me {
  username: string;
  role: Role;
  permissions: Permission[];
}

export type InstanceStatus = 'provisioning' | 'running' | 'stopped' | 'error' | 'deleting';

export interface Instance {
  id: number;
  slug: string;
  provider: string;
  domain: string;
  db_name: string;
  db_user: string;
  bot_username: string | null;
  admin_telegram_id: string;
  source_commit: string | null;
  app_port: number | null;
  status: InstanceStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Backup {
  id: string;
  instance_id: number | null;
  slug: string;
  kind: 'manual' | 'pre-delete' | 'pre-restore';
  filename: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export interface Admin {
  id: number;
  username: string;
  role: Role;
  is_active: number;
  created_at: string;
  last_login: string | null;
}

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  resource: string;
  resource_id: string | null;
  ip: string | null;
  status: 'SUCCESS' | 'FAILED';
  metadata: Record<string, unknown> | null;
}

export interface Session {
  public_id: string;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
  last_activity: number;
  current: boolean;
}

export interface SystemInfo {
  version: string;
  node: string;
  hostname: string;
  platform: string;
  uptime_seconds: number;
  process_uptime_seconds: number;
  cpu: { cores: number; model: string | null; load_avg: number[] };
  memory: { total_bytes: number; free_bytes: number };
  disk: { path: string; total_bytes: number; free_bytes: number } | null;
  instances: Partial<Record<InstanceStatus, number>>;
  backups: { count: number; total_bytes: number };
}

export interface Provider {
  id: string;
  name: string;
  repo_url: string;
  version: string;
  commit: string;
  /** php: served by PHP-FPM with a Telegram webhook; python: a long-running service. */
  runtime: 'php' | 'python';
  extra_fields: Array<'api_id' | 'api_hash'>;
  /** The bot's own web page, relative to its domain (e.g. "panel/"). */
  web_path: string;
  /** What the bot's own project published (checked every 6 hours); null before the first check. */
  upstream: {
    checked_at: string;
    latest: string | null;
    latest_date: string | null;
    url: string | null;
    /** Newer than the version this FleetPanel pins: waiting for review. */
    newer: boolean;
    error: string | null;
  } | null;
}

/** An installed bot running an older reviewed version than this FleetPanel pins. */
export function isOutdated(inst: Instance, providers: Provider[] | null): boolean {
  const pinned = providers?.find((p) => p.id === inst.provider)?.commit;
  return (
    !!pinned &&
    inst.source_commit !== null &&
    inst.source_commit !== pinned &&
    (inst.status === 'running' || inst.status === 'stopped')
  );
}

/** Link to an instance's own web page (its admin panel or web app), never the webhook at the root. */
export function instanceWebUrl(inst: Pick<Instance, 'domain' | 'provider'>, providers: Provider[] | null): string {
  const webPath = providers?.find((p) => p.id === inst.provider)?.web_path ?? '';
  return `https://${inst.domain}/${webPath}`;
}

export interface InstanceCheck {
  bot_username: string;
  conflicts: Partial<Record<'slug' | 'domain' | 'bot_token', string>>;
}

export interface CreateInstanceInput {
  slug: string;
  provider: string;
  domain: string;
  bot_token: string;
  admin_telegram_id: string;
  api_id?: string;
  api_hash?: string;
}

// Mirrors src/security/validation.ts so forms can explain problems before submitting.
export const SLUG_RE = /^[a-z][a-z0-9-]{1,27}[a-z0-9]$/;
export const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const BOT_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
export const TELEGRAM_ID_RE = /^\d{1,20}$/;
export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
export const API_ID_RE = /^\d{3,12}$/;
export const API_HASH_RE = /^[0-9a-f]{32}$/;

/** Same rules as the server's passwordPolicyErrors(). */
export function passwordProblems(password: string): string[] {
  const out: string[] = [];
  if (password.length < 12) out.push('at least 12 characters');
  if (password.length > 256) out.push('at most 256 characters');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) out.push('three of: lowercase, uppercase, digits, symbols');
  return out;
}

const FRIENDLY: Record<string, string> = {
  authentication_required: 'Your session has expired. Please sign in again.',
  invalid_credentials: 'Invalid username or password.',
  csrf_token_invalid: 'Security token mismatch. Reload the page and try again.',
  cross_origin_blocked: 'Request blocked: it did not come from this panel.',
  permission_denied: 'Your role does not allow this action.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  not_found: 'Not found.',
  internal_error: 'The server hit an unexpected error. Check `sudo fleetpanel logs`.',
  bad_request: 'The request was malformed.',
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: string;
  message?: string;
  required?: string;
  retry_after?: number;
  issues?: Array<{ path: string; message: string }>;
}

function describeError(status: number, body: ErrorBody | null): ApiError {
  const code = body?.error ?? `http_${status}`;
  let message = body?.message;
  if (!message && body?.issues?.length) {
    message = body.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('\n');
  }
  if (!message && code === 'rate_limited' && body?.retry_after) {
    message = `Too many requests. Try again in ${body.retry_after}s.`;
  }
  if (!message && code === 'permission_denied' && body?.required) {
    message = `Your role does not allow this action (needs ${body.required}).`;
  }
  return new ApiError(status, code, message ?? FRIENDLY[code] ?? `Request failed (HTTP ${status}).`);
}

let csrfToken = '';
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the FleetPanel server. Check your connection.');
  }

  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = describeError(res.status, data as ErrorBody | null);
    if (res.status === 401 && path !== '/api/auth/login') onUnauthorized?.();
    throw err;
  }
  return data as T;
}

export type BackupSchedule = 'hourly' | '6h' | 'daily';

export interface BackupSettings {
  enabled: boolean;
  chat_id: string;
  thread_id: string;
  schedule: BackupSchedule;
  has_token: boolean;
  bot_username: string | null;
  has_passphrase: boolean;
  last_sent_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
  last_file: string | null;
}

export interface BackupSettingsInput {
  enabled: boolean;
  chat_id: string;
  thread_id?: string;
  schedule: BackupSchedule;
  bot_token?: string;
  passphrase?: string;
}

/** Uploads a bot database backup with progress (fetch cannot report upload progress). */
function uploadFile<T>(path: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('accept', 'application/json');
    if (csrfToken) xhr.setRequestHeader('x-csrf-token', csrfToken);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', 'The upload was interrupted.'));
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else {
        if (xhr.status === 401) onUnauthorized?.();
        reject(
          xhr.status === 413 && !data
            ? new ApiError(413, 'upload_too_large', 'The file is too large for the panel (512 MB at most).')
            : describeError(xhr.status, data as ErrorBody | null),
        );
      }
    };
    xhr.send(file);
  });
}

type MeResponse = ({ authenticated: true; csrf_token: string } & Me) | { authenticated: false };

export const api = {
  async me(): Promise<Me | null> {
    const res = await request<MeResponse>('GET', '/api/auth/me');
    if (!res.authenticated) {
      csrfToken = '';
      return null;
    }
    csrfToken = res.csrf_token;
    return { username: res.username, role: res.role, permissions: res.permissions };
  },
  async login(username: string, password: string): Promise<Me> {
    const res = await request<Me & { csrf_token: string }>('POST', '/api/auth/login', { username, password });
    csrfToken = res.csrf_token;
    return { username: res.username, role: res.role, permissions: res.permissions };
  },
  async logout(): Promise<void> {
    try {
      await request('POST', '/api/auth/logout');
    } finally {
      csrfToken = '';
    }
  },
  changePassword: (current_password: string, new_password: string) =>
    request<{ ok: true }>('POST', '/api/auth/password', { current_password, new_password }),
  sessions: () => request<{ sessions: Session[] }>('GET', '/api/auth/sessions').then((r) => r.sessions),
  revokeSession: (publicId: string) => request<{ ok: true }>('DELETE', `/api/auth/sessions/${encodeURIComponent(publicId)}`),

  instances: () => request<{ instances: Instance[] }>('GET', '/api/instances').then((r) => r.instances),
  instance: (id: number) => request<{ instance: Instance }>('GET', `/api/instances/${id}`).then((r) => r.instance),
  createInstance: (input: CreateInstanceInput) =>
    request<{ instance: Instance }>('POST', '/api/instances', input).then((r) => r.instance),
  checkInstance: (input: CreateInstanceInput) => request<InstanceCheck>('POST', '/api/instances/check', input),
  startInstance: (id: number) => request<{ instance: Instance }>('POST', `/api/instances/${id}/start`).then((r) => r.instance),
  stopInstance: (id: number) => request<{ instance: Instance }>('POST', `/api/instances/${id}/stop`).then((r) => r.instance),
  upgradeInstance: (id: number) =>
    request<{ instance: Instance }>('POST', `/api/instances/${id}/upgrade`).then((r) => r.instance),
  checkUpstream: () => request<{ ok: true }>('POST', '/api/system/providers/check'),
  reprovision: (id: number) =>
    request<{ instance: Instance }>('POST', `/api/instances/${id}/reprovision`).then((r) => r.instance),
  deleteInstance: (id: number, withBackup: boolean) =>
    request<{ ok: true }>('DELETE', `/api/instances/${id}${withBackup ? '' : '?backup=false'}`),

  backups: () => request<{ backups: Backup[] }>('GET', '/api/backups').then((r) => r.backups),
  instanceBackups: (id: number) =>
    request<{ backups: Backup[] }>('GET', `/api/instances/${id}/backups`).then((r) => r.backups),
  createBackup: (id: number) => request<{ backup: Backup }>('POST', `/api/instances/${id}/backups`).then((r) => r.backup),
  restoreBackup: (id: string) =>
    request<{ safety_backup_id: string }>('POST', `/api/backups/${encodeURIComponent(id)}/restore`),
  deleteBackup: (id: string) => request<{ ok: true }>('DELETE', `/api/backups/${encodeURIComponent(id)}`),

  admins: () => request<{ admins: Admin[] }>('GET', '/api/admins').then((r) => r.admins),
  createAdmin: (username: string, password: string, role: Role) =>
    request<{ admin: Admin }>('POST', '/api/admins', { username, password, role }).then((r) => r.admin),
  updateAdmin: (id: number, patch: { role?: Role; is_active?: boolean }) =>
    request<{ admin: Admin }>('PATCH', `/api/admins/${id}`, patch).then((r) => r.admin),

  auditLogs: (before?: number, limit = 100) =>
    request<{ entries: AuditEntry[] }>(
      'GET',
      `/api/audit-logs?limit=${limit}${before ? `&before=${before}` : ''}`,
    ).then((r) => r.entries),

  system: () => request<SystemInfo>('GET', '/api/system'),
  providers: () => request<{ providers: Provider[] }>('GET', '/api/system/providers').then((r) => r.providers),

  backupSettings: () => request<{ backup: BackupSettings }>('GET', '/api/settings/backup').then((r) => r.backup),
  saveBackupSettings: (input: BackupSettingsInput) =>
    request<{ backup: BackupSettings }>('PUT', '/api/settings/backup', input).then((r) => r.backup),
  testBackup: () => request<{ ok: true }>('POST', '/api/settings/backup/test'),
  runBackup: () => request<{ file: string }>('POST', '/api/settings/backup/run'),
  backupDownloadUrl: '/api/settings/backup/download',
  importDatabase: (id: number, file: File, onProgress?: (fraction: number) => void) =>
    uploadFile<{ safety_backup_id: string }>(`/api/instances/${id}/import-db`, file, onProgress),
};
