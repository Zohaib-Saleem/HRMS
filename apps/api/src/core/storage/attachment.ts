import {
  CASE_ATTACHMENT_CONTENT_TYPES,
  type CaseAttachmentContentType,
} from '@hrms/shared';

/**
 * What an uploaded attachment actually is.
 *
 * The sibling of `image.ts`, and built on the same refusal to believe anybody.
 * The Content-Type header is written by whoever made the request and a filename
 * says nothing about the bytes behind it, so neither decides anything: the
 * format is read out of the file's own leading bytes, and a file whose header
 * matches nothing we accept is refused however it was announced.
 *
 * Two departures from the photo sniffer, both forced by what a helpdesk
 * attachment actually is:
 *
 *   - PDF is accepted. It has a four-byte signature of its own and is what
 *     half the evidence on a case arrives as - a payslip, a bill, a scan.
 *   - Plain text and CSV are accepted, and they have NO signature. There is no
 *     byte sequence that begins a CSV. So they are established negatively: the
 *     file matched none of the binary formats, and it decodes as UTF-8 with no
 *     NUL and no stray control characters. That is a real test and not a
 *     formality - it refuses every executable, archive, image and office
 *     document, all of which fail it within their first few bytes.
 *
 * What is deliberately NOT here is anything ZIP-shaped: .docx, .xlsx, .pptx and
 * every archive share one header, so accepting that header means accepting an
 * arbitrary archive and calling it a Word document. A later phase can look
 * inside one properly; waving it through now would be an accept-anything rule
 * wearing an allow-list's clothes.
 *
 * This is a signature check, not a decoder. Nothing on the server ever parses
 * one of these files, and the browser that does is sent it with
 * `X-Content-Type-Options: nosniff`, the sniffed type rather than the declared
 * one, and - for everything but an image - as a download rather than a page.
 */

/** Longest signature compared, so a shorter file is refused without a read. */
const MIN_BYTES = 12;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `%PDF`. The version and the rest of the header follow; four bytes is the id. */
const PDF_SIGNATURE = Buffer.from('%PDF', 'latin1');

/**
 * The binary formats, by their own leading bytes.
 *
 *   JPEG  FF D8 FF                    (SOI followed by the first marker)
 *   PNG   89 50 4E 47 0D 0A 1A 0A     (the full 8-byte signature)
 *   WebP  "RIFF" .... "WEBP"          (a RIFF container of form-type WEBP)
 *   PDF   "%PDF"
 */
function sniffBinary(data: Buffer): CaseAttachmentContentType | null {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';

  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';

  if (
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  if (data.subarray(0, 4).equals(PDF_SIGNATURE)) return 'application/pdf';

  return null;
}

/**
 * Whether these bytes are text a person could have typed.
 *
 * Two conditions, and both matter. It must decode as UTF-8 - which is checked
 * by round-tripping it, because `toString('utf8')` never throws and silently
 * substitutes U+FFFD for anything invalid, so comparing the re-encoded bytes is
 * the only way to find out. And it must contain no NUL and no C0 control
 * character other than tab, carriage return and line feed, which is what every
 * binary format on earth fails and no text file ever does.
 */
export function isPlainText(data: Buffer): boolean {
  if (data.length === 0) return false;

  const decoded = data.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(data)) return false;

  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i] as number;
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) return false;
  }

  return true;
}

/**
 * The type an attachment is stored and served as, or null to refuse it.
 *
 * `declared` is the only place a client's word is used at all, and only to
 * choose between two types that are byte-identical and are served identically:
 * whether a text file is labelled `text/csv` or `text/plain`. It can never turn
 * a refusal into an acceptance and can never make a binary file into a text
 * one - the sniff has already decided that by the time it is consulted.
 */
export function sniffAttachmentType(
  data: Buffer,
  declared?: string | null,
): CaseAttachmentContentType | null {
  if (data.length < MIN_BYTES) {
    // Too short to compare against a signature. Still admissible as text - a
    // three-line note is a legitimate attachment - and refused otherwise.
    return isPlainText(data) ? textType(declared) : null;
  }

  const binary = sniffBinary(data);
  if (binary) return binary;

  return isPlainText(data) ? textType(declared) : null;
}

/** CSV only when the request said so; plain text for everything else. */
function textType(declared?: string | null): CaseAttachmentContentType {
  return normaliseAttachmentContentType(declared) === 'text/csv' ? 'text/csv' : 'text/plain';
}

/**
 * The declared Content-Type reduced to one we recognise, or null.
 *
 * Parameters are dropped (`text/csv; charset=utf-8`), case is folded, and the
 * two JPEG spellings browsers still emit are folded onto the one we store.
 */
export function normaliseAttachmentContentType(
  value: string | string[] | undefined | null,
): CaseAttachmentContentType | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;

  const type = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'image/jpg' || type === 'image/pjpeg') return 'image/jpeg';

  return (CASE_ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(type)
    ? (type as CaseAttachmentContentType)
    : null;
}

/**
 * Whether a stored file may be rendered in the browser rather than downloaded.
 *
 * Images only. A PDF viewer is a program, and a text file rendered inline is a
 * page served from the API's own origin - neither is worth the risk when the
 * alternative costs the user one click. `nosniff` is sent either way.
 */
export function isInlineViewable(contentType: string): boolean {
  return contentType.startsWith('image/');
}
