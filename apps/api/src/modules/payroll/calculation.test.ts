import { describe, expect, it } from 'vitest';
import {
  calculate,
  capOvertime,
  resolveBasisDays,
  roundTo,
  tallyDays,
  type AdjustmentInput,
  type ComponentInput,
  type DayFact,
  type EffectiveConfig,
  type SalarySegment,
} from './calculation.js';
import { canTransition } from './payroll.service.js';

/**
 * The payroll calculation, against known figures.
 *
 * Every expected number below is one that can be worked out on paper, and is
 * written as the arithmetic rather than as a magic constant, so a failure says
 * which rule broke rather than that a total moved. This is the code that
 * decides what people are paid; it was written as pure functions precisely so
 * it could be pinned down like this.
 *
 * The company under test: 120,000 monthly, a fixed 30-day basis, 8 standard
 * hours a day. That makes the daily rate exactly 4,000 and the hourly rate
 * exactly 500, so every figure downstream stays checkable by hand.
 */

const CONFIG: EffectiveConfig = {
  basis: 'FIXED_DAYS',
  fixedBasisDays: 30,
  // Payroll's standard hours stay 8, deliberately: the 540-minute attendance
  // window and the 8-hour payroll day are different numbers answering
  // different questions, and conflating them is what this suite guards.
  standardHoursPerDay: 8,
  overtimeMode: 'MULTIPLIER',
  overtimeMultiplier: 1.5,
  overtimeFixedRate: 0,
  // Off for most cases so overtime is exercised on its own; the approval gate
  // has its own tests below.
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
  hourlyRateOverride: null,
  roundingDecimals: 2,
  overtimeWeekendMultiplier: null,
  overtimeHolidayMultiplier: null,
  fallbackScheduledMinutes: 480,
  prorationMethod: 'CALENDAR_DAYS',
  shortHoursDeductionMode: 'NONE',
  shortHoursDeductionRate: 0,
  shortHoursGraceMinutes: 0,
};

const SALARY = 120000;
const PERIOD_DAYS = 30;
/** 120,000 / 30 */
const DAILY_RATE = 4000;
/** 4,000 / 8 */
const HOURLY_RATE = 500;

/** One day, with everything harmless unless the case says otherwise. */
function day(over: Partial<DayFact> = {}): DayFact {
  return {
    date: '2026-06-01',
    status: 'PRESENT',
    leaveIsPaid: null,
    leaveIsDeductible: null,
    leaveDayPart: null,
    workedMinutes: 540,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    overtimeApproved: false,
    scheduledMinutes: 480,
    hasShift: true,
    hasRecord: true,
    ...over,
  };
}

const days = (count: number, over: Partial<DayFact> = {}): DayFact[] =>
  Array.from({ length: count }, (_, i) =>
    day({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, ...over }),
  );

/** A period: 22 working days, 8 weekend days, unless overridden. */
function standardMonth(over: Partial<DayFact> = {}): DayFact[] {
  return [...days(22, over), ...days(8, { status: 'WEEKEND', workedMinutes: null })];
}

function segment(monthDays: DayFact[], amount = SALARY): SalarySegment {
  return { salaryType: 'MONTHLY', amount, currency: 'PKR', days: monthDays };
}

function run(input: {
  segments: SalarySegment[];
  config?: Partial<EffectiveConfig>;
  components?: ComponentInput[];
  adjustments?: AdjustmentInput[];
  periodDays?: number;
}) {
  return calculate({
    segments: input.segments,
    config: { ...CONFIG, ...input.config },
    components: input.components ?? [],
    adjustments: input.adjustments ?? [],
    periodDays: input.periodDays ?? PERIOD_DAYS,
  });
}

// ---------------------------------------------------------------- foundations

describe('rounding', () => {
  it('rounds half away from zero without the binary floating point trap', () => {
    // 2.675 * 100 is 267.49999999999997 in binary; naive rounding loses a cent.
    expect(roundTo(2.675, 2)).toBe(2.68);
    expect(roundTo(-2.675, 2)).toBe(-2.68);
    expect(roundTo(1.005, 2)).toBe(1.01);
  });
});

describe('basis days', () => {
  it('uses the fixed basis when configured', () => {
    expect(resolveBasisDays(CONFIG, 30, 22)).toBe(30);
  });

  it('uses calendar days, or working days, when told to', () => {
    expect(resolveBasisDays({ ...CONFIG, basis: 'CALENDAR_DAYS' }, 31, 22)).toBe(31);
    expect(resolveBasisDays({ ...CONFIG, basis: 'WORKING_DAYS' }, 31, 22)).toBe(22);
  });
});

// ---------------------------------------------------------------------- tally

describe('counting the period', () => {
  it('does not count weekends or holidays as scheduled', () => {
    const tally = tallyDays(
      [...days(20), ...days(8, { status: 'WEEKEND' }), ...days(2, { status: 'HOLIDAY' })],
      CONFIG,
    );
    expect(tally.scheduledDays).toBe(20);
    expect(tally.weekendDays).toBe(8);
    expect(tally.holidayDays).toBe(2);
  });

  it('counts a half day as half a present day', () => {
    const tally = tallyDays(days(2, { status: 'HALF_DAY' }), CONFIG);
    expect(tally.halfDays).toBe(2);
    expect(tally.presentDays).toBe(1);
  });

  it('separates paid from unpaid leave', () => {
    const tally = tallyDays(
      [
        ...days(3, { status: 'ON_LEAVE', leaveIsPaid: true, leaveDayPart: 'FULL_DAY' }),
        ...days(2, { status: 'ON_LEAVE', leaveIsPaid: false, leaveDayPart: 'FULL_DAY' }),
      ],
      CONFIG,
    );
    expect(tally.paidLeaveDays).toBe(3);
    expect(tally.unpaidLeaveDays).toBe(2);
  });

  it('treats leave with no paid flag as unpaid rather than guessing', () => {
    const tally = tallyDays(days(1, { status: 'ON_LEAVE', leaveIsPaid: null }), CONFIG);
    expect(tally.unpaidLeaveDays).toBe(1);
    expect(tally.paidLeaveDays).toBe(0);
  });

  it('flags days with no record and days with no shift', () => {
    const tally = tallyDays(
      [...days(2, { hasRecord: false, status: 'ABSENT' }), ...days(3, { hasShift: false })],
      CONFIG,
    );
    expect(tally.daysWithoutRecord).toBe(2);
    expect(tally.daysWithoutShift).toBe(3);
  });

  it('flags a day with a check-in and no check-out', () => {
    const tally = tallyDays(days(4, { workedMinutes: null }), CONFIG);
    expect(tally.incompleteDays).toBe(4);
  });

  it('applies the late grace before counting lateness', () => {
    const tally = tallyDays(days(3, { lateMinutes: 20 }), { ...CONFIG, lateGraceMinutes: 15 });
    expect(tally.lateOccurrences).toBe(3);
    expect(tally.lateMinutes).toBe(15); // 3 x (20 - 15)
  });
});

// -------------------------------------------------------------- monthly basic

describe('monthly salary', () => {
  it('pays exactly the salary for a full period with nothing unusual', () => {
    const result = run({ segments: [segment(standardMonth())] });
    expect(result.basicAmount).toBe(SALARY);
    expect(result.grossAmount).toBe(SALARY);
    expect(result.netAmount).toBe(SALARY);
  });

  it('derives the daily and hourly rates from the basis and standard hours', () => {
    const result = run({ segments: [segment(standardMonth())] });
    expect(result.basisDays).toBe(30);
    expect(result.dailyRate).toBe(DAILY_RATE);
    expect(result.hourlyRate).toBe(HOURLY_RATE);
  });

  it('a fixed basis of 26 prices a day at 120,000 / 26, not / 30', () => {
    // The basis is read from configuration, never assumed. An absence under
    // a 26-day contract costs more than under a 30-day one, and should.
    const month = [...days(21), ...days(1, { status: 'ABSENT', workedMinutes: null }), ...days(8, { status: 'WEEKEND' })];
    const result = run({ segments: [segment(month)], config: { fixedBasisDays: 26 } });
    expect(result.basisDays).toBe(26);
    expect(result.dailyRate).toBe(roundTo(SALARY / 26, 2)); // 4,615.38
    expect(result.deductions.find((d) => d.kind === 'ABSENCE')?.amount).toBe(roundTo(SALARY / 26, 2));
  });

  it('deducts an absence at the daily rate', () => {
    const month = [...days(20), ...days(2, { status: 'ABSENT', workedMinutes: null }), ...days(8, { status: 'WEEKEND' })];
    const result = run({ segments: [segment(month)] });

    expect(result.tally.absentDays).toBe(2);
    // Basic is unchanged; the absence is a deduction, so the payslip shows both.
    expect(result.basicAmount).toBe(SALARY);
    expect(result.deductionsTotal).toBe(2 * DAILY_RATE);
    expect(result.netAmount).toBe(SALARY - 2 * DAILY_RATE);
  });

  it('charges half a day for a half day', () => {
    const month = [...days(21), ...days(1, { status: 'HALF_DAY' }), ...days(8, { status: 'WEEKEND' })];
    const result = run({ segments: [segment(month)] });
    expect(result.netAmount).toBe(SALARY - 0.5 * DAILY_RATE);
  });

  it('leaves pay alone when absence deduction is switched off', () => {
    const month = [...days(20), ...days(2, { status: 'ABSENT' }), ...days(8, { status: 'WEEKEND' })];
    const result = run({ segments: [segment(month)], config: { deductUnpaidAbsence: false } });
    expect(result.netAmount).toBe(SALARY);
  });
});

// ------------------------------------------------------------------ the raise

describe('effective-dated salary', () => {
  it('pays each salary for the part of the period it covered', () => {
    // The stated rule: Jan-Jun 100,000, from Jul 120,000. Within one period,
    // a raise on the 16th pays half the month at each rate.
    const first = { salaryType: 'MONTHLY' as const, amount: 100000, currency: 'PKR', days: days(15) };
    const second = { salaryType: 'MONTHLY' as const, amount: 120000, currency: 'PKR', days: days(15) };

    const result = run({ segments: [first, second] });

    // 100,000 x 15/30 + 120,000 x 15/30
    expect(result.basicAmount).toBe(50000 + 60000);
  });

  it('pays exactly one salary when only one was in force', () => {
    // No basis arithmetic: dividing by 30 and multiplying back introduces an
    // error the contract never had.
    const result = run({ segments: [segment(standardMonth(), 100000)] });
    expect(result.basicAmount).toBe(100000);
  });

  it('prices absence from the salary in force at the end of the period', () => {
    const first = { salaryType: 'MONTHLY' as const, amount: 100000, currency: 'PKR', days: days(15) };
    const second = {
      salaryType: 'MONTHLY' as const,
      amount: 120000,
      currency: 'PKR',
      days: [...days(14), ...days(1, { status: 'ABSENT' })],
    };

    const result = run({ segments: [first, second] });
    expect(result.dailyRate).toBe(DAILY_RATE); // 120,000 / 30
  });
});

// ------------------------------------------------------------------- overtime

describe('overtime', () => {
  it('pays the multiplier on the hourly rate', () => {
    // 2 hours at 500 x 1.5
    const month = [...days(21), ...days(1, { overtimeMinutes: 120 }), ...days(8, { status: 'WEEKEND' })];
    const result = run({ segments: [segment(month)] });

    expect(result.tally.overtimeMinutes).toBe(120);
    expect(result.overtimeAmount).toBe(2 * HOURLY_RATE * 1.5);
    expect(result.grossAmount).toBe(SALARY + 1500);
  });

  it('pays a fixed rate when configured', () => {
    const month = [...days(21), ...days(1, { overtimeMinutes: 120 }), ...days(8, { status: 'WEEKEND' })];
    const result = run({
      segments: [segment(month)],
      config: { overtimeMode: 'FIXED_RATE', overtimeFixedRate: 900 },
    });
    expect(result.overtimeAmount).toBe(2 * 900);
  });

  it('takes the daily cap as the attendance engine already applied it', () => {
    // Payroll never re-derives overtime from punches. The engine caps a day at
    // 240 minutes, so a long day arrives here already capped and payroll pays
    // exactly what it was given.
    const month = [...days(21), ...days(1, { overtimeMinutes: 240 }), ...days(8, { status: 'WEEKEND' })];
    const result = run({ segments: [segment(month)] });

    expect(result.tally.overtimeMinutes).toBe(240);
    expect(result.overtimeAmount).toBe(4 * HOURLY_RATE * 1.5); // 3,000
  });

  it('sums overtime across the period', () => {
    const month = [...days(20), ...days(2, { overtimeMinutes: 30 }), ...days(8, { status: 'WEEKEND' })];
    const result = run({ segments: [segment(month)] });
    expect(result.tally.overtimeMinutes).toBe(60);
    expect(result.overtimeAmount).toBe(1 * HOURLY_RATE * 1.5);
  });

  it('pays nothing for overtime that has not been approved, when approval is required', () => {
    // The production setting today. Without an approved timesheet behind the
    // day, none of it is paid - which is why no phantom overtime could ever
    // have reached a payslip.
    const month = [...days(21), ...days(1, { overtimeMinutes: 240 }), ...days(8, { status: 'WEEKEND' })];
    const result = run({ segments: [segment(month)], config: { requireApprovedOvertime: true } });

    expect(result.tally.overtimeMinutes).toBe(240);
    expect(result.tally.approvedOvertimeMinutes).toBe(0);
    expect(result.overtimeAmount).toBe(0);
  });

  it('pays approved overtime when approval is required', () => {
    const month = [
      ...days(21),
      ...days(1, { overtimeMinutes: 120, overtimeApproved: true }),
      ...days(8, { status: 'WEEKEND' }),
    ];
    const result = run({ segments: [segment(month)], config: { requireApprovedOvertime: true } });
    expect(result.overtimeAmount).toBe(2 * HOURLY_RATE * 1.5);
  });

  it('honours an hourly rate override', () => {
    const month = [...days(21), ...days(1, { overtimeMinutes: 60 }), ...days(8, { status: 'WEEKEND' })];
    const result = run({ segments: [segment(month)], config: { hourlyRateOverride: 1000 } });
    expect(result.overtimeAmount).toBe(1 * 1000 * 1.5);
  });
});

// ----------------------------------------------------------------------- leave

describe('leave', () => {
  it('pays paid leave and does not deduct for it', () => {
    const month = [
      ...days(19),
      ...days(3, { status: 'ON_LEAVE', leaveIsPaid: true, leaveDayPart: 'FULL_DAY', workedMinutes: null }),
      ...days(8, { status: 'WEEKEND' }),
    ];
    const result = run({ segments: [segment(month)] });

    expect(result.tally.paidLeaveDays).toBe(3);
    expect(result.deductionsTotal).toBe(0);
    expect(result.netAmount).toBe(SALARY);
  });

  it('deducts unpaid leave at the daily rate', () => {
    const month = [
      ...days(19),
      ...days(3, { status: 'ON_LEAVE', leaveIsPaid: false, leaveDayPart: 'FULL_DAY', workedMinutes: null }),
      ...days(8, { status: 'WEEKEND' }),
    ];
    const result = run({ segments: [segment(month)] });

    expect(result.tally.unpaidLeaveDays).toBe(3);
    expect(result.netAmount).toBe(SALARY - 3 * DAILY_RATE);
  });

  it('charges half a day for half-day leave', () => {
    const month = [
      ...days(21),
      ...days(1, { status: 'ON_LEAVE', leaveIsPaid: false, leaveDayPart: 'FIRST_HALF', workedMinutes: 270 }),
      ...days(8, { status: 'WEEKEND' }),
    ];
    const result = run({ segments: [segment(month)] });

    expect(result.tally.unpaidLeaveDays).toBe(0.5);
    expect(result.netAmount).toBe(SALARY - 0.5 * DAILY_RATE);
  });

  it('leaves unpaid leave alone when the deduction is switched off', () => {
    const month = [
      ...days(19),
      ...days(3, { status: 'ON_LEAVE', leaveIsPaid: false, leaveDayPart: 'FULL_DAY' }),
      ...days(8, { status: 'WEEKEND' }),
    ];
    const result = run({ segments: [segment(month)], config: { deductUnpaidLeave: false } });
    expect(result.netAmount).toBe(SALARY);
  });
});

// ------------------------------------------------------ allowances, deductions

const allowance = (over: Partial<ComponentInput> = {}): ComponentInput => ({
  componentId: 'c1',
  code: 'HOUSE',
  label: 'House rent',
  kind: 'EARNING',
  calc: 'FIXED',
  value: 10000,
  isTaxable: true,
  ...over,
});

describe('allowances', () => {
  it('adds a fixed allowance to gross', () => {
    const result = run({ segments: [segment(standardMonth())], components: [allowance()] });
    expect(result.grossAmount).toBe(SALARY + 10000);
    expect(result.netAmount).toBe(SALARY + 10000);
  });

  it('computes a percentage of basic', () => {
    const result = run({
      segments: [segment(standardMonth())],
      components: [allowance({ calc: 'PERCENT_OF_BASIC', value: 10 })],
    });
    expect(result.grossAmount).toBe(SALARY + 12000); // 10% of 120,000
  });

  it('reads percent-of-gross against basic plus the fixed allowances, in a fixed order', () => {
    // Without the ordering, two percentage components would each be computed on
    // a total that included the other and the answer would depend on iteration.
    const result = run({
      segments: [segment(standardMonth())],
      components: [
        allowance({ componentId: 'c1', value: 10000 }),
        allowance({ componentId: 'c2', code: 'MED', calc: 'PERCENT_OF_GROSS', value: 10 }),
      ],
    });
    // 10% of (120,000 + 10,000)
    expect(result.grossAmount).toBe(120000 + 10000 + 13000);
  });

  it('includes overtime in the gross a percentage is read against', () => {
    const month = [...days(21), ...days(1, { overtimeMinutes: 120 }), ...days(8, { status: 'WEEKEND' })];
    const result = run({
      segments: [segment(month)],
      components: [allowance({ calc: 'PERCENT_OF_GROSS', value: 10 })],
    });
    // basic 120,000 + overtime 1,500, then 10% of that
    expect(result.grossAmount).toBe(121500 + 12150);
  });
});

describe('deductions', () => {
  it('subtracts a fixed deduction from net without touching gross', () => {
    const result = run({
      segments: [segment(standardMonth())],
      components: [allowance({ kind: 'DEDUCTION', code: 'LOAN', label: 'Loan', value: 5000 })],
    });
    expect(result.grossAmount).toBe(SALARY);
    expect(result.deductionsTotal).toBe(5000);
    expect(result.netAmount).toBe(SALARY - 5000);
  });

  it('computes a deduction as a percentage of basic', () => {
    const result = run({
      segments: [segment(standardMonth())],
      components: [
        allowance({ kind: 'DEDUCTION', code: 'X', calc: 'PERCENT_OF_BASIC', value: 5 }),
      ],
    });
    expect(result.netAmount).toBe(SALARY - 6000);
  });

  it('charges lateness only when the deduction is configured', () => {
    const month = [...days(20, { lateMinutes: 30 }), ...days(2), ...days(8, { status: 'WEEKEND' })];

    expect(run({ segments: [segment(month)] }).deductionsTotal).toBe(0);

    const charged = run({
      segments: [segment(month)],
      config: { lateDeductionMode: 'PER_MINUTE', lateDeductionRate: 10 },
    });
    expect(charged.deductionsTotal).toBe(20 * 30 * 10);
  });

  it('charges early leaving only when configured, after the payroll grace', () => {
    // Three days leaving 25 minutes early, one leaving 5 minutes early.
    const month = [
      ...days(18),
      ...days(3, { earlyLeaveMinutes: 25 }),
      ...days(1, { earlyLeaveMinutes: 5 }),
      ...days(8, { status: 'WEEKEND' }),
    ];

    expect(run({ segments: [segment(month)] }).deductionsTotal).toBe(0);

    const perOccurrence = run({
      segments: [segment(month)],
      config: { earlyLeaveDeductionMode: 'PER_OCCURRENCE', earlyLeaveDeductionRate: 200, earlyLeaveGraceMinutes: 10 },
    });
    // The 5-minute day is inside the grace and does not count.
    expect(perOccurrence.tally.earlyLeaveOccurrences).toBe(3);
    expect(perOccurrence.deductions.find((d) => d.kind === 'EARLY_LEAVE')?.amount).toBe(3 * 200);

    const perMinute = run({
      segments: [segment(month)],
      config: { earlyLeaveDeductionMode: 'PER_MINUTE', earlyLeaveDeductionRate: 10, earlyLeaveGraceMinutes: 10 },
    });
    // 25 - 10 grace = 15 chargeable minutes a day, three days.
    expect(perMinute.tally.earlyLeaveMinutes).toBe(45);
    expect(perMinute.deductions.find((d) => d.kind === 'EARLY_LEAVE')?.amount).toBe(45 * 10);
    expect(perMinute.netAmount).toBe(SALARY - 450);
  });
});

// --------------------------------------------------------------- adjustments

describe('manual adjustments', () => {
  it('adds a bonus to gross and to net', () => {
    const result = run({
      segments: [segment(standardMonth())],
      adjustments: [{ id: 'a1', kind: 'EARNING', label: 'Eid bonus', amount: 25000 }],
    });
    expect(result.grossAmount).toBe(SALARY + 25000);
    expect(result.netAmount).toBe(SALARY + 25000);
    expect(result.adjustmentTotal).toBe(25000);
  });

  it('subtracts a deduction adjustment', () => {
    const result = run({
      segments: [segment(standardMonth())],
      adjustments: [{ id: 'a1', kind: 'DEDUCTION', label: 'Advance recovery', amount: 15000 }],
    });
    expect(result.netAmount).toBe(SALARY - 15000);
    expect(result.adjustmentTotal).toBe(-15000);
  });

  it('nets several adjustments together', () => {
    const result = run({
      segments: [segment(standardMonth())],
      adjustments: [
        { id: 'a1', kind: 'EARNING', label: 'Bonus', amount: 20000 },
        { id: 'a2', kind: 'DEDUCTION', label: 'Advance', amount: 5000 },
      ],
    });
    expect(result.adjustmentTotal).toBe(15000);
    expect(result.netAmount).toBe(SALARY + 20000 - 5000);
  });
});

// ------------------------------------------------------------- the whole thing

describe('a complete payslip', () => {
  it('adds up, line by line, to the stated net', () => {
    // 20 present, 1 unpaid absence, 1 paid leave, 2 hours overtime, a 10,000
    // house allowance, a 5,000 loan deduction and a 25,000 bonus.
    const month = [
      ...days(19),
      ...days(1, { overtimeMinutes: 120 }),
      ...days(1, { status: 'ABSENT', workedMinutes: null }),
      ...days(1, { status: 'ON_LEAVE', leaveIsPaid: true, leaveDayPart: 'FULL_DAY', workedMinutes: null }),
      ...days(8, { status: 'WEEKEND' }),
    ];

    const result = run({
      segments: [segment(month)],
      components: [
        allowance({ value: 10000 }),
        allowance({ componentId: 'c2', kind: 'DEDUCTION', code: 'LOAN', label: 'Loan', value: 5000 }),
      ],
      adjustments: [{ id: 'a1', kind: 'EARNING', label: 'Eid bonus', amount: 25000 }],
    });

    const overtimePay = 2 * HOURLY_RATE * 1.5; // 1,500
    const gross = SALARY + overtimePay + 10000 + 25000; // 156,500
    const deductions = DAILY_RATE + 5000; // absence 4,000 + loan 5,000

    expect(result.tally.presentDays).toBe(20);
    expect(result.tally.absentDays).toBe(1);
    expect(result.tally.paidLeaveDays).toBe(1);
    expect(result.grossAmount).toBe(gross);
    expect(result.deductionsTotal).toBe(deductions);
    expect(result.netAmount).toBe(gross - deductions);

    // The totals are the lines, not a parallel sum that could drift from them.
    expect(result.earnings.reduce((s, l) => s + l.amount, 0)).toBe(result.grossAmount);
    expect(result.deductions.reduce((s, l) => s + l.amount, 0)).toBe(result.deductionsTotal);
  });

  it('never invents a tax or statutory line', () => {
    const result = run({
      segments: [segment(standardMonth())],
      components: [allowance()],
      adjustments: [{ id: 'a1', kind: 'EARNING', label: 'Bonus', amount: 1000 }],
    });

    const codes = [...result.earnings, ...result.deductions].map((l) => l.code);
    for (const invented of ['TAX', 'INCOME_TAX', 'EOBI', 'SOCIAL_SECURITY', 'PF', 'PROVIDENT']) {
      expect(codes).not.toContain(invented);
    }
  });
});

// --------------------------------------------------- per-unit components

describe('per-day and per-hour components', () => {
  it('prices a per-day allowance by the days actually paid for', () => {
    // 20 present + 2 absent: 20 payable days at 500. An absence does not also
    // earn a day's allowance.
    const month = [...days(20), ...days(2, { status: 'ABSENT', workedMinutes: null }), ...days(8, { status: 'WEEKEND' })];
    const result = run({
      segments: [segment(month)],
      components: [allowance({ code: 'MEAL', label: 'Meal', calc: 'PER_DAY', value: 500 })],
    });

    expect(result.payableDays).toBe(20);
    const line = result.earnings.find((l) => l.code === 'MEAL');
    expect(line?.units).toBe(20);
    expect(line?.amount).toBe(20 * 500);
  });

  it('prices a per-hour allowance by the hours actually worked', () => {
    // 22 days x 540 minutes = 198 hours, at 50 an hour.
    const result = run({
      segments: [segment(standardMonth())],
      components: [allowance({ code: 'SHIFT', label: 'Shift premium', calc: 'PER_HOUR', value: 50 })],
    });

    expect(result.tally.workedMinutes).toBe(22 * 540);
    const line = result.earnings.find((l) => l.code === 'SHIFT');
    expect(line?.units).toBe(198);
    expect(line?.amount).toBe(198 * 50);
  });

  it('prices a per-day deduction the same way', () => {
    const month = [...days(20), ...days(2, { status: 'ABSENT', workedMinutes: null }), ...days(8, { status: 'WEEKEND' })];
    const result = run({
      segments: [segment(month)],
      components: [allowance({ kind: 'DEDUCTION', code: 'TRANSPORT_D', label: 'Transport', calc: 'PER_DAY', value: 100 })],
    });

    const line = result.deductions.find((l) => l.code === 'TRANSPORT_D');
    expect(line?.amount).toBe(20 * 100);
  });

  it('pays nothing per hour on a period with no worked time', () => {
    const month = [...days(22, { status: 'ABSENT', workedMinutes: null }), ...days(8, { status: 'WEEKEND' })];
    const result = run({
      segments: [segment(month)],
      components: [allowance({ code: 'SHIFT', label: 'Shift', calc: 'PER_HOUR', value: 50 })],
    });
    expect(result.earnings.find((l) => l.code === 'SHIFT')?.amount).toBe(0);
  });
});

// ------------------------------------------------------------- proration

describe('proration method', () => {
  // The stated case: 100,000 for the first half, 120,000 for the second.
  const first = (n: number) => ({ salaryType: 'MONTHLY' as const, amount: 100000, currency: 'PKR', days: days(n) });
  const second = (n: number) => ({ salaryType: 'MONTHLY' as const, amount: 120000, currency: 'PKR', days: days(n) });

  it('by calendar days: 15 + 15 of a 30-day month is exactly 110,000', () => {
    const result = run({ segments: [first(15), second(15)], periodDays: 30 });
    expect(result.basicAmount).toBe(110000);
  });

  it('does not round the split incorrectly', () => {
    // 10 + 21 of a 31-day month. 100,000 x 10/31 + 120,000 x 21/31, rounded
    // once at the end, not once per segment.
    const result = run({ segments: [first(10), second(21)], periodDays: 31 });
    expect(result.basicAmount).toBe(roundTo((100000 * 10) / 31 + (120000 * 21) / 31, 2));
    expect(result.basicAmount).toBe(113548.39);
  });

  it('by working days: only scheduled days decide the split', () => {
    // First segment covers 10 scheduled days and 4 weekend days; second covers
    // 12 scheduled and 4 weekend. By calendar days the split is 14/16; by
    // working days it is 10/12 - the weekends stop counting.
    const a = { ...first(0), days: [...days(10), ...days(4, { status: 'WEEKEND', workedMinutes: null })] };
    const b = { ...second(0), days: [...days(12), ...days(4, { status: 'WEEKEND', workedMinutes: null })] };

    const calendar = run({ segments: [a, b], periodDays: 30, config: { prorationMethod: 'CALENDAR_DAYS' } });
    const working = run({ segments: [a, b], periodDays: 30, config: { prorationMethod: 'WORKING_DAYS' } });

    expect(calendar.basicAmount).toBe(roundTo((100000 * 14) / 30 + (120000 * 16) / 30, 2));
    expect(working.basicAmount).toBe(roundTo((100000 * 10) / 22 + (120000 * 12) / 22, 2));
    expect(calendar.basicAmount).not.toBe(working.basicAmount);
  });

  it('a full period at one salary pays exactly that salary under either method', () => {
    for (const prorationMethod of ['CALENDAR_DAYS', 'WORKING_DAYS'] as const) {
      expect(run({ segments: [segment(standardMonth())], config: { prorationMethod } }).basicAmount).toBe(SALARY);
    }
  });
});

// -------------------------------------------------------- the 9-hour day

describe('the standard day is configuration', () => {
  it('9 hours per day is 540 minutes and prices the hourly rate from it', () => {
    // If the company sets its payroll day to 9 hours - the 09:00-18:00
    // office window with the break inside it - the hourly rate follows.
    const nine = run({ segments: [segment(standardMonth())], config: { standardHoursPerDay: 9 } });
    expect(9 * 60).toBe(540);
    expect(nine.dailyRate).toBe(DAILY_RATE);
    expect(nine.hourlyRate).toBe(roundTo(DAILY_RATE / 9, 2));
  });

  it('overtime is priced from whichever standard day is configured', () => {
    // Two hours of overtime at 1.5x. At 8 hours/day the hourly rate is 500;
    // at 9 it is 444.44. Neither number lives in the engine.
    const month = [...days(21), ...days(1, { overtimeMinutes: 120 }), ...days(8, { status: 'WEEKEND' })];
    const eight = run({ segments: [segment(month)], config: { standardHoursPerDay: 8 } });
    const nine = run({ segments: [segment(month)], config: { standardHoursPerDay: 9 } });

    expect(eight.overtimeAmount).toBe(roundTo(500 * 1.5 * 2, 2));
    expect(nine.overtimeAmount).toBe(roundTo((DAILY_RATE / 9) * 1.5 * 2, 2));
  });

  it('the office window is not the payroll day: 540 worked minutes at 8 standard hours is still one full day', () => {
    // A 09:00-18:00 day is 540 minutes of presence. Payroll prices it as one
    // payable day, not as 8 hours plus an hour of something else.
    const result = run({ segments: [segment(standardMonth())], config: { standardHoursPerDay: 8 } });
    expect(result.tally.presentDays).toBe(22);
    expect(result.payableDays).toBe(22);
    expect(result.basicAmount).toBe(SALARY);
    expect(result.overtimeAmount).toBe(0);
  });
});

// ---------------------------------------------------------------- overtime cap

describe('overtime cap', () => {
  const month = [...days(21), ...days(1, { overtimeMinutes: 240 }), ...days(8, { status: 'WEEKEND' })];

  it('pays every minute when there is no cap', () => {
    const result = run({ segments: [segment(month)], config: { overtimeCapMinutes: null } });
    expect(result.paidOvertimeMinutes).toBe(240);
    expect(result.cappedOvertimeMinutes).toBe(0);
    expect(result.overtimeAmount).toBe(4 * HOURLY_RATE * 1.5);
  });

  it('pays up to the cap and reports the rest', () => {
    // 4 hours worked, 2 allowed: 2 x 500 x 1.5 = 1,500, and 120 minutes go unpaid.
    const result = run({ segments: [segment(month)], config: { overtimeCapMinutes: 120 } });
    expect(result.paidOvertimeMinutes).toBe(120);
    expect(result.cappedOvertimeMinutes).toBe(120);
    expect(result.overtimeAmount).toBe(2 * HOURLY_RATE * 1.5);
    expect(result.earnings.find((e) => e.kind === 'OVERTIME')?.units).toBe(2);
  });

  it('a cap of zero pays nothing and reports everything', () => {
    const result = run({ segments: [segment(month)], config: { overtimeCapMinutes: 0 } });
    expect(result.paidOvertimeMinutes).toBe(0);
    expect(result.cappedOvertimeMinutes).toBe(240);
    expect(result.overtimeAmount).toBe(0);
    expect(result.grossAmount).toBe(SALARY);
  });

  it('a cap above what was worked changes nothing', () => {
    const capped = run({ segments: [segment(month)], config: { overtimeCapMinutes: 600 } });
    const open = run({ segments: [segment(month)], config: { overtimeCapMinutes: null } });
    expect(capped.overtimeAmount).toBe(open.overtimeAmount);
    expect(capped.cappedOvertimeMinutes).toBe(0);
  });

  it('caps the period total, not each day', () => {
    // Three days of 60 minutes: 180 worked, 100 allowed. The cap is a ceiling
    // on the period, so the third day is what falls outside it.
    const spread = [...days(19), ...days(3, { overtimeMinutes: 60 }), ...days(8, { status: 'WEEKEND' })];
    const result = run({ segments: [segment(spread)], config: { overtimeCapMinutes: 100 } });
    expect(result.tally.overtimeMinutes).toBe(180);
    expect(result.paidOvertimeMinutes).toBe(100);
    expect(result.cappedOvertimeMinutes).toBe(80);
    expect(result.overtimeAmount).toBe(roundTo((100 / 60) * HOURLY_RATE * 1.5, 2));
  });

  it('is applied after approval, so unapproved minutes never count against it', () => {
    // 240 recorded, 60 approved, cap 120: the 60 approved are paid in full.
    const mixed = [
      ...days(20),
      ...days(1, { overtimeMinutes: 180 }),
      ...days(1, { overtimeMinutes: 60, overtimeApproved: true }),
      ...days(8, { status: 'WEEKEND' }),
    ];
    const result = run({
      segments: [segment(mixed)],
      config: { requireApprovedOvertime: true, overtimeCapMinutes: 120 },
    });
    expect(result.tally.approvedOvertimeMinutes).toBe(60);
    expect(result.paidOvertimeMinutes).toBe(60);
    expect(result.cappedOvertimeMinutes).toBe(0);
    expect(result.overtimeAmount).toBe(1 * HOURLY_RATE * 1.5);
  });

  it('spends the cap on ordinary overtime first, then weekend, then holiday', () => {
    expect(capOvertime({ regular: 60, weekend: 60, holiday: 60 }, 90)).toEqual({
      regular: 60,
      weekend: 30,
      holiday: 0,
      capped: 90,
    });
    expect(capOvertime({ regular: 60, weekend: 60, holiday: 60 }, null)).toEqual({
      regular: 60,
      weekend: 60,
      holiday: 60,
      capped: 0,
    });
  });

  it('the cap trims premium-rate weekend minutes before ordinary ones', () => {
    // 120 ordinary at 1.5x and 120 weekend at 2x, cap 180: the ordinary
    // 120 are paid in full and only 60 of the weekend minutes are.
    const withWeekend = [
      ...days(21),
      ...days(1, { overtimeMinutes: 120 }),
      ...days(7, { status: 'WEEKEND' }),
      ...days(1, { status: 'WEEKEND', overtimeMinutes: 120 }),
    ];
    const result = run({
      segments: [segment(withWeekend)],
      config: { overtimeCapMinutes: 180, overtimeWeekendMultiplier: 2 },
    });
    expect(result.paidOvertimeMinutes).toBe(180);
    expect(result.cappedOvertimeMinutes).toBe(60);
    expect(result.overtimeAmount).toBe(roundTo(2 * HOURLY_RATE * 1.5 + 1 * HOURLY_RATE * 2, 2));
  });
});

// ------------------------------------------------ the specification's example

describe('the stated example: 120,000 a month, a 9-hour day', () => {
  // 120,000 / 30 = 4,000 a day; 4,000 / 9 = 444.44 an hour. The multiplier
  // is read from configuration each time, so 1.5x and 2x are both checked
  // and neither is a constant in the engine.
  const NINE: Partial<EffectiveConfig> = { standardHoursPerDay: 9 };
  const month = [...days(21), ...days(1, { overtimeMinutes: 180, overtimeApproved: true }), ...days(8, { status: 'WEEKEND' })];

  it('540 minutes is one working day and the rates follow the basis', () => {
    const result = run({ segments: [segment(standardMonth())], config: NINE });
    expect(9 * 60).toBe(540);
    expect(result.dailyRate).toBe(4000);
    expect(result.hourlyRate).toBe(roundTo(4000 / 9, 2));
    expect(result.basicAmount).toBe(120000);
  });

  it('overtime pay = hourly rate x hours x multiplier, at 1.5x', () => {
    const result = run({ segments: [segment(month)], config: { ...NINE, requireApprovedOvertime: true } });
    expect(result.paidOvertimeMinutes).toBe(180);
    expect(result.overtimeAmount).toBe(roundTo((4000 / 9) * 3 * 1.5, 2)); // 2,000.00
    expect(result.grossAmount).toBe(120000 + 2000);
  });

  it('and at 2x, because the multiplier is configuration', () => {
    const result = run({
      segments: [segment(month)],
      config: { ...NINE, requireApprovedOvertime: true, overtimeMultiplier: 2 },
    });
    expect(result.overtimeAmount).toBe(roundTo((4000 / 9) * 3 * 2, 2)); // 2,666.67
  });

  it('with overtime switched off, the same hours pay nothing', () => {
    const result = run({ segments: [segment(month)], config: { ...NINE, overtimeMode: 'NONE' } });
    expect(result.overtimeAmount).toBe(0);
    expect(result.grossAmount).toBe(120000);
  });

  it('the whole formula: basic + allowance + overtime + bonus - deduction - unpaid leave - absence', () => {
    // 21 present, 1 absent, 1 unpaid leave day... on a 9-hour day at 120,000.
    const period = [
      ...days(19),
      ...days(1, { overtimeMinutes: 180, overtimeApproved: true }),
      ...days(1, { status: 'ABSENT', workedMinutes: null }),
      ...days(1, { status: 'ON_LEAVE', leaveIsPaid: false, leaveDayPart: 'FULL_DAY', workedMinutes: null }),
      ...days(8, { status: 'WEEKEND', workedMinutes: null }),
    ];
    const result = run({
      segments: [segment(period)],
      config: { ...NINE, requireApprovedOvertime: true },
      components: [
        { componentId: 'c1', code: 'HRA', label: 'House rent', kind: 'EARNING', calc: 'FIXED', value: 10000, isTaxable: true },
        { componentId: 'c2', code: 'PF', label: 'Provident fund', kind: 'DEDUCTION', calc: 'PERCENT_OF_BASIC', value: 5, isTaxable: false },
      ],
      adjustments: [{ id: 'a1', kind: 'EARNING', label: 'Performance bonus', amount: 5000 }],
    });

    const overtimePay = roundTo((4000 / 9) * 3 * 1.5, 2); // 2,000.00
    expect(result.basicAmount).toBe(120000);
    expect(result.overtimeAmount).toBe(overtimePay);
    expect(result.grossAmount).toBe(120000 + 10000 + overtimePay + 5000); // 137,000
    expect(result.deductions.find((d) => d.kind === 'ABSENCE')?.amount).toBe(4000);
    expect(result.deductions.find((d) => d.kind === 'UNPAID_LEAVE')?.amount).toBe(4000);
    expect(result.deductions.find((d) => d.code === 'PF')?.amount).toBe(6000); // 5% of 120,000
    expect(result.deductionsTotal).toBe(4000 + 4000 + 6000);
    expect(result.netAmount).toBe(137000 - 14000); // 123,000
  });
});

// ------------------------------------------------------------------- lifecycle

describe('run lifecycle', () => {
  it('follows DRAFT -> REVIEW -> APPROVED -> FINALIZED', () => {
    expect(canTransition('DRAFT', 'CALCULATING')).toBe(true);
    expect(canTransition('CALCULATING', 'REVIEW')).toBe(true);
    expect(canTransition('REVIEW', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVED', 'FINALIZED')).toBe(true);
  });

  it('lets a run go back for another look before it is finalized', () => {
    expect(canTransition('REVIEW', 'CALCULATING')).toBe(true);
    expect(canTransition('APPROVED', 'REVIEW')).toBe(true);
  });

  it('will not skip review or approval', () => {
    expect(canTransition('DRAFT', 'FINALIZED')).toBe(false);
    expect(canTransition('DRAFT', 'APPROVED')).toBe(false);
    expect(canTransition('REVIEW', 'FINALIZED')).toBe(false);
  });

  it('lets nothing out of FINALIZED', () => {
    // A finalized run is a fact. Corrections are a new adjustment, never an
    // edit to what was already paid.
    for (const to of ['DRAFT', 'CALCULATING', 'REVIEW', 'APPROVED', 'CANCELLED']) {
      expect(canTransition('FINALIZED', to)).toBe(false);
    }
  });

  it('lets nothing out of CANCELLED', () => {
    for (const to of ['DRAFT', 'CALCULATING', 'REVIEW', 'APPROVED', 'FINALIZED']) {
      expect(canTransition('CANCELLED', to)).toBe(false);
    }
  });
});

// -------------------------------------------------- the hand-checkable example

/**
 * The worked example, in full.
 *
 * Salary 120,000. A 30-day period: 20 days present, 2 days of paid leave,
 * 3 days of unpaid absence, 5 weekend days. Two hours of approved overtime and
 * a 10,000 allowance.
 *
 * The arithmetic, written out so it can be checked on paper:
 *
 *   daily rate     120,000 / 30 basis days              =   4,000.00
 *   hourly rate      4,000 / 8 standard hours           =     500.00
 *
 *   basic          one salary, whole period             = 120,000.00
 *   overtime       2 h x 500 x 1.5                      =   1,500.00
 *   allowance      fixed                                =  10,000.00
 *                                                        -----------
 *   GROSS                                                 131,500.00
 *
 *   unpaid absence 3 days x 4,000                       =  12,000.00
 *   paid leave     2 days, paid, nothing deducted       =       0.00
 *                                                        -----------
 *   DEDUCTIONS                                             12,000.00
 *
 *   NET            131,500 - 12,000                     = 119,500.00
 *
 * Scheduled days are 20 + 2 + 3 = 25; the 5 weekend days are nobody's
 * expectation. Payable days are 25 - 3 = 22.
 */
describe('the worked example', () => {
  const month = [
    ...days(19),
    // The two hours of approved overtime, on one of the twenty present days.
    ...days(1, { overtimeMinutes: 120, overtimeApproved: true }),
    ...days(2, {
      status: 'ON_LEAVE',
      leaveIsPaid: true,
      leaveIsDeductible: null,
      leaveDayPart: 'FULL_DAY',
      workedMinutes: null,
    }),
    ...days(3, { status: 'ABSENT', workedMinutes: null }),
    ...days(5, { status: 'WEEKEND', workedMinutes: null }),
  ];

  const result = run({
    segments: [segment(month)],
    config: { requireApprovedOvertime: true },
    components: [allowance({ value: 10000 })],
  });

  it('counts the period the way the example states it', () => {
    expect(result.tally.scheduledDays).toBe(25);
    expect(result.tally.presentDays).toBe(20);
    expect(result.tally.paidLeaveDays).toBe(2);
    expect(result.tally.absentDays).toBe(3);
    expect(result.tally.weekendDays).toBe(5);
    expect(result.payableDays).toBe(22);
    expect(result.unpaidDays).toBe(3);
  });

  it('derives the rates from the basis, not from the calendar', () => {
    expect(result.basisDays).toBe(30);
    expect(result.dailyRate).toBe(4000);
    expect(result.hourlyRate).toBe(500);
  });

  it('reaches 131,500 gross and 119,500 net, line by line', () => {
    const line = (code: string) =>
      [...result.earnings, ...result.deductions].find((l) => l.code === code);

    expect(line('BASIC')?.amount).toBe(120000);
    expect(line('OVERTIME')?.amount).toBe(1500);
    expect(line('HOUSE')?.amount).toBe(10000);
    expect(line('ABSENCE')?.amount).toBe(12000);
    // Paid leave costs nothing: there is no line for it at all.
    expect(line('UNPAID_LEAVE')).toBeUndefined();

    expect(result.grossAmount).toBe(131500);
    expect(result.deductionsTotal).toBe(12000);
    expect(result.netAmount).toBe(119500);
  });

  it('pays no overtime at all when the approval is withheld', () => {
    // The same period with the two hours unapproved: gross drops by exactly
    // the overtime line and nothing else moves.
    const unapproved = run({
      segments: [
        segment(
          month.map((d) => (d.overtimeMinutes ? { ...d, overtimeApproved: false } : d)),
        ),
      ],
      config: { requireApprovedOvertime: true },
      components: [allowance({ value: 10000 })],
    });

    expect(unapproved.grossAmount).toBe(130000);
    expect(unapproved.netAmount).toBe(118000);
  });
});
