import path from 'node:path';
import { fileURLToPath } from 'node:url';

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value !== '' ? value : fallback;
}

function parseTrustProxy(value: string): string | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

const root = env('FLEET_DIR', '/opt/fleetpanel');

export const config = {
  root,
  dataDir: env('DATA_DIR', path.join(root, 'data')),
  instancesDir: env('INSTANCES_DIR', path.join(root, 'instances')),
  backupsDir: env('BACKUPS_DIR', path.join(root, 'backups')),
  masterKeyFile: env('MASTER_KEY_FILE', path.join(root, 'config', 'master.key')),
  helperPath: env('HELPER_PATH', '/usr/local/sbin/fleetpanel-helper'),
  // Vite builds the UI into dist/public, next to the compiled server.
  webDir: env('WEB_DIR', path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')),
  // The panel is always published through nginx; never bind to a public interface.
  host: env('HOST', '127.0.0.1'),
  port: Number.parseInt(env('PORT', '3000'), 10),
  cookieSecure: env('COOKIE_SECURE', 'true') !== 'false',
  // nginx runs on the same host, so only loopback is a trusted proxy.
  trustProxy: parseTrustProxy(env('TRUST_PROXY', 'loopback')),
  backupRetention: Number.parseInt(env('BACKUP_RETENTION', '7'), 10),
};
