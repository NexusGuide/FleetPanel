import type { DB } from './db.js';
import type { SecretBox } from './security/crypto.js';

/**
 * Panel-wide settings (key/value). Values marked secret are encrypted with the master key,
 * bound to their key name like instance secrets are bound to their instance.
 */
export class SettingsStore {
  constructor(
    private readonly db: DB,
    private readonly box: SecretBox,
  ) {}

  private aad(key: string): string {
    return `setting:${key}`;
  }

  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(key, value);
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }

  getSecret(key: string): string | undefined {
    const value = this.get(key);
    return value === undefined ? undefined : this.box.decrypt(value, this.aad(key));
  }

  setSecret(key: string, value: string): void {
    this.set(key, this.box.encrypt(value, this.aad(key)));
  }

  getJson<T>(key: string): T | undefined {
    const value = this.get(key);
    return value === undefined ? undefined : (JSON.parse(value) as T);
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }
}
