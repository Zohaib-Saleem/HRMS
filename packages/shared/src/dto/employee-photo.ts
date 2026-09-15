/**
 * The employee profile photo: one contract, shared by the browser and the API.
 *
 * Both sides need the same three facts - which image formats are allowed, how
 * big a file may be, and the address a stored photo is served from - and the
 * one thing that must never happen is the two disagreeing. A browser that
 * accepts a 6 MB TIFF and an API that refuses it produces a failure the user
 * cannot act on; a browser that builds a different URL than the API serves
 * produces an avatar that is silently blank.
 *
 * The browser checks are a courtesy that saves a doomed upload. The API repeats
 * every one of them against the bytes it actually received - see
 * `core/storage/image.ts`, which reads the file's own header rather than
 * trusting what the request claimed.
 */

/** The formats a profile photo may be in. */
export const EMPLOYEE_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type EmployeePhotoContentType = (typeof EMPLOYEE_PHOTO_CONTENT_TYPES)[number];

/**
 * Aliases a browser or a camera app may send for the same format.
 *
 * `image/jpg` is not a registered media type but is common enough in the wild
 * that refusing it would read as "your JPEG is not a JPEG".
 */
export const EMPLOYEE_PHOTO_CONTENT_TYPE_ALIASES: Readonly<Record<string, EmployeePhotoContentType>> =
  {
    'image/jpeg': 'image/jpeg',
    'image/jpg': 'image/jpeg',
    'image/pjpeg': 'image/jpeg',
    'image/png': 'image/png',
    'image/webp': 'image/webp',
  };

/**
 * Normalises a Content-Type header to one of the allowed formats.
 *
 * Returns null for anything else, including a header with no type at all.
 * Parameters (`; charset=...`) and case are stripped first, because a header is
 * written by the client and neither is worth a rejection on its own.
 */
export function normaliseEmployeePhotoContentType(
  header: string | null | undefined,
): EmployeePhotoContentType | null {
  if (!header) return null;
  const type = header.split(';')[0]?.trim().toLowerCase() ?? '';
  return EMPLOYEE_PHOTO_CONTENT_TYPE_ALIASES[type] ?? null;
}

/** 5 MB, server-enforced. The browser refuses the same size before uploading. */
export const EMPLOYEE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** For the file input's `accept` attribute. */
export const EMPLOYEE_PHOTO_ACCEPT = EMPLOYEE_PHOTO_CONTENT_TYPES.join(',');

/** Human wording for the two rejections, so both sides say the same thing. */
export const EMPLOYEE_PHOTO_UNSUPPORTED_MESSAGE =
  'That file is not a supported image. Use a JPG, PNG or WebP.';
export const EMPLOYEE_PHOTO_TOO_LARGE_MESSAGE = 'That image is larger than 5 MB.';

/**
 * The longest edge a photo is scaled down to before upload.
 *
 * An avatar is never rendered above 80px, so anything beyond this is bytes
 * nobody sees. The scale preserves the aspect ratio - the square crop is done
 * in CSS at display time, so the stored file is never distorted and a photo can
 * be re-cropped later without having lost anything.
 */
export const EMPLOYEE_PHOTO_MAX_EDGE = 512;

/** The file extension a stored object gets, per format. */
export const EMPLOYEE_PHOTO_EXTENSIONS: Readonly<Record<EmployeePhotoContentType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Where a stored photo is served from.
 *
 * An API path, not a filesystem path: the bytes are behind the same session and
 * the same permission check as the rest of the employee record, and nothing
 * about where the file actually lives is ever sent to a browser.
 *
 * `version` is a cache-buster. The response is `private` and revalidated, so a
 * replaced photo would be picked up anyway - but an `<img>` already on screen
 * only re-fetches when its `src` changes, and that is what this makes happen.
 */
export function employeePhotoUrl(employeeId: string, version?: string | null): string {
  const base = `/api/v1/employees/${encodeURIComponent(employeeId)}/photo`;
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}

/** What the upload and remove endpoints answer with. */
export interface EmployeePhotoResult {
  /** The URL to render, or null when there is neither a photo nor a link. */
  photoUrl: string | null;
  /** True when an uploaded photo is what `photoUrl` points at. */
  hasPhoto: boolean;
  updatedAt: string | null;
}
