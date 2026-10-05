import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DB } from '../db.js';
import type { ActorRef, AuditLog } from '../audit.js';
import type { SecretStore } from '../secrets.js';
import type { PrivilegedOps } from '../system/helper.js';
import type { Toolchain } from '../system/toolchain.js';
import type { TelegramClient } from './telegram.js';
import type { BackupRow, BackupService } from './backups.js';
import {
  APP_PORT_BASE,
  PROVIDERS,
  type BotProvider,
  type PhpProvider,
  type ProviderContext,
  type ProviderId,
  type PythonProvider,
} from '../providers/index.js';
import { SLUG_RE, type CreateInstanceInput } from '../security/validation.js';
import { generatePassword, randomToken } from '../security/crypto.js';
import { HttpError, errorMessage } from '../errors.js';
import { maskSecrets } from '../security/mask.js';
import { prepareDump, saveUpload } from './dbImport.js';
import type { Readable } from 'node:stream';
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
  /** Upstream commit the instance's code was installed from (null before the first download). */
  source_commit: string | null;
  /** Loopback port of a service bot's web server (null for PHP bots). */
  app_port: number | null;
  status: InstanceStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type InstanceConflicts = Partial<Record<'slug' | 'domain' | 'bot_token', string>>;

export type GitCheckout = (repoUrl: string, commit: string, dest: string) => Promise<void>;

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
  git: GitCheckout;
  tools: Toolchain;
  instancesDir: string;
}

/** Directories a service bot writes to; created by the control plane before ownership is handed over. */
const SERVICE_DIRS = ['workdir', 'logs', 'sessions', 'data/redis'];

/**
 * Some bots (python-decouple with RepositoryEnv(".env")) refuse to start without a .env file in their
 * working directory, although real environment variables win over it. These stay empty: the secrets
 * live in the root-only environment file, so the bot's own backups (which zip .env) carry none.
 */
const ENV_PLACEHOLDERS = ['.env', 'workdir/.env'];
const ENV_PLACEHOLDER_TEXT = '# Managed by FleetPanel: settings come from the service environment, not this file.\n';

/** KEY=value lines for the helper's instance-env command. */
function envFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
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

  /**
   * Called at boot: an instance whose files are gone (e.g. the control plane was restored on a new
   * server) is flagged instead of shown as running; Repair reinstalls it from its stored settings.
   */
  flagMissingInstalls(): void {
    for (const inst of this.list()) {
      if (inst.status !== 'running' && inst.status !== 'stopped') continue;
      if (existsSync(instanceDir(this.d.instancesDir, inst.slug))) continue;
      this.setStatus(inst.id, 'error', 'The bot is not installed on this server (restored from a backup?). Press Repair to reinstall it.');
      log.warn(`Instance ${inst.slug} has no files on this server; flagged for Repair`);
    }
  }

  /**
   * Called at boot: brings running PHP bots up to date with what this FleetPanel version manages
   * outside their files (cron timer, nginx rules), so an update needs no Repair. Never throws.
   */
  async refreshPhpInstances(): Promise<void> {
    for (const inst of this.list()) {
      const provider = PROVIDERS[inst.provider];
      if (inst.status !== 'running' || provider.runtime !== 'php') continue;
      try {
        await this.d.ops.refreshInstance(inst.slug, provider.cronScript);
      } catch (err) {
        log.warn(`Could not refresh ${inst.slug} (cron jobs / nginx rules)`, err);
      }
    }
  }

  /** Why an instance with these values cannot be created, per field (empty when there is no conflict). */
  conflicts(slug: string, domain: string, botUsername?: string): InstanceConflicts {
    const find = (column: 'slug' | 'domain' | 'bot_username', value: string) =>
      this.d.db.prepare(`SELECT slug FROM instances WHERE ${column} = ? COLLATE NOCASE`).get(value) as { slug: string } | undefined;
    const out: InstanceConflicts = {};
    if (find('slug', slug)) out.slug = `A bot named '${slug}' already exists.`;
    const byDomain = find('domain', domain);
    if (byDomain) out.domain = `${domain} is already used by bot '${byDomain.slug}'.`;
    // A bot has exactly one webhook: a second instance would silently steal its traffic.
    const byBot = botUsername ? find('bot_username', botUsername) : undefined;
    if (byBot) out.bot_token = `Bot @${botUsername} is already used by bot '${byBot.slug}'.`;
    return out;
  }

  /** Validates a creation request without changing anything (token checked with Telegram). */
  async check(input: CreateInstanceInput): Promise<{ bot_username: string; conflicts: InstanceConflicts }> {
    // Assumes createInstanceSchema already required the provider's extra fields.
    const bot = await this.d.telegram.getMe(input.bot_token);
    return { bot_username: bot.username, conflicts: this.conflicts(input.slug, input.domain, bot.username) };
  }

  async create(input: CreateInstanceInput, actor: ActorRef): Promise<InstanceRow> {
    // Fail fast on a bad token before touching the system.
    const bot = await this.d.telegram.getMe(input.bot_token);
    const conflicts = this.conflicts(input.slug, input.domain, bot.username);
    if (conflicts.slug) throw new HttpError(409, 'slug_in_use', conflicts.slug);
    if (conflicts.domain) throw new HttpError(409, 'domain_in_use', conflicts.domain);
    if (conflicts.bot_token) throw new HttpError(409, 'bot_in_use', conflicts.bot_token);
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
    if (input.api_id) this.d.secrets.put(id, 'api_id', input.api_id);
    if (input.api_hash) this.d.secrets.put(id, 'api_hash', input.api_hash);
    if (PROVIDERS[input.provider].runtime === 'python') {
      this.d.db.prepare('UPDATE instances SET app_port = ? WHERE id = ?').run(APP_PORT_BASE + id, id);
    }
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
      const ctx = this.contextFor(inst);
      const dir = ctx.instanceDir;

      if (cleanFirst) await step('Removing the previous install', () => this.d.ops.removeInstance(inst.slug));
      await step(`Downloading ${provider.displayName} ${provider.version}`, () => this.d.git(provider.repoUrl, provider.commit, dir));
      this.d.db.prepare('UPDATE instances SET source_commit = ? WHERE id = ?').run(provider.commit, id);

      if (provider.runtime === 'python') await this.provisionService(inst, provider, ctx);
      else await this.provisionPhp(inst, provider, ctx);

      this.setStatus(id, 'running');
      this.d.audit.write({ actor, action: 'INSTANCE_PROVISION', resource: 'instance', resourceId: id, status: 'SUCCESS' });
      log.info(`Instance ${inst.slug} is running`);
    } catch (err) {
      // Step errors can carry the bot's own log lines; never store a token or password from them.
      const message = maskSecrets(errorMessage(err)).slice(0, 1000);
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

  /** Everything a provider needs to configure this instance (secrets decrypted). */
  private contextFor(inst: InstanceRow): ProviderContext {
    return {
      domain: inst.domain,
      dbName: inst.db_name,
      dbUser: inst.db_user,
      dbPassword: this.d.secrets.get(inst.id, 'db_password'),
      botToken: this.d.secrets.get(inst.id, 'bot_token'),
      botUsername: inst.bot_username ?? '',
      adminTelegramId: inst.admin_telegram_id,
      webhookSecret: this.d.secrets.get(inst.id, 'webhook_secret'),
      instanceDir: instanceDir(this.d.instancesDir, inst.slug),
      apiId: this.d.secrets.find(inst.id, 'api_id'),
      apiHash: this.d.secrets.find(inst.id, 'api_hash'),
      appPort: inst.app_port ?? undefined,
    };
  }

  /**
   * Replaces a bot's database with one of its own backups (a mysqldump as .sql, .sql.gz or a .zip
   * holding one .sql). A safety backup is taken first; the bot is stopped during the import and its
   * FleetPanel-managed settings (schema, webhook secret, webhook) are reapplied afterwards.
   */
  async importDatabase(id: number, upload: Readable, actor: ActorRef): Promise<{ safety_backup_id: string }> {
    const inst = this.get(id);
    if (inst.status !== 'running' && inst.status !== 'stopped') {
      throw new HttpError(409, 'instance_not_ready', 'The bot must be installed (running or stopped) before importing a database. Press Repair first.');
    }
    this.lock(inst);
    const work = await this.d.backups.workDir('import');
    let safetyId: string | null = null;
    try {
      const uploadFile = path.join(work, 'upload');
      await saveUpload(upload, uploadFile);
      const dump = await prepareDump(uploadFile, work);
      await fs.rm(uploadFile, { force: true });

      safetyId = (await this.d.backups.create(inst, 'pre-restore', actor)).id;
      const provider = PROVIDERS[inst.provider];
      const ctx = this.contextFor(inst);
      const db = { dbName: inst.db_name, dbUser: inst.db_user, password: ctx.dbPassword };
      await this.d.ops.disableInstance(inst.slug);
      try {
        await step('Importing the database', () => this.d.tools.importDump(db, dump));
        await this.reapplySettings(inst, provider, ctx);
      } finally {
        if (inst.status === 'running') await this.d.ops.enableInstance(inst.slug);
      }
      this.d.audit.write({ actor, action: 'INSTANCE_DB_IMPORT', resource: 'instance', resourceId: id, status: 'SUCCESS', metadata: { slug: inst.slug, safety_backup_id: safetyId } });
      return { safety_backup_id: safetyId };
    } catch (err) {
      const message = maskSecrets(errorMessage(err)).slice(0, 1000);
      this.d.audit.write({ actor, action: 'INSTANCE_DB_IMPORT', resource: 'instance', resourceId: id, status: 'FAILED', metadata: { slug: inst.slug, error: message, safety_backup_id: safetyId } });
      if (err instanceof HttpError && safetyId === null) throw err;
      throw new HttpError(
        500,
        'import_failed',
        safetyId ? `${message}. The previous database is in safety backup ${safetyId} (Backups → Restore).` : message,
      );
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
      this.unlock(id);
    }
  }

  /** After a database import: bring the schema up to date and put FleetPanel's settings back. */
  private async reapplySettings(inst: InstanceRow, provider: BotProvider, ctx: ProviderContext): Promise<void> {
    if (provider.runtime === 'python') {
      await step('Updating database tables (alembic)', () => this.d.ops.runTask(inst.slug, 'python-migrate'));
      return;
    }
    const db = { dbName: inst.db_name, dbUser: inst.db_user, password: ctx.dbPassword };
    await step(`Updating database tables (${provider.schemaScript})`, async () => {
      await this.d.ops.runPhp(inst.slug, provider.schemaScript);
      await this.d.ops.fixPermissions(inst.slug);
    });
    // The imported data carries the old webhook secret (MirzaBot keeps it in its database).
    const post = provider.postSchemaSql?.(ctx);
    if (post) await step('Restoring the webhook secret', () => this.d.tools.sql(db, post));
    await step('Registering the Telegram webhook', () => this.d.telegram.setWebhook(ctx.botToken, provider.webhookUrl(ctx), ctx.webhookSecret));
  }

  private async provisionPhp(inst: InstanceRow, provider: PhpProvider, ctx: ProviderContext): Promise<void> {
    const dir = ctx.instanceDir;
    const db = { dbName: inst.db_name, dbUser: inst.db_user, password: ctx.dbPassword };
    const inside = (rel: string): string => {
      const p = path.resolve(dir, rel);
      if (!p.startsWith(dir + path.sep)) throw new Error(`provider path ${rel} escapes the instance directory`);
      return p;
    };

    await step('Writing config.php', async () => {
      const configPath = inside(provider.configFile);
      const template = await fs.readFile(configPath, 'utf8');
      await fs.writeFile(configPath, provider.renderConfig(template, ctx), { mode: 0o640 });
      await fs.chmod(configPath, 0o640);
    });

    // The upstream web installer could reconfigure the bot; it must never be reachable.
    await fs.rm(inside(provider.installerDir), { recursive: true, force: true });

    await step('Creating the MySQL database', () => this.d.ops.createDatabase(inst.db_name, inst.db_user, ctx.dbPassword));
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
      this.d.ops.createInstance(inst.slug, inst.domain, provider.webhookPath, provider.webhookAuth, ctx.webhookSecret),
    );
    await step('Issuing the TLS certificate', () => this.d.ops.issueCertificate(inst.domain));
    // Last, so it overrides any webhook the schema script registered on its own.
    await step('Registering the Telegram webhook', () =>
      this.d.telegram.setWebhook(ctx.botToken, provider.webhookUrl(ctx), ctx.webhookSecret),
    );
    await step("Scheduling the bot's cron jobs", () => this.d.ops.refreshInstance(inst.slug, provider.cronScript));
  }

  /** A long-running Python bot: its own systemd service and Redis, web server behind nginx. */
  private async provisionService(inst: InstanceRow, provider: PythonProvider, ctx: ProviderContext): Promise<void> {
    const dir = ctx.instanceDir;
    const port = inst.app_port;
    if (port === null) throw new Error('No application port was assigned to this instance');
    const db = { dbName: inst.db_name, dbUser: inst.db_user, password: ctx.dbPassword };

    await step('Creating the MySQL database', () => this.d.ops.createDatabase(inst.db_name, inst.db_user, ctx.dbPassword));
    await step('Preparing the Python runtime (the first bot takes a few minutes)', () => this.d.ops.prepareRuntime());
    await step('Writing the bot configuration', async () => {
      await this.d.ops.writeEnv(inst.slug, envFile(provider.renderEnv(ctx)));
      for (const rel of SERVICE_DIRS) await fs.mkdir(path.join(dir, rel), { recursive: true });
      for (const rel of ENV_PLACEHOLDERS) await fs.writeFile(path.join(dir, rel), ENV_PLACEHOLDER_TEXT);
      for (const rel of provider.workdirFiles) {
        if (rel.includes('/') || rel.startsWith('.')) throw new Error(`invalid working-directory file ${rel}`);
        await fs.copyFile(path.join(dir, rel), path.join(dir, 'workdir', rel));
      }
    });
    // Everything below runs the bot's own code: as its Linux user, never as the control plane.
    await step('Setting file permissions', () => this.d.ops.fixPermissions(inst.slug));
    await step('Installing Python dependencies (uv sync)', () => this.d.ops.runTask(inst.slug, 'python-deps'));
    await step('Building the web app', () => this.d.ops.runTask(inst.slug, 'webapp-build'));
    await step('Creating database tables (alembic)', () => this.d.ops.runTask(inst.slug, 'python-migrate'));
    await step('Checking the database', async () => {
      const out = (await this.d.tools.sql(db, provider.readyCheckSql(ctx))).trim();
      if (!(Number.parseInt(out, 10) > 0)) throw new Error('the database schema was not created as expected');
    });
    // The bot talks to Telegram over MTProto; a webhook left over from another bot would keep
    // Bot API updates queued for nobody.
    await step('Clearing an old Telegram webhook', () => this.d.telegram.deleteWebhook(ctx.botToken));
    await step('Creating the bot service and nginx site', () => this.d.ops.createService(inst.slug, inst.domain, port));
    await step('Issuing the TLS certificate', () => this.d.ops.issueCertificate(inst.domain));
    await step('Starting the bot', () => this.d.ops.waitForService(inst.slug, port));
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
