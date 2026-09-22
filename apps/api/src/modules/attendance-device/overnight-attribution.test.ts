import { describe, expect, it } from 'vitest';
import { clockBoundary } from '../../core/zoned-time.js';
import {
  punchesBelongingToPreviousDay,
  type OvernightSettings,
} from './overnight-attribution.js';

/**
 * The day that ends after midnight.
 *
 * Taken from a real September: an employee arrives 08:55 on the Monday, works
 * very late, and badges out at 00:29 on the Tuesday. Before this rule the
 * Monday was left open and earned nothing, and the Tuesday was scored PRESENT
 * from a 00:29 "arrival" and an 09:27 "departure" - 538 minutes the person did
 * not work, on a day it also called ABSENT.
 */

const ZONE = 'Asia/Karachi';
const MONDAY = '2026-09-21';
const TUESDAY = '2026-09-22';

const at = (dayKey: string, hhmm: string): Date => {
  const instant = clockBoundary(dayKey, hhmm, ZONE);
  if (!instant) throw new Error(`bad time ${hhmm}`);
  return instant;
};

const punch = (id: string, dayKey: string, hhmm: string, punchState: string | null = null) => ({
  id,
  punchedAt: at(dayKey, hhmm),
  punchState,
});

const SETTINGS: OvernightSettings = {
  windowMinutes: 1080,
  cutoff: '06:00',
  timeZone: ZONE,
  pairing: 'FIRST_IN_LAST_OUT',
  duplicateWindowSeconds: 60,
};

const decide = (
  previousDayPunches: ReturnType<typeof punch>[],
  dayPunches: ReturnType<typeof punch>[],
  settings: Partial<OvernightSettings> = {},
) =>
  punchesBelongingToPreviousDay({
    dayKey: TUESDAY,
    previousDayPunches,
    dayPunches,
    settings: { ...SETTINGS, ...settings },
  });

describe('the reported case: out at 00:29 after arriving 08:55', () => {
  const monday = [punch('mon-in', MONDAY, '08:55')];
  const tuesday = [punch('tue-out', TUESDAY, '00:29'), punch('tue-in', TUESDAY, '09:27')];

  it('gives the 00:29 punch back to Monday', () => {
    expect(decide(monday, tuesday)).toEqual(['tue-out']);
  });

  it('leaves the 09:27 arrival on Tuesday, which is the other half of the fix', () => {
    expect(decide(monday, tuesday)).not.toContain('tue-in');
  });
});

describe('the previous day has to be waiting for a departure', () => {
  it('moves nothing when yesterday already closed', () => {
    const closed = [punch('in', MONDAY, '08:55'), punch('out', MONDAY, '18:10')];
    expect(decide(closed, [punch('early', TUESDAY, '00:29')])).toEqual([]);
  });

  it('moves nothing when yesterday has no punches at all', () => {
    expect(decide([], [punch('early', TUESDAY, '00:29')])).toEqual([]);
  });
});

describe('the window is measured from the arrival', () => {
  it('accepts a 17-hour day, which the real data contains', () => {
    const monday = [punch('in', MONDAY, '08:50')];
    expect(decide(monday, [punch('late', TUESDAY, '01:51')])).toEqual(['late']);
  });

  it('refuses a punch beyond the window, where a forgotten departure is likelier', () => {
    const monday = [punch('in', MONDAY, '06:30')];
    // 06:30 + 1080 minutes = 00:30; this punch is half an hour past it.
    expect(decide(monday, [punch('late', TUESDAY, '01:00')])).toEqual([]);
  });

  it('is switched off entirely by a window of zero', () => {
    const monday = [punch('in', MONDAY, '08:55')];
    expect(decide(monday, [punch('early', TUESDAY, '00:29')], { windowMinutes: 0 })).toEqual([]);
  });
});

describe('the cutoff guards the morning', () => {
  it('refuses a punch at or after the cutoff however open yesterday looks', () => {
    const monday = [punch('in', MONDAY, '17:00')];
    // Within the window from 17:00, but 08:00 is an arrival, not a departure.
    expect(decide(monday, [punch('morning', TUESDAY, '08:00')])).toEqual([]);
  });

  it('follows the company setting rather than a constant', () => {
    const monday = [punch('in', MONDAY, '14:00')];
    const tuesday = [punch('early', TUESDAY, '03:30')];

    expect(decide(monday, tuesday, { cutoff: '06:00' })).toEqual(['early']);
    expect(decide(monday, tuesday, { cutoff: '02:00' })).toEqual([]);
  });
});

describe('only a leading run moves', () => {
  it('stops at the first punch that stays, so a later early punch is safe', () => {
    const monday = [punch('in', MONDAY, '09:00')];
    const tuesday = [
      punch('a', TUESDAY, '00:29'),
      punch('b', TUESDAY, '00:31'),
      punch('c', TUESDAY, '09:27'),
      punch('d', TUESDAY, '23:50'),
    ];

    expect(decide(monday, tuesday)).toEqual(['a', 'b']);
  });
});
