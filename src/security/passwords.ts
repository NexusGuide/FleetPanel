import argon2 from 'argon2';

// RFC 9106 second recommended option (64 MiB, t=3, p=4).
const OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 } as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies a password. When the account does not exist (hash === null) a dummy
 * hash is still verified so response timing does not reveal valid usernames.
 */
export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (hash === null) {
    dummyHash ??= hashPassword('fleetpanel-timing-equalizer');
    await argon2.verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function passwordPolicyErrors(password: string): string[] {
  const errors: string[] = [];
  if (password.length < 12) errors.push('Password must be at least 12 characters.');
  if (password.length > 256) errors.push('Password must be at most 256 characters.');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) errors.push('Password must mix at least three of: lowercase, uppercase, digits, symbols.');
  return errors;
}
