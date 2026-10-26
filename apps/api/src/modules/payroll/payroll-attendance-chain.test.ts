import { describe, expect, it } from 'vitest';
import { clockBoundary } from '../../core/zoned-time.js';
import { computeAttendance, type AttendancePolicy } from '../time/attendance-policy.js';
import { buildAttendanceReport } from '../time/attendance-reports.service.js';
import type { DerivedDay } from '../time/attendance.service.js';
import { attendanceFlags } from '../time/attendance-policy.js';
import {
  calculate,
  tallyDays,
  type DayFact,
  type EffectiveConfig,
  type SalarySegment,
} from './calculation.js';

/**
 * One overtime figure, from the punch to the payslip.
 *
 * The chain is: attendance engine -> derived day -> overtime report -> payroll
 * calculation -> preview row -> CSV cell. Five presentations of one number.
 *
 * The assertions are deliberately equalities between the LINKS rather than
 * against constants. A constant proves the test agrees with the code; a chain
 * of equalities proves a payroll clerk, an HR manager reading the overtime
 * report and an employee looking at their own attendance are being told the
 * same thing. That is the property that was actually broken.
 *
 * Everything is run twice, against two different overtime settings, and the
 * assertion is that BOTH runs agree with themselves and that the two runs
 * differ from each other. A hardcoded threshold anywhere in the chain fails
 * one half or the other.
 */

const DAY = '2026-09-08';
const ZONE = 'Asia/Karachi';

const at = (hhmm: string, day: string = DAY): Date => {
  const instant = clockBoundary(day, hhmm, ZONE);
  if (!instant) throw new Error(`bad time ${hhmm}`);
  return instant;
};

const ATTENDANCE: AttendancePolicy = {
  timeZone: ZONE,
  weekendDays: ['SATURDAY', 'SUNDAY'],
  graceMinutes: 10,
  halfDayMinutes: 240,
  fullDayMinutes: 480,
  earlyLeaveGraceMinutes: 10,
  overtimeEnabled: true,
  overtimeAfterMinutes: 480,
  overtimeDailyCapMinutes: 600,
  locationRestrictionEnabled: false,
  defaultGeofenceRadiusM: 200,
  checkOutLocationEnforced: false,
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
  overnightCheckOutWindowMinutes: 1080,
  overnightCheckOutCutoff: '06:00',
};

const PAYROLL: EffectiveConfig = {
  basis: 'FIXED_DAYS',
  fixedBasisDays: 30,
  standardHoursPerDay: 8,
  overtimeMode: 'MULTIPLIER',
  overtimeMultiplier: 1.5,
  overtimeFixedRate: 0,
  // The chain test is about the figure, not about approval; approval gating
  // has its own cases below.
  requireApprovedOvertime: false,
  overtimeCapMinutes: null,
  deductUnpaidAbsence: true,
  deductUnpaidLeave: true,
  lateDeductionMode: 'NONE',
  lateDeductionRate: 0,
  lateGraceMinutes: 0,
  earlyLeaveDeductionMode: 'NONE',
  earlyLeaveDeductionRate: 0,
  earlyLeaveGraceMinutes: 0,
  shortHoursDeductionMode: 'NONE',
  shortHoursDeductionRate: 0,
  shortHoursGraceMinutes: 0,
  hourlyRateOverride: null,
  roundingDecimals: 2,
  overtimeWeekendMultiplier: null,
  overtimeHolidayMultiplier: null,
  fallbackScheduledMinutes: 480,
  prorationMethod: 'CALENDAR_DAYS',
};

/** Five working days, each with the same punches, under a given policy. */
function chainFor(policy: AttendancePolicy, punchOut: string) {
  const dates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];

  // --- link 1: the attendance engine ---------------------------------------
  const computed = dates.map((date) =>
    computeAttendance({
      day: date,
      checkInAt: at('09:00', date),
      checkOutAt: at(punchOut, date),
      shift: null,
      policy,
    }),
  );

  // --- link 2: the derived day every screen and report reads ---------------
  const days: DerivedDay[] = computed.map((c, i) => {
    const base = {
      date: dates[i]!,
      status: c.status as DerivedDay['status'],
      checkInAt: at('09:00', dates[i]!).toISOString(),
      checkOutAt: at(punchOut, dates[i]!).toISOString(),
      workedMinutes: c.workedMinutes,
      expectedMinutes: c.expectedMinutes,
      lateMinutes: c.lateMinutes,
      earlyLeaveMinutes: c.earlyLeaveMinutes,
      overtimeMinutes: c.overtimeMinutes,
      irregular: c.irregular,
      integrity: c.integrity,
      mode: null,
      shiftId: null,
      shiftName: null,
      notes: null,
      leaveTypeName: null,
      leaveIsPaid: null,
      leaveIsDeductible: null,
      leaveDayPart: null,
      holidayName: null,
      source: 'DEVICE' as const,
      recordId: `rec-${i}`,
      hasRecord: true,
    };
    return { ...base, flags: attendanceFlags(base, policy) };
  });

  // --- link 3: the overtime report -----------------------------------------
  const report = buildAttendanceReport({
    type: 'overtime',
    from: dates[0]!,
    to: dates[dates.length - 1]!,
    employees: [
      {
        id: 'emp-1',
        name: 'Ayesha Khan',
        employeeNumber: 'E-001',
        departmentId: null,
        departmentName: null,
        teamId: null,
        teamName: null,
        designationName: null,
        shiftName: null,
      },
    ],
    days: new Map([['emp-1', days]]),
    truncated: false,
  });

  // --- link 4: payroll -----------------------------------------------------
  const facts: DayFact[] = days.map((d) => ({
    date: d.date,
    status: d.status,
    leaveIsPaid: d.leaveIsPaid,
    leaveIsDeductible: d.leaveIsDeductible,
    leaveDayPart: d.leaveDayPart,
    workedMinutes: d.workedMinutes,
    lateMinutes: d.lateMinutes,
    earlyLeaveMinutes: d.earlyLeaveMinutes,
    overtimeMinutes: d.overtimeMinutes,
    overtimeApproved: true,
    scheduledMinutes: d.expectedMinutes ?? 480,
    hasShift: true,
    hasRecord: d.hasRecord,
  }));

  const segments: SalarySegment[] = [
    { salaryType: 'MONTHLY', amount: 120_000, currency: 'PKR', days: facts },
  ];
  const result = calculate({
    segments,
    config: PAYROLL,
    components: [],
    adjustments: [],
    periodDays: dates.length,
  });

  return {
    engineMinutes: computed.reduce((sum, c) => sum + (c.overtimeMinutes ?? 0), 0),
    derivedMinutes: days.reduce((sum, d) => sum + (d.overtimeMinutes ?? 0), 0),
    reportMinutes: report.rows.reduce(
      (sum, r) => sum + ((r.overtimeMinutes as number) ?? 0),
      0,
    ),
    payrollMinutes: result.tally.overtimeMinutes,
    paidMinutes: result.paidOvertimeMinutes,
    overtimeAmount: result.overtimeAmount,
    result,
    days,
  };
}

describe('THE FINAL CHECK: one overtime figure from attendance to export', () => {
  it('attendance, the report and payroll agree under the shipped setting', () => {
    const chain = chainFor(ATTENDANCE, '20:00');

    // 18:00 -> 20:00 is two hours, five times over.
    expect(chain.engineMinutes).toBe(600);
    expect(chain.derivedMinutes).toBe(chain.engineMinutes);
    expect(chain.reportMinutes).toBe(chain.engineMinutes);
    expect(chain.payrollMinutes).toBe(chain.engineMinutes);
    expect(chain.paidMinutes).toBe(chain.engineMinutes);
  });

  it('and they still agree after the overtime setting is changed', () => {
    /**
     * The same punches, one setting moved. If any link held its own threshold
     * the two chains would disagree with each other at that link only, which
     * is precisely how the original bug presented.
     */
    const moved: AttendancePolicy = { ...ATTENDANCE, defaultShiftEnd: '17:00' };
    const chain = chainFor(moved, '20:00');

    // 17:00 -> 20:00 is three hours now, not two.
    expect(chain.engineMinutes).toBe(900);
    expect(chain.derivedMinutes).toBe(chain.engineMinutes);
    expect(chain.reportMinutes).toBe(chain.engineMinutes);
    expect(chain.payrollMinutes).toBe(chain.engineMinutes);
    expect(chain.paidMinutes).toBe(chain.engineMinutes);
  });

  it('the change actually moved the figure, so the test is not vacuous', () => {
    const before = chainFor(ATTENDANCE, '20:00');
    const after = chainFor({ ...ATTENDANCE, defaultShiftEnd: '17:00' }, '20:00');

    expect(after.engineMinutes).toBeGreaterThan(before.engineMinutes);
    expect(after.overtimeAmount).toBeGreaterThan(before.overtimeAmount);
  });

  it('the money follows the minutes, at the configured multiplier', () => {
    const chain = chainFor(ATTENDANCE, '20:00');
    const { hourlyRate } = chain.result;

    expect(chain.overtimeAmount).toBeCloseTo(
      hourlyRate * PAYROLL.overtimeMultiplier * (chain.paidMinutes / 60),
      1,
    );
  });

  it('the payslip overtime line reports the same hours payroll priced', () => {
    const chain = chainFor(ATTENDANCE, '20:00');
    const line = chain.result.earnings.find((l) => l.code === 'OVERTIME')!;

    expect(line.units).toBeCloseTo(chain.paidMinutes / 60, 2);
    expect(line.amount).toBe(chain.overtimeAmount);
  });

  it('switching overtime off zeroes every link at once', () => {
    const chain = chainFor({ ...ATTENDANCE, overtimeEnabled: false }, '20:00');

    expect(chain.engineMinutes).toBe(0);
    expect(chain.reportMinutes).toBe(0);
    expect(chain.payrollMinutes).toBe(0);
    expect(chain.overtimeAmount).toBe(0);
  });

  it('the attendance daily cap reaches payroll without payroll knowing about it', () => {
    const capped = chainFor({ ...ATTENDANCE, overtimeDailyCapMinutes: 60 }, '20:00');

    // One hour a day, five days. Payroll applied no ceiling of its own.
    expect(capped.engineMinutes).toBe(300);
    expect(capped.payrollMinutes).toBe(300);
  });
});

describe('the export is the screen, not a second query', () => {
  it('every preview column reads the row the screen was given', async () => {
    /**
     * The CSV and the table are built from ONE column list with one accessor
     * per column. This asserts that structurally: whatever the row says, the
     * exported cell says, for every column, with no separate formatting path
     * that could round or relabel differently.
     */
    const { PREVIEW_COLUMNS } = await import('./payroll-runs.routes.js');

    const row = {
      employeeId: 'emp-1',
      employeeName: 'Ayesha Khan',
      employeeNumber: 'E-001',
      departmentName: 'Engineering',
      currency: 'PKR',
      salaryType: 'MONTHLY' as const,
      basicSalary: 120000,
      salarySegments: 1,
      basis: 'FIXED_DAYS' as const,
      basisDays: 30,
      dailyRate: 4000,
      hourlyRate: 500,
      calendarDays: 31,
      scheduledDays: 22,
      paidDays: 20,
      presentDays: 20,
      halfDays: 0,
      absentDays: 1,
      unpaidLeaveDays: 1,
      paidLeaveDays: 2,
      holidayDays: 1,
      weekendDays: 8,
      unpaidDays: 2,
      allowances: 5000,
      overtimeHours: 10,
      overtimeAmount: 7500,
      lateDeduction: 100,
      earlyLeaveDeduction: 200,
      absenceDeduction: 4000,
      shortHoursDeduction: 300,
      loanDeduction: 2500,
      advanceDeduction: 0,
      otherDeductions: 900,
      deductionsTotal: 8000,
      adjustmentTotal: 0,
      basicAmount: 112000,
      grossAmount: 124500,
      netAmount: 116500,
      earnings: [],
      deductions: [],
      notes: [],
      blocked: false,
    };

    const exported = Object.fromEntries(
      PREVIEW_COLUMNS.map(([key, , pick]) => [key, pick(row)]),
    );

    for (const [key] of PREVIEW_COLUMNS) {
      if (key === 'notes') continue;
      expect(exported[key]).toBe((row as Record<string, unknown>)[key]);
    }
  });

  it('carries every line the specification asks the breakdown to show', async () => {
    const { PREVIEW_COLUMNS } = await import('./payroll-runs.routes.js');
    const keys = PREVIEW_COLUMNS.map(([key]) => key);

    expect(keys).toEqual(
      expect.arrayContaining([
        'basicSalary',
        'scheduledDays',
        'paidLeaveDays',
        'unpaidLeaveDays',
        'absentDays',
        'shortHoursDeduction',
        'overtimeHours',
        'overtimeAmount',
        'loanDeduction',
        'advanceDeduction',
        'otherDeductions',
        'netAmount',
      ]),
    );
  });

  it('the deduction columns add up to the deductions total', async () => {
    /**
     * A breakdown whose parts do not sum to the whole invites the reader to
     * believe both. Asserted on a real calculation rather than a literal, so
     * a new deduction line that nobody gives a column to fails here.
     */
    const facts: DayFact[] = [
      fact({ date: '2026-09-07', status: 'ABSENT', workedMinutes: null, hasRecord: false }),
      fact({ date: '2026-09-08', workedMinutes: 300 }),
      fact({
        date: '2026-09-09',
        status: 'ON_LEAVE',
        leaveIsPaid: false,
        workedMinutes: null,
      }),
    ];

    const result = calculate({
      segments: [{ salaryType: 'MONTHLY', amount: 120_000, currency: 'PKR', days: facts }],
      config: { ...PAYROLL, shortHoursDeductionMode: 'PRO_RATA' },
      components: [],
      adjustments: [
        { id: 'loan-1', kind: 'DEDUCTION', label: 'Loan repayment 1/6', amount: 5000, code: 'LOAN', lineKind: 'LOAN' },
        { id: 'adj-1', kind: 'DEDUCTION', label: 'Uniform', amount: 750 },
      ],
      periodDays: 3,
    });

    const by = (code: string) =>
      result.deductions.filter((l) => l.code === code).reduce((s, l) => s + l.amount, 0);

    const absence = by('ABSENCE') + by('UNPAID_LEAVE') + by('PAID_LEAVE');
    const parts =
      absence + by('SHORT_HOURS') + by('LATE') + by('EARLY_LEAVE') + by('LOAN') + by('ADJUSTMENT');

    expect(parts).toBeCloseTo(result.deductionsTotal, 2);
  });
});

// ------------------------------------------------------------------ the rules

function fact(over: Partial<DayFact> = {}): DayFact {
  return {
    date: '2026-09-08',
    status: 'PRESENT',
    leaveIsPaid: null,
    leaveIsDeductible: null,
    leaveDayPart: null,
    workedMinutes: 480,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    overtimeApproved: true,
    scheduledMinutes: 480,
    hasShift: true,
    hasRecord: true,
    ...over,
  };
}

const money = (days: DayFact[], config: Partial<EffectiveConfig> = {}) =>
  calculate({
    segments: [{ salaryType: 'MONTHLY', amount: 120_000, currency: 'PKR', days }],
    config: { ...PAYROLL, ...config },
    components: [],
    adjustments: [],
    periodDays: days.length,
  });

describe('rule 1: approved paid leave is not deducted unless the type says so', () => {
  const paidLeave = fact({
    status: 'ON_LEAVE',
    leaveIsPaid: true,
    leaveIsDeductible: false,
    workedMinutes: null,
  });

  it('costs nothing by default', () => {
    const result = money([paidLeave]);

    expect(result.deductions.find((l) => l.code === 'PAID_LEAVE')).toBeUndefined();
    expect(result.tally.paidLeaveDays).toBe(1);
    expect(result.unpaidDays).toBe(0);
  });

  it('stays undeducted even when the unpaid-leave switch is on', () => {
    // The unpaid-leave switch governs UNPAID leave. Borrowing it for paid
    // leave would make one toggle silently decide two unrelated things.
    const result = money([paidLeave], { deductUnpaidLeave: true });

    expect(result.deductions.find((l) => l.code === 'PAID_LEAVE')).toBeUndefined();
  });

  it('is deducted only when the leave type itself is marked deductible', () => {
    const result = money([{ ...paidLeave, leaveIsDeductible: true }]);
    const line = result.deductions.find((l) => l.code === 'PAID_LEAVE');

    expect(line).toBeDefined();
    expect(line!.units).toBe(1);
    expect(result.tally.deductiblePaidLeaveDays).toBe(1);
    // Still counted as paid leave everywhere leave is reported.
    expect(result.tally.paidLeaveDays).toBe(1);
  });

  it('a half day of deductible paid leave costs half a day', () => {
    const result = money([
      { ...paidLeave, leaveIsDeductible: true, leaveDayPart: 'FIRST_HALF' },
    ]);

    expect(result.deductions.find((l) => l.code === 'PAID_LEAVE')!.units).toBe(0.5);
  });
});

describe('rule 2: unpaid leave follows the configured payroll policy', () => {
  const unpaid = fact({ status: 'ON_LEAVE', leaveIsPaid: false, workedMinutes: null });

  it('is deducted when the company says to', () => {
    const result = money([unpaid], { deductUnpaidLeave: true });
    expect(result.deductions.find((l) => l.code === 'UNPAID_LEAVE')).toBeDefined();
  });

  it('is not deducted when the company says not to', () => {
    const result = money([unpaid], { deductUnpaidLeave: false });
    expect(result.deductions.find((l) => l.code === 'UNPAID_LEAVE')).toBeUndefined();
  });

  it('leave with no paid flag is treated as unpaid rather than guessed at', () => {
    const result = money([fact({ status: 'ON_LEAVE', leaveIsPaid: null, workedMinutes: null })], {
      deductUnpaidLeave: true,
    });

    expect(result.tally.unpaidLeaveDays).toBe(1);
  });
});

describe('rule 3: short hours use the configured working-hours rule', () => {
  // Rostered 480, worked 300: three hours short.
  const short = fact({ workedMinutes: 300 });

  it('costs nothing while the rule is off', () => {
    expect(money([short]).deductions.find((l) => l.code === 'SHORT_HOURS')).toBeUndefined();
  });

  it('pro rata charges the employee own hourly rate', () => {
    const result = money([short], { shortHoursDeductionMode: 'PRO_RATA' });
    const line = result.deductions.find((l) => l.code === 'SHORT_HOURS')!;

    expect(line.units).toBeCloseTo(3, 2);
    expect(line.rate).toBe(result.hourlyRate);
    expect(line.amount).toBeCloseTo(result.hourlyRate * 3, 1);
  });

  it('per minute charges the configured flat rate instead', () => {
    const result = money([short], {
      shortHoursDeductionMode: 'PER_MINUTE',
      shortHoursDeductionRate: 12,
    });
    const line = result.deductions.find((l) => l.code === 'SHORT_HOURS')!;

    expect(line.units).toBe(180);
    expect(line.amount).toBe(180 * 12);
  });

  it('the grace period is configuration, and forgives what it covers', () => {
    const barelyShort = fact({ workedMinutes: 470 });
    const forgiven = money([barelyShort], {
      shortHoursDeductionMode: 'PRO_RATA',
      shortHoursGraceMinutes: 15,
    });
    const charged = money([barelyShort], {
      shortHoursDeductionMode: 'PRO_RATA',
      shortHoursGraceMinutes: 5,
    });

    expect(forgiven.deductions.find((l) => l.code === 'SHORT_HOURS')).toBeUndefined();
    expect(charged.deductions.find((l) => l.code === 'SHORT_HOURS')).toBeDefined();
  });

  it('never charges an absence twice: an absent day is not also short', () => {
    const result = money([fact({ status: 'ABSENT', workedMinutes: null, hasRecord: false })], {
      shortHoursDeductionMode: 'PRO_RATA',
    });

    expect(result.tally.shortMinutes).toBe(0);
    expect(result.deductions.find((l) => l.code === 'SHORT_HOURS')).toBeUndefined();
    expect(result.deductions.find((l) => l.code === 'ABSENCE')).toBeDefined();
  });

  it('a day of leave is not short hours either', () => {
    const result = money(
      [fact({ status: 'ON_LEAVE', leaveIsPaid: true, workedMinutes: null })],
      { shortHoursDeductionMode: 'PRO_RATA' },
    );

    expect(result.tally.shortMinutes).toBe(0);
  });

  it('a day whose hours are unknown is never charged as short', () => {
    /**
     * The attendance engine reports null when it will not fabricate hours -
     * an open day, or one whose punches it does not believe. Reading that as
     * "worked none of it" would deduct a full day for a forgotten check-out,
     * which is the fabrication the engine declined to make.
     */
    const result = money([fact({ workedMinutes: null })], {
      shortHoursDeductionMode: 'PRO_RATA',
    });

    expect(result.tally.shortMinutes).toBe(0);
    expect(result.deductions.find((l) => l.code === 'SHORT_HOURS')).toBeUndefined();
  });
});

describe('rules 4 and 5: overtime is never a constant in payroll', () => {
  it('payroll prices whatever minutes the attendance engine reported', () => {
    const minutes = [0, 30, 120, 600];
    const priced = minutes.map(
      (overtimeMinutes) => money([fact({ overtimeMinutes })]).paidOvertimeMinutes,
    );

    expect(priced).toEqual(minutes);
  });

  it('payroll never re-derives a minute from a punch', () => {
    // Worked minutes wildly inconsistent with the overtime figure. Payroll
    // must take the engine's number and not attempt to recompute one.
    const result = money([fact({ workedMinutes: 60, overtimeMinutes: 240 })]);

    expect(result.tally.overtimeMinutes).toBe(240);
  });

  it('the payroll ceiling trims the total without inventing a threshold', () => {
    const uncapped = money([fact({ overtimeMinutes: 600 })], { overtimeCapMinutes: null });
    const capped = money([fact({ overtimeMinutes: 600 })], { overtimeCapMinutes: 120 });

    expect(uncapped.paidOvertimeMinutes).toBe(600);
    expect(capped.paidOvertimeMinutes).toBe(120);
    expect(capped.cappedOvertimeMinutes).toBe(480);
  });

  it('unapproved overtime is paid or not, per configuration', () => {
    const day = fact({ overtimeMinutes: 120, overtimeApproved: false });

    expect(money([day], { requireApprovedOvertime: false }).paidOvertimeMinutes).toBe(120);
    expect(money([day], { requireApprovedOvertime: true }).paidOvertimeMinutes).toBe(0);
  });
});

describe('rule 6: only approved active loans are deducted', () => {
  it('a loan repayment appears as its own line, not as an adjustment', () => {
    const result = calculate({
      segments: [{ salaryType: 'MONTHLY', amount: 120_000, currency: 'PKR', days: [fact()] }],
      config: PAYROLL,
      components: [],
      adjustments: [
        {
          id: 'inst-1',
          kind: 'DEDUCTION',
          label: 'Loan repayment 2/6',
          amount: 5000,
          code: 'LOAN',
          lineKind: 'LOAN',
        },
      ],
      periodDays: 1,
    });

    const line = result.deductions.find((l) => l.code === 'LOAN')!;
    expect(line).toBeDefined();
    expect(line.label).toContain('Loan repayment');
    expect(line.amount).toBe(5000);
  });

  it('no loan means no line at all, rather than a zero', () => {
    const result = money([fact()]);
    expect(result.deductions.find((l) => l.code === 'LOAN')).toBeUndefined();
  });
});

describe('rules 7 and 8: the salary in force, and the history that stays', () => {
  it('a mid-period raise pays each rate for the days it covered', () => {
    const half = (n: number) => Array.from({ length: n }, (_, i) => fact({ date: `2026-09-0${i + 1}` }));

    const result = calculate({
      segments: [
        { salaryType: 'MONTHLY', amount: 60_000, currency: 'PKR', days: half(4) },
        { salaryType: 'MONTHLY', amount: 120_000, currency: 'PKR', days: half(4) },
      ],
      config: PAYROLL,
      components: [],
      adjustments: [],
      periodDays: 8,
    });

    // Four days at each rate over an eight-day period: half of each salary.
    expect(result.basicAmount).toBeCloseTo(60_000 / 2 + 120_000 / 2, 0);
  });

  it('one salary over the whole period pays exactly that salary', () => {
    const days = Array.from({ length: 30 }, (_, i) =>
      fact({ date: `2026-09-${String(i + 1).padStart(2, '0')}` }),
    );

    const result = calculate({
      segments: [{ salaryType: 'MONTHLY', amount: 120_000, currency: 'PKR', days }],
      config: PAYROLL,
      components: [],
      adjustments: [],
      periodDays: 30,
    });

    expect(result.basicAmount).toBeCloseTo(120_000, 0);
  });

  it('the rate a deduction is priced at comes from the salary, not a constant', () => {
    const absent = fact({ status: 'ABSENT', workedMinutes: null, hasRecord: false });

    const small = money([absent]);
    const large = calculate({
      segments: [{ salaryType: 'MONTHLY', amount: 240_000, currency: 'PKR', days: [absent] }],
      config: PAYROLL,
      components: [],
      adjustments: [],
      periodDays: 1,
    });

    expect(large.deductions[0]!.amount).toBeCloseTo(small.deductions[0]!.amount * 2, 1);
  });
});

describe('the tally counts a period the same way the attendance module does', () => {
  it('weekends and holidays are not scheduled days and nobody is short for them', () => {
    const tally = tallyDays(
      [
        fact({ status: 'WEEKEND', workedMinutes: null }),
        fact({ status: 'HOLIDAY', workedMinutes: null }),
        fact({ status: 'PRESENT' }),
      ],
      PAYROLL,
    );

    expect(tally.scheduledDays).toBe(1);
    expect(tally.weekendDays).toBe(1);
    expect(tally.holidayDays).toBe(1);
    expect(tally.absentDays).toBe(0);
  });

  it('overtime worked on a non-working day is still counted, at its own rate', () => {
    const tally = tallyDays(
      [fact({ status: 'WEEKEND', workedMinutes: 300, overtimeMinutes: 300 })],
      PAYROLL,
    );

    expect(tally.weekendOvertimeMinutes).toBe(300);
    expect(tally.scheduledDays).toBe(0);
  });
});
