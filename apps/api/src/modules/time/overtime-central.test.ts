import { describe, expect, it } from 'vitest';
import { clockBoundary } from '../../core/zoned-time.js';
import {
  attendanceFlags,
  computeAttendance,
  nonWorkingDayOvertime,
  type AttendancePolicy,
} from './attendance-policy.js';
import { aggregateDailyTotals } from './attendance-analytics.service.js';
import { buildAttendanceReport, countInto, emptyCount } from './attendance-reports.service.js';
import type { DerivedDay } from './attendance.service.js';
import { collapseDuplicates, pairPunches } from '../attendance-device/attendance-import.service.js';

/**
 * Overtime has one definition, and everything reads it.
 *
 * The failures these cover were all the same failure wearing different hats:
 * a figure computed in one place and re-derived, re-clamped or read from a
 * stale column somewhere else. So the assertions here are mostly equalities
 * BETWEEN consumers - screen against export, report against aggregate - rather
 * than each one against a number typed into this file. A constant in a test is
 * only evidence that the test and the code agree; two consumers agreeing is
 * evidence that a reader will not be told two different things.
 *
 * Nothing below hardcodes a threshold. Every expected value is derived from the
 * policy object the case itself supplies, which is what makes "change the
 * setting, the answer changes" a property the suite can actually check.
 */

const DAY = '2026-09-08'; // a Tuesday
const SATURDAY = '2026-09-12';
const ZONE = 'Asia/Karachi';

const at = (hhmm: string, day: string = DAY): Date => {
  const instant = clockBoundary(day, hhmm, ZONE);
  if (!instant) throw new Error(`bad time ${hhmm}`);
  return instant;
};

/**
 * A company whose numbers are all distinctive, so a hardcoded 480 or 18:00
 * anywhere in the engine shows up as a wrong answer rather than a lucky one.
 */
const POLICY: AttendancePolicy = {
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
  defaultBreakMinutes: 0,
  lateThresholdMinutes: 0,
  earlyLeaveThresholdMinutes: 0,
  weekendWorkRule: 'AS_WORKING_DAY',
  holidayWorkRule: 'AS_WORKING_DAY',
  duplicatePunchWindowSeconds: 60,
  maxPlausibleSpanMinutes: 960,
  allowImplausibleSpans: false,
};

function score(
  inAt: string | null,
  outAt: string | null,
  overrides: Partial<AttendancePolicy> = {},
  day: string = DAY,
) {
  return computeAttendance({
    day,
    checkInAt: inAt ? at(inAt, day) : null,
    checkOutAt: outAt ? at(outAt, day) : null,
    shift: null,
    policy: { ...POLICY, ...overrides },
  });
}

/** Wraps a computation as the derived day every consumer downstream reads. */
function derived(
  computed: ReturnType<typeof computeAttendance>,
  over: Partial<DerivedDay> = {},
  policy: AttendancePolicy = POLICY,
): DerivedDay {
  const base = {
    date: DAY,
    status: computed.status as DerivedDay['status'],
    checkInAt: null,
    checkOutAt: null,
    workedMinutes: computed.workedMinutes,
    expectedMinutes: computed.expectedMinutes,
    lateMinutes: computed.lateMinutes,
    earlyLeaveMinutes: computed.earlyLeaveMinutes,
    overtimeMinutes: computed.overtimeMinutes,
    irregular: computed.irregular,
    integrity: computed.integrity,
    mode: null,
    shiftId: null,
    shiftName: null,
    notes: null,
    leaveTypeName: null,
    leaveIsPaid: null,
    leaveDayPart: null,
    holidayName: null,
    source: 'DEVICE' as const,
    recordId: 'rec-1',
    hasRecord: true,
    ...over,
  };
  return { ...base, flags: attendanceFlags(base, policy) };
}

// ---------------------------------------------------------------- the cases

describe('overtime comes from the configuration, never from a constant', () => {
  it('no overtime: leaving at the configured shift end earns nothing', () => {
    const day = score('09:00', POLICY.defaultShiftEnd);

    expect(day.overtimeMinutes).toBe(0);
    expect(day.status).toBe('PRESENT');
    expect(day.integrity).toBe('COMPLETE');
  });

  it('30 minutes overtime: half an hour past the configured end', () => {
    expect(score('09:00', '18:30').overtimeMinutes).toBe(30);
  });

  it('a changed threshold changes the answer with no code change', () => {
    /**
     * The same punches, scored against two different shift ends. This is the
     * regression that matters most: the figure used to be written to the
     * record at import and read back forever, so a company could move its
     * shift end and watch every historical and current day keep the old
     * number.
     */
    const punchOut = '18:30';

    const before = score('09:00', punchOut);
    const after = score('09:00', punchOut, { defaultShiftEnd: '17:00' });

    expect(before.overtimeMinutes).toBe(30);
    expect(after.overtimeMinutes).toBe(90);
    expect(after.overtimeMinutes).toBeGreaterThan(before.overtimeMinutes!);
  });

  it('the duration model reads its own threshold, not the shift end', () => {
    const day = score('09:00', '19:00', {
      overtimeFromShiftEnd: false,
      overtimeAfterMinutes: 420,
    });

    // 09:00 -> 19:00 is 600 worked; the configured threshold is 420.
    expect(day.workedMinutes).toBe(600);
    expect(day.overtimeMinutes).toBe(600 - 420);
  });

  it('large overtime is credited in full up to the configured daily cap', () => {
    const generous = score('09:00', '23:00', { overtimeDailyCapMinutes: 600 });
    const capped = score('09:00', '23:00', { overtimeDailyCapMinutes: 120 });

    // 18:00 -> 23:00 is five hours, under the generous cap and over the tight one.
    expect(generous.overtimeMinutes).toBe(300);
    expect(capped.overtimeMinutes).toBe(120);
  });

  it('the cap is a setting, so raising it raises the figure', () => {
    const caps = [60, 180, 300].map(
      (overtimeDailyCapMinutes) =>
        score('09:00', '23:00', { overtimeDailyCapMinutes }).overtimeMinutes,
    );

    expect(caps).toEqual([60, 180, 300]);
  });

  it('overtime switched off produces zero rather than a default guess', () => {
    expect(score('09:00', '22:00', { overtimeEnabled: false }).overtimeMinutes).toBe(0);
  });

  it('never exceeds the worked time it is a label on', () => {
    /**
     * Break deducted from the day AND early arrival counting as overtime push
     * the two figures apart. The engine guarantees the relationship so that no
     * consumer has to clamp defensively - which is exactly how the chart and
     * the CSV came to disagree.
     */
    const day = score('06:00', '18:30', {
      breakIncludedInWindow: false,
      defaultBreakMinutes: 600,
      overtimeCountsEarlyArrival: true,
    });

    expect(day.overtimeMinutes).toBeLessThanOrEqual(day.workedMinutes!);
  });

  it('missing punch: an open day reports no overtime rather than zero', () => {
    const day = score('09:00', null);

    expect(day.overtimeMinutes).toBeNull();
    expect(day.workedMinutes).toBeNull();
    expect(day.integrity).toBe('OPEN');
    // The company's own rule decides what the day is worth, not this file.
    expect(day.status).toBe(POLICY.missingCheckOutStatus);
  });

  it('missing punch: the same day under the opposite rule is absent', () => {
    expect(score('09:00', null, { missingCheckOutStatus: 'ABSENT' }).status).toBe('ABSENT');
  });

  it('half day: scored on the configured half-day threshold, earning no overtime', () => {
    const day = score('09:00', '13:00');

    expect(day.status).toBe('HALF_DAY');
    expect(day.overtimeMinutes).toBe(0);
    expect(day.workedMinutes).toBe(240);
  });

  it('half day: moving the threshold moves the boundary', () => {
    // The same four hours, against a company that calls a half day three.
    expect(score('09:00', '13:00', { halfDayMinutes: 180, fullDayMinutes: 200 }).status).toBe(
      'PRESENT',
    );
  });
});

describe('days nobody was rostered for follow their own configured rule', () => {
  // Under the policy's own daily cap, so this case is about the RULE; the cap
  // gets its own case below rather than being tangled up in this one.
  const worked = { workedMinutes: 180, overtimeMinutes: 0 };

  it('weekend work is all overtime when the company says so', () => {
    expect(worked.workedMinutes).toBeLessThan(POLICY.overtimeDailyCapMinutes);
    expect(nonWorkingDayOvertime('ALL_OVERTIME', worked, POLICY)).toBe(worked.workedMinutes);
  });

  it('weekend work is ignored when the company says so', () => {
    expect(nonWorkingDayOvertime('IGNORE', worked, POLICY)).toBe(0);
  });

  it('weekend work scored as an ordinary day keeps the engine figure', () => {
    expect(nonWorkingDayOvertime('AS_WORKING_DAY', worked, POLICY)).toBe(worked.overtimeMinutes);
  });

  it('the daily cap still applies to an all-overtime weekend', () => {
    const capped = nonWorkingDayOvertime(
      'ALL_OVERTIME',
      { workedMinutes: 900, overtimeMinutes: 0 },
      { ...POLICY, overtimeDailyCapMinutes: 240 },
    );

    expect(capped).toBe(240);
  });

  it('a Saturday is still scored against the shift when it is worked', () => {
    const day = score('09:00', '19:00', {}, SATURDAY);

    // The engine does not know about weekends; the deriver classifies the day
    // and applies the rule above. The figure it hands over is the ordinary one.
    expect(day.overtimeMinutes).toBe(60);
  });
});

describe('leave and holidays contribute no hours and no overtime', () => {
  it('a day of leave carries no worked time into any total', () => {
    const bucket = emptyCount();
    countInto(
      bucket,
      derived(score(null, null), {
        status: 'ON_LEAVE',
        leaveTypeName: 'Annual',
        leaveIsPaid: true,
        hasRecord: false,
      }),
    );

    expect(bucket.leaveDays).toBe(1);
    expect(bucket.paidLeaveDays).toBe(1);
    expect(bucket.workedMinutes).toBe(0);
    expect(bucket.overtimeMinutes).toBe(0);
    // Leave is a scheduled day somebody was expected on, and is not an absence.
    expect(bucket.scheduledDays).toBe(1);
    expect(bucket.absentDays).toBe(0);
  });

  it('a holiday is not a scheduled day and is never in the absence count', () => {
    const bucket = emptyCount();
    countInto(
      bucket,
      derived(score(null, null), {
        status: 'HOLIDAY',
        holidayName: 'Independence Day',
        hasRecord: false,
      }),
    );

    expect(bucket.holidayDays).toBe(1);
    expect(bucket.scheduledDays).toBe(0);
    expect(bucket.absentDays).toBe(0);
    expect(bucket.overtimeMinutes).toBe(0);
  });

  it('a weekend is not a scheduled day either', () => {
    const bucket = emptyCount();
    countInto(bucket, derived(score(null, null), { status: 'WEEKEND', hasRecord: false }));

    expect(bucket.weekendDays).toBe(1);
    expect(bucket.scheduledDays).toBe(0);
    expect(bucket.absentDays).toBe(0);
  });
});

// ------------------------------------------------- excessive hours, honestly

describe('hours that cannot be believed are reported as such, never fabricated', () => {
  it('a span past the configured bound yields no hours at all', () => {
    // A forgotten check-out: in at 09:00, a stray swipe at 23:59.
    const day = score('09:00', '23:59', { maxPlausibleSpanMinutes: 720 });

    expect(day.integrity).toBe('IMPLAUSIBLE');
    expect(day.workedMinutes).toBeNull();
    expect(day.overtimeMinutes).toBeNull();
    expect(day.irregular).toBe(true);
  });

  it('the times themselves are kept, so somebody can correct the day', () => {
    const day = score('09:00', '23:59', { maxPlausibleSpanMinutes: 720 });
    // The span is still reported - it is the evidence that something is wrong.
    expect(day.spanMinutes).toBe(899);
  });

  it('is a bound, not a cap: nothing is quietly trimmed to fit', () => {
    const day = score('09:00', '23:59', { maxPlausibleSpanMinutes: 720 });

    expect(day.workedMinutes).not.toBe(720);
    expect(day.workedMinutes).toBeNull();
  });

  it('the bound is configuration, so a long-shift company keeps its hours', () => {
    const day = score('09:00', '23:59', { maxPlausibleSpanMinutes: 960 });

    expect(day.integrity).toBe('COMPLETE');
    expect(day.workedMinutes).toBe(899);
  });

  it('zero switches the check off entirely', () => {
    expect(score('09:00', '23:59', { maxPlausibleSpanMinutes: 0 }).integrity).toBe('COMPLETE');
  });

  it('a company can opt back into scoring implausible days', () => {
    const day = score('09:00', '23:59', {
      maxPlausibleSpanMinutes: 720,
      allowImplausibleSpans: true,
    });

    expect(day.integrity).toBe('COMPLETE');
    expect(day.workedMinutes).toBe(899);
  });

  it('an ordinary long day is untouched by the bound', () => {
    const day = score('09:00', '20:00', { maxPlausibleSpanMinutes: 720 });

    expect(day.integrity).toBe('COMPLETE');
    expect(day.workedMinutes).toBe(660);
    expect(day.overtimeMinutes).toBe(120);
  });

  it('an implausible day is flagged so a report can list it', () => {
    const day = derived(score('09:00', '23:59', { maxPlausibleSpanMinutes: 720 }));
    expect(day.flags).toContain('IRREGULAR');
  });
});

describe('duplicate punches are read past, never written over', () => {
  /**
   * A punch at a wall-clock minute plus a number of seconds. Duplicates are a
   * seconds-apart phenomenon, and the shift boundaries this file works in are
   * expressed in minutes, so the two are spelled differently on purpose.
   */
  const punch = (hhmm: string, seconds = 0, punchState: string | null = null) => ({
    punchedAt: new Date(at(hhmm).getTime() + seconds * 1000),
    punchState,
  });

  it('collapses a badge read twice by the same reader', () => {
    const kept = collapseDuplicates([punch('09:00'), punch('09:00', 20)], 60);
    expect(kept).toHaveLength(1);
  });

  it('keeps the earliest of a cluster, because that is when it happened', () => {
    const kept = collapseDuplicates([punch('09:00'), punch('09:00', 30)], 60);
    expect(kept[0]!.punchedAt).toEqual(at('09:00'));
  });

  it('never collapses two punches that say different things', () => {
    // Two readers disagreeing is still two events; dropping one loses a
    // departure and turns the day into a missing punch.
    const kept = collapseDuplicates([punch('09:00', 0, 'IN'), punch('09:00', 10, 'OUT')], 60);
    expect(kept).toHaveLength(2);
  });

  it('takes every punch at face value when the window is zero', () => {
    expect(collapseDuplicates([punch('09:00'), punch('09:00', 20)], 0)).toHaveLength(2);
  });

  it('a morning of duplicates does not become a worked day', () => {
    /**
     * The shape that produced spurious hours: one arrival reported four times
     * by two readers. Paired naively it is an arrival and a "departure" forty
     * seconds later; collapsed it is what it is - one arrival, no departure.
     */
    const paired = pairPunches(
      [punch('09:00'), punch('09:00', 10), punch('09:00', 25), punch('09:00', 40)],
      'FIRST_IN_LAST_OUT',
      60,
    );

    expect(paired.checkInAt).toEqual(at('09:00'));
    expect(paired.checkOutAt).toBeNull();
  });

  it('a real departure still pairs after the duplicates are collapsed', () => {
    const paired = pairPunches(
      [punch('09:00'), punch('09:00', 10), punch('18:30'), punch('18:30', 15)],
      'FIRST_IN_LAST_OUT',
      60,
    );

    expect(paired.checkInAt).toEqual(at('09:00'));
    expect(paired.checkOutAt).toEqual(at('18:30'));
  });

  it('one punch is an arrival, never an arrival and a departure at once', () => {
    const paired = pairPunches([punch('09:00')], 'FIRST_IN_LAST_OUT', 60);
    expect(paired.checkOutAt).toBeNull();
  });
});

// ------------------------------------------------- the export must not differ

describe('every consumer reports the same overtime for the same day', () => {
  /** One month of assorted days, scored once and handed to each consumer. */
  const days: DerivedDay[] = [
    derived(score('09:00', '18:30')), // 30 overtime
    derived(score('09:00', '21:00')), // 180 overtime
    derived(score('09:00', '18:00')), // none
    derived(score('09:00', '13:00')), // half day
    derived(score('09:00', null)), // open
    derived(score('09:00', '23:59', { maxPlausibleSpanMinutes: 720 })), // implausible
    derived(score(null, null), { status: 'ON_LEAVE', hasRecord: false }),
    derived(score(null, null), { status: 'WEEKEND', hasRecord: false }),
  ].map((day, index) => ({ ...day, date: `2026-09-0${index + 1}` }));

  const byEmployee = new Map([['emp-1', days]]);
  const dates = days.map((d) => d.date);

  const employee = {
    id: 'emp-1',
    name: 'Ayesha Khan',
    employeeNumber: 'E-001',
    departmentId: null,
    departmentName: null,
    teamId: null,
    teamName: null,
    designationName: null,
    shiftName: null,
  };

  const report = (type: Parameters<typeof buildAttendanceReport>[0]['type']) =>
    buildAttendanceReport({
      type,
      from: dates[0]!,
      to: dates[dates.length - 1]!,
      employees: [employee],
      days: byEmployee,
      truncated: false,
    });

  /** What the engine itself says, and therefore what everything must say. */
  const engineTotal = days.reduce((sum, day) => sum + (day.overtimeMinutes ?? 0), 0);

  it('the chart aggregate agrees with the engine', () => {
    const { summary, days: rows } = aggregateDailyTotals({ dates, byEmployee });
    const rowTotal = rows.reduce((sum, row) => sum + row.overtimeMinutes, 0);

    expect(summary.overtimeMinutes).toBe(engineTotal);
    expect(rowTotal).toBe(engineTotal);
  });

  it('the chart rows and the chart summary agree with each other', () => {
    // These disagreed: the row clamped to worked minutes and the summary did not.
    const { summary, days: rows } = aggregateDailyTotals({ dates, byEmployee });

    expect(rows.reduce((sum, row) => sum + row.overtimeMinutes, 0)).toBe(summary.overtimeMinutes);
  });

  it('the daily report - which is what the CSV export is built from - agrees', () => {
    const rows = report('daily').rows;
    const total = rows.reduce((sum, row) => sum + ((row.overtimeMinutes as number) ?? 0), 0);

    expect(total).toBe(engineTotal);
  });

  it('the exported totals line carries the same figure as the rows above it', () => {
    const built = report('daily');
    const fromRows = built.rows.reduce(
      (sum, row) => sum + ((row.overtimeMinutes as number) ?? 0),
      0,
    );

    expect(built.totals!.overtimeMinutes).toBe(fromRows);
  });

  it('the monthly report agrees, in hours rather than minutes', () => {
    const row = report('monthly').rows[0]!;
    expect(row.overtimeHours).toBe(Math.round((engineTotal / 60) * 100) / 100);
  });

  it('the overtime report lists exactly the days that earned any', () => {
    const rows = report('overtime').rows;
    const earned = days.filter((d) => (d.overtimeMinutes ?? 0) > 0);

    expect(rows).toHaveLength(earned.length);
    expect(rows.reduce((sum, row) => sum + ((row.overtimeMinutes as number) ?? 0), 0)).toBe(
      engineTotal,
    );
  });

  it('the working-hours report agrees with all of them', () => {
    const row = report('working-hours').rows[0]!;
    expect(row.overtimeHours).toBe(Math.round((engineTotal / 60) * 100) / 100);
  });
});

describe('the monthly working hours report answers the whole question', () => {
  const days: DerivedDay[] = [
    derived(score('09:00', '18:30')),
    derived(score('09:00', '13:00')),
    derived(score('09:00', null)),
    derived(score('09:00', '23:59', { maxPlausibleSpanMinutes: 720 })),
    derived(score(null, null), { status: 'ON_LEAVE', hasRecord: false }),
    derived(score(null, null), { status: 'HOLIDAY', hasRecord: false }),
    derived(score(null, null), { status: 'WEEKEND', hasRecord: false }),
    derived(score(null, null), { status: 'ABSENT', hasRecord: false }),
  ].map((day, index) => ({ ...day, date: `2026-09-0${index + 1}` }));

  const built = buildAttendanceReport({
    type: 'working-hours',
    from: '2026-09-01',
    to: '2026-09-08',
    employees: [
      {
        id: 'emp-1',
        name: 'Ayesha Khan',
        employeeNumber: 'E-001',
        departmentId: null,
        departmentName: null,
        teamId: null,
        teamName: null,
        designationName: 'Engineer',
        shiftName: null,
      },
    ],
    days: new Map([['emp-1', days]]),
    truncated: false,
  });

  const row = built.rows[0]!;

  it('carries every column the report is asked for', () => {
    const keys = built.columns.map((c) => c.key);

    expect(keys).toEqual(
      expect.arrayContaining([
        'scheduledHours',
        'actualHours',
        'normalHours',
        'overtimeHours',
        'lateMinutes',
        'earlyLeaveMinutes',
        'presentDays',
        'halfDays',
        'absentDays',
        'leaveDays',
        'holidayDays',
        'weekendDays',
        'irregularDays',
      ]),
    );
  });

  it('splits actual hours into normal and overtime without double counting', () => {
    const normal = row.normalHours as number;
    const overtime = row.overtimeHours as number;

    expect(normal + overtime).toBeCloseTo(row.actualHours as number, 2);
  });

  it('counts the day it could not calculate rather than inventing hours for it', () => {
    expect(row.irregularDays).toBe(1);
  });

  it('separates leave, holiday and weekend from absence', () => {
    expect(row.leaveDays).toBe(1);
    expect(row.holidayDays).toBe(1);
    expect(row.weekendDays).toBe(1);
    expect(row.absentDays).toBe(1);
  });

  it('reports scheduled hours from the roster, not from what was worked', () => {
    expect(row.scheduledHours).not.toBe(row.actualHours);
    expect(row.scheduledHours as number).toBeGreaterThan(0);
  });

  it('totals the rows in the same units as the rows themselves', () => {
    expect(built.totals!.actualHours).toBe(row.actualHours);
    expect(built.totals!.overtimeHours).toBe(row.overtimeHours);
  });
});
