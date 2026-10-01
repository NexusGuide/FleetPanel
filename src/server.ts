import { config } from './config.js';
import { openDb } from './db.js';
import { AuditLog } from './audit.js';
import { SecretStore } from './secrets.js';
import { SecretBox } from './security/crypto.js';
import { SessionStore } from './http/sessions.js';
import { createApp } from './http/app.js';
import { SudoHelper } from './system/helper.js';
import { gitClone } from './system/git.js';
import { systemToolchain } from './system/toolchain.js';
import { TelegramApi } from './services/telegram.js';
import { BackupService } from './services/backups.js';
import { InstanceService } from './services/instances.js';
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
    telegram: new TelegramApi(),
    backups,
    git: gitClone,
    tools: systemToolchain,
    instancesDir: config.instancesDir,
  });
  instances.recoverInterrupted();

  const admins = (db.prepare('SELECT COUNT(*) AS n FROM admins').get() as { n: number }).n;
  if (admins === 0) log.warn('No administrators exist yet. Create one with: sudo fleetbot create-admin <username>');

  const app = createApp({
    db,
    sessions,
    audit,
    instances,
    backups,
    cookieSecure: config.cookieSecure,
    trustProxy: config.trustProxy,
    dataRoot: config.root,
    webDir: config.webDir,
  });
  setInterval(() => sessions.purgeExpired(), 10 * 60_000).unref();

  const server = app.listen(config.port, config.host, () => {
    log.info(`Fleetbot ${VERSION} listening on ${config.host}:${config.port}`);
  });

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
