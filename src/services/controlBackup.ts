import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from '../db.js';
import type { ActorRef, AuditLog } from '../audit.js';
import type { SettingsStore } from '../settings.js';
import type { TelegramClient, TelegramTarget } from './telegram.js';
import { run } from '../system/exec.js';
import { createRecipient, sealBackup, type BackupRecipient } from '../security/fleetBackup.js';
import { HttpError, errorMessage } from '../errors.js';
import { log } from '../log.js';

export const BACKUP_SCHEDULES = ['hourly', '6h', 'daily'] as const;
export type BackupSchedule = (typeof BACKUP_SCHEDULES)[number];

const INTERVAL_MS: Record<BackupSchedule, number> = { hourly: 3_600_000, '6h': 6 * 3_600_000, daily: 24 * 3_600_000 };
/** Even without changes, send one backup a day so a silent failure gets noticed. */
const HEARTBEAT_MS = 24 * 3_600_000;
const TICK_MS = 5 * 60_000;
const AUDIT_ACTION = 'CONTROL_PLANE_BACKUP';

const KEY = {
  config: 'backup.telegram',
  token: 'backup.telegram.token',
  recipient: 'backup.recipient',
  state: 'backup.state',
} as const;

interface TelegramConfig {
  enabled: boolean;
  chatId: string;
  threadId?: string;
  schedule: BackupSchedule;
}

interface BackupState {
  lastAttemptAt?: string;
  lastSentAt?: string;
  lastHash?: string;
  lastError?: string | null;
  lastFile?: string;
}

export interface BackupSettingsInput {
  enabled: boolean;
  chat_id: string;
  thread_id?: string;
  schedule: BackupSchedule;
  /** Omitted: keep the stored token. */
  bot_token?: string;
  /** Sets (or replaces) the recovery passphrase; never stored. */
  passphrase?: string;
}

export interface BackupSettingsView {
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

export interface ControlBackupDeps {
  db: DB;
  settings: SettingsStore;
  telegram: TelegramClient;
  audit: AuditLog;
  masterKeyFile: string;
  version: string;
  host?: string;
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Encrypted control-plane backups (.fleet): the panel database and master key, never the bots'
 * own data. Sent to a Telegram chat on a schedule, or downloaded from the panel.
 */
export class ControlBackupService {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly host: string;

  constructor(private readonly d: ControlBackupDeps) {
    this.host = (d.host ?? os.hostname()).replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 63) || 'server';
  }

  private config(): TelegramConfig | undefined {
    return this.d.settings.getJson<TelegramConfig>(KEY.config);
  }

  private state(): BackupState {
    return this.d.settings.getJson<BackupState>(KEY.state) ?? {};
  }

  private saveState(patch: BackupState): void {
    this.d.settings.setJson(KEY.state, { ...this.state(), ...patch });
  }

  private recipient(): BackupRecipient | undefined {
    return this.d.settings.getJson<BackupRecipient>(KEY.recipient);
  }

  private target(): TelegramTarget {
    const cfg = this.config();
    const token = this.d.settings.getSecret(KEY.token);
    if (!cfg || !token) throw new HttpError(409, 'backup_not_configured', 'Set up the Telegram backup first.');
    return { token, chatId: cfg.chatId, ...(cfg.threadId ? { threadId: cfg.threadId } : {}) };
  }

  view(): BackupSettingsView {
    const cfg = this.config();
    const st = this.state();
    return {
      enabled: cfg?.enabled ?? false,
      chat_id: cfg?.chatId ?? '',
      thread_id: cfg?.threadId ?? '',
      schedule: cfg?.schedule ?? 'daily',
      has_token: this.d.settings.get(KEY.token) !== undefined,
      bot_username: this.d.settings.get('backup.telegram.bot') ?? null,
      has_passphrase: this.recipient() !== undefined,
      last_sent_at: st.lastSentAt ?? null,
      last_attempt_at: st.lastAttemptAt ?? null,
      last_error: st.lastError ?? null,
      last_file: st.lastFile ?? null,
    };
  }

  async configure(input: BackupSettingsInput, actor: ActorRef): Promise<BackupSettingsView> {
    if (input.bot_token) {
      const bot = await this.d.telegram.getMe(input.bot_token);
      this.d.settings.setSecret(KEY.token, input.bot_token);
      this.d.settings.set('backup.telegram.bot', bot.username);
    }
    if (input.passphrase) this.d.settings.setJson(KEY.recipient, createRecipient(input.passphrase));
    if (input.enabled) {
      if (this.d.settings.get(KEY.token) === undefined) throw new HttpError(400, 'bot_token_required', 'Enter the bot token of the backup bot.');
      if (!this.recipient()) throw new HttpError(400, 'passphrase_required', 'Set a recovery passphrase: backups cannot be restored without it.');
    }
    this.d.settings.setJson(KEY.config, {
      enabled: input.enabled,
      chatId: input.chat_id,
      ...(input.thread_id ? { threadId: input.thread_id } : {}),
      schedule: input.schedule,
    } satisfies TelegramConfig);
    this.d.audit.write({
      actor,
      action: 'BACKUP_SETTINGS_UPDATE',
      resource: 'settings',
      resourceId: 'backup',
      status: 'SUCCESS',
      metadata: {
        enabled: input.enabled,
        schedule: input.schedule,
        chat_id: input.chat_id,
        token_changed: Boolean(input.bot_token),
        passphrase_changed: Boolean(input.passphrase),
      },
    });
    return this.view();
  }

  async sendTest(): Promise<void> {
    await this.d.telegram.sendMessage(this.target(), `FleetPanel (${this.host}): backups will be sent to this chat.`);
  }

  /** Builds the plain tar.gz: fleetpanel.db (without sessions), master.key, manifest.json. */
  private async archive(): Promise<Buffer> {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fleetpanel-cp-'));
    try {
      const dbFile = path.join(work, 'fleetpanel.db');
      // The online backup API gives a consistent copy while the panel keeps writing.
      await this.d.db.backup(dbFile);
      const copy = new Database(dbFile);
      try {
        // Login sessions are short-lived and must not outlive a restore on another server.
        copy.prepare('DELETE FROM sessions').run();
        copy.pragma('journal_mode = DELETE');
        copy.exec('VACUUM');
      } finally {
        copy.close();
      }
      await fs.copyFile(this.d.masterKeyFile, path.join(work, 'master.key'));
      const slugs = (this.d.db.prepare('SELECT slug FROM instances ORDER BY slug').all() as Array<{ slug: string }>).map((r) => r.slug);
      await fs.writeFile(
        path.join(work, 'manifest.json'),
        JSON.stringify({ format: 1, kind: 'control-plane', created_at: new Date().toISOString(), version: this.d.version, host: this.host, instances: slugs }, null, 2),
      );
      const tarFile = path.join(work, 'backup.tar.gz');
      await run('tar', ['-czf', tarFile, '-C', work, 'fleetpanel.db', 'master.key', 'manifest.json']);
      return await fs.readFile(tarFile);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  /** Creates an encrypted backup file in memory. */
  async create(): Promise<{ name: string; data: Buffer; instances: number }> {
    const recipient = this.recipient();
    if (!recipient) throw new HttpError(409, 'passphrase_required', 'Set a recovery passphrase first.');
    const now = new Date();
    const data = sealBackup(await this.archive(), recipient, { created_at: now.toISOString(), host: this.host, version: this.d.version });
    const instances = (this.d.db.prepare('SELECT COUNT(*) AS n FROM instances').get() as { n: number }).n;
    return { name: `fleetpanel-${this.host}-${stamp(now)}.fleet`, data, instances };
  }

  /**
   * Fingerprint of what a backup would contain, without volatile fields (sessions, last login,
   * the backup job's own audit entries), so an unchanged panel is not re-sent every hour.
   */
  private contentHash(): string {
    const q = (sql: string) => this.d.db.prepare(sql).all();
    const parts = {
      admins: q('SELECT id, username, password_hash, role, is_active FROM admins ORDER BY id'),
      instances: q(
        'SELECT id, slug, provider, domain, db_name, db_user, bot_username, admin_telegram_id, source_commit, app_port, status FROM instances ORDER BY id',
      ),
      secrets: q('SELECT instance_id, name, ciphertext FROM secrets ORDER BY instance_id, name'),
      backups: q('SELECT id FROM backups ORDER BY id'),
      audit: q(`SELECT MAX(id) AS id FROM audit_logs WHERE action <> '${AUDIT_ACTION}'`),
      settings: q(`SELECT key, value FROM app_settings WHERE key <> '${KEY.state}' ORDER BY key`),
    };
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }

  /** Creates and sends a backup now. Records the outcome; throws on failure. */
  async sendNow(actor: ActorRef): Promise<{ file: string }> {
    if (this.running) throw new HttpError(409, 'backup_running', 'A backup is already being sent.');
    this.running = true;
    const hash = this.contentHash();
    this.saveState({ lastAttemptAt: new Date().toISOString() });
    try {
      const target = this.target();
      const backup = await this.create();
      const caption = `FleetPanel backup · ${this.host} · v${this.d.version} · ${backup.instances} bot(s)\nRestore: sudo fleetpanel restore ${backup.name}`;
      await this.d.telegram.sendDocument(target, { name: backup.name, data: backup.data }, caption);
      this.saveState({ lastSentAt: new Date().toISOString(), lastHash: hash, lastError: null, lastFile: backup.name });
      this.d.audit.write({ actor, action: AUDIT_ACTION, resource: 'control-plane', resourceId: backup.name, status: 'SUCCESS', metadata: { destination: 'telegram' } });
      return { file: backup.name };
    } catch (err) {
      const message = errorMessage(err).slice(0, 500);
      this.saveState({ lastError: message });
      this.d.audit.write({ actor, action: AUDIT_ACTION, resource: 'control-plane', status: 'FAILED', metadata: { destination: 'telegram', error: message } });
      throw err;
    } finally {
      this.running = false;
    }
  }

  /** Scheduler step: sends when the interval passed and something changed, or once a day regardless. */
  async tick(now = Date.now()): Promise<'sent' | 'skipped' | 'idle'> {
    const cfg = this.config();
    if (!cfg?.enabled || this.running) return 'idle';
    const st = this.state();
    const lastAttempt = st.lastAttemptAt ? Date.parse(st.lastAttemptAt) : 0;
    if (now - lastAttempt < INTERVAL_MS[cfg.schedule]) return 'idle';
    const lastSent = st.lastSentAt ? Date.parse(st.lastSentAt) : 0;
    if (st.lastHash === this.contentHash() && now - lastSent < HEARTBEAT_MS && !st.lastError) {
      this.saveState({ lastAttemptAt: new Date(now).toISOString() });
      return 'skipped';
    }
    await this.sendNow('scheduler');
    return 'sent';
  }

  start(): void {
    if (this.timer) return;
    const step = () => {
      this.tick().catch((err: unknown) => log.warn('Scheduled control-plane backup failed', err));
    };
    this.timer = setInterval(step, TICK_MS);
    this.timer.unref();
    setTimeout(step, 60_000).unref();
  }
}
