import { describe, expect, it } from 'vitest';
import { isInvertedRange, rangesOverlap } from './shift-assignment.js';

/**
 * Overlap detection for shift assignments.
 *
 * `shiftOnDate` resolves a day by taking the latest assignment that covers it,
 * so overlapping rows do not fail loudly - they silently pick a winner. These
 * cases pin the boundaries, particularly the open-ended ones, because an
 * assignment with no end date is the shape almost every real assignment has.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const range = (from: string, to: string | null) => ({
  effectiveFrom: d(from),
  effectiveTo: to === null ? null : d(to),
});

describe('rangesOverlap', () => {
  describe('closed ranges', () => {
    it('detects a plain overlap', () => {
      expect(rangesOverlap(range('2026-01-01', '2026-06-30'), range('2026-06-01', '2026-12-31'))).toBe(true);
    });

    it('allows ranges that do not touch', () => {
      expect(rangesOverlap(range('2026-01-01', '2026-05-31'), range('2026-06-01', '2026-12-31'))).toBe(false);
    });

    it('treats a shared single day as an overlap', () => {
      // effectiveTo is inclusive, so ending and starting on the same date is
      // two shifts on one day, not a clean handover.
      expect(rangesOverlap(range('2026-01-01', '2026-06-01'), range('2026-06-01', '2026-12-31'))).toBe(true);
    });

    it('allows a handover on consecutive days', () => {
      expect(rangesOverlap(range('2026-01-01', '2026-05-31'), range('2026-06-01', null))).toBe(false);
    });

    it('detects full containment', () => {
      expect(rangesOverlap(range('2026-01-01', '2026-12-31'), range('2026-03-01', '2026-04-01'))).toBe(true);
    });

    it('is symmetric', () => {
      const a = range('2026-01-01', '2026-06-30');
      const b = range('2026-06-01', '2026-12-31');
      expect(rangesOverlap(a, b)).toBe(rangesOverlap(b, a));
    });
  });

  describe('open-ended ranges', () => {
    it('an open range overlaps anything starting after it', () => {
      expect(rangesOverlap(range('2026-01-01', null), range('2030-01-01', '2030-12-31'))).toBe(true);
    });

    it('an open range does not reach backwards', () => {
      expect(rangesOverlap(range('2026-06-01', null), range('2025-01-01', '2025-12-31'))).toBe(false);
    });

    it('two open ranges always overlap', () => {
      expect(rangesOverlap(range('2020-01-01', null), range('2030-01-01', null))).toBe(true);
    });

    it('an open range overlaps one that ends on its start date', () => {
      expect(rangesOverlap(range('2026-06-01', null), range('2025-01-01', '2026-06-01'))).toBe(true);
    });
  });

  describe('the historical backfill shape', () => {
    // Every assignment in the F-02 proposal is (earliest date -> null).
    it('rejects a second open assignment for the same employee', () => {
      const existing = range('2025-09-15', null);
      expect(rangesOverlap(existing, range('2026-09-09', null))).toBe(true);
    });

    it('accepts a re-run only after the first has been closed off', () => {
      const closed = range('2025-09-15', '2026-09-08');
      expect(rangesOverlap(closed, range('2026-09-09', null))).toBe(false);
    });
  });
});

describe('isInvertedRange', () => {
  it('flags an end before the start', () => {
    expect(isInvertedRange(range('2026-06-01', '2026-01-01'))).toBe(true);
  });

  it('accepts a single-day range', () => {
    expect(isInvertedRange(range('2026-06-01', '2026-06-01'))).toBe(false);
  });

  it('accepts an open range', () => {
    expect(isInvertedRange(range('2026-06-01', null))).toBe(false);
  });
});
