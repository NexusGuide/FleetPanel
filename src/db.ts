import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export type DB = Database.Database;

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

// Append-only list of migrations. Never edit an entry once released; add a new one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('Owner','Admin','Manager','Support','Viewer')),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    last_login TEXT
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_admin ON sessions(admin_id);

  CREATE TABLE instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    domain TEXT NOT NULL UNIQUE,
    db_name TEXT NOT NULL UNIQUE,
    db_user TEXT NOT NULL UNIQUE,
    bot_username TEXT,
    admin_telegram_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('provisioning','running','stopped','error','deleting')),
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE secrets (
    instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT ${NOW},
    PRIMARY KEY (instance_id, name)
  );

  CREATE TABLE backups (
    id TEXT PRIMARY KEY,
    instance_id INTEGER REFERENCES instances(id) ON DELETE SET NULL,
    slug TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('manual','pre-delete','pre-restore')),
    filename TEXT NOT NULL UNIQUE,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX idx_backups_instance ON backups(instance_id, created_at);

  CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT ${NOW},
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    resource_id TEXT,
    ip TEXT,
    status TEXT NOT NULL CHECK (status IN ('SUCCESS','FAILED')),
    metadata TEXT
  );
  CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
    BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
    BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  `,
];

export function openDb(file: string = path.join(config.dataDir, 'fleetpanel.db')): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version] as string;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
  return db;
}
