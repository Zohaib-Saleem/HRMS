import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The payroll preview.
 *
 * Two things are asserted, and they are the only two that matter:
 *
 *   1. The preview writes nothing. No line, no exception, no claimed
 *      adjustment, no run moved out of DRAFT. The prisma mock exposes no
 *      writer at all for those tables, so an attempt to write is a crash
 *      rather than a quiet pass.
 *   2. The figures are the calculation's own. The preview does not recompute
 *      a gross or a net of its own devising; it splits the lines the shared
 *      `computePayroll` produced, which is what makes a preview and the
 *      payslip that follows it agree by construction.
 *
 * The whole company is a mock. What is under test is the plumbing, and the
 * arithmetic it plumbs is already pinned in `calculation.test.ts`.
 */

const db = vi.hoisted(() => ({
  company: { findUniqueOrThrow: vi.fn() },
  payrollSettings: { findUnique: vi.fn(), create: vi.fn() },
  payrollPeriod: { findFirst: vi.fn() },
  payrollRun: { findFirst: vi.fn() },
  employee: { findMany: vi.fn() },
  payrollProfile: { findMany: vi.fn() },
  employeeSalary: { findMany: vi.fn() },
  employeeSalaryComponent: { findMany: vi.fn() },
  payrollAdjustment: { findMany: vi.fn() },
  timesheet: { findMany: vi.fn() },
  employeeShiftAssignment: { findMany: vi.fn() },
  attendanceRecord: { findMany: vi.fn() },
  leaveRequest: { findMany: vi.fn() },
  holiday: { findMany: vi.fn() },
  attendancePolicyAssignment: { findMany: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { buildPayrollPreview } = await import('./payroll-preview.service.js');

const d = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** June 2026: 30 days, 22 of them working days under a Sat/Sun weekend. */
const FROM = d('2026-06-01');
const TO = d('2026-06-30');

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

/** Every working day of June present, recorded by the terminals. */
function presentRecords(): unknown[] {
  const rows: unknown[] = [];
  for (let day = 1; day <= 30; day += 1) {
    const date = d(`2026-06-${String(day).padStart(2, '0')}`);
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    rows.push({
      id: `rec-${day}`,
      employeeId: 'emp-1',
      date,
      status: 'PRESENT',
      checkInAt: new Date(date.getTime() + 4 * 3_600_000),
      checkOutAt: new Date(date.getTime() + 13 * 3_600_000),
      workedMinutes: 540,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
      irregular: false,
      mode: null,
      shiftId: null,
      notes: null,
      source: 'DEVICE',
      shift: null,
    });
  }
  return rows;
}

beforeEach(() => {
  vi.clearAllMocks();

  // No policy overrides: every day resolves to the company baseline above.
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
  db.attendanceRecord.findMany.mockResolvedValue(presentRecords());
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.holiday.findMany.mockResolvedValue([]);
  db.payrollPeriod.findFirst.mockResolvedValue({
    id: 'period-1',
    companyId: 'company-1',
    startDate: FROM,
    endDate: TO,
  });
  db.payrollRun.findFirst.mockResolvedValue({
    id: 'run-1',
    companyId: 'company-1',
    periodId: 'period-1',
    status: 'REVIEW',
    period: { startDate: FROM, endDate: TO },
  });
});

const preview = (over: Record<string, unknown> = {}) =>
  buildPayrollPreview({
    companyId: 'company-1',
    periodId: 'period-1',
    scopeFilter: {},
    ...over,
  } as never);

describe('what a preview writes', () => {
  it('writes nothing at all', async () => {
    await preview();

    // Not a line, not an exception, not a claimed adjustment. The tables have
    // no writers on the mock, so this is belt and braces on top of that.
    expect(db.payrollAdjustment).not.toHaveProperty('updateMany');
    expect(db.payrollRun).not.toHaveProperty('update');
    expect(db.payrollRun).not.toHaveProperty('updateMany');
    expect(db).not.toHaveProperty('$transaction');
  });

  it('only sees adjustments nobody has claimed', async () => {
    await preview();

    const where = db.payrollAdjustment.findMany.mock.calls[0]![0]!.where as {
      OR: Array<Record<string, unknown>>;
    };
    // A run also sees the ones it claimed itself. A preview claims nothing,
    // so seeing a claimed one would make it look like the run without being it.
    expect(where.OR).toEqual([{ appliedRunId: null }]);
  });
});

describe('the figures', () => {
  it('reports the calculation`s own gross and net', async () => {
    const result = await preview();

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;

    // A full month present on 120,000 with a 30-day basis pays exactly the
    // salary, and nothing is deducted.
    expect(row.basicAmount).toBe(120000);
    expect(row.grossAmount).toBe(120000);
    expect(row.deductionsTotal).toBe(0);
    expect(row.netAmount).toBe(120000);
    expect(row.dailyRate).toBe(4000);
    expect(row.hourlyRate).toBe(500);
  });

  it('carries the columns the specification asks for', async () => {
    const row = (await preview()).rows[0]!;

    expect(row.employeeName).toBe('Ayesha Khan');
    expect(row.employeeNumber).toBe('E-001');
    expect(row.departmentName).toBe('Engineering');
    expect(row.basicSalary).toBe(120000);
    expect(row.paidDays).toBe(22);
    expect(row.absentDays).toBe(0);
    expect(row.unpaidLeaveDays).toBe(0);
    expect(row.allowances).toBe(0);
    expect(row.overtimeHours).toBe(0);
    expect(row.overtimeAmount).toBe(0);
  });

  it('splits allowances out of the earnings rather than recomputing them', async () => {
    db.employeeSalaryComponent.findMany.mockResolvedValue([
      {
        employeeId: 'emp-1',
        componentId: 'c1',
        value: 10000,
        isActive: true,
        component: {
          id: 'c1',
          code: 'HOUSE',
          name: 'House rent',
          kind: 'EARNING',
          calc: 'FIXED',
          isTaxable: true,
          isActive: true,
        },
      },
    ]);

    const row = (await preview()).rows[0]!;
    expect(row.allowances).toBe(10000);
    expect(row.grossAmount).toBe(130000);
    // The allowance is a real line on the payslip, not a summary figure.
    expect(row.earnings.find((l) => l.code === 'HOUSE')?.amount).toBe(10000);
  });

  it('prices an absence and shows it as its own deduction column', async () => {
    const records = presentRecords() as Array<{ status: string; workedMinutes: number | null }>;
    records[0]!.status = 'ABSENT';
    records[0]!.workedMinutes = null;
    db.attendanceRecord.findMany.mockResolvedValue(records);

    const row = (await preview()).rows[0]!;
    expect(row.absentDays).toBe(1);
    expect(row.absenceDeduction).toBe(4000);
    expect(row.deductionsTotal).toBe(4000);
    expect(row.netAmount).toBe(116000);
  });

  it('totals the rows', async () => {
    const result = await preview();
    expect(result.totals.employees).toBe(1);
    expect(result.totals.grossAmount).toBe(120000);
    expect(result.totals.netAmount).toBe(120000);
    expect(result.totals.blocked).toBe(0);
  });
});

describe('employees a blocking exception stops', () => {
  it('appears in the preview, flagged, rather than quietly missing', async () => {
    // The mistake this guards against: finalizing a payroll without the three
    // people who have no salary on record, because the preview omitted them.
    db.employeeSalary.findMany.mockResolvedValue([]);

    const result = await preview();

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.blocked).toBe(true);
    expect(result.rows[0]!.employeeName).toBe('Ayesha Khan');
    expect(result.rows[0]!.notes.join(' ')).toMatch(/no salary on record/i);
    expect(result.totals.blocked).toBe(1);
    expect(result.exceptions.some((e) => e.severity === 'BLOCKING')).toBe(true);
  });
});

describe('what a preview covers', () => {
  it('takes the range from a run when one is given', async () => {
    const result = await preview({ runId: 'run-1', periodId: undefined });
    expect(result.runId).toBe('run-1');
    expect(result.runStatus).toBe('REVIEW');
    expect(result.from).toBe('2026-06-01');
    expect(result.to).toBe('2026-06-30');
  });

  it('accepts an explicit range, so a period need not exist yet', async () => {
    const result = await preview({
      periodId: undefined,
      from: '2026-06-01',
      to: '2026-06-30',
    });
    expect(result.periodId).toBeNull();
    expect(result.runId).toBeNull();
    expect(result.from).toBe('2026-06-01');
  });

  it('refuses a request with nothing to preview', async () => {
    await expect(preview({ periodId: undefined })).rejects.toThrow();
  });

  it('applies the caller`s data scope before anything is calculated', async () => {
    await preview({ scopeFilter: { departmentId: 'dep-1' } });

    const where = db.employee.findMany.mock.calls[0]![0]!.where as {
      AND: Array<Record<string, unknown>>;
    };
    // The scope is inside the AND, so it can only ever remove rows.
    expect(JSON.stringify(where.AND)).toContain('dep-1');
  });
});
