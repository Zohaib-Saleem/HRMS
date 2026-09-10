import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DayFact } from './calculation.js';
import type { SalaryRow } from './payroll.service.js';

/**
 * The service around the calculation: which salary is in force on a day, how
 * a period is cut into salary segments, what the effective configuration is
 * once an employee's overrides are laid over the company's, and the two
 * gates that make a finalized run immutable.
 *
 * The database is a mock throughout. Nothing here needs a row to exist; it
 * needs to know what the service does when one says FINALIZED.
 */

const db = vi.hoisted(() => ({
  payrollRun: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  payrollSettings: { findUnique: vi.fn(), create: vi.fn() },
  payslip: { count: vi.fn(), create: vi.fn() },
  payrollAdjustment: { updateMany: vi.fn() },
  payrollPeriod: { update: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const {
  calculateRun,
  daysInRange,
  effectiveConfig,
  finalizeRun,
  overlappingSalaries,
  salaryOn,
  segmentBySalary,
  shiftLengthMinutes,
} = await import('./payroll.service.js');

const d = (value: string): Date => new Date(`${value}T00:00:00Z`);

function salary(over: Partial<SalaryRow> & { id: string }): SalaryRow {
  return {
    salaryType: 'MONTHLY',
    amount: 100000,
    currency: 'PKR',
    effectiveFrom: d('2026-01-01'),
    effectiveTo: null,
    ...over,
  };
}

function day(date: string): DayFact {
  return {
    date,
    status: 'PRESENT',
    leaveIsPaid: null,
    leaveDayPart: null,
    workedMinutes: 540,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    overtimeApproved: false,
    scheduledMinutes: 540,
    hasShift: true,
    hasRecord: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------- salary lookup

describe('salary lookup', () => {
  const rows = [
    salary({ id: 'old', amount: 100000, effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-06-15') }),
    salary({ id: 'new', amount: 120000, effectiveFrom: d('2026-06-16') }),
  ];

  it('finds the salary in force on a day', () => {
    expect(salaryOn(rows, '2026-06-15')?.id).toBe('old');
    expect(salaryOn(rows, '2026-06-16')?.id).toBe('new');
    expect(salaryOn(rows, '2026-12-31')?.id).toBe('new');
  });

  it('finds nothing before the first record began', () => {
    expect(salaryOn(rows, '2025-12-31')).toBeNull();
  });

  it('finds nothing in a gap between records', () => {
    const gapped = [
      salary({ id: 'a', effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-03-31') }),
      salary({ id: 'b', effectiveFrom: d('2026-05-01') }),
    ];
    expect(salaryOn(gapped, '2026-04-15')).toBeNull();
  });

  it('is inclusive at both ends', () => {
    const one = [salary({ id: 'a', effectiveFrom: d('2026-03-01'), effectiveTo: d('2026-03-31') })];
    expect(salaryOn(one, '2026-03-01')?.id).toBe('a');
    expect(salaryOn(one, '2026-03-31')?.id).toBe('a');
    expect(salaryOn(one, '2026-04-01')).toBeNull();
  });

  it('prefers the latest start when two open-ended records both apply', () => {
    // Not a valid state - overlap detection refuses it - but the lookup must
    // still be deterministic rather than order-dependent.
    const twice = [
      salary({ id: 'first', effectiveFrom: d('2026-01-01') }),
      salary({ id: 'later', effectiveFrom: d('2026-03-01') }),
    ];
    expect(salaryOn(twice, '2026-06-01')?.id).toBe('later');
    expect(salaryOn([...twice].reverse(), '2026-06-01')?.id).toBe('later');
  });
});

describe('overlapping salaries', () => {
  it('accepts records that abut', () => {
    const rows = [
      salary({ id: 'a', effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-06-15') }),
      salary({ id: 'b', effectiveFrom: d('2026-06-16') }),
    ];
    expect(overlappingSalaries(rows)).toEqual([]);
  });

  it('flags a record that starts before the previous one ended', () => {
    const rows = [
      salary({ id: 'a', effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-06-30') }),
      salary({ id: 'b', effectiveFrom: d('2026-06-16') }),
    ];
    expect(overlappingSalaries(rows)).toEqual([['a', 'b']]);
  });

  it('flags a second open-ended record', () => {
    const rows = [salary({ id: 'a' }), salary({ id: 'b', effectiveFrom: d('2026-03-01') })];
    expect(overlappingSalaries(rows)).toEqual([['a', 'b']]);
  });
});

// ------------------------------------------------------------- effective dates

describe('cutting the period by salary', () => {
  const june = Array.from({ length: 30 }, (_, i) => day(`2026-06-${String(i + 1).padStart(2, '0')}`));

  it('one salary for the whole period is one segment', () => {
    const { segments, uncovered } = segmentBySalary(june, [salary({ id: 'a' })]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.days).toHaveLength(30);
    expect(uncovered).toEqual([]);
  });

  it('a raise on the 16th makes two segments of 15 days each', () => {
    const rows = [
      salary({ id: 'old', amount: 100000, effectiveTo: d('2026-06-15') }),
      salary({ id: 'new', amount: 120000, effectiveFrom: d('2026-06-16') }),
    ];
    const { segments, uncovered } = segmentBySalary(june, rows);
    expect(segments.map((s) => [s.amount, s.days.length])).toEqual([
      [100000, 15],
      [120000, 15],
    ]);
    expect(segments[0]?.days[0]?.date).toBe('2026-06-01');
    expect(segments[1]?.days[0]?.date).toBe('2026-06-16');
    expect(uncovered).toEqual([]);
  });

  it('reports days no salary covers rather than guessing', () => {
    const rows = [salary({ id: 'late', effectiveFrom: d('2026-06-10') })];
    const { segments, uncovered } = segmentBySalary(june, rows);
    expect(uncovered).toHaveLength(9);
    expect(uncovered[0]).toBe('2026-06-01');
    expect(segments[0]?.days).toHaveLength(21);
  });

  it('a salary that ends mid-period leaves the rest uncovered', () => {
    const rows = [salary({ id: 'a', effectiveTo: d('2026-06-20') })];
    const { uncovered } = segmentBySalary(june, rows);
    expect(uncovered).toHaveLength(10);
  });

  it('carries the salary type and currency onto the segment', () => {
    const { segments } = segmentBySalary(june, [
      salary({ id: 'h', salaryType: 'HOURLY', amount: 500, currency: 'USD' }),
    ]);
    expect(segments[0]?.salaryType).toBe('HOURLY');
    expect(segments[0]?.currency).toBe('USD');
  });
});

describe('period helpers', () => {
  it('lists every day of an inclusive range', () => {
    expect(daysInRange(d('2026-06-28'), d('2026-07-02'))).toEqual([
      '2026-06-28',
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02',
    ]);
  });

  it('a 09:00-18:00 shift with an hour of break is 480 minutes; with none it is 540', () => {
    expect(shiftLengthMinutes('09:00', '18:00', 60)).toBe(480);
    expect(shiftLengthMinutes('09:00', '18:00', 0)).toBe(540);
  });

  it('an overnight shift wraps midnight', () => {
    expect(shiftLengthMinutes('22:00', '06:00', 0)).toBe(480);
  });
});

// -------------------------------------------------------- effective configuration

const SETTINGS = {
  id: 'settings-1',
  companyId: 'company-1',
  frequency: 'MONTHLY',
  overtimeWeekendMultiplier: null,
  overtimeHolidayMultiplier: null,
  fallbackScheduledMinutes: 540,
  prorationMethod: 'CALENDAR_DAYS',
  payDay: null,
  basis: 'FIXED_DAYS',
  fixedBasisDays: 30,
  standardHoursPerDay: 9,
  overtimeMode: 'MULTIPLIER',
  overtimeMultiplier: 1.5,
  overtimeFixedRate: 0,
  requireApprovedOvertime: true,
  overtimeCapMinutes: 2400,
  deductUnpaidAbsence: true,
  deductUnpaidLeave: true,
  lateDeductionMode: 'NONE',
  lateDeductionRate: 0,
  lateGraceMinutes: 0,
  earlyLeaveDeductionMode: 'NONE',
  earlyLeaveDeductionRate: 0,
  earlyLeaveGraceMinutes: 0,
  taxEnabled: false,
  roundingDecimals: 2,
  payslipPrefix: 'PS-',
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Parameters<typeof effectiveConfig>[0];

describe('effective configuration', () => {
  it('reads the company settings when there is no profile', () => {
    const config = effectiveConfig(SETTINGS, null);
    expect(config.standardHoursPerDay).toBe(9);
    expect(config.overtimeMultiplier).toBe(1.5);
    expect(config.requireApprovedOvertime).toBe(true);
    expect(config.overtimeCapMinutes).toBe(2400);
    expect(config.fallbackScheduledMinutes).toBe(540);
    expect(config.deductUnpaidAbsence).toBe(true);
    expect(config.hourlyRateOverride).toBeNull();
  });

  it('a null cap means no cap', () => {
    const config = effectiveConfig({ ...SETTINGS, overtimeCapMinutes: null }, null);
    expect(config.overtimeCapMinutes).toBeNull();
  });

  it('a profile overrides only what it sets', () => {
    const profile = {
      basis: null,
      fixedBasisDays: null,
      standardHoursPerDay: null,
      overtimeMode: null,
      overtimeMultiplier: 2,
      overtimeFixedRate: null,
      hourlyRateOverride: 1000,
      deductUnpaidAbsence: false,
      deductUnpaidLeave: null,
    } as unknown as Parameters<typeof effectiveConfig>[1];
    const config = effectiveConfig(SETTINGS, profile);
    expect(config.overtimeMultiplier).toBe(2);
    expect(config.hourlyRateOverride).toBe(1000);
    expect(config.deductUnpaidAbsence).toBe(false);
    // Inherited.
    expect(config.deductUnpaidLeave).toBe(true);
    expect(config.standardHoursPerDay).toBe(9);
    expect(config.basis).toBe('FIXED_DAYS');
  });
});

// -------------------------------------------------------- finalized immutability

describe('a finalized run cannot be recalculated', () => {
  const runRow = (status: string) => ({
    id: 'run-1',
    companyId: 'company-1',
    periodId: 'period-1',
    status,
    calculationStartedAt: null,
    blockingCount: 0,
    period: { startDate: d('2026-06-01'), endDate: d('2026-06-30') },
    lines: [{ id: 'line-1', employeeId: 'employee-1' }],
  });

  it('refuses FINALIZED', async () => {
    db.payrollRun.findFirst.mockResolvedValue(runRow('FINALIZED'));
    await expect(
      calculateRun({ runId: 'run-1', companyId: 'company-1', actorId: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(db.payrollRun.updateMany).not.toHaveBeenCalled();
    expect(db.payrollRun.update).not.toHaveBeenCalled();
  });

  it('refuses APPROVED until it is sent back to review', async () => {
    db.payrollRun.findFirst.mockResolvedValue(runRow('APPROVED'));
    await expect(
      calculateRun({ runId: 'run-1', companyId: 'company-1', actorId: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(db.payrollRun.updateMany).not.toHaveBeenCalled();
  });

  it('refuses CANCELLED', async () => {
    db.payrollRun.findFirst.mockResolvedValue(runRow('CANCELLED'));
    await expect(
      calculateRun({ runId: 'run-1', companyId: 'company-1', actorId: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('does not exist for another company', async () => {
    db.payrollRun.findFirst.mockResolvedValue(null);
    await expect(
      calculateRun({ runId: 'run-1', companyId: 'other', actorId: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('will not finalize twice', async () => {
    db.payrollRun.findFirst.mockResolvedValue(runRow('FINALIZED'));
    await expect(
      finalizeRun({ runId: 'run-1', companyId: 'company-1', actorId: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('will not finalize a run that was never approved', async () => {
    db.payrollRun.findFirst.mockResolvedValue(runRow('REVIEW'));
    await expect(
      finalizeRun({ runId: 'run-1', companyId: 'company-1', actorId: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('will not finalize over a blocking exception', async () => {
    db.payrollRun.findFirst.mockResolvedValue({ ...runRow('APPROVED'), blockingCount: 1 });
    await expect(
      finalizeRun({ runId: 'run-1', companyId: 'company-1', actorId: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('will not finalize a run with nothing on it', async () => {
    db.payrollRun.findFirst.mockResolvedValue({ ...runRow('APPROVED'), lines: [] });
    await expect(
      finalizeRun({ runId: 'run-1', companyId: 'company-1', actorId: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('finalizes an approved run: one payslip per line, adjustments marked paid, period closed', async () => {
    db.payrollRun.findFirst.mockResolvedValue({
      ...runRow('APPROVED'),
      lines: [
        { id: 'line-1', employeeId: 'employee-1' },
        { id: 'line-2', employeeId: 'employee-2' },
      ],
    });
    db.payrollSettings.findUnique.mockResolvedValue(SETTINGS);
    db.payslip.count.mockResolvedValue(7);
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));

    const result = await finalizeRun({ runId: 'run-1', companyId: 'company-1', actorId: 'user-1' });

    expect(result.payslips).toBe(2);
    const numbers = db.payslip.create.mock.calls.map(
      (c) => (c[0] as { data: { number: string } }).data.number,
    );
    expect(numbers).toEqual(['PS-000008', 'PS-000009']);
    expect(db.payrollRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FINALIZED', finalizedBy: 'user-1' }) }),
    );
    expect(db.payrollAdjustment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { appliedRunId: 'run-1', appliedAt: null } }),
    );
    expect(db.payrollPeriod.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CLOSED' } }),
    );
  });
});
