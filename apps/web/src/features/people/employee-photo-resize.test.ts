import { describe, expect, it } from 'vitest';
import { EMPLOYEE_PHOTO_MAX_EDGE } from '@hrms/shared';
import { prepareEmployeePhoto, scaledSize } from './employee-photo-resize';

/**
 * Scaling a photo before it is uploaded.
 *
 * The property that matters is that the aspect ratio survives. An avatar is
 * cropped to a circle in CSS, so a scale that squashed one edge would put a
 * distorted face on every screen in the system and there would be no way back
 * to the original - the stored file is all there is.
 */

describe('scaling to fit', () => {
  it('leaves a photo already small enough alone', () => {
    expect(scaledSize(200, 300)).toEqual({ width: 200, height: 300 });
    expect(scaledSize(EMPLOYEE_PHOTO_MAX_EDGE, EMPLOYEE_PHOTO_MAX_EDGE)).toEqual({
      width: EMPLOYEE_PHOTO_MAX_EDGE,
      height: EMPLOYEE_PHOTO_MAX_EDGE,
    });
  });

  it('scales the longest edge down and the other by the same factor', () => {
    // A 4:3 photograph from a phone.
    expect(scaledSize(4032, 3024, 512)).toEqual({ width: 512, height: 384 });
    // The same photograph held the other way up.
    expect(scaledSize(3024, 4032, 512)).toEqual({ width: 384, height: 512 });
  });

  it.each([
    [4032, 3024],
    [3024, 4032],
    [1920, 1080],
    [1000, 1000],
    [2500, 700],
  ])('keeps the aspect ratio of %ix%i', (width, height) => {
    const scaled = scaledSize(width, height, 512);

    expect(scaled.width / scaled.height).toBeCloseTo(width / height, 1);
  });

  it('never scales an edge away to nothing', () => {
    // An extreme panorama: rounding the short edge to zero would produce a
    // canvas that cannot be drawn to.
    const scaled = scaledSize(8000, 3, 512);

    expect(scaled.width).toBe(512);
    expect(scaled.height).toBeGreaterThanOrEqual(1);
  });
});

describe('when the runtime cannot scale', () => {
  it('uploads the original file rather than failing', async () => {
    // Node has no canvas and no createImageBitmap, which is exactly the
    // fallback path an old browser would take.
    const file = new File(['bytes'], 'me.jpg', { type: 'image/jpeg' });

    expect(await prepareEmployeePhoto(file)).toBe(file);
  });
});
