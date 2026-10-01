import type { DB } from '../db.js';
import { randomToken, sha256Hex } from '../security/crypto.js';
import type { Role } from '../security/rbac.js';

export const SESSION_COOKIE = 'fb_session';
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000;

export interface AuthContext {
  adminId: number;
  username: string;
  role: Role;
  csrfToken: string;
  publicId: string;
  tokenHash: string;
}

export interface SessionInfo {
  public_id: string;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
  last_activity: number;
}

interface SessionJoinRow {
  public_id: string;
  admin_id: number;
  csrf_token: string;
  last_activity: number;
  expires_at: number;
  username: string;
  role: Role;
  is_active: number;
}

/**
 * Sessions live in SQLite (they survive restarts). Only a SHA-256 of the session
 * token is stored, so a leaked database cannot be replayed as cookies. Sessions
 * are referenced externally only by a separate random public_id.
 */
export class SessionStore {
  constructor(
    private readonly db: DB,
    private readonly now: () => number = Date.now,
  ) {}

  create(adminId: number, ip: string | undefined, userAgent: string | undefined): { token: string; csrfToken: string } {
    const token = randomToken(32);
    const csrfToken = randomToken(32);
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, public_id, admin_id, csrf_token, ip, user_agent, created_at, last_activity, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sha256Hex(token), randomToken(12), adminId, csrfToken, ip ?? null, (userAgent ?? '').slice(0, 255), t, t, t + SESSION_ABSOLUTE_MS);
    return { token, csrfToken };
  }

  resolve(token: unknown): AuthContext | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 128) return null;
    const hash = sha256Hex(token);
    const row = this.db
      .prepare(
        `SELECT s.public_id, s.admin_id, s.csrf_token, s.last_activity, s.expires_at, a.username, a.role, a.is_active
         FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`,
      )
      .get(hash) as SessionJoinRow | undefined;
    if (!row) return null;

    const t = this.now();
    if (!row.is_active || t > row.expires_at || t - row.last_activity > SESSION_IDLE_MS) {
      this.revokeByHash(hash);
      return null;
    }
    if (t - row.last_activity > 60_000) {
      this.db.prepare('UPDATE sessions SET last_activity = ? WHERE token_hash = ?').run(t, hash);
    }
    return {
      adminId: row.admin_id,
      username: row.username,
      role: row.role,
      csrfToken: row.csrf_token,
      publicId: row.public_id,
      tokenHash: hash,
    };
  }

  revokeByHash(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  /** Users can only see and revoke their own sessions. */
  listForAdmin(adminId: number): SessionInfo[] {
    return this.db
      .prepare('SELECT public_id, ip, user_agent, created_at, last_activity FROM sessions WHERE admin_id = ? ORDER BY last_activity DESC')
      .all(adminId) as SessionInfo[];
  }

  revokeByPublicId(adminId: number, publicId: string): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE admin_id = ? AND public_id = ?').run(adminId, publicId).changes > 0;
  }

  revokeAllForAdmin(adminId: number, exceptTokenHash?: string): void {
    if (exceptTokenHash) {
      this.db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token_hash <> ?').run(adminId, exceptTokenHash);
    } else {
      this.db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(adminId);
    }
  }

  purgeExpired(): void {
    const t = this.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_activity < ?').run(t, t - SESSION_IDLE_MS);
  }
}
