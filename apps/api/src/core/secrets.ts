import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Reversible encryption for secrets the system must be able to *use* again.
 *
 * Everything else secret in this codebase is hashed - passwords, session
 * tokens, reset tokens - because it only ever needs to be compared. A device
 * comm key is different: it has to be sent to the device on every connection,
 * so it must come back out. That makes it encryption, not hashing, and the two
 * must not be confused.
 *
 * AES-256-GCM, so a tampered ciphertext fails to decrypt rather than quietly
 * yielding rubbish. The key is derived from SESSION_SECRET, which is already
 * required to be long and is already the thing whose leak compromises the
 * install; adding a second secret to lose would not make anything safer.
 */

const KEY = createHash('sha256').update(`device-secret:${env.SESSION_SECRET}`).digest();
const IV_BYTES = 12;

/** Encrypts to `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enciphered = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    enciphered.toString('base64url'),
  ].join('.');
}

/**
 * Returns null rather than throwing when the value cannot be read.
 *
 * A comm key that fails to decrypt - a rotated SESSION_SECRET, a truncated
 * column - should surface as "the device will not authenticate", which is
 * recoverable by re-entering it. Throwing here would take down every screen
 * that merely lists devices.
 */
export function decryptSecret(value: string | null | undefined): string | null {
  if (!value) return null;

  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;

  try {
    const iv = Buffer.from(parts[1]!, 'base64url');
    const tag = Buffer.from(parts[2]!, 'base64url');
    const payload = Buffer.from(parts[3]!, 'base64url');

    const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
