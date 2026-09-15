import { describe, expect, it } from 'vitest';
import { sniffImageType } from './image.js';

/**
 * What an uploaded file actually is.
 *
 * The point of this module is that neither the Content-Type header nor the
 * filename is consulted, so the cases worth asserting are the ones where a file
 * is not what it says it is: a script, an HTML page or an SVG announced as a
 * photograph. Each of those is a stored-XSS vector if it is ever served back
 * with a type a browser will execute, and refusing them at the door is cheaper
 * than relying on the headers that stop them later.
 */

/** Enough bytes past the signature to clear the minimum length. */
const pad = (...prefix: number[]) => Buffer.concat([Buffer.from(prefix), Buffer.alloc(16)]);

describe('recognising the formats we store', () => {
  it('reads a JPEG', () => {
    expect(sniffImageType(pad(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
  });

  it('reads a PNG', () => {
    expect(sniffImageType(pad(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
  });

  it('reads a WebP', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x20, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP', 'latin1'),
      Buffer.alloc(16),
    ]);
    expect(sniffImageType(webp)).toBe('image/webp');
  });
});

describe('refusing everything else', () => {
  it.each([
    ['a GIF', Buffer.from('GIF89a________________', 'latin1')],
    ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'latin1')],
    ['an HTML page', Buffer.from('<!doctype html><script>alert(1)</script>', 'latin1')],
    ['a PDF', Buffer.from('%PDF-1.7________________', 'latin1')],
    ['a ZIP or Office file', Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.alloc(16)])],
    ['an ELF binary', Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...Buffer.alloc(16)])],
    ['a shell script', Buffer.from('#!/bin/sh\nrm -rf /\n________', 'latin1')],
    ['a RIFF container that is not WebP', Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x20, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'latin1'),
      Buffer.alloc(16),
    ])],
  ])('refuses %s', (_label, bytes) => {
    expect(sniffImageType(bytes)).toBeNull();
  });

  it('refuses a file too short to carry a signature', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  it('refuses a payload that only starts to look like a PNG', () => {
    // The first four bytes match and the rest of the signature does not, which
    // a looser check would wave through.
    expect(sniffImageType(pad(0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00))).toBeNull();
  });
});
