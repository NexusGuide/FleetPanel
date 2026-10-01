import type { AuditLog } from '../audit.js';
import type { DB } from '../db.js';
import type { BackupService } from '../services/backups.js';
import type { InstanceService } from '../services/instances.js';
import type { SessionStore } from './sessions.js';

export interface AppDeps {
  db: DB;
  sessions: SessionStore;
  audit: AuditLog;
  instances: InstanceService;
  backups: BackupService;
  cookieSecure: boolean;
  trustProxy: string | boolean;
}
