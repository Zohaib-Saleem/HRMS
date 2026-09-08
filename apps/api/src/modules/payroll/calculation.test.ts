import { describe, expect, it } from 'vitest';
import {
  calculate,
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
