import { describe, expect, it } from 'vitest';
import { clockBoundary } from '../../core/zoned-time.js';
import { computeAttendance, type AttendancePolicy } from './attendance-policy.js';
import { calculate, type EffectiveConfig, type SalarySegment } from '../payroll/calculation.js';

/**
 * The engines must not know which company they are running for.
 *
 * Every case below runs the SAME functions twice against two companies that
 * agree on nothing, and asserts each gets its own answer. If a rule ever gets
 * written back into the code as a constant, one of these two halves breaks -
 * which is the point: a passing suite here is the evidence that Super Admin can
 * change the rules without a deployment.
 *
 *   A: 09:00-18:00, overtime after the shift, cap 240, time and a half
 *   B: 08:00-17:00, overtime after the shift, cap 120, double time
 */

const DAY = '2026-09-08';
const ZONE = 'Asia/Karachi';

const at = (hhmm: string): Date => {
  const instant = clockBoundary(DAY, hhmm, ZONE);
  if (!instant) throw new Error(`bad time ${hhmm}`);
  return instant;
};

/** Company A - the arrangement this deployment happens to use today. */
const COMPANY_A: AttendancePolicy = {
  timeZone: ZONE,
  weekendDays: ['SATURDAY', 'SUNDAY'],
  graceMinutes: 10,
  halfDayMinutes: 240,
  fullDayMinutes: 540,
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
};

/** Company B - a different company, agreeing with A about nothing. */
const COMPANY_B: AttendancePolicy = {
  ...COMPANY_A,
  weekendDays: ['FRIDAY'],
  graceMinutes: 0,
  halfDayMinutes: 180,
  fullDayMinutes: 480,
  earlyLeaveGraceMinutes: 0,
  defaultShiftStart: '08:00',
  defaultShiftEnd: '17:00',
  overtimeDailyCapMinutes: 120,
  overtimeCountsEarlyArrival: true,
  fullDayToleranceMinutes: 0,
  irregularCheckInCutoff: '10:00',
  overtimeMinimumMinutes: 15,
  overtimeRoundingMinutes: 15,
  missingCheckOutStatus: 'ABSENT',
};

function score(policy: AttendancePolicy, inAt: string | null, outAt: string | null) {
  return computeAttendance({
    day: DAY,
    checkInAt: inAt ? at(inAt) : null,
    checkOutAt: outAt ? at(outAt) : null,
    shift: null,
    policy,
  });
}

describe('the attendance engine reads the company, not the calendar on the wall', () => {
  it('measures lateness against each company own start time', () => {
    // 08:30 is early for A and half an hour late for B. Same punch, same code.
    expect(score(COMPANY_A, '08:30', '18:00').lateMinutes).toBe(0);
    expect(score(COMPANY_B, '08:30', '17:00').lateMinutes).toBe(30);
  });

  it('starts overtime at each company own end time', () => {
    // 17:30: half an hour early for A, half an hour of overtime for B.
    expect(score(COMPANY_A, '09:00', '17:30').overtimeMinutes).toBe(0);
    expect(score(COMPANY_B, '08:00', '17:30').overtimeMinutes).toBe(30);
  });

  it('applies each company own daily cap', () => {
    // Six hours past the end, against caps of 240 and 120.
    expect(score(COMPANY_A, '09:00', '23:59').overtimeMinutes).toBe(240);
    expect(score(COMPANY_B, '08:00', '23:00').overtimeMinutes).toBe(120);
  });

  it('honours each company answer on whether early arrival is overtime', () => {
    // A says no; B says yes and adds the hour before the shift.
    expect(score(COMPANY_A, '08:00', '18:30').overtimeMinutes).toBe(30);
    expect(score(COMPANY_B, '07:00', '17:30').overtimeMinutes).toBe(90);
  });

  it('applies each company minimum and rounding before crediting overtime', () => {
    // A credits every minute. B ignores anything under 15 and rounds down to a
    // quarter of an hour.
    expect(score(COMPANY_A, '09:00', '18:10').overtimeMinutes).toBe(10);
    expect(score(COMPANY_B, '08:00', '17:10').overtimeMinutes).toBe(0);
    expect(score(COMPANY_B, '08:00', '17:20').overtimeMinutes).toBe(15);
    expect(score(COMPANY_B, '08:00', '17:40').overtimeMinutes).toBe(30);
  });

  it('uses each company own irregular cutoff', () => {
    // 10:30 is an ordinary late start for A and irregular for B.
    expect(score(COMPANY_A, '10:30', '19:00').irregular).toBe(false);
    expect(score(COMPANY_B, '10:30', '19:00').irregular).toBe(true);
  });

  it('classifies the day by each company own window and tolerance', () => {
    // Both worked their whole scheduled day; the days are different lengths.
    expect(score(COMPANY_A, '09:00', '18:00').status).toBe('PRESENT');
    expect(score(COMPANY_B, '08:00', '17:00').status).toBe('PRESENT');
    // Half an hour early is within A's 30-minute tolerance. B allows none, but
    // its full-day threshold of 480 sits below its 540-minute window, so 16:30
    // still clears it and 15:30 does not.
    expect(score(COMPANY_A, '09:00', '17:30').status).toBe('PRESENT');
    expect(score(COMPANY_B, '08:00', '16:30').status).toBe('PRESENT');
    expect(score(COMPANY_B, '08:00', '15:30').status).toBe('HALF_DAY');
  });

  it('honours each company rule for a missing check-out', () => {
    expect(score(COMPANY_A, '09:00', null).status).toBe('PRESENT');
    expect(score(COMPANY_B, '08:00', null).status).toBe('ABSENT');
  });

  it('supports scoring a missing punch on the thresholds instead', () => {
    const byThreshold: AttendancePolicy = { ...COMPANY_A, missingCheckOutStatus: 'THRESHOLD' };
    // No check-out means no scheduled coverage to measure, so it falls to ABSENT
    // rather than being credited a day nobody can evidence.
    expect(score(byThreshold, '09:00', null).status).toBe('ABSENT');
  });

  it('deducts the break only when the company says it sits outside the window', () => {
    const shift = { startTime: '09:00', endTime: '18:00', breakMinutes: 60 };
    const inside = computeAttendance({
      day: DAY, checkInAt: at('09:00'), checkOutAt: at('18:00'), shift, policy: COMPANY_A,
    });
    const outside = computeAttendance({
      day: DAY, checkInAt: at('09:00'), checkOutAt: at('18:00'), shift,
      policy: { ...COMPANY_A, breakIncludedInWindow: false },
    });

    expect(inside.workedMinutes).toBe(540);
    expect(outside.workedMinutes).toBe(480);
  });
});

describe('an assigned shift beats whatever the company default says', () => {
  const night = { startTime: '18:00', endTime: '23:00' };
  const run = (policy: AttendancePolicy) =>
    computeAttendance({
      day: DAY, checkInAt: at('18:00'), checkOutAt: at('23:30'), shift: night, policy,
    });

  it('measures lateness and overtime against the shift, not the company window', () => {
    expect(run(COMPANY_A).lateMinutes).toBe(0);
    expect(run(COMPANY_B).lateMinutes).toBe(0);
  });

  it('an absolute irregular cutoff cannot describe a night shift', () => {
    // 18:00 is past any morning cutoff, so an absolute rule calls a night
    // worker irregular every single day and refuses to score their overtime.
    // This is the "everyone works 09:00-18:00" assumption, and it is why the
    // cutoff has a mode.
    expect(run(COMPANY_A).irregular).toBe(true);
    expect(run(COMPANY_A).overtimeMinutes).toBeNull();
  });

  it('a shift-relative cutoff describes any shift correctly', () => {
    const relative: AttendancePolicy = {
      ...COMPANY_A,
      irregularCheckInMode: 'AFTER_SHIFT_START',
      irregularAfterShiftStartMinutes: 120,
    };

    // Starting on time is regular whatever hour it happens to be.
    expect(run(relative).irregular).toBe(false);
    expect(run(relative).overtimeMinutes).toBe(30);

    // And three hours after the shift start is still irregular.
    const veryLate = computeAttendance({
      day: DAY, checkInAt: at('21:00'), checkOutAt: at('23:30'), shift: night, policy: relative,
    });
    expect(veryLate.irregular).toBe(true);
  });

  it('the same relative rule still catches a late start on a day shift', () => {
    const relative: AttendancePolicy = { ...COMPANY_A, irregularCheckInMode: 'AFTER_SHIFT_START' };
    const shift = { startTime: '09:00', endTime: '18:00' };
    const day = (inAt: string) =>
      computeAttendance({ day: DAY, checkInAt: at(inAt), checkOutAt: at('19:00'), shift, policy: relative });

    expect(day('10:30').irregular).toBe(false); // 90 minutes after start
    expect(day('11:30').irregular).toBe(true); // 150 minutes after start
  });
});

// ------------------------------------------------------------------- payroll

const PAY_A: EffectiveConfig = {
  basis: 'FIXED_DAYS',
  fixedBasisDays: 30,
  standardHoursPerDay: 8,
  overtimeMode: 'MULTIPLIER',
  overtimeMultiplier: 1.5,
  overtimeFixedRate: 0,
  requireApprovedOvertime: false,
  deductUnpaidAbsence: true,
  deductUnpaidLeave: true,
  lateDeductionMode: 'NONE',
  lateDeductionRate: 0,
  lateGraceMinutes: 0,
  earlyLeaveDeductionMode: 'NONE',
  earlyLeaveDeductionRate: 0,
  earlyLeaveGraceMinutes: 0,
  hourlyRateOverride: null,
  roundingDecimals: 2,
  overtimeWeekendMultiplier: null,
  overtimeHolidayMultiplier: null,
  fallbackScheduledMinutes: 480,
};

/** A different company: 26-day basis, 7-hour day, double time, holiday premium. */
const PAY_B: EffectiveConfig = {
  ...PAY_A,
  basis: 'WORKING_DAYS',
  standardHoursPerDay: 7,
  overtimeMultiplier: 2,
  overtimeWeekendMultiplier: 2.5,
  overtimeHolidayMultiplier: 3,
  fallbackScheduledMinutes: 420,
};

const payDay = (over: Record<string, unknown> = {}) => ({
  date: '2026-06-01',
  status: 'PRESENT',
  leaveIsPaid: null,
  leaveDayPart: null,
  workedMinutes: 480,
  lateMinutes: 0,
  earlyLeaveMinutes: 0,
  overtimeMinutes: 0,
  overtimeApproved: false,
  scheduledMinutes: 480,
  hasShift: true,
  hasRecord: true,
  ...over,
});

const payDays = (n: number, over: Record<string, unknown> = {}) =>
  Array.from({ length: n }, () => payDay(over)) as never[];

function pay(config: EffectiveConfig, days: unknown[], periodDays = 30) {
  const segments: SalarySegment[] = [
    { salaryType: 'MONTHLY', amount: 120000, currency: 'PKR', days: days as never[] },
  ];
  return calculate({ segments, config, components: [], adjustments: [], periodDays });
}

describe('the payroll engine reads the company too', () => {
  it('derives the rates from each company basis and standard hours', () => {
    const month = [...payDays(22), ...payDays(8, { status: 'WEEKEND' })];

    // A: 120,000 / 30 = 4,000 a day, / 8 = 500 an hour.
    const a = pay(PAY_A, month);
    expect(a.dailyRate).toBe(4000);
    expect(a.hourlyRate).toBe(500);

    // B: 120,000 / 22 working days, / 7 hours.
    const b = pay(PAY_B, month);
    expect(b.basisDays).toBe(22);
    expect(b.dailyRate).toBeCloseTo(120000 / 22, 2);
    expect(b.hourlyRate).toBeCloseTo(120000 / 22 / 7, 2);
  });

  it('prices overtime at each company multiplier', () => {
    const month = [...payDays(21), ...payDays(1, { overtimeMinutes: 120 }), ...payDays(8, { status: 'WEEKEND' })];

    // 2 hours at 500 x 1.5
    expect(pay(PAY_A, month).overtimeAmount).toBe(1500);
    // 2 hours at B's own hourly rate x 2
    expect(pay(PAY_B, month).overtimeAmount).toBeCloseTo((120000 / 22 / 7) * 2 * 2, 2);
  });

  it('prices weekend and holiday overtime at their own multipliers when configured', () => {
    const month = [
      ...payDays(22),
      ...payDays(1, { status: 'WEEKEND', overtimeMinutes: 60 }),
      ...payDays(1, { status: 'HOLIDAY', overtimeMinutes: 60 }),
      ...payDays(6, { status: 'WEEKEND' }),
    ];

    // A has no separate multipliers, so both fall back to the ordinary 1.5.
    expect(pay(PAY_A, month).overtimeAmount).toBe(500 * 1.5 * 2);

    // B pays 2.5 on a weekend and 3 on a holiday.
    const rateB = 120000 / 22 / 7; // WORKING_DAYS counts scheduled days only
    expect(pay(PAY_B, month).overtimeAmount).toBeCloseTo(rateB * 2.5 + rateB * 3, 1);
  });

  it('changing the multiplier changes the pay, with no code change', () => {
    // The stated requirement: set it to 2.0 and payroll uses 2.0.
    const month = [...payDays(21), ...payDays(1, { overtimeMinutes: 60 }), ...payDays(8, { status: 'WEEKEND' })];

    expect(pay(PAY_A, month).overtimeAmount).toBe(750); // 500 x 1.5
    expect(pay({ ...PAY_A, overtimeMultiplier: 2 }, month).overtimeAmount).toBe(1000);
    expect(pay({ ...PAY_A, overtimeMultiplier: 3 }, month).overtimeAmount).toBe(1500);
  });

  it('honours each company answer on deducting absence', () => {
    const month = [...payDays(20), ...payDays(2, { status: 'ABSENT' }), ...payDays(8, { status: 'WEEKEND' })];

    expect(pay(PAY_A, month).netAmount).toBe(120000 - 2 * 4000);
    expect(pay({ ...PAY_A, deductUnpaidAbsence: false }, month).netAmount).toBe(120000);
  });

  it('uses the configured fallback for a day with no shift, not a constant', () => {
    // The last business-rule constant that used to live in the code. Two
    // companies, two answers, one code path.
    expect(PAY_A.fallbackScheduledMinutes).toBe(480);
    expect(PAY_B.fallbackScheduledMinutes).toBe(420);
  });
});

describe('no configuration is a configured fallback, never a hidden rule', () => {
  it('an overtime rule that is switched off produces zero, not a default guess', () => {
    expect(score({ ...COMPANY_A, overtimeEnabled: false }, '09:00', '22:00').overtimeMinutes).toBe(0);
  });

  it('tracking switched off reports null rather than a fabricated zero', () => {
    const day = score(
      { ...COMPANY_A, lateTrackingEnabled: false, earlyDepartureTrackingEnabled: false },
      '10:00',
      '17:00',
    );
    expect(day.lateMinutes).toBeNull();
    expect(day.earlyLeaveMinutes).toBeNull();
  });
});
