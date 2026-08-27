import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id password hashing.
 *
 * Parameters follow the OWASP baseline (19 MiB, t=2, p=1). @node-rs/argon2
 * ships prebuilt binaries, so no C/Rust toolchain is required on Windows.
 */
const OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashValue, plain, OPTIONS);
  } catch {
    // Malformed hash in the database - treat as a failed attempt, never a crash.
    return false;
  }
}
