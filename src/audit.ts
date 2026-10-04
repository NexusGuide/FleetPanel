import type Database from 'better-sqlite3';
import type { DB } from './db.js';
import { maskSecrets } from './security/mask.js';

/** Who performed an action. Services receive this from the HTTP layer so the audit log keeps the client IP. */
export interface Actor {
  name: string;
  ip?: string | null;
}
export type ActorRef = string | Actor;

export interface AuditEntry {
  actor: ActorRef;
  action: string;
  resource: string;
  resourceId?: string | number | null;
  ip?: string | null;
  status: 'SUCCESS' | 'FAILED';
  metadata?: Record<string, unknown>;
}

export interface AuditRecord {
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

// Rows can only be inserted: UPDATE and DELETE are blocked by triggers in the schema.
export class AuditLog {
  private readonly insert: Database.Statement;

  constructor(private readonly db: DB) {
    this.insert = db.prepare(
      'INSERT INTO audit_logs (actor, action, resource, resource_id, ip, status, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
  }

  write(entry: AuditEntry): void {
    const actor = typeof entry.actor === 'string' ? { name: entry.actor, ip: null } : entry.actor;
    this.insert.run(
      actor.name,
      entry.action,
      entry.resource,
      entry.resourceId === undefined || entry.resourceId === null ? null : String(entry.resourceId),
      entry.ip ?? actor.ip ?? null,
      entry.status,
      entry.metadata ? maskSecrets(JSON.stringify(entry.metadata)) : null,
    );
  }

  list(limit: number, beforeId?: number): AuditRecord[] {
    const rows = (
      beforeId
        ? this.db.prepare('SELECT * FROM audit_logs WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, limit)
        : this.db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit)
    ) as Array<Omit<AuditRecord, 'metadata'> & { metadata: string | null }>;
    return rows.map((row) => ({ ...row, metadata: parseMetadata(row.metadata) }));
  }
}

/** Metadata is masked after serialisation; if masking ever broke the JSON, show it as text instead of failing the page. */
function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}
