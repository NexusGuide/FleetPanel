import crypto from 'node:crypto';
import fs from 'node:fs';

const FORMAT = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM with associated data. Decryption failures always throw. */
export class SecretBox {
  readonly #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
  }

  static fromKey(key: Buffer): SecretBox {
    if (key.length !== 32) throw new Error('Master key must be exactly 32 bytes');
    return new SecretBox(Buffer.from(key));
  }

  /** Loads the master key and refuses to start if anyone but the owner can read it. */
  static fromFile(file: string): SecretBox {
    const stat = fs.statSync(file);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`Master key ${file} is readable by group/others. Fix with: chmod 600 ${file}`);
    }
    return SecretBox.fromKey(fs.readFileSync(file));
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${FORMAT}:${Buffer.concat([iv, tag, body]).toString('base64')}`;
  }

  decrypt(token: string, aad: string): string {
    const separator = token.indexOf(':');
    if (separator < 0 || token.slice(0, separator) !== FORMAT) throw new Error('Unsupported ciphertext format');
    const raw = Buffer.from(token.slice(separator + 1), 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('Ciphertext is truncated');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Alphanumeric only, so it is safe in SQL, shell, PHP and my.cnf contexts. CSPRNG-backed. */
export function generatePassword(length = 32): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHANUMERIC.charAt(crypto.randomInt(ALPHANUMERIC.length));
  return out;
}
