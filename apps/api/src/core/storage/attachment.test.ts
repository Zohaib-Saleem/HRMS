import { describe, expect, it } from 'vitest';
import {
  isInlineViewable,
  isPlainText,
  normaliseAttachmentContentType,
  sniffAttachmentType,
} from './attachment.js';

/**
 * What an uploaded attachment actually is.
 *
 * The rule under test is a single sentence - the bytes decide, not the header -
 * and almost every case below is a way somebody might try to get round it. The
 * two that are not are the text formats, which have no signature at all and are
 * therefore established negatively: this is not any binary format we know, and
 * it decodes as UTF-8 with nothing but printable characters, tabs and newlines
 * in it. That is a real test rather than a formality, and the executable and
 * archive cases are here to show it holding.
 */

/**
 * A header followed by binary padding.
 *
 * The fill byte is NUL rather than something printable, and that matters: a
 * file consisting of nothing but printable characters really IS a text file,
 * whatever four bytes it happens to begin with, and would be stored as one -
 * correctly, and harmlessly, since text is served as a download. Padding the
 * fixtures with `A` would have made every "binary" case below a text file and
 * quietly turned the refusal tests into nothing. Real executables, archives and
 * images all contain NULs within their first few dozen bytes.
 */
const pad = (head: number[] | string, length = 64) =>
  Buffer.concat([
    typeof head === 'string' ? Buffer.from(head, 'latin1') : Buffer.from(head),
    Buffer.alloc(length, 0x00),
  ]);

const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(32, 0x41),
]);
const PDF = pad('%PDF-1.7\n');
const GIF = pad('GIF89a');
const ELF = pad([0x7f, 0x45, 0x4c, 0x46]);
// `MZ` plus the two bytes that follow it in a real DOS header.
const EXE = pad([0x4d, 0x5a, 0x90, 0x00]);
const ZIP = pad([0x50, 0x4b, 0x03, 0x04]);

describe('sniffing an attachment', () => {
  it('recognises the four binary formats from their own headers', () => {
    expect(sniffAttachmentType(JPEG)).toBe('image/jpeg');
    expect(sniffAttachmentType(PNG)).toBe('image/png');
    expect(sniffAttachmentType(WEBP)).toBe('image/webp');
    expect(sniffAttachmentType(PDF)).toBe('application/pdf');
  });

  it('ignores a declared type that disagrees with the bytes', () => {
    // Every one of these is a PNG, however it was announced.
    for (const declared of ['application/pdf', 'text/csv', 'image/jpeg', undefined]) {
      expect(sniffAttachmentType(PNG, declared)).toBe('image/png');
    }
  });

  it('refuses an executable, an archive and a format we do not accept', () => {
    for (const bytes of [ELF, EXE, ZIP, GIF]) {
      // Announced as something allowed, which is what an attacker would do.
      expect(sniffAttachmentType(bytes, 'application/pdf')).toBeNull();
      expect(sniffAttachmentType(bytes, 'text/plain')).toBeNull();
    }
  });

  it('accepts text, and uses the declared type only to choose between two labels', () => {
    const csv = Buffer.from('date,amount\n2026-09-01,1200\n', 'utf8');

    expect(sniffAttachmentType(csv, 'text/csv')).toBe('text/csv');
    expect(sniffAttachmentType(csv, 'text/plain')).toBe('text/plain');
    // No claim at all, and a claim we do not recognise, both land on plain.
    expect(sniffAttachmentType(csv)).toBe('text/plain');
    expect(sniffAttachmentType(csv, 'application/x-made-up')).toBe('text/plain');
  });

  it('treats an all-printable file as text, whatever it begins with', () => {
    /*
     * Stated rather than left implicit, because it looks like a hole and is
     * not. A file with no NUL and no control character in it is text by every
     * definition that matters here; what makes it safe is not the sniff but
     * what happens afterwards - it is stored as text/plain, served with
     * `nosniff`, and sent as a download rather than as a page.
     */
    expect(sniffAttachmentType(Buffer.from('MZ this is not really an executable', 'utf8'))).toBe(
      'text/plain',
    );
  });

  it('accepts a file too short to carry a signature, if it is text', () => {
    expect(sniffAttachmentType(Buffer.from('hello', 'utf8'))).toBe('text/plain');
    // Too short AND binary is still a refusal.
    expect(sniffAttachmentType(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
  });

  it('refuses an empty file', () => {
    expect(sniffAttachmentType(Buffer.alloc(0))).toBeNull();
  });
});

describe('deciding whether bytes are text', () => {
  it('accepts ordinary text, including tabs, newlines and non-ASCII', () => {
    expect(isPlainText(Buffer.from('a\tb\r\nc\n', 'utf8'))).toBe(true);
    expect(isPlainText(Buffer.from('Ayesha Khan - salary query - £120', 'utf8'))).toBe(true);
    expect(isPlainText(Buffer.from('mixed éèê and 你好', 'utf8'))).toBe(true);
  });

  it('refuses a NUL, which no text file has and every binary one does', () => {
    expect(isPlainText(Buffer.from([0x68, 0x69, 0x00, 0x6f, 0x6b]))).toBe(false);
  });

  it('refuses other control characters', () => {
    expect(isPlainText(Buffer.from([0x68, 0x69, 0x07]))).toBe(false);
  });

  it('refuses bytes that are not valid UTF-8', () => {
    /*
     * The case that needs the round trip. `toString('utf8')` never throws - it
     * substitutes U+FFFD - so a decode that "worked" proves nothing, and only
     * re-encoding and comparing catches this.
     */
    expect(isPlainText(Buffer.from([0x68, 0x69, 0xff, 0xfe]))).toBe(false);
  });

  it('refuses an empty buffer', () => {
    expect(isPlainText(Buffer.alloc(0))).toBe(false);
  });
});

describe('normalising a declared content type', () => {
  it('drops parameters and folds case', () => {
    expect(normaliseAttachmentContentType('TEXT/CSV; charset=utf-8')).toBe('text/csv');
    expect(normaliseAttachmentContentType('  application/pdf ')).toBe('application/pdf');
  });

  it('folds the JPEG spellings browsers still emit', () => {
    expect(normaliseAttachmentContentType('image/jpg')).toBe('image/jpeg');
    expect(normaliseAttachmentContentType('image/pjpeg')).toBe('image/jpeg');
  });

  it('is null for anything we do not store', () => {
    expect(normaliseAttachmentContentType('application/zip')).toBeNull();
    expect(normaliseAttachmentContentType(undefined)).toBeNull();
    expect(normaliseAttachmentContentType('')).toBeNull();
  });
});

describe('deciding how to serve a file back', () => {
  it('renders only images in the page', () => {
    expect(isInlineViewable('image/png')).toBe(true);
    expect(isInlineViewable('image/jpeg')).toBe(true);
    // A PDF viewer is a program, and a text file rendered inline is a page on
    // the API's own origin. Both are downloads.
    expect(isInlineViewable('application/pdf')).toBe(false);
    expect(isInlineViewable('text/plain')).toBe(false);
    expect(isInlineViewable('text/csv')).toBe(false);
  });
});
