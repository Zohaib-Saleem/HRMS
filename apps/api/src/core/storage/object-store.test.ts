import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The file store, and the one thing it must never do.
 *
 * This is the first place in the HRMS that turns something a request influenced
 * into a path on disk, so the property worth pinning down is not that a file
 * round-trips - it is that no key can name a file outside the store. The API
 * process can read the .env and write anywhere its user can; a traversal here
 * would be the whole system.
 *
 * Keys are generated server-side, so none of the hostile inputs below can
 * actually be reached through an endpoint today. They are asserted anyway,
 * because "the caller never passes a bad key" is a property of today's callers
 * and not of this module.
 */

// Set before the module is imported: env is read and frozen at import time.
const root = await mkdtemp(join(tmpdir(), 'hrms-object-store-'));
process.env.STORAGE_ROOT = root;

const { deleteObject, getObject, isValidObjectKey, putObject, storageRoot } = await import(
  './object-store.js'
);

/** A file outside the store, which nothing below is allowed to reach. */
const outsidePath = join(root, '..', 'hrms-object-store-outsider.txt');

beforeAll(async () => {
  await writeFile(outsidePath, 'untouched');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outsidePath, { force: true });
});

describe('object keys', () => {
  it('accepts the shape the photo routes generate', () => {
    expect(isValidObjectKey('employee-photos/cmp_1/emp_1/abc-123.jpg')).toBe(true);
    expect(isValidObjectKey('a.png')).toBe(true);
  });

  it.each([
    ['a parent traversal', '../secret.txt'],
    ['a traversal in the middle', 'employee-photos/../../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['a Windows absolute path', 'C:\\Windows\\system.ini'],
    ['a backslash separator', 'employee-photos\\..\\..\\etc\\passwd'],
    ['a leading dot', '.env'],
    ['a hidden segment', 'employee-photos/.ssh/id_rsa'],
    ['an empty segment', 'employee-photos//photo.jpg'],
    ['an empty key', ''],
    ['a NUL byte', 'photo.jpg\u0000.txt'],
    ['a URL-encoded traversal', '%2e%2e/secret.txt'],
  ])('refuses %s', (_label, key) => {
    expect(isValidObjectKey(key)).toBe(false);
  });

  it.each([
    '../hrms-object-store-outsider.txt',
    '/etc/passwd',
    'employee-photos/../../../tmp/evil.txt',
  ])('refuses to read, write or delete through %s', async (key) => {
    await expect(putObject(key, Buffer.from('x'))).rejects.toThrow(/unsafe object key/i);
    await expect(getObject(key)).rejects.toThrow(/unsafe object key/i);
    await expect(deleteObject(key)).rejects.toThrow(/unsafe object key/i);
  });

  it('leaves a file outside the root untouched after a traversal attempt', async () => {
    await putObject('../hrms-object-store-outsider.txt', Buffer.from('overwritten')).catch(
      () => undefined,
    );

    expect(await readFile(outsidePath, 'utf8')).toBe('untouched');
  });
});

describe('storing and reading objects', () => {
  it('round-trips bytes unchanged', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
    await putObject('employee-photos/c1/e1/photo.jpg', bytes);

    expect(await getObject('employee-photos/c1/e1/photo.jpg')).toEqual(bytes);
  });

  it('creates the directories a nested key implies', async () => {
    await putObject('employee-photos/c9/e9/deep/photo.png', Buffer.from('png'));

    expect(await getObject('employee-photos/c9/e9/deep/photo.png')).toEqual(Buffer.from('png'));
  });

  it('answers null rather than throwing for a key that was never written', async () => {
    expect(await getObject('employee-photos/c1/e1/absent.jpg')).toBeNull();
  });

  it('replaces the bytes at an existing key', async () => {
    await putObject('employee-photos/c1/e2/photo.jpg', Buffer.from('first'));
    await putObject('employee-photos/c1/e2/photo.jpg', Buffer.from('second'));

    expect(await getObject('employee-photos/c1/e2/photo.jpg')).toEqual(Buffer.from('second'));
  });

  it('leaves no staging file behind', async () => {
    await putObject('employee-photos/c1/e3/photo.jpg', Buffer.from('bytes'));

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(join(storageRoot(), 'employee-photos/c1/e3'));
    expect(entries).toEqual(['photo.jpg']);
  });

  it('deletes, and reports whether there was anything to delete', async () => {
    await putObject('employee-photos/c1/e4/photo.jpg', Buffer.from('bytes'));

    expect(await deleteObject('employee-photos/c1/e4/photo.jpg')).toBe(true);
    expect(await getObject('employee-photos/c1/e4/photo.jpg')).toBeNull();
    // Idempotent: deleting what is already gone is the state that was asked for.
    expect(await deleteObject('employee-photos/c1/e4/photo.jpg')).toBe(false);
  });
});
