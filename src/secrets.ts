import type { DB } from './db.js';
import type { SecretBox } from './security/crypto.js';

export type SecretName = 'bot_token' | 'db_password' | 'webhook_secret';

// Per-instance secrets, encrypted at rest. The AAD binds each ciphertext to its
// instance and name, so ciphertexts cannot be swapped between rows.
export class SecretStore {
  constructor(
    private readonly db: DB,
    private readonly box: SecretBox,
  ) {}

  private aad(instanceId: number, name: SecretName): string {
    return `instance:${instanceId}:${name}`;
  }

  put(instanceId: number, name: SecretName, value: string): void {
    this.db
      .prepare(
        `INSERT INTO secrets (instance_id, name, ciphertext) VALUES (?, ?, ?)
         ON CONFLICT (instance_id, name) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(instanceId, name, this.box.encrypt(value, this.aad(instanceId, name)));
  }

  get(instanceId: number, name: SecretName): string {
    const row = this.db
      .prepare('SELECT ciphertext FROM secrets WHERE instance_id = ? AND name = ?')
      .get(instanceId, name) as { ciphertext: string } | undefined;
    if (!row) throw new Error(`Secret '${name}' is missing for instance ${instanceId}`);
    return this.box.decrypt(row.ciphertext, this.aad(instanceId, name));
  }
}
