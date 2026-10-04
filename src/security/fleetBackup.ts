import crypto from 'node:crypto';

/**
 * The encrypted control-plane backup format (`.fleet`).
 *
 *   FLEETPANEL-BACKUP 1\n
 *   <header JSON>\n
 *   <AES-256-GCM ciphertext of the tar.gz>
 *
 * Every backup is sealed to an X25519 public key: an ephemeral key pair is generated per file,
 * and HKDF-SHA256 over the shared secret gives the AES key. The matching private key is stored
 * in each file's header, encrypted with a key derived (scrypt) from the operator's recovery
 * passphrase. So restoring needs only the file and the passphrase, while the server keeps just
 * the public key and the wrapped private key: neither a stolen server nor the Telegram chat the
 * files are sent to can open a backup without the passphrase.
 */

const MAGIC = 'FLEETPANEL-BACKUP 1\n';
const HKDF_INFO = 'fleetpanel-backup-v1';
const KEY_AAD = 'fleetpanel-backup-key-v1';
// 64 MiB of memory per guess: slow enough to make guessing a passphrase expensive.
const SCRYPT = { N: 2 ** 16, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export const PASSPHRASE_MIN_LENGTH = 12;

export interface WrappedKey {
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

/** What the server stores to seal backups: the public key and the passphrase-wrapped private key. */
export interface BackupRecipient {
  publicKey: string;
  wrappedKey: WrappedKey;
}

export interface BackupMeta {
  created_at: string;
  host: string;
  version: string;
}

interface Header extends BackupMeta {
  format: 1;
  recipient: string;
  ephemeral: string;
  key: WrappedKey;
  iv: string;
  tag: string;
}

const b64 = (buf: Buffer): string => buf.toString('base64');
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64');

export function passphraseProblems(passphrase: string): string[] {
  const problems: string[] = [];
  if (passphrase.length < PASSPHRASE_MIN_LENGTH) problems.push(`The recovery passphrase must be at least ${PASSPHRASE_MIN_LENGTH} characters.`);
  if (passphrase.length > 512) problems.push('The recovery passphrase must be at most 512 characters.');
  return problems;
}

function passphraseKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return crypto.scryptSync(passphrase.normalize('NFKC'), salt, 32, { ...params, maxmem: SCRYPT_MAXMEM });
}

/** Creates the key pair for a new recovery passphrase. Nothing that can open a backup is returned unwrapped. */
export function createRecipient(passphrase: string): BackupRecipient {
  const problems = passphraseProblems(passphrase);
  if (problems.length > 0) throw new Error(problems.join(' '));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', passphraseKey(passphrase, salt, SCRYPT), iv);
  cipher.setAAD(Buffer.from(KEY_AAD));
  const data = Buffer.concat([cipher.update(privateKey.export({ type: 'pkcs8', format: 'der' })), cipher.final()]);
  return {
    publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })),
    wrappedKey: { kdf: 'scrypt', ...SCRYPT, salt: b64(salt), iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(data) },
  };
}

function unwrapPrivateKey(wrapped: WrappedKey, passphrase: string): crypto.KeyObject {
  if (wrapped.kdf !== 'scrypt' || wrapped.N > 2 ** 20 || wrapped.r > 16 || wrapped.p > 4) throw new Error('Unsupported key format in backup');
  const decipher = crypto.createDecipheriv('aes-256-gcm', passphraseKey(passphrase, unb64(wrapped.salt), wrapped), unb64(wrapped.iv));
  decipher.setAAD(Buffer.from(KEY_AAD));
  decipher.setAuthTag(unb64(wrapped.tag));
  let der: Buffer;
  try {
    der = Buffer.concat([decipher.update(unb64(wrapped.data)), decipher.final()]);
  } catch {
    throw new Error('Wrong recovery passphrase.');
  }
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** True when the passphrase opens this recipient's private key (used before replacing settings). */
export function passphraseMatches(recipient: BackupRecipient, passphrase: string): boolean {
  try {
    unwrapPrivateKey(recipient.wrappedKey, passphrase);
    return true;
  } catch {
    return false;
  }
}

function bodyKey(shared: Buffer, ephemeral: string, recipient: string): Buffer {
  const salt = Buffer.concat([unb64(ephemeral), unb64(recipient)]);
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, HKDF_INFO, 32));
}

function aadOf(h: Pick<Header, 'format' | 'created_at' | 'host' | 'version' | 'recipient' | 'ephemeral'>): Buffer {
  return Buffer.from(
    JSON.stringify([MAGIC, h.format, h.created_at, h.host, h.version, h.recipient, h.ephemeral]),
    'utf8',
  );
}

/**
 * Encrypts a backup for the recipient, then proves the result decrypts to the same bytes
 * (with the ephemeral key, which yields the same shared secret) before returning it.
 */
export function sealBackup(plain: Buffer, recipient: BackupRecipient, meta: BackupMeta): Buffer {
  const recipientKey = crypto.createPublicKey({ key: unb64(recipient.publicKey), format: 'der', type: 'spki' });
  const eph = crypto.generateKeyPairSync('x25519');
  const ephemeral = b64(eph.publicKey.export({ type: 'spki', format: 'der' }));
  const key = bodyKey(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipientKey }), ephemeral, recipient.publicKey);

  const base = { format: 1 as const, ...meta, recipient: recipient.publicKey, ephemeral };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadOf(base));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const header: Header = { ...base, key: recipient.wrappedKey, iv: b64(iv), tag: b64(cipher.getAuthTag()) };

  // Verify: decrypt what was just written.
  const check = crypto.createDecipheriv('aes-256-gcm', key, iv);
  check.setAAD(aadOf(base));
  check.setAuthTag(cipher.getAuthTag());
  const roundTrip = Buffer.concat([check.update(body), check.final()]);
  if (!roundTrip.equals(plain)) throw new Error('Backup verification failed');

  return Buffer.concat([Buffer.from(MAGIC), Buffer.from(`${JSON.stringify(header)}\n`), body]);
}

function parse(file: Buffer): { header: Header; body: Buffer } {
  if (!file.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC))) throw new Error('Not a FleetPanel backup (.fleet) file.');
  const end = file.indexOf(0x0a, MAGIC.length);
  if (end < 0 || end - MAGIC.length > 16_384) throw new Error('Corrupted backup header.');
  let header: Header;
  try {
    header = JSON.parse(file.subarray(MAGIC.length, end).toString('utf8')) as Header;
  } catch {
    throw new Error('Corrupted backup header.');
  }
  if (header.format !== 1) throw new Error(`Unsupported backup format ${String(header.format)}.`);
  return { header, body: file.subarray(end + 1) };
}

/** Reads a backup's unencrypted facts (when, which host, which version) without the passphrase. */
export function backupInfo(file: Buffer): BackupMeta {
  const { header } = parse(file);
  return { created_at: header.created_at, host: header.host, version: header.version };
}

export function openBackup(file: Buffer, passphrase: string): { plain: Buffer; meta: BackupMeta } {
  const { header, body } = parse(file);
  const privateKey = unwrapPrivateKey(header.key, passphrase);
  const ephemeralKey = crypto.createPublicKey({ key: unb64(header.ephemeral), format: 'der', type: 'spki' });
  const key = bodyKey(crypto.diffieHellman({ privateKey, publicKey: ephemeralKey }), header.ephemeral, header.recipient);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64(header.iv));
  decipher.setAAD(aadOf(header));
  decipher.setAuthTag(unb64(header.tag));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error('The backup is damaged or was modified.');
  }
  return { plain, meta: { created_at: header.created_at, host: header.host, version: header.version } };
}
