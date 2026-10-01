import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { DB } from '../db.js';
import type { ActorRef, AuditLog } from '../audit.js';
import type { SecretStore } from '../secrets.js';
import type { PrivilegedOps } from '../system/helper.js';
import { run } from '../system/exec.js';
import { randomToken } from '../security/crypto.js';
import { HttpError, errorMessage } from '../errors.js';
import { instanceDir, type InstanceRow } from './instances.js';

export type BackupKind = 'manual' | 'pre-delete' | 'pre-restore';

export interface BackupRow {
  id: string;
  instance_id: number | null;
  slug: string;
  kind: BackupKind;
  filename: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export const BACKUP_ID_RE = /^\d{8}T\d{6}Z-[A-Za-z0-9]{8}$/;

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** An archive may only contain the instance directory, the SQL dump and the manifest. */
export function assertSafeArchiveEntries(entries: string[], slug: string): void {
  for (const raw of entries) {
    const entry = raw.trim().replace(/\/$/, '');
    if (entry === '') continue;
    if (entry.startsWith('/') || entry.split('/').includes('..')) throw new Error(`Unsafe path in archive: ${raw}`);
    if (entry === 'database.sql' || entry === 'manifest.json' || entry === slug || entry.startsWith(`${slug}/`)) continue;
    throw new Error(`Unexpected path in archive: ${raw}`);
  }
}

export interface BackupServiceDeps {
  db: DB;
  audit: AuditLog;
  secrets: SecretStore;
  ops: PrivilegedOps;
  instancesDir: string;
  backupsDir: string;
  retention: number;
}

export class BackupService {
  constructor(private readonly d: BackupServiceDeps) {}

  list(instanceId?: number): BackupRow[] {
    const stmt =
      instanceId === undefined
        ? this.d.db.prepare('SELECT * FROM backups ORDER BY created_at DESC')
        : this.d.db.prepare('SELECT * FROM backups WHERE instance_id = ? ORDER BY created_at DESC');
    return (instanceId === undefined ? stmt.all() : stmt.all(instanceId)) as BackupRow[];
  }

  get(id: string): BackupRow {
    const row = this.d.db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as BackupRow | undefined;
    if (!row) throw new HttpError(404, 'backup_not_found', 'Backup not found.');
    return row;
  }

  /** Writes a throwaway my.cnf so the DB password never appears in argv. */
  private async withClientConfig<T>(inst: InstanceRow, fn: (cnfPath: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleetbot-'));
    const cnf = path.join(dir, 'client.cnf');
    try {
      const password = this.d.secrets.get(inst.id, 'db_password');
      await fs.writeFile(cnf, `[client]\nuser=${inst.db_user}\npassword=${password}\nhost=localhost\n`, { mode: 0o600 });
      return await fn(cnf);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async create(inst: InstanceRow, kind: BackupKind, actor: ActorRef = 'system'): Promise<BackupRow> {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const id = `${stamp}-${randomToken(6).replace(/[^A-Za-z0-9]/g, 'x')}`;
    const filename = `${inst.slug}_${kind}_${id}.tar.gz`;
    const dest = path.join(this.d.backupsDir, filename);
    const work = await fs.mkdtemp(path.join(this.d.backupsDir, '.work-'));
    try {
      const dump = path.join(work, 'database.sql');
      await this.withClientConfig(inst, (cnf) =>
        run('mysqldump', [
          `--defaults-extra-file=${cnf}`,
          '--single-transaction',
          '--quick',
          '--no-tablespaces',
          `--result-file=${dump}`,
          inst.db_name,
        ]),
      );
      const manifest = {
        format: 1,
        slug: inst.slug,
        provider: inst.provider,
        domain: inst.domain,
        db_name: inst.db_name,
        kind,
        created_at: new Date().toISOString(),
      };
      await fs.writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await run('tar', ['-czf', dest, '-C', this.d.instancesDir, inst.slug, '-C', work, 'database.sql', 'manifest.json'], {
        timeoutMs: 900_000,
      });
      await fs.chmod(dest, 0o600);
      const [stat, sha256] = await Promise.all([fs.stat(dest), sha256File(dest)]);
      this.d.db
        .prepare('INSERT INTO backups (id, instance_id, slug, kind, filename, size_bytes, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, inst.id, inst.slug, kind, filename, stat.size, sha256);
      this.d.audit.write({
        actor,
        action: 'BACKUP_CREATE',
        resource: 'backup',
        resourceId: id,
        status: 'SUCCESS',
        metadata: { slug: inst.slug, kind, size_bytes: stat.size },
      });
      await this.prune(inst.id);
      return this.get(id);
    } catch (err) {
      await fs.rm(dest, { force: true });
      this.d.audit.write({
        actor,
        action: 'BACKUP_CREATE',
        resource: 'backup',
        resourceId: id,
        status: 'FAILED',
        metadata: { slug: inst.slug, kind, error: errorMessage(err).slice(0, 1000) },
      });
      throw err;
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  /** Keeps the newest N manual backups per instance. Safety backups are never pruned automatically. */
  private async prune(instanceId: number): Promise<void> {
    const rows = this.d.db
      .prepare("SELECT id, filename FROM backups WHERE instance_id = ? AND kind = 'manual' ORDER BY created_at DESC")
      .all(instanceId) as Array<Pick<BackupRow, 'id' | 'filename'>>;
    for (const row of rows.slice(Math.max(1, this.d.retention))) {
      await fs.rm(path.join(this.d.backupsDir, row.filename), { force: true });
      this.d.db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
    }
  }

  async restore(backup: BackupRow, inst: InstanceRow, actor: ActorRef): Promise<{ safety_backup_id: string }> {
    const file = path.join(this.d.backupsDir, backup.filename);
    if ((await sha256File(file)) !== backup.sha256) {
      throw new HttpError(409, 'backup_corrupted', 'Backup checksum does not match; refusing to restore.');
    }
    const { stdout } = await run('tar', ['-tzf', file], { timeoutMs: 300_000 });
    assertSafeArchiveEntries(stdout.split('\n'), inst.slug);

    const safety = await this.create(inst, 'pre-restore', actor);
    const dir = instanceDir(this.d.instancesDir, inst.slug);
    const previous = path.join(this.d.instancesDir, `.previous-${inst.slug}-${Date.now()}`);
    const work = await fs.mkdtemp(path.join(this.d.instancesDir, '.restore-'));
    let swapped = false;
    try {
      await run('tar', ['-xzf', file, '-C', work, '--no-same-owner', '--no-same-permissions'], { timeoutMs: 900_000 });
      await this.d.ops.disableInstance(inst.slug);
      await fs.rename(dir, previous);
      swapped = true;
      await fs.rename(path.join(work, inst.slug), dir);
      const sql = await fs.readFile(path.join(work, 'database.sql'), 'utf8');
      await this.withClientConfig(inst, (cnf) =>
        run('mysql', [`--defaults-extra-file=${cnf}`, inst.db_name], { input: sql, timeoutMs: 900_000 }),
      );
      await this.d.ops.fixPermissions(inst.slug);
      await this.d.ops.enableInstance(inst.slug);
      await fs.rm(previous, { recursive: true, force: true });
      this.d.audit.write({
        actor,
        action: 'BACKUP_RESTORE',
        resource: 'backup',
        resourceId: backup.id,
        status: 'SUCCESS',
        metadata: { slug: inst.slug, safety_backup_id: safety.id },
      });
      return { safety_backup_id: safety.id };
    } catch (err) {
      if (swapped) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        await fs.rename(previous, dir).catch(() => undefined);
      }
      await this.d.ops.enableInstance(inst.slug).catch(() => undefined);
      this.d.audit.write({
        actor,
        action: 'BACKUP_RESTORE',
        resource: 'backup',
        resourceId: backup.id,
        status: 'FAILED',
        metadata: { slug: inst.slug, error: errorMessage(err), safety_backup_id: safety.id },
      });
      throw new HttpError(
        500,
        'restore_failed',
        `Restore failed: ${errorMessage(err)}. Files were rolled back. If the database was partially imported, restore safety backup ${safety.id}.`,
      );
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async remove(id: string, actor: ActorRef): Promise<void> {
    const backup = this.get(id);
    await fs.rm(path.join(this.d.backupsDir, backup.filename), { force: true });
    this.d.db.prepare('DELETE FROM backups WHERE id = ?').run(id);
    this.d.audit.write({ actor, action: 'BACKUP_DELETE', resource: 'backup', resourceId: id, status: 'SUCCESS' });
  }
}
