import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SALARY_ADVANCE_REPAYMENT_LABEL } from '@hrms/shared';

/**
 * A salary advance, from its schedule to the payroll that recovers it.
 *
 * The rule: an advance is recovered from the payroll month it was requested
 * in. Payroll reads the schedule and only the schedule, so the month the
 * request form showed, the repayment schedule, the Payroll Review row and the
 * payslip line all name the same month. And it only ever recovers an advance
 * somebody released: pending, rejected and approved-but-unreleased advances
 * cost the employee nothing.
 *
 * When the requested month's payroll is already finalized, the advance is held
 * - not collected as arrears in a later month, and the finalized payroll is
 * not touched - until an authorised user decides.
 *
 * The installment table is a small in-memory store that applies the same
 * filters the real query sends, so the ACTIVE gate and the claimed-by-this-run
 * rule are exercised rather than assumed.
 */

type Installment = {
  id: string;
  loanId: string;
  employeeId: string;
  sequence: number;
  amount: number;
  dueMonth: Date;
  status: 'SCHEDULED' | 'PENDING_PAYROLL' | 'PAID' | 'SKIPPED';
  payrollRunId: string | null;
  loanStatus: 'PENDING' | 'APPROVED' | 'ACTIVE' | 'REJECTED' | 'CANCELLED';
};

const store = vi.hoisted(() => ({
  installments: [] as Installment[],
  periods: [] as Array<{ startDate: Date; endDate: Date }>,
}));

const db = vi.hoisted(() => ({
  company: { findUniqueOrThrow: vi.fn() },
  payrollSettings: { findUnique: vi.fn(), create: vi.fn() },
  payrollPeriod: {
    findFirst: vi.fn(),
    // Only finalized months are returned: the store holds nothing else.
    findMany: vi.fn(async () => store.periods),
  },
  payrollRun: { findFirst: vi.fn() },
  employee: { findMany: vi.fn() },
  payrollProfile: { findMany: vi.fn() },
  employeeSalary: { findMany: vi.fn() },
  employeeSalaryComponent: { findMany: vi.fn() },
  payrollAdjustment: { findMany: vi.fn() },
  employeeLoanInstallment: {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where: {
          dueMonth: { lte: Date };
          status: { in: string[] };
          OR: Array<{ payrollRunId: string | null }>;
          loan: { status: string };
        };
      }) =>
        store.installments
          .filter(
            (i) =>
              i.dueMonth <= where.dueMonth.lte &&
              where.status.in.includes(i.status) &&
              where.OR.some((c) => c.payrollRunId === i.payrollRunId) &&
              i.loanStatus === where.loan.status,
          )
          .map((i) => ({
            ...i,
            loan: { reference: null, installmentCount: 1, kind: 'SALARY_ADVANCE' },
          })),
    ),
  },
  timesheet: { findMany: vi.fn() },
  employeeShiftAssignment: { findMany: vi.fn() },
  attendanceRecord: { findMany: vi.fn() },
  leaveRequest: { findMany: vi.fn() },
  holiday: { findMany: vi.fn() },
  attendancePolicyAssignment: { findMany: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { computePayroll } = await import('./payroll.service.js');
const { buildPayrollPreview } = await import('./payroll-preview.service.js');

const d = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const OCT_FROM = d('2026-10-01');
const OCT_TO = d('2026-10-31');
const NOV_FROM = d('2026-11-01');
const NOV_TO = d('2026-11-30');

const COMPANY = {
  currency: 'PKR',
  duplicatePunchWindowSeconds: 60,
  maxPlausibleSpanMinutes: 960,
  allowImplausibleSpans: false,
  timezone: 'Asia/Karachi',
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
};

const SETTINGS = {
  companyId: 'company-1',
  basis: 'FIXED_DAYS',
  fixedBasisDays: 30,
  standardHoursPerDay: 8,
  overtimeMode: 'MULTIPLIER',
  overtimeMultiplier: 1.5,
  overtimeFixedRate: 0,
  requireApprovedOvertime: false,
  overtimeCapMinutes: null,
  fallbackScheduledMinutes: 540,
  deductUnpaidAbsence: true,
  deductUnpaidLeave: true,
  lateDeductionMode: 'NONE',
  lateDeductionRate: 0,
  lateGraceMinutes: 0,
  earlyLeaveDeductionMode: 'NONE',
  earlyLeaveDeductionRate: 0,
  earlyLeaveGraceMinutes: 0,
  roundingDecimals: 2,
  overtimeWeekendMultiplier: null,
  overtimeHolidayMultiplier: null,
  prorationMethod: 'CALENDAR_DAYS',
};

const EMPLOYEE = {
  id: 'emp-1',
  companyId: 'company-1',
  firstName: 'Ayesha',
  lastName: 'Khan',
  displayName: null,
  employeeNumber: 'E-001',
  hireDate: d('2020-01-01'),
  terminationDate: null,
  locationId: null,
  department: { name: 'Engineering' },
};

function advance(over: Partial<Installment> = {}): Installment {
  return {
    id: 'inst-adv',
    loanId: 'loan-adv',
    employeeId: 'emp-1',
    sequence: 1,
    amount: 20000,
    dueMonth: d('2026-10-01'),
    status: 'SCHEDULED',
    payrollRunId: null,
    loanStatus: 'ACTIVE',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.installments = [];
  store.periods = [];

  db.attendancePolicyAssignment.findMany.mockResolvedValue([]);
  db.company.findUniqueOrThrow.mockResolvedValue({ ...COMPANY });
  db.payrollSettings.findUnique.mockResolvedValue({ ...SETTINGS });
  db.employee.findMany.mockResolvedValue([EMPLOYEE]);
  db.payrollProfile.findMany.mockResolvedValue([]);
  db.employeeSalary.findMany.mockResolvedValue([
    {
      id: 'sal-1',
      employeeId: 'emp-1',
      salaryType: 'MONTHLY',
      amount: 120000,
      currency: 'PKR',
      effectiveFrom: d('2020-01-01'),
      effectiveTo: null,
    },
  ]);
  db.employeeSalaryComponent.findMany.mockResolvedValue([]);
  db.payrollAdjustment.findMany.mockResolvedValue([]);
  db.timesheet.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findMany.mockResolvedValue([]);
  db.attendanceRecord.findMany.mockResolvedValue([]);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.holiday.findMany.mockResolvedValue([]);
  db.payrollPeriod.findFirst.mockResolvedValue({
    id: 'period-oct',
    companyId: 'company-1',
    startDate: OCT_FROM,
    endDate: OCT_TO,
  });
  db.payrollRun.findFirst.mockResolvedValue({
    id: 'run-oct',
    companyId: 'company-1',
    periodId: 'period-oct',
    status: 'REVIEW',
    period: { startDate: OCT_FROM, endDate: OCT_TO },
  });
});

const compute = (from: Date, to: Date, runId: string | null = null) =>
  computePayroll({ companyId: 'company-1', from, to, runId });

const advanceLines = (computed: Awaited<ReturnType<typeof compute>>) =>
  computed.lines.flatMap((l) => l.deductions.filter((x) => x.code === 'ADVANCE'));

describe('which advances payroll recovers', () => {
  it.each(['PENDING', 'REJECTED', 'CANCELLED'] as const)('a %s request is not deducted', async (loanStatus) => {
    store.installments = [advance({ loanStatus, status: loanStatus === 'PENDING' ? 'SCHEDULED' : 'SKIPPED' })];
    const computed = await compute(OCT_FROM, OCT_TO, 'run-oct');
    expect(advanceLines(computed)).toEqual([]);
    expect(computed.appliedLoanInstallmentIds).toEqual([]);
  });

  it('an approved advance that was never released is not deducted', async () => {
    store.installments = [advance({ loanStatus: 'APPROVED' })];
    const computed = await compute(OCT_FROM, OCT_TO, 'run-oct');
    expect(advanceLines(computed)).toEqual([]);
  });

  it('a released advance is deducted in its own month while that payroll is open', async () => {
    store.installments = [advance()];
    const computed = await compute(OCT_FROM, OCT_TO, 'run-oct');

    expect(advanceLines(computed)).toEqual([
      expect.objectContaining({ code: 'ADVANCE', label: SALARY_ADVANCE_REPAYMENT_LABEL, amount: 20000 }),
    ]);
    expect(computed.appliedLoanInstallmentIds).toEqual(['inst-adv']);
  });

  it('is not deducted in an earlier month than the one it was requested for', async () => {
    store.installments = [advance({ dueMonth: d('2026-11-01') })];
    const computed = await compute(OCT_FROM, OCT_TO, 'run-oct');
    expect(advanceLines(computed)).toEqual([]);
  });
});

describe('a month whose payroll is already finalized', () => {
  beforeEach(() => {
    store.periods = [{ startDate: OCT_FROM, endDate: OCT_TO }];
  });

  it('holds the advance in November instead of collecting October as arrears, and says why', async () => {
    store.installments = [advance()];
    const computed = await compute(NOV_FROM, NOV_TO, 'run-nov');

    expect(advanceLines(computed)).toEqual([]);
    expect(computed.appliedLoanInstallmentIds).toEqual([]);
    expect(computed.exceptions).toContainEqual(
      expect.objectContaining({
        code: 'LOAN_ARREARS',
        severity: 'WARNING',
        employeeId: 'emp-1',
        detail: expect.objectContaining({ heldForDecision: true, months: ['2026-10'] }),
      }),
    );
  });

  it('collects it in the revised month once an authorised user has moved it there', async () => {
    store.installments = [advance({ dueMonth: d('2026-11-01') })];
    const computed = await compute(NOV_FROM, NOV_TO, 'run-nov');
    expect(advanceLines(computed)).toHaveLength(1);
    expect(computed.exceptions.filter((e) => e.code === 'LOAN_ARREARS')).toEqual([]);
  });
});

describe('recalculating a run', () => {
  it('deducts the advance it already claimed exactly once, however often it is rerun', async () => {
    // Claimed by the October run on its first calculation.
    store.installments = [advance({ status: 'PENDING_PAYROLL', payrollRunId: 'run-oct' })];

    const first = await compute(OCT_FROM, OCT_TO, 'run-oct');
    const second = await compute(OCT_FROM, OCT_TO, 'run-oct');
    expect(advanceLines(first)).toHaveLength(1);
    expect(advanceLines(second)).toHaveLength(1);
    expect(second.appliedLoanInstallmentIds).toEqual(['inst-adv']);
  });

  it('never sees an advance another run has claimed, or one already paid', async () => {
    store.installments = [
      advance({ id: 'claimed-elsewhere', status: 'PENDING_PAYROLL', payrollRunId: 'run-other' }),
      advance({ id: 'paid', status: 'PAID', payrollRunId: 'run-sep' }),
    ];
    const computed = await compute(OCT_FROM, OCT_TO, 'run-oct');
    expect(advanceLines(computed)).toEqual([]);
  });
});

describe('the same month on every screen', () => {
  it('the schedule month is the period on Payroll Review and the line the payslip is printed from', async () => {
    store.installments = [advance()];

    const computed = await compute(OCT_FROM, OCT_TO, 'run-oct');
    const preview = await buildPayrollPreview({
      companyId: 'company-1',
      periodId: 'period-oct',
      scopeFilter: {},
    } as never);

    // The payslip is written from the run's stored lines, which are these.
    const line = computed.lines[0]!;
    expect(line.deductions.find((x) => x.code === 'ADVANCE')).toMatchObject({
      label: SALARY_ADVANCE_REPAYMENT_LABEL,
      amount: 20000,
    });
    // Payroll Review for October shows the same figure in its advance column.
    expect(preview.rows[0]!.advanceDeduction).toBe(20000);
    // And the schedule it came from is October's.
    expect(store.installments[0]!.dueMonth.toISOString().slice(0, 7)).toBe('2026-10');
  });
});
