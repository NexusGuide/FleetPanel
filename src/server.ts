import { config } from './config.js';
import { openDb } from './db.js';
import { AuditLog } from './audit.js';
import { SecretStore } from './secrets.js';
import { SecretBox } from './security/crypto.js';
import { SessionStore } from './http/sessions.js';
import { createApp } from './http/app.js';
import { SudoHelper } from './system/helper.js';
import { gitCheckout } from './system/git.js';
import { systemToolchain } from './system/toolchain.js';
import { TelegramApi } from './services/telegram.js';
import { BackupService } from './services/backups.js';
import { InstanceService } from './services/instances.js';
import { ControlBackupService } from './services/controlBackup.js';
import { SettingsStore } from './settings.js';
import { log } from './log.js';
import { VERSION } from './version.js';

function main(): void {
  // Refuses to start without a correctly protected master key: no silent key generation.
  const box = SecretBox.fromFile(config.masterKeyFile);
  const db = openDb();
  const audit = new AuditLog(db);
  const sessions = new SessionStore(db);
  const secrets = new SecretStore(db, box);
  const ops = new SudoHelper(config.helperPath);
  const telegram = new TelegramApi();

  const backups = new BackupService({
    db,
    audit,
    secrets,
    ops,
    instancesDir: config.instancesDir,
    backupsDir: config.backupsDir,
    retention: config.backupRetention,
  });
  const instances = new InstanceService({
    db,
    audit,
    secrets,
    ops,
    telegram,
    backups,
    git: gitCheckout,
    tools: systemToolchain,
    instancesDir: config.instancesDir,
  });
  instances.recoverInterrupted();
  instances.flagMissingInstalls();

  const controlBackup = new ControlBackupService({
    db,
    settings: new SettingsStore(db, box),
    telegram,
    audit,
    masterKeyFile: config.masterKeyFile,
    version: VERSION,
  });
  controlBackup.start();

  const admins = (db.prepare('SELECT COUNT(*) AS n FROM admins').get() as { n: number }).n;
  if (admins === 0) log.warn('No administrators exist yet. Create one with: sudo fleetpanel create-admin <username>');

  const app = createApp({
    db,
    sessions,
    audit,
    instances,
    backups,
    controlBackup,
    cookieSecure: config.cookieSecure,
    trustProxy: config.trustProxy,
    dataRoot: config.root,
    webDir: config.webDir,
  });
  setInterval(() => sessions.purgeExpired(), 10 * 60_000).unref();

  const server = app.listen(config.port, config.host, () => {
    log.info(`FleetPanel ${VERSION} listening on ${config.host}:${config.port}`);
  });
  // A bot database upload plus its import can outlast Node's 5-minute default; nginx in front
  // still limits how long a client may stall between reads.
  server.requestTimeout = 60 * 60_000;

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (err) {
  log.error('Fatal startup error', err);
  process.exit(1);
}
