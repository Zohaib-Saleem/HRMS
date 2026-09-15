import {
  EMPLOYEE_PHOTO_CONTENT_TYPES,
  type EmployeePhotoContentType,
} from '@hrms/shared';

/**
 * What an uploaded file actually is.
 *
 * The Content-Type header is written by whoever made the request, and a
 * filename is worse than useless - `photo.jpg` says nothing about the bytes
 * behind it. So neither is trusted: the format is read out of the file's own
 * header, and a file whose header is not one of the three allowed formats is
 * refused however it was announced.
 *
 * This is a signature check, not a decoder. It establishes that the bytes begin
 * the way a JPEG, PNG or WebP begins - enough to refuse an executable, an HTML
 * document, an SVG or a PDF that arrived claiming to be an image, which is the
 * attack this is here to stop. It is not a claim that the file is a valid,
 * fully-decodable image; nothing on the server ever decodes it, and the browser
 * that does is sent it with `X-Content-Type-Options: nosniff` and the sniffed
 * type rather than the declared one.
 */

/** Longest signature we compare, so a shorter file is refused without a read. */
const MIN_BYTES = 12;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Reads the format from the leading bytes, or null if it is not one of ours.
 *
 *   JPEG  FF D8 FF                         (SOI followed by the first marker)
 *   PNG   89 50 4E 47 0D 0A 1A 0A          (the full 8-byte signature)
 *   WebP  "RIFF" .... "WEBP"               (a RIFF container of form-type WEBP)
 */
export function sniffImageType(data: Buffer): EmployeePhotoContentType | null {
  if (data.length < MIN_BYTES) return null;

  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';

  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';

  if (
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

/** True for a format this system stores. Kept next to the sniffer on purpose. */
export function isSupportedImageType(value: string): value is EmployeePhotoContentType {
  return (EMPLOYEE_PHOTO_CONTENT_TYPES as readonly string[]).includes(value);
}
