import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOAN_POLICY_DEFAULTS } from '@hrms/shared';

/**
 * The loan eligibility engine.
 *
 * Every threshold in these tests comes from a policy row, never from a literal
 * in the engine - which is the property under test as much as any individual
 * rule. A test that passes only because 90 is written into the code would pass
 * just as well if the settings screen did nothing, so each attendance case sets
 * its own limit and then moves it.
 *
 * The attendance TALLY is the real one. Only `deriveRange` is stubbed, so the
 * days go in as fixtures and the percentage, the absence count and the late
 * count are computed by the same `tallyDerived` the attendance screens and
 * payroll read. Stubbing the tally too would let this file invent an attendance
 * percentage the rest of the product does not agree with.
 */

const db = vi.hoisted(() => ({
  company: { findUniqueOrThrow: vi.fn() },
  employee: { findFirst: vi.fn() },
  employeeSalary: { findFirst: vi.fn() },
  attendanceRecord: { count: vi.fn() },
  employeeLoan: { findFirst: vi.fn() },
  attendanceRegularizationRequest: { findMany: vi.fn() },
  payrollSettings: { findUnique: vi.fn() },
  loanPolicy: {
    findFirst: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  user: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const attendance = vi.hoisted(() => ({ deriveRange: vi.fn() }));
vi.mock('../time/attendance.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deriveRange: attendance.deriveRange,
}));

vi.mock('../time/attendance-policy.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveAttendancePolicy: vi.fn(async () => ({ timeZone: 'Asia/Karachi' })),
}));

const { evaluateLoanEligibility, evaluationWindow, completedMonths, isOnProbation } = await import(
  './loan-eligibility.service.js'
);
const { diffPolicies, toLoanPolicyRecord } = await import('./loan-policy.service.js');

/** A policy row, defaults unless a test says otherwise. */
function policy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pol-1',
    companyId: 'company-1',
    maxSalaryMultiplier: LOAN_POLICY_DEFAULTS.maxSalaryMultiplier,
    minEmploymentMonths: LOAN_POLICY_DEFAULTS.minEmploymentMonths,
    allowProbation: LOAN_POLICY_DEFAULTS.allowProbation,
    minSalary: LOAN_POLICY_DEFAULTS.minSalary,
    minAttendancePercent: LOAN_POLICY_DEFAULTS.minAttendancePercent,
    maxUnapprovedAbsences: LOAN_POLICY_DEFAULTS.maxUnapprovedAbsences,
    maxLateDays: LOAN_POLICY_DEFAULTS.maxLateDays,
    maxMissingPunches: LOAN_POLICY_DEFAULTS.maxMissingPunches,
    evaluationMonths: LOAN_POLICY_DEFAULTS.evaluationMonths,
    maxMonthlyDeductionPercent: LOAN_POLICY_DEFAULTS.maxMonthlyDeductionPercent,
    maxTenureMonths: LOAN_POLICY_DEFAULTS.maxTenureMonths,
    maxInstallments: LOAN_POLICY_DEFAULTS.maxInstallments,
    oneActiveLoan: LOAN_POLICY_DEFAULTS.oneActiveLoan,
    onePendingLoan: LOAN_POLICY_DEFAULTS.onePendingLoan,
    blockTerminated: LOAN_POLICY_DEFAULTS.blockTerminated,
    blockResigned: LOAN_POLICY_DEFAULTS.blockResigned,
    allowHrOverride: LOAN_POLICY_DEFAULTS.allowHrOverride,
    requireOverrideReason: LOAN_POLICY_DEFAULTS.requireOverrideReason,
    effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    createdAt: new Date('2020-01-01T00:00:00Z'),
    createdBy: null,
    ...overrides,
  };
}

type DayStatus = 'PRESENT' | 'ABSENT' | 'HALF_DAY' | 'ON_LEAVE' | 'WEEKEND';

const day = (date: string, status: DayStatus, flags: string[] = []) => ({
  date,
  status,
  flags,
  checkInAt: null,
  checkOutAt: null,
  workedMinutes: status === 'PRESENT' ? 480 : 0,
  expectedMinutes: 480,
  lateMinutes: flags.includes('LATE') ? 15 : 0,
  earlyLeaveMinutes: 0,
  overtimeMinutes: 0,
  irregular: false,
});

/** `count` working days, the first `absent` of them absent. */
function days(count: number, opts: { absent?: number; late?: number; missing?: number } = {}) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const date = `2026-06-${String(i + 1).padStart(2, '0')}`;
    const flags: string[] = [];
    if (i < (opts.late ?? 0)) flags.push('LATE');
    if (i < (opts.missing ?? 0)) flags.push('MISSING_PUNCH');
    out.push(day(date, i < (opts.absent ?? 0) ? 'ABSENT' : 'PRESENT', flags));
  }
  return out;
}

const NOW = new Date('2026-07-15T09:00:00Z');

function setup(input: {
  policy?: Record<string, unknown>;
  salary?: { amount: number; salaryType?: string; currency?: string } | null;
  employee?: Record<string, unknown> | null;
  days?: unknown[];
  activeLoan?: boolean;
  pendingLoan?: boolean;
  raisedCorrections?: string[];
  records?: number;
} = {}) {
  db.loanPolicy.findFirst.mockResolvedValue(policy(input.policy));
  db.company.findUniqueOrThrow.mockResolvedValue({ currency: 'PKR' });
  db.employee.findFirst.mockResolvedValue(
    input.employee === null
      ? null
      : {
          id: 'emp-1',
          status: 'ACTIVE',
          hireDate: new Date('2020-01-01T00:00:00Z'),
          confirmationDate: new Date('2020-07-01T00:00:00Z'),
          confirmationStatus: 'Permanent',
          locationId: null,
          contracts: [],
          ...input.employee,
        },
  );
  db.employeeSalary.findFirst.mockResolvedValue(
    input.salary === null
      ? null
      : {
          amount: input.salary?.amount ?? 100_000,
          currency: input.salary?.currency ?? 'PKR',
          salaryType: input.salary?.salaryType ?? 'MONTHLY',
        },
  );
  const derived = input.days ?? days(20);
  attendance.deriveRange.mockResolvedValue(derived);
  /*
   * How many days actually have a record behind them.
   *
   * Defaults to "all of them", because that is the ordinary case. A test that
   * wants the no-data case passes `records: 0` and gets derived ABSENT days
   * with nothing behind them - which is exactly the shape a new joiner or an
   * un-instrumented location produces.
   */
  db.attendanceRecord.count.mockResolvedValue(input.records ?? derived.length);
  db.attendanceRegularizationRequest.findMany.mockResolvedValue(
    (input.raisedCorrections ?? []).map((d) => ({ attendanceDate: new Date(`${d}T00:00:00Z`) })),
  );
  // findFirst is asked twice - once for an ACTIVE-like loan, once for PENDING.
  db.employeeLoan.findFirst.mockImplementation((args: { where: { status: unknown } }) => {
    const status = args.where.status as { in?: string[] } | string;
    if (typeof status === 'string') {
      return Promise.resolve(input.pendingLoan ? { id: 'loan-p' } : null);
    }
    return Promise.resolve(input.activeLoan ? { id: 'loan-a' } : null);
  });
}

const evaluate = (extra: { requestedAmount?: number; requestedInstallments?: number } = {}) =>
  evaluateLoanEligibility({
    companyId: 'company-1',
    employeeId: 'emp-1',
    now: NOW,
    ...extra,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the loan amount ceiling', () => {
  it('is salary times the policy multiple, and nothing is stored against the employee', async () => {
    setup({ salary: { amount: 100_000 } });

    const result = await evaluate();

    expect(result.maxAllowedAmount).toBe(100_000);
    expect(result.monthlySalary).toBe(100_000);
    expect(result.eligible).toBe(true);
  });

  it('moves with the policy, not with the employee', async () => {
    setup({ salary: { amount: 50_000 } });
    expect((await evaluate()).maxAllowedAmount).toBe(50_000);

    // Same employee, same salary, same everything: only the policy changed.
    setup({ salary: { amount: 50_000 }, policy: { maxSalaryMultiplier: 2 } });
    expect((await evaluate()).maxAllowedAmount).toBe(100_000);
  });

  it('refuses a request above the ceiling', async () => {
    setup({ salary: { amount: 100_000 } });

    const result = await evaluate({ requestedAmount: 120_000, requestedInstallments: 12 });

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toContain('MAX_AMOUNT');
    expect(result.reasons.join(' ')).toContain('100,000');
  });

  it('allows a request exactly at the ceiling', async () => {
    setup({ salary: { amount: 100_000 } });

    const result = await evaluate({ requestedAmount: 100_000, requestedInstallments: 12 });

    expect(result.failedRules).not.toContain('MAX_AMOUNT');
  });
});

describe('attendance rules', () => {
  it('refuses when attendance is below the configured minimum', async () => {
    // 16 of 18 present is 88.9%.
    setup({ days: days(18, { absent: 2 }), policy: { minAttendancePercent: 90 } });

    const result = await evaluate();

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toContain('ATTENDANCE_PERCENT');
    expect(result.evaluation.attendancePercentage).toBeCloseTo(88.9, 1);
  });

  it('passes at exactly the minimum', async () => {
    // 18 of 20 present is 90%, and the rule is "below", not "at or below".
    setup({
      days: days(20, { absent: 2 }),
      policy: { minAttendancePercent: 90, maxUnapprovedAbsences: 5 },
    });

    const result = await evaluate();

    expect(result.evaluation.attendancePercentage).toBe(90);
    expect(result.failedRules).not.toContain('ATTENDANCE_PERCENT');
  });

  it('is decided by the policy value, not by a number in the code', async () => {
    const eighty = { days: days(20, { absent: 4 }), policy: { maxUnapprovedAbsences: 10 } };

    setup({ ...eighty, policy: { ...eighty.policy, minAttendancePercent: 90 } });
    expect((await evaluate()).failedRules).toContain('ATTENDANCE_PERCENT');

    setup({ ...eighty, policy: { ...eighty.policy, minAttendancePercent: 75 } });
    expect((await evaluate()).failedRules).not.toContain('ATTENDANCE_PERCENT');
  });

  it('refuses above the unapproved absence limit and allows at it', async () => {
    setup({ days: days(40, { absent: 4 }), policy: { maxUnapprovedAbsences: 3, minAttendancePercent: 0 } });
    expect((await evaluate()).failedRules).toContain('UNAPPROVED_ABSENCES');

    setup({ days: days(40, { absent: 3 }), policy: { maxUnapprovedAbsences: 3, minAttendancePercent: 0 } });
    expect((await evaluate()).failedRules).not.toContain('UNAPPROVED_ABSENCES');
  });

  it('refuses too many late days', async () => {
    setup({ days: days(30, { late: 11 }), policy: { maxLateDays: 10 } });

    const result = await evaluate();

    expect(result.failedRules).toContain('LATE_DAYS');
    expect(result.evaluation.lateDays).toBe(11);
  });

  it('refuses too many unresolved missing punches', async () => {
    setup({ days: days(30, { missing: 4 }), policy: { maxMissingPunches: 3 } });

    const result = await evaluate();

    expect(result.failedRules).toContain('MISSING_PUNCHES');
    expect(result.evaluation.missingPunches).toBe(4);
  });

  it('does not count a missing punch the employee has already raised', async () => {
    setup({
      days: days(30, { missing: 4 }),
      policy: { maxMissingPunches: 3 },
      // One of the four is already sitting with a manager.
      raisedCorrections: ['2026-06-01'],
    });

    const result = await evaluate();

    expect(result.evaluation.missingPunches).toBe(3);
    expect(result.failedRules).not.toContain('MISSING_PUNCHES');
  });

  it('does not refuse somebody the window holds no attendance for', async () => {
    setup({ days: [] });

    const result = await evaluate();

    expect(result.evaluation.measured).toBe(false);
    expect(result.failedRules).not.toContain('ATTENDANCE_PERCENT');
    expect(result.warnings.join(' ')).toContain('no attendance on record');
  });

  /*
   * The case that matters in production, and the one a stubbed engine hid.
   *
   * `deriveRange` scores a past working day with NO record as ABSENT. So an
   * employee nobody has attendance data for does not come back with an empty
   * day list - they come back with a full one, every day absent, and a 0%
   * attendance percentage. Judged on that they are refused a loan for data that
   * was never collected about them, and there is nothing they can do to fix it.
   */
  it('does not score somebody at 0% when the days are derived from no records at all', async () => {
    setup({ days: days(60, { absent: 60 }), records: 0 });

    const result = await evaluate();

    expect(result.evaluation.measured).toBe(false);
    expect(result.failedRules).not.toContain('ATTENDANCE_PERCENT');
    expect(result.failedRules).not.toContain('UNAPPROVED_ABSENCES');
    expect(result.eligible).toBe(true);
  });

  it('does not count approved leave against the attendance percentage', async () => {
    /*
     * Ten working days: eight present, two on approved leave, none absent.
     *
     * The attendance screens report 80% for this - leave sits in their
     * denominator with no credit. The loan rule asks a different question, "did
     * they turn up when expected", and the answer is 100%. Without this, taking
     * granted leave would cost somebody a loan.
     */
    const withLeave = [
      ...days(8),
      day('2026-06-09', 'ON_LEAVE'),
      day('2026-06-10', 'ON_LEAVE'),
    ];
    setup({ days: withLeave, records: 10, policy: { minAttendancePercent: 90 } });

    const result = await evaluate();

    expect(result.evaluation.attendancePercentage).toBe(100);
    expect(result.failedRules).not.toContain('ATTENDANCE_PERCENT');
  });

  it('counts a half day as half, over the days expected', async () => {
    const mixed = [...days(8), day('2026-06-09', 'HALF_DAY'), day('2026-06-10', 'ABSENT')];
    setup({ days: mixed, records: 10, policy: { minAttendancePercent: 0, maxUnapprovedAbsences: 5 } });

    const result = await evaluate();

    // 8 + 0.5 over 10 expected days.
    expect(result.evaluation.attendancePercentage).toBe(85);
  });

  it('still refuses genuine absence, where the records exist', async () => {
    // The same sixty absent days, but recorded ones this time.
    setup({ days: days(60, { absent: 60 }), records: 60 });

    const result = await evaluate();

    expect(result.evaluation.measured).toBe(true);
    expect(result.failedRules).toContain('ATTENDANCE_PERCENT');
  });

  it('never measures a window that starts before the employee was hired', async () => {
    setup({ employee: { hireDate: new Date('2026-05-20T00:00:00Z') } });

    await evaluate();

    // The policy window would be 2026-04-01; the hire date wins.
    const call = attendance.deriveRange.mock.calls[0] as unknown[];
    expect((call[2] as Date).toISOString().slice(0, 10)).toBe('2026-05-20');
  });
});

describe('employment rules', () => {
  it('refuses a terminated employee, and only while the policy says so', async () => {
    setup({ employee: { status: 'TERMINATED' } });
    expect((await evaluate()).failedRules).toContain('EMPLOYMENT_STATUS');

    setup({ employee: { status: 'TERMINATED' }, policy: { blockTerminated: false } });
    expect((await evaluate()).failedRules).not.toContain('EMPLOYMENT_STATUS');
  });

  it('refuses a resigned employee, and only while the policy says so', async () => {
    setup({ employee: { status: 'RESIGNED' } });
    expect((await evaluate()).failedRules).toContain('EMPLOYMENT_STATUS');

    setup({ employee: { status: 'RESIGNED' }, policy: { blockResigned: false } });
    expect((await evaluate()).failedRules).not.toContain('EMPLOYMENT_STATUS');
  });

  it('refuses a probation employee while probation applications are off', async () => {
    setup({ employee: { confirmationStatus: 'Probation' } });
    expect((await evaluate()).failedRules).toContain('PROBATION');

    setup({ employee: { confirmationStatus: 'Probation' }, policy: { allowProbation: true } });
    expect((await evaluate()).failedRules).not.toContain('PROBATION');
  });

  it('refuses somebody short of the minimum employment period', async () => {
    setup({
      employee: { hireDate: new Date('2026-06-01T00:00:00Z') },
      policy: { minEmploymentMonths: 3 },
    });

    const result = await evaluate();

    expect(result.failedRules).toContain('MIN_EMPLOYMENT');
    expect(result.reasons.join(' ')).toContain('minimum is 3');
  });

  it('refuses when there is no employee record at all', async () => {
    setup({ employee: null });

    const result = await evaluate();

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toEqual(['EMPLOYEE_RECORD']);
  });

  it('refuses when there is no salary on record', async () => {
    setup({ salary: null });

    expect((await evaluate()).failedRules).toContain('SALARY_RECORD');
  });

  it('refuses a salary below the configured minimum', async () => {
    setup({ salary: { amount: 20_000 }, policy: { minSalary: 30_000 } });

    expect((await evaluate()).failedRules).toContain('MIN_SALARY');
  });
});

describe('loans already on file', () => {
  it('refuses while an active loan exists, and only while the rule is on', async () => {
    setup({ activeLoan: true });
    expect((await evaluate()).failedRules).toContain('ACTIVE_LOAN');

    setup({ activeLoan: true, policy: { oneActiveLoan: false } });
    expect((await evaluate()).failedRules).not.toContain('ACTIVE_LOAN');
  });

  it('refuses while an application is pending, and only while the rule is on', async () => {
    setup({ pendingLoan: true });
    expect((await evaluate()).failedRules).toContain('PENDING_LOAN');

    setup({ pendingLoan: true, policy: { onePendingLoan: false } });
    expect((await evaluate()).failedRules).not.toContain('PENDING_LOAN');
  });
});

describe('the shape of the loan', () => {
  it('refuses a tenure longer than the policy allows', async () => {
    setup({ policy: { maxTenureMonths: 12, maxInstallments: 24 } });

    const result = await evaluate({ requestedAmount: 10_000, requestedInstallments: 18 });

    expect(result.failedRules).toContain('MAX_TENURE');
  });

  it('refuses more installments than the policy allows', async () => {
    setup({ policy: { maxInstallments: 12, maxTenureMonths: 24 } });

    const result = await evaluate({ requestedAmount: 10_000, requestedInstallments: 18 });

    expect(result.failedRules).toContain('MAX_INSTALLMENTS');
  });

  it('refuses an installment above the salary deduction ceiling', async () => {
    // 100,000 over 3 months is 33,333 a month; 30% of 100,000 is 30,000.
    setup({ salary: { amount: 100_000 }, policy: { maxMonthlyDeductionPercent: 30 } });

    const result = await evaluate({ requestedAmount: 100_000, requestedInstallments: 3 });

    expect(result.failedRules).toContain('MONTHLY_DEDUCTION');
    expect(result.maxMonthlyDeduction).toBe(30_000);
    expect(result.estimatedMonthlyDeduction).toBeGreaterThan(30_000);
  });

  it('allows the same loan when the ceiling is raised', async () => {
    setup({ salary: { amount: 100_000 }, policy: { maxMonthlyDeductionPercent: 40 } });

    const result = await evaluate({ requestedAmount: 100_000, requestedInstallments: 3 });

    expect(result.failedRules).not.toContain('MONTHLY_DEDUCTION');
  });

  it('quotes the installment the schedule will actually carry', async () => {
    setup({ salary: { amount: 100_000 } });

    const result = await evaluate({ requestedAmount: 80_000, requestedInstallments: 12 });

    /*
     * 6,666.66 rather than 6,666.67: `buildSchedule` floors the even
     * installments and lets the last one absorb the remainder, so eleven
     * months of 6,666.66 and a final 6,666.74 come to exactly 80,000. Quoting
     * the rounded-up figure here would over-state the deduction by a cent and
     * disagree with the schedule that is actually collected - which is the
     * whole reason this calls the builder's own function.
     */
    expect(result.estimatedMonthlyDeduction).toBe(6_666.66);
    expect(result.eligible).toBe(true);
  });
});

describe('the evaluation window', () => {
  it('is whole completed months, and never includes today', () => {
    // Mid-July, looking back three months: April, May, June.
    const window = evaluationWindow(3, 'UTC', new Date('2026-07-15T09:00:00Z'));

    expect(window).toEqual({ from: '2026-04-01', to: '2026-06-30' });
  });

  it('follows the configured number of months', () => {
    expect(evaluationWindow(1, 'UTC', new Date('2026-07-15T00:00:00Z')).from).toBe('2026-06-01');
    expect(evaluationWindow(12, 'UTC', new Date('2026-07-15T00:00:00Z')).from).toBe('2025-07-01');
  });

  it('crosses a year boundary correctly', () => {
    expect(evaluationWindow(3, 'UTC', new Date('2026-01-10T00:00:00Z'))).toEqual({
      from: '2025-10-01',
      to: '2025-12-31',
    });
  });
});

describe('supporting rules', () => {
  it('counts whole months of service only', () => {
    expect(completedMonths(new Date('2026-01-15T00:00:00Z'), new Date('2026-04-14T00:00:00Z'))).toBe(2);
    expect(completedMonths(new Date('2026-01-15T00:00:00Z'), new Date('2026-04-15T00:00:00Z'))).toBe(3);
  });

  it('reads probation from a contract, the roster wording or an unreached date', () => {
    const now = new Date('2026-07-15T00:00:00Z');
    const base = { confirmationDate: null, confirmationStatus: null, contracts: [] };

    expect(isOnProbation(base, now)).toBe(false);
    expect(isOnProbation({ ...base, contracts: [{ id: 'c1' }] }, now)).toBe(true);
    expect(isOnProbation({ ...base, confirmationStatus: 'probation' }, now)).toBe(true);
    expect(
      isOnProbation({ ...base, confirmationDate: new Date('2026-12-01T00:00:00Z') }, now),
    ).toBe(true);
    // A confirmation date already passed is confirmation, not probation.
    expect(
      isOnProbation({ ...base, confirmationDate: new Date('2026-01-01T00:00:00Z') }, now),
    ).toBe(false);
  });

  it('reports no change for the first policy version, and the fields that moved after it', () => {
    const first = toLoanPolicyRecord(policy() as never, { createdByName: null, isCurrent: false });
    const second = toLoanPolicyRecord(policy({ maxSalaryMultiplier: 2, allowProbation: true }) as never, {
      createdByName: null,
      isCurrent: true,
    });

    expect(diffPolicies(null, first)).toEqual([]);

    const changes = diffPolicies(first, second);
    expect(changes.map((c) => c.field).sort()).toEqual(['allowProbation', 'maxSalaryMultiplier']);
    expect(changes.find((c) => c.field === 'maxSalaryMultiplier')).toMatchObject({
      from: '1',
      to: '2',
    });
    expect(changes.find((c) => c.field === 'allowProbation')).toMatchObject({
      from: 'No',
      to: 'Yes',
    });
  });
});
