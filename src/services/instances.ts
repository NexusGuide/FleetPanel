import fs from 'node:fs/promises';
import path from 'node:path';
import type { DB } from '../db.js';
import type { ActorRef, AuditLog } from '../audit.js';
import type { SecretStore } from '../secrets.js';
import type { PrivilegedOps } from '../system/helper.js';
import type { Toolchain } from '../system/toolchain.js';
import type { TelegramClient } from './telegram.js';
import type { BackupRow, BackupService } from './backups.js';
import { PROVIDERS, type ProviderId } from '../providers/index.js';
import { SLUG_RE, type CreateInstanceInput } from '../security/validation.js';
import { generatePassword, randomToken } from '../security/crypto.js';
import { HttpError, errorMessage } from '../errors.js';
import { log } from '../log.js';

export type InstanceStatus = 'provisioning' | 'running' | 'stopped' | 'error' | 'deleting';

export interface InstanceRow {
  id: number;
  slug: string;
  provider: ProviderId;
  domain: string;
  db_name: string;
  db_user: string;
  bot_username: string | null;
  admin_telegram_id: string;
  status: InstanceStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type GitClone = (repoUrl: string, ref: string | undefined, dest: string) => Promise<void>;

export function dbIdentFor(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error('invalid slug');
  return `fp_${slug.replace(/-/g, '_')}`;
}

/** Resolves an instance directory and guarantees it is a direct child of instancesDir. */
export function instanceDir(instancesDir: string, slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error('invalid slug');
  const base = path.resolve(instancesDir);
  const dir = path.resolve(base, slug);
  if (path.dirname(dir) !== base) throw new Error('instance path escapes the instances directory');
  return dir;
}

export interface InstanceServiceDeps {
  db: DB;
  audit: AuditLog;
  secrets: SecretStore;
  ops: PrivilegedOps;
  telegram: TelegramClient;
  backups: BackupService;
  git: GitClone;
  tools: Toolchain;
  instancesDir: string;
}

/** Runs one provisioning step and prefixes failures with its name, so last_error says where it broke. */
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(`${label}: ${errorMessage(err)}`);
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

const TIMESTAMP = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export class InstanceService {
  /** Instances with a long-running operation in progress (one at a time per instance). */
  private readonly busy = new Set<number>();

  constructor(private readonly d: InstanceServiceDeps) {}

  list(): InstanceRow[] {
    return this.d.db.prepare('SELECT * FROM instances ORDER BY created_at DESC').all() as InstanceRow[];
  }

  get(id: number): InstanceRow {
    const row = this.d.db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as InstanceRow | undefined;
    if (!row) throw new HttpError(404, 'instance_not_found', 'Instance not found.');
    return row;
  }

  private setStatus(id: number, status: InstanceStatus, lastError: string | null = null): void {
    this.d.db
      .prepare(`UPDATE instances SET status = ?, last_error = ?, updated_at = ${TIMESTAMP} WHERE id = ?`)
      .run(status, lastError, id);
  }

  private lock(inst: InstanceRow): void {
    if (this.busy.has(inst.id) || inst.status === 'provisioning' || inst.status === 'deleting') {
      throw new HttpError(409, 'instance_busy', 'Another operation is running on this instance. Try again shortly.');
    }
    this.busy.add(inst.id);
  }

  private unlock(id: number): void {
    this.busy.delete(id);
  }

  private auditFailure(actor: ActorRef, action: string, id: number, err: unknown): void {
    this.d.audit.write({
      actor,
      action,
      resource: 'instance',
      resourceId: id,
      status: 'FAILED',
      metadata: { error: errorMessage(err).slice(0, 1000) },
    });
  }

  /** Called at boot: anything left half-done by a crash is flagged instead of silently "running". */
  recoverInterrupted(): void {
    const result = this.d.db
      .prepare(
        `UPDATE instances SET status = 'error',
           last_error = 'Interrupted by a control-plane restart. Reprovision or delete this instance.',
           updated_at = ${TIMESTAMP}
         WHERE status IN ('provisioning', 'deleting')`,
      )
      .run();
    if (result.changes > 0) log.warn(`Flagged ${result.changes} interrupted instance(s) as error`);
  }

  async create(input: CreateInstanceInput, actor: ActorRef): Promise<InstanceRow> {
    // Fail fast on a bad token before touching the system.
    const bot = await this.d.telegram.getMe(input.bot_token);
    // A bot has exactly one webhook: a second instance would silently steal its traffic.
    const sameBot = this.d.db.prepare('SELECT slug FROM instances WHERE bot_username = ? COLLATE NOCASE').get(bot.username) as
      | { slug: string }
      | undefined;
    if (sameBot) {
      throw new HttpError(409, 'bot_in_use', `Bot @${bot.username} is already used by instance '${sameBot.slug}'.`);
    }
    const ident = dbIdentFor(input.slug);

    let id: number;
    try {
      id = Number(
        this.d.db
          .prepare(
            `INSERT INTO instances (slug, provider, domain, db_name, db_user, bot_username, admin_telegram_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning')`,
          )
          .run(input.slug, input.provider, input.domain, ident, ident, bot.username, input.admin_telegram_id)
          .lastInsertRowid,
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new HttpError(409, 'instance_exists', 'An instance with this slug or domain already exists.');
      }
      throw err;
    }

    this.d.secrets.put(id, 'bot_token', input.bot_token);
    this.d.secrets.put(id, 'db_password', generatePassword(32));
    this.d.secrets.put(id, 'webhook_secret', randomToken(32));
    this.d.audit.write({
      actor,
      action: 'INSTANCE_CREATE',
      resource: 'instance',
      resourceId: id,
      status: 'SUCCESS',
      metadata: { slug: input.slug, provider: input.provider, domain: input.domain },
    });

    this.provisionInBackground(id, actor, false);
    return this.get(id);
  }

  reprovision(id: number, actor: ActorRef): InstanceRow {
    const inst = this.get(id);
    // Also allowed for running/stopped instances: it repairs a broken install. The database is kept.
    if (inst.status === 'provisioning' || inst.status === 'deleting' || this.busy.has(id)) {
      throw new HttpError(409, 'instance_busy', 'Another operation is running on this instance. Try again shortly.');
    }
    this.setStatus(id, 'provisioning');
    this.provisionInBackground(id, actor, true);
    return this.get(id);
  }

  private provisionInBackground(id: number, actor: ActorRef, cleanFirst: boolean): void {
    this.busy.add(id);
    void this.provision(id, actor, cleanFirst).finally(() => this.unlock(id));
  }

  /** Never throws: the outcome is recorded on the instance row and in the audit log. */
  private async provision(id: number, actor: ActorRef, cleanFirst: boolean): Promise<void> {
    const inst = this.get(id);
    const provider = PROVIDERS[inst.provider];
    try {
      const dir = instanceDir(this.d.instancesDir, inst.slug);
      const botToken = this.d.secrets.get(id, 'bot_token');
      const dbPassword = this.d.secrets.get(id, 'db_password');
      const webhookSecret = this.d.secrets.get(id, 'webhook_secret');

      const ctx = {
        domain: inst.domain,
        dbName: inst.db_name,
        dbUser: inst.db_user,
        dbPassword,
        botToken,
        botUsername: inst.bot_username ?? '',
        adminTelegramId: inst.admin_telegram_id,
        webhookSecret,
      };
      const db = { dbName: inst.db_name, dbUser: inst.db_user, password: dbPassword };
      const inside = (rel: string): string => {
        const p = path.resolve(dir, rel);
        if (!p.startsWith(dir + path.sep)) throw new Error(`provider path ${rel} escapes the instance directory`);
        return p;
      };

      if (cleanFirst) await step('Removing the previous install', () => this.d.ops.removeInstance(inst.slug));
      await step(`Downloading ${provider.displayName}`, () => this.d.git(provider.repoUrl, provider.ref, dir));

      await step('Writing config.php', async () => {
        const configPath = inside(provider.configFile);
        const template = await fs.readFile(configPath, 'utf8');
        await fs.writeFile(configPath, provider.renderConfig(template, ctx), { mode: 0o640 });
        await fs.chmod(configPath, 0o640);
      });

      // The upstream web installer could reconfigure the bot; it must never be reachable.
      await fs.rm(inside(provider.installerDir), { recursive: true, force: true });

      await step('Creating the MySQL database', () => this.d.ops.createDatabase(inst.db_name, inst.db_user, dbPassword));
      // From here on the bot's own code runs (Composer, its schema script): give the files to the
      // bot's Linux user first and run those steps as that user, never as the control plane.
      await step('Setting file permissions', () => this.d.ops.fixPermissions(inst.slug));
      if ((await exists(inside('composer.json'))) && !(await exists(inside('vendor/autoload.php')))) {
        await step('Installing PHP dependencies (composer install)', async () => {
          await this.d.ops.runComposer(inst.slug);
          await this.d.ops.fixPermissions(inst.slug);
        });
        if (!(await exists(inside('vendor/autoload.php')))) {
          throw new Error('Installing PHP dependencies (composer install): vendor/autoload.php is still missing');
        }
      }
      await step(`Creating database tables (${provider.schemaScript})`, async () => {
        await this.d.ops.runPhp(inst.slug, provider.schemaScript);
        await this.d.ops.fixPermissions(inst.slug);
      });
      await step('Configuring the bot', async () => {
        const post = provider.postSchemaSql?.(ctx);
        if (post) await this.d.tools.sql(db, post);
        const out = (await this.d.tools.sql(db, provider.readyCheckSql(ctx))).trim();
        if (!(Number.parseInt(out, 10) > 0)) throw new Error('the database schema was not created as expected');
      });

      await step('Creating the PHP pool and nginx site', () =>
        this.d.ops.createInstance(inst.slug, inst.domain, provider.webhookPath, provider.webhookAuth, webhookSecret),
      );
      await step('Issuing the TLS certificate', () => this.d.ops.issueCertificate(inst.domain));
      // Last, so it overrides any webhook the schema script registered on its own.
      await step('Registering the Telegram webhook', () => this.d.telegram.setWebhook(botToken, provider.webhookUrl(ctx), webhookSecret));

      this.setStatus(id, 'running');
      this.d.audit.write({ actor, action: 'INSTANCE_PROVISION', resource: 'instance', resourceId: id, status: 'SUCCESS' });
      log.info(`Instance ${inst.slug} is running`);
    } catch (err) {
      const message = errorMessage(err).slice(0, 1000);
      this.setStatus(id, 'error', message);
      this.d.audit.write({
        actor,
        action: 'INSTANCE_PROVISION',
        resource: 'instance',
        resourceId: id,
        status: 'FAILED',
        metadata: { error: message },
      });
      log.error(`Provisioning failed for ${inst.slug}`, err);
    }
  }

  async start(id: number, actor: ActorRef): Promise<InstanceRow> {
    const inst = this.get(id);
    if (inst.status === 'error') {
      throw new HttpError(409, 'instance_error', 'Instance is in the error state. Reprovision it first.');
    }
    this.lock(inst);
    try {
      await this.d.ops.enableInstance(inst.slug);
      this.setStatus(id, 'running');
      this.d.audit.write({ actor, action: 'INSTANCE_START', resource: 'instance', resourceId: id, status: 'SUCCESS' });
      return this.get(id);
    } catch (err) {
      this.auditFailure(actor, 'INSTANCE_START', id, err);
      throw err;
    } finally {
      this.unlock(id);
    }
  }

  async stop(id: number, actor: ActorRef): Promise<InstanceRow> {
    const inst = this.get(id);
    if (inst.status === 'error') {
      throw new HttpError(409, 'instance_error', 'Instance is in the error state. Reprovision or delete it.');
    }
    this.lock(inst);
    try {
      await this.d.ops.disableInstance(inst.slug);
      this.setStatus(id, 'stopped');
      this.d.audit.write({ actor, action: 'INSTANCE_STOP', resource: 'instance', resourceId: id, status: 'SUCCESS' });
      return this.get(id);
    } catch (err) {
      this.auditFailure(actor, 'INSTANCE_STOP', id, err);
      throw err;
    } finally {
      this.unlock(id);
    }
  }

  async remove(id: number, actor: ActorRef, withBackup: boolean): Promise<void> {
    const inst = this.get(id);
    this.lock(inst);
    try {
      if (withBackup) {
        try {
          await this.d.backups.create(inst, 'pre-delete', actor);
        } catch (err) {
          this.auditFailure(actor, 'INSTANCE_DELETE', id, err);
          throw new HttpError(
            500,
            'backup_failed',
            `Pre-delete backup failed, so nothing was deleted: ${errorMessage(err)}. Retry with backup=false to skip it.`,
          );
        }
      }
      this.setStatus(id, 'deleting');
      try {
        await this.d.telegram.deleteWebhook(this.d.secrets.get(id, 'bot_token'));
      } catch (err) {
        log.warn(`Could not delete Telegram webhook for ${inst.slug}`, err);
      }
      try {
        await this.d.ops.removeInstance(inst.slug);
        await this.d.ops.dropDatabase(inst.db_name, inst.db_user);
      } catch (err) {
        this.setStatus(id, 'error', `Delete failed: ${errorMessage(err)}`);
        this.auditFailure(actor, 'INSTANCE_DELETE', id, err);
        throw err;
      }
      this.d.db.prepare('DELETE FROM instances WHERE id = ?').run(id);
      this.d.audit.write({
        actor,
        action: 'INSTANCE_DELETE',
        resource: 'instance',
        resourceId: id,
        status: 'SUCCESS',
        metadata: { slug: inst.slug, with_backup: withBackup },
      });
    } finally {
      this.unlock(id);
    }
  }

  async backup(id: number, actor: ActorRef): Promise<BackupRow> {
    const inst = this.get(id);
    if (inst.status === 'error') throw new HttpError(409, 'instance_error', 'Cannot back up an instance in the error state.');
    this.lock(inst);
    try {
      return await this.d.backups.create(inst, 'manual', actor);
    } finally {
      this.unlock(id);
    }
  }

  async restore(backupId: string, actor: ActorRef): Promise<{ safety_backup_id: string }> {
    const backup = this.d.backups.get(backupId);
    if (backup.instance_id === null) {
      throw new HttpError(409, 'instance_deleted', 'The instance of this backup was deleted; restoring into a new instance is not supported yet.');
    }
    const inst = this.get(backup.instance_id);
    this.lock(inst);
    try {
      const result = await this.d.backups.restore(backup, inst, actor);
      this.setStatus(inst.id, 'running');
      return result;
    } finally {
      this.unlock(inst.id);
    }
  }
}
