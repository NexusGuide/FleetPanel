import type { AuditLog } from '../audit.js';
import type { DB } from '../db.js';
import type { BackupService } from '../services/backups.js';
import type { ControlBackupService } from '../services/controlBackup.js';
import type { UpstreamWatcher } from '../services/upstream.js';
import type { InstanceService } from '../services/instances.js';
import type { SessionStore } from './sessions.js';

export interface AppDeps {
  db: DB;
  sessions: SessionStore;
  audit: AuditLog;
  instances: InstanceService;
  backups: BackupService;
  controlBackup: ControlBackupService;
  /** Omitted: the providers list carries no upstream status. */
  upstream?: UpstreamWatcher;
  cookieSecure: boolean;
  trustProxy: string | boolean;
  /** Filesystem path whose disk usage the dashboard reports. */
  dataRoot: string;
  /** Built web UI (index.html + assets). Omitted or missing = API only. */
  webDir?: string;
}
