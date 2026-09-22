import { describe, expect, it } from 'vitest';
import { clockBoundary } from '../../core/zoned-time.js';
import { computeAttendance, type AttendancePolicy } from './attendance-policy.js';

/**
 * The attendance rules, as configuration.
 *
 * Two things are being proved here. First that the defaults reproduce the
 * confirmed office policy - 09:00-18:00, break inside the window, overtime only
 * after the shift ends, early arrival never earning any. Second, and the reason
 * the settings exist at all, that changing a setting changes the answer: every
 * rule below is exercised in both positions, so none of these numbers can be
 * quietly reintroduced as a literal in the calculation.
 */

const DAY = '2026-09-08';
const ZONE = 'Asia/Karachi';

/** A local wall-clock time on the attendance day, as the instant it happened. */
const at = (hhmm: string): Date => {
  const instant = clockBoundary(DAY, hhmm, ZONE);
  if (!instant) throw new Error(`bad time ${hhmm}`);
  return instant;
};

/** The shipped defaults. Individual cases override one field at a time. */
const DEFAULTS: AttendancePolicy = {
  timeZone: ZONE,
  weekendDays: ['SATURDAY', 'SUNDAY'],
  graceMinutes: 10,
  halfDayMinutes: 240,
  fullDayMinutes: 480,
  earlyLeaveGraceMinutes: 10,
  overtimeEnabled: true,
  overtimeAfterMinutes: 480,
  overtimeDailyCapMinutes: 240,
  locationRestrictionEnabled: false,
  defaultGeofenceRadiusM: 200,
  ipRestrictionEnabled: false,
  allowedCheckInCidrs: [],
  defaultShiftStart: '09:00',
  defaultShiftEnd: '18:00',
  overtimeFromShiftEnd: true,
  overtimeCountsEarlyArrival: false,
  overtimeReducedByLateArrival: false,
  lateTrackingEnabled: true,
  earlyDepartureTrackingEnabled: true,
  fullDayToleranceMinutes: 30,
  irregularCheckInEnabled: true,
  irregularCheckInCutoff: '11:00',
  breakIncludedInWindow: true,
  overtimeMinimumMinutes: 0,
  overtimeRoundingMinutes: 0,
  overtimeWeeklyCapMinutes: null,
  overtimeMonthlyCapMinutes: null,
  missingCheckOutStatus: 'PRESENT',
  missingCheckInStatus: 'ABSENT',
  irregularCheckInMode: 'ABSOLUTE_TIME',
  irregularAfterShiftStartMinutes: 120,
  // Added with the attendance module. The shipped values, which reproduce
  // exactly what the engine did before these rules existed.
  defaultBreakMinutes: 0,
  lateThresholdMinutes: 0,
  earlyLeaveThresholdMinutes: 0,
  weekendWorkRule: 'AS_WORKING_DAY',
  holidayWorkRule: 'AS_WORKING_DAY',
  duplicatePunchWindowSeconds: 60,
  maxPlausibleSpanMinutes: 960,
  allowImplausibleSpans: false,
  overnightCheckOutWindowMinutes: 1080,
  overnightCheckOutCutoff: '06:00',
};

/** Scores one day. `shift` null means "no assignment, use the company window". */
function score(
  inAt: string | null,
  outAt: string | null,
  overrides: Partial<AttendancePolicy> = {},
  shift: { startTime: string; endTime: string } | null = null,
) {
  return computeAttendance({
    day: DAY,
    checkInAt: inAt ? at(inAt) : null,
    checkOutAt: outAt ? at(outAt) : null,
    shift,
    policy: { ...DEFAULTS, ...overrides },
  });
}

describe('default rules reproduce the confirmed office policy', () => {
  it('09:00 -> 18:00 is a full day with no overtime', () => {
    const day = score('09:00', '18:00');
    expect(day.overtimeMinutes).toBe(0);
    expect(day.lateMinutes).toBe(0);
    expect(day.status).toBe('PRESENT');
  });

  it('09:00 -> 18:30 earns 30 minutes', () => {
    expect(score('09:00', '18:30').overtimeMinutes).toBe(30);
  });

  it('09:00 -> 19:00 earns 60 minutes', () => {
    expect(score('09:00', '19:00').overtimeMinutes).toBe(60);
  });

  it('09:15 -> 18:30 is 15 late and 30 overtime, independently', () => {
    const day = score('09:15', '18:30');
    expect(day.lateMinutes).toBe(15);
    expect(day.overtimeMinutes).toBe(30);
  });

  it('08:43 -> 18:00 earns nothing: arriving early is not overtime', () => {
    const day = score('08:43', '18:00');
    expect(day.overtimeMinutes).toBe(0);
    expect(day.lateMinutes).toBe(0);
  });

  it('08:43 -> 18:30 earns 30, measured from the shift end and not from arrival', () => {
    expect(score('08:43', '18:30').overtimeMinutes).toBe(30);
  });

  it('the 60-minute break is never subtracted from the 540-minute window', () => {
    // The regression the whole exercise exists to prevent: 540 elapsed minutes
    // against a 480-minute threshold used to book an hour every ordinary day.
    const day = score('09:00', '18:00');
    expect(day.workedMinutes).toBe(540);
    expect(day.overtimeMinutes).toBe(0);
  });
});

describe('changing a setting changes the result', () => {
  it('lowering the daily cap truncates overtime', () => {
    // 18:00 -> 21:00 is 180 minutes, under the default 240 cap.
    expect(score('09:00', '21:00').overtimeMinutes).toBe(180);
    expect(score('09:00', '21:00', { overtimeDailyCapMinutes: 120 }).overtimeMinutes).toBe(120);
  });

  it('moving the shift end moves where overtime starts', () => {
    expect(score('09:00', '19:00').overtimeMinutes).toBe(60);
    expect(score('09:00', '19:00', { defaultShiftEnd: '18:30' }).overtimeMinutes).toBe(30);
    expect(score('09:00', '19:00', { defaultShiftEnd: '19:00' }).overtimeMinutes).toBe(0);
  });

  it('moving the shift start moves lateness', () => {
    expect(score('09:15', '18:00').lateMinutes).toBe(15);
    expect(score('09:15', '18:00', { defaultShiftStart: '09:30' }).lateMinutes).toBe(0);
  });

  it('the late grace decides whether lateness is recorded at all', () => {
    // Grace decides whether, not how much: past it, the full lateness shows.
    expect(score('09:08', '18:00').lateMinutes).toBe(0);
    expect(score('09:08', '18:00', { graceMinutes: 5 }).lateMinutes).toBe(8);
    expect(score('09:20', '18:00', { graceMinutes: 30 }).lateMinutes).toBe(0);
  });

  it('turning overtime off zeroes it without touching lateness', () => {
    const day = score('09:15', '19:00', { overtimeEnabled: false });
    expect(day.overtimeMinutes).toBe(0);
    expect(day.lateMinutes).toBe(15);
  });

  it('counting early arrival as overtime adds the time before shift start', () => {
    expect(score('08:30', '18:30').overtimeMinutes).toBe(30);
    expect(
      score('08:30', '18:30', { overtimeCountsEarlyArrival: true }).overtimeMinutes,
    ).toBe(60);
  });

  it('letting lateness reduce overtime nets the two off', () => {
    expect(score('09:15', '18:30').overtimeMinutes).toBe(30);
    expect(
      score('09:15', '18:30', { overtimeReducedByLateArrival: true }).overtimeMinutes,
    ).toBe(15);
  });

  it('lateness can never push overtime below zero', () => {
    const day = score('10:30', '18:20', { overtimeReducedByLateArrival: true });
    expect(day.overtimeMinutes).toBe(0);
  });

  it('turning late tracking off stops recording it', () => {
    expect(score('09:15', '18:00', { lateTrackingEnabled: false }).lateMinutes).toBeNull();
  });

  it('turning early departure tracking off stops recording it', () => {
    expect(score('09:00', '17:00').earlyLeaveMinutes).toBe(60);
    expect(
      score('09:00', '17:00', { earlyDepartureTrackingEnabled: false }).earlyLeaveMinutes,
    ).toBeNull();
  });

  it('switching back to the duration model restores the legacy behaviour', () => {
    // Kept configurable because it is what every existing record was scored
    // with. 540 elapsed against a 480 threshold is the old phantom hour.
    const day = score('09:00', '18:00', { overtimeFromShiftEnd: false });
    expect(day.overtimeMinutes).toBe(60);
  });
});

describe('irregular arrivals', () => {
  it('a check-in after the cutoff yields no overtime figure at all', () => {
    const day = score('14:00', '21:00');
    expect(day.irregular).toBe(true);
    // Null, not zero: "cannot be measured" is not "none earned".
    expect(day.overtimeMinutes).toBeNull();
  });

  it('a check-in before the cutoff is scored normally', () => {
    const day = score('10:30', '19:00');
    expect(day.irregular).toBe(false);
    expect(day.overtimeMinutes).toBe(60);
  });

  it('moving the cutoff moves which days are irregular', () => {
    expect(score('12:00', '21:00', { irregularCheckInCutoff: '13:00' }).irregular).toBe(false);
    expect(score('12:00', '21:00', { irregularCheckInCutoff: '11:30' }).irregular).toBe(true);
  });

  it('disabling the cutoff scores a late arrival against the shift anyway', () => {
    const day = score('14:00', '21:00', { irregularCheckInEnabled: false });
    expect(day.irregular).toBe(false);
    expect(day.overtimeMinutes).toBe(180);
  });

  it('an irregular day still records its worked minutes and status', () => {
    // Being irregular suppresses the overtime figure and nothing else: the day
    // is still classified by the ordinary elapsed thresholds, and 420 minutes
    // is a half day under the existing 480-minute full day.
    const day = score('14:00', '21:00');
    expect(day.workedMinutes).toBe(420);
    expect(day.status).toBe('HALF_DAY');
    expect(day.overtimeMinutes).toBeNull();
  });
});

describe('an assigned shift beats the company default', () => {
  const late = { startTime: '10:00', endTime: '19:00' };

  it('overtime starts after the assigned end, not the company one', () => {
    // The blanket-18:00 mistake: this day is 0 overtime, not 60.
    expect(score('10:00', '19:00', {}, late).overtimeMinutes).toBe(0);
    expect(score('10:00', '19:30', {}, late).overtimeMinutes).toBe(30);
  });

  it('lateness is measured against the assigned start', () => {
    expect(score('09:30', '19:00', {}, late).lateMinutes).toBe(0);
    expect(score('10:20', '19:00', {}, late).lateMinutes).toBe(20);
  });

  it('early departure is measured against the assigned end', () => {
    expect(score('10:00', '18:00', {}, late).earlyLeaveMinutes).toBe(60);
  });
});

describe('full day is measured against the scheduled shift, not elapsed time', () => {
  /**
   * The correction. Elapsed time asks "how long were they here?"; a day's
   * worth asks "did they work the day they were rostered for?" - and for a
   * late arrival those disagree. 09:15 -> 18:00 is 525 elapsed against a
   * 540-minute window, and used to score half a day for arriving late.
   */
  const rules = { fullDayMinutes: 540, halfDayMinutes: 270 };

  it('09:00 -> 18:00 is a full day, on time, no overtime', () => {
    const day = score('09:00', '18:00', rules);
    expect(day.status).toBe('PRESENT');
    expect(day.lateMinutes).toBe(0);
    expect(day.overtimeMinutes).toBe(0);
    expect(day.scheduledMinutes).toBe(540);
  });

  it('09:15 -> 18:00 is a FULL DAY with 15 minutes late', () => {
    const day = score('09:15', '18:00', rules);
    expect(day.status).toBe('PRESENT');
    expect(day.lateMinutes).toBe(15);
    expect(day.overtimeMinutes).toBe(0);
  });

  it('09:24 -> 18:00 is a full day with 24 minutes late', () => {
    const day = score('09:24', '18:00', rules);
    expect(day.status).toBe('PRESENT');
    expect(day.lateMinutes).toBe(24);
    expect(day.overtimeMinutes).toBe(0);
  });

  it('09:30 -> 18:00 is a full day with 30 minutes late', () => {
    const day = score('09:30', '18:00', rules);
    expect(day.status).toBe('PRESENT');
    expect(day.lateMinutes).toBe(30);
    expect(day.overtimeMinutes).toBe(0);
  });

  it('08:43 -> 18:00 is a full day, and arriving early earns nothing', () => {
    const day = score('08:43', '18:00', rules);
    expect(day.status).toBe('PRESENT');
    expect(day.overtimeMinutes).toBe(0);
    // Early arrival does not inflate the day either: capped at the shift start.
    expect(day.scheduledMinutes).toBe(540);
  });

  it('09:00 -> 18:30 is a full day with 30 minutes overtime', () => {
    const day = score('09:00', '18:30', rules);
    expect(day.status).toBe('PRESENT');
    expect(day.overtimeMinutes).toBe(30);
    // Staying late does not inflate the day: the extra is overtime, counted once.
    expect(day.scheduledMinutes).toBe(540);
  });

  it('09:15 -> 18:30 is a full day, 15 late and 30 overtime', () => {
    const day = score('09:15', '18:30', rules);
    expect(day.status).toBe('PRESENT');
    expect(day.lateMinutes).toBe(15);
    expect(day.overtimeMinutes).toBe(30);
  });

  it('08:43 -> 18:30 is a full day with 30 minutes overtime', () => {
    const day = score('08:43', '18:30', rules);
    expect(day.status).toBe('PRESENT');
    expect(day.overtimeMinutes).toBe(30);
  });

  it('lateness never shortens the day it is reported against', () => {
    // Same departure, four arrivals: one full day each, four different
    // lateness figures. Charging lateness twice is the bug being fixed.
    for (const [arrival, late] of [['09:00', 0], ['09:15', 15], ['09:24', 24], ['09:30', 30]] as const) {
      const day = score(arrival, '18:00', rules);
      expect(day.status).toBe('PRESENT');
      expect(day.lateMinutes).toBe(late);
      expect(day.scheduledMinutes).toBe(540);
    }
  });
});

describe('an assigned shift decides the day, not the company window', () => {
  const late = { startTime: '10:00', endTime: '19:00' };
  const rules = { fullDayMinutes: 540, halfDayMinutes: 270 };

  it('10:15 -> 19:00 is a full day with 15 minutes late', () => {
    const day = score('10:15', '19:00', rules, late);
    expect(day.status).toBe('PRESENT');
    expect(day.lateMinutes).toBe(15);
    expect(day.overtimeMinutes).toBe(0);
  });

  it('10:00 -> 19:30 is a full day with 30 minutes overtime', () => {
    const day = score('10:00', '19:30', rules, late);
    expect(day.status).toBe('PRESENT');
    expect(day.overtimeMinutes).toBe(30);
  });

  it('the same punches score differently against the company window', () => {
    // 10:15 -> 19:00 measured against 09:00-18:00 is a late start and an hour
    // of overtime; against the employee's own shift it is an ordinary day.
    const onDefault = score('10:15', '19:00', rules);
    expect(onDefault.overtimeMinutes).toBe(60);
    expect(score('10:15', '19:00', rules, late).overtimeMinutes).toBe(0);
  });
});

describe('short days and irregular days are still not full days', () => {
  const rules = { fullDayMinutes: 540, halfDayMinutes: 270 };

  it('leaving 30 minutes early is still a full day, and still reported as early', () => {
    // Within the 30-minute tolerance: worth reporting, not worth costing the
    // day. The early departure is recorded either way.
    const day = score('09:00', '17:30', rules);
    expect(day.scheduledMinutes).toBe(510);
    expect(day.earlyLeaveMinutes).toBe(30);
    expect(day.overtimeMinutes).toBe(0);
    expect(day.status).toBe('PRESENT');
  });

  it('leaving beyond the tolerance costs the day', () => {
    const day = score('09:00', '17:00', rules);
    expect(day.scheduledMinutes).toBe(480);
    expect(day.earlyLeaveMinutes).toBe(60);
    expect(day.status).toBe('HALF_DAY');
  });

  it('genuinely short attendance still earns a half day', () => {
    expect(score('09:00', '14:00', rules).status).toBe('HALF_DAY');
  });

  it('very short attendance is still absent', () => {
    expect(score('09:00', '11:00', rules).status).toBe('ABSENT');
  });

  it('the tolerance is configurable, and zero restores the strict rule', () => {
    // 09:00 -> 17:30 covers 510 of a 540 window.
    expect(score('09:00', '17:30', { ...rules, fullDayToleranceMinutes: 0 }).status).toBe('HALF_DAY');
    expect(score('09:00', '17:30', { ...rules, fullDayToleranceMinutes: 29 }).status).toBe('HALF_DAY');
    expect(score('09:00', '17:30', { ...rules, fullDayToleranceMinutes: 30 }).status).toBe('PRESENT');
    expect(score('09:00', '17:00', { ...rules, fullDayToleranceMinutes: 60 }).status).toBe('PRESENT');
  });

  it('the tolerance never swallows the half day', () => {
    // Only bites when the tolerance is wider than the gap between the two
    // thresholds. Here half day is 500 and full day 540, so a 100-minute
    // tolerance would put the full-day line at 440 - below the half day, which
    // would retire it entirely. The floor holds it at 500.
    // Half day 500, full day 540, tolerance 100. Unclamped the full-day line
    // would fall to 440 - below the half-day threshold - and a 450-minute day
    // shorter than half a day would be scored a FULL one. The floor holds the
    // line at 500 so it cannot.
    const narrow = { fullDayMinutes: 540, halfDayMinutes: 500, fullDayToleranceMinutes: 100 };

    const short = score('09:00', '16:30', narrow);
    expect(short.scheduledMinutes).toBe(450);
    expect(short.status).toBe('ABSENT');

    const full = score('09:00', '17:30', narrow);
    expect(full.scheduledMinutes).toBe(510);
    expect(full.status).toBe('PRESENT');
  });

  it('the tolerance does not stretch an irregular day', () => {
    // 12:00 -> 20:00 is 480 elapsed and irregular. Applying the tolerance would
    // drop the full-day line to 300 and hand it a full day; scored strictly on
    // elapsed against 540, it is half a day.
    const day = score('12:00', '20:00', { ...rules, fullDayToleranceMinutes: 240 });
    expect(day.irregular).toBe(true);
    expect(day.scheduledMinutes).toBeNull();
    expect(day.workedMinutes).toBe(480);
    expect(day.status).toBe('HALF_DAY');
  });

  it('an irregular day is scored on elapsed time, not credited a full shift', () => {
    // The fabrication this guards against: crediting a 14:00 start with a
    // whole 09:00 day because it happens to run past 18:00.
    const day = score('14:00', '21:00', rules);
    expect(day.irregular).toBe(true);
    expect(day.scheduledMinutes).toBeNull();
    expect(day.workedMinutes).toBe(420);
    expect(day.status).toBe('HALF_DAY');
    expect(day.overtimeMinutes).toBeNull();
  });

  it('an open day stays present and is scored on nothing yet', () => {
    const day = score('09:00', null, rules);
    expect(day.status).toBe('PRESENT');
    expect(day.scheduledMinutes).toBeNull();
    expect(day.overtimeMinutes).toBeNull();
  });

  it('no check-in is still absent', () => {
    expect(score(null, null, rules).status).toBe('ABSENT');
  });

  it('an overnight shift falls back to elapsed rather than guessing', () => {
    const night = { startTime: '22:00', endTime: '06:00' };
    const day = score('09:00', '18:00', rules, night);
    expect(day.scheduledMinutes).toBeNull();
    expect(day.workedMinutes).toBe(540);
    expect(day.status).toBe('PRESENT');
  });
});
