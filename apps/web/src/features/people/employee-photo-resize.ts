import {
  EMPLOYEE_PHOTO_MAX_EDGE,
  type EmployeePhotoContentType,
} from '@hrms/shared';

/**
 * Shrinking a photo before it is uploaded.
 *
 * The server stores what it is given - there is no image library on the API and
 * adding a native one for avatars would be a poor trade. The browser, however,
 * already has a complete image pipeline, and a phone photograph is several
 * megabytes of detail nobody will ever see at 80 pixels across. So the file is
 * scaled here, on the machine that took it.
 *
 * Two rules:
 *
 *   - The aspect ratio is preserved. Both edges are scaled by the same factor;
 *     the square crop happens in CSS at display time, so the stored file is
 *     never distorted and can be re-cropped later without having lost anything.
 *   - A photo already small enough is uploaded untouched. Re-encoding a small
 *     JPEG costs quality and saves nothing.
 *
 * This is a courtesy, not a control. Every limit is enforced again by the API
 * against the bytes it actually receives, so a failure here - an old browser, a
 * canvas the runtime does not provide, a file the decoder does not like - falls
 * back to uploading the original and lets the server have the final word.
 */

/** What the scaled image is re-encoded as, and how hard it is compressed. */
const OUTPUT_TYPE: EmployeePhotoContentType = 'image/jpeg';
const OUTPUT_QUALITY = 0.86;

/** The scaled dimensions for a source of this size, aspect ratio preserved. */
export function scaledSize(
  width: number,
  height: number,
  maxEdge = EMPLOYEE_PHOTO_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };

  const factor = maxEdge / longest;
  return {
    // At least one pixel each way: a 4000x3 panorama must not scale to zero.
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/** Whether this runtime can actually do the work. False under jsdom. */
function canResize(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof createImageBitmap === 'function' &&
    typeof HTMLCanvasElement !== 'undefined'
  );
}

/**
 * Returns the blob to upload: a scaled copy, or the original file unchanged.
 *
 * Never throws. Every failure path is "upload what the user chose", because a
 * photo that uploads at full size is a far better outcome than an error the
 * user cannot act on.
 */
export async function prepareEmployeePhoto(file: File): Promise<Blob> {
  if (!canResize()) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const target = scaledSize(bitmap.width, bitmap.height);

    if (target.width === bitmap.width && target.height === bitmap.height) {
      bitmap.close?.();
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;

    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close?.();
      return file;
    }

    context.drawImage(bitmap, 0, 0, target.width, target.height);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, OUTPUT_TYPE, OUTPUT_QUALITY);
    });

    // Re-encoding that came out larger is re-encoding that was not worth doing.
    if (!blob || blob.size >= file.size) return file;
    return blob;
  } catch {
    return file;
  }
}
