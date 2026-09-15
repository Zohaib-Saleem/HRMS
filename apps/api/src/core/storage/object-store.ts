import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { env } from '../../config/env.js';

/**
 * The file store.
 *
 * The HRMS had no place to put a file before this: every "document" in the
 * system is a link somebody typed. A profile photo cannot be a link, so this is
 * the smallest thing that can hold one - a directory on the server's own disk,
 * addressed by opaque keys, with no external service and nothing to pay for.
 *
 * It is deliberately shaped like an object store rather than like a filesystem,
 * because that is the interface a bucket would present later. Callers hand it a
 * key and bytes; they never see, build or join a path. Swapping the body of
 * these four functions for S3 calls would not change one line anywhere else.
 *
 * Two rules matter more than the rest:
 *
 *   - A key is validated, not sanitised. A key that does not match the pattern
 *     is refused outright rather than cleaned up into something that "looks
 *     safe", because a cleaner is a thing to be outwitted and a rejection is
 *     not. `..` cannot survive the pattern, and the resolved path is checked
 *     against the root afterwards anyway - belt and braces, since the cost of
 *     being wrong here is reading or writing an arbitrary file as the API user.
 *   - A path never leaves this module. Errors raised here name the key, and
 *     the key is ours; nothing a client can see reveals where the file lives.
 */

/**
 * Keys are `segment/segment/...`, each segment starting alphanumeric and
 * containing only `A-Z a-z 0-9 . _ -`.
 *
 * That admits `employee-photos/<cuid>/<uuid>.jpg` and admits nothing with a
 * leading dot, an empty segment, a backslash, a drive letter, a NUL or a `..`
 * anywhere in it.
 */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** Thrown for a key that could never be valid. Never surfaced to a client. */
export class InvalidObjectKeyError extends Error {
  constructor(key: string) {
    super(`Refusing to use an unsafe object key: ${JSON.stringify(key)}`);
    this.name = 'InvalidObjectKeyError';
  }
}

export function isValidObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  if (!KEY_PATTERN.test(key)) return false;
  // Redundant against the pattern - a segment cannot start with a dot - but
  // stated explicitly so the traversal rule is legible rather than inferred.
  return !key.split('/').includes('..');
}

/** The directory every object lives under. Resolved once. */
export function storageRoot(): string {
  return resolve(env.STORAGE_ROOT);
}

/**
 * The absolute path for a key, after proving it stays inside the root.
 *
 * Private on purpose: a path is the one thing this module exists to keep to
 * itself.
 */
function pathFor(key: string): string {
  if (!isValidObjectKey(key)) throw new InvalidObjectKeyError(key);

  const root = storageRoot();
  const full = resolve(root, key);

  // `resolve` collapses `..` before we see the result, so this catches anything
  // the pattern somehow let through, on any platform's separator.
  if (full !== root && !full.startsWith(root + sep)) throw new InvalidObjectKeyError(key);

  return full;
}

/**
 * Writes an object, replacing whatever was at that key.
 *
 * Written to a temporary name in the same directory and then renamed, which is
 * atomic on a single filesystem: a reader either sees the whole old file or the
 * whole new one, never a half-written image. A crash mid-write leaves a stray
 * `.tmp` rather than a corrupt photo.
 */
export async function putObject(key: string, data: Buffer): Promise<void> {
  const full = pathFor(key);
  const directory = dirname(full);
  await mkdir(directory, { recursive: true });

  const staging = `${full}.${randomUUID()}.tmp`;
  try {
    await writeFile(staging, data, { mode: 0o640 });
    await rename(staging, full);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Reads an object, or null when there is nothing at that key. */
export async function getObject(key: string): Promise<Buffer | null> {
  try {
    return await readFile(pathFor(key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Deletes an object. Returns false when there was nothing there.
 *
 * Missing is not an error: the caller's intent is "this should not exist", and
 * it already does not.
 */
export async function deleteObject(key: string): Promise<boolean> {
  const full = pathFor(key);
  try {
    await rm(full);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
