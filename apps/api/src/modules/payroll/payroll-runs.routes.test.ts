import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type DataScope, type Permission } from '@hrms/shared';

/**
 * The gates around a payroll run and a payslip, asserted against the HTTP
 * surface rather than the service beneath it: who may calculate, approve,
 * finalize and cancel; that a finalized run refuses every one of those; that
 * an employee reads their own payslip and nobody else's, and not before it is
 * released; and that the overtime cap survives a round trip through settings.
 *
 * The database is a mock with just enough shape for the routes to reach the
 * decision under test. An employee table of two rows is emulated for scope,
 * because the scope check is the finding these tests exist to protect.
 */

const db = vi.hoisted(() => ({
  company: { findUniqueOrThrow: vi.fn() },
  employee: { findFirst: vi.fn() },
  payrollRun: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  payrollPeriod: { findFirst: vi.fn() },
  payrollAdjustment: { findFirst: vi.fn(), delete: vi.fn() },
  payslip: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
  payrollSettings: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { payrollRunRoutes, payrollAdjustmentRoutes, payslipRoutes } = await import(
  './payroll-runs.routes.js'
);
const { payrollSettingsRoutes } = await import('./payroll.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const ADMIN: Permission[] = [
  PERMISSIONS.PAYROLL_READ,
  PERMISSIONS.PAYROLL_MANAGE,
  PERMISSIONS.PAYROLL_APPROVE,
  PERMISSIONS.PAYSLIP_READ,
];
/** Prepares and calculates, but cannot approve or finalize. */
const PAYROLL_CLERK: Permission[] = [PERMISSIONS.PAYROLL_READ, PERMISSIONS.PAYROLL_MANAGE];
/** Approves, but cannot create or calculate. */
const APPROVER: Permission[] = [PERMISSIONS.PAYROLL_READ, PERMISSIONS.PAYROLL_APPROVE];
const READ_ONLY: Permission[] = [PERMISSIONS.PAYROLL_READ, PERMISSIONS.PAYSLIP_READ];
/** What every employee holds: their own payslips, nothing about payroll. */
const EMPLOYEE: Permission[] = [PERMISSIONS.PAYSLIP_READ];

/** Two employees; user-1 is employee-1. */
const EMPLOYEES = [
  { id: 'employee-1', userId: 'user-1', companyId: 'company-1', departmentId: 'dept-1' },
  { id: 'employee-2', userId: 'user-2', companyId: 'company-1', departmentId: 'dept-1' },
];

/**
 * A minimal evaluation of the two shapes the scope code asks for: the
 * caller's own row by userId, and "this id, within this filter".
 */
function emulateEmployeeTable() {
  db.employee.findFirst.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) => {
      if (typeof where.userId === 'string') {
        return EMPLOYEES.find((e) => e.userId === where.userId) ?? null;
      }
      const clauses = (where.AND as Array<Record<string, unknown>>) ?? [where];
      const wanted = clauses.find((c) => typeof c.id === 'string')?.id as string | undefined;
      const row = EMPLOYEES.find((e) => e.id === wanted);
      if (!row) return null;
      for (const clause of clauses) {
        if (typeof clause.id === 'string' && clause.id !== row.id) return null;
      }
      return row;
    },
  );
}

async function appAs(permissions: Permission[], dataScope: DataScope = 'ALL'): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 's',
      userId: 'user-1',
      companyId: 'company-1',
      email: 'x@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(payrollRunRoutes, { prefix: '/payroll/runs' });
  await app.register(payrollAdjustmentRoutes, { prefix: '/payroll/adjustments' });
  await app.register(payslipRoutes, { prefix: '/payslips' });
  await app.register(payrollSettingsRoutes, { prefix: '/payroll/settings' });
  await app.ready();
  return app;
}

const RUN = {
  id: 'run-1',
  companyId: 'company-1',
  periodId: 'period-1',
  status: 'FINALIZED',
  notes: null,
  currency: 'PKR',
  employeeCount: 2,
  grossTotal: 240000,
  deductionTotal: 0,
  netTotal: 240000,
  exceptionCount: 0,
  blockingCount: 0,
  calculatedAt: new Date(),
  calculatedBy: 'user-1',
  reviewedAt: null,
  reviewedBy: null,
  approvedAt: new Date(),
  approvedBy: 'user-1',
  finalizedAt: new Date(),
  finalizedBy: 'user-1',
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  calculationStartedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  period: { name: 'June 2026', startDate: new Date('2026-06-01T00:00:00Z'), endDate: new Date('2026-06-30T00:00:00Z') },
  lines: [{ id: 'line-1', employeeId: 'employee-1' }],
};

const LINE = {
  id: 'line-1',
  runId: 'run-1',
  employeeId: 'employee-1',
  salaryType: 'MONTHLY',
  salaryAmount: 120000,
  currency: 'PKR',
  basis: 'FIXED_DAYS',
  basisDays: 30,
  dailyRate: 4000,
  hourlyRate: 444.44,
  salarySegments: 1,
  scheduledDays: 22,
  scheduledMinutes: 11880,
  presentDays: 22,
  halfDays: 0,
  absentDays: 0,
  paidLeaveDays: 0,
  unpaidLeaveDays: 0,
  holidayDays: 0,
  weekendDays: 8,
  payableDays: 22,
  unpaidDays: 0,
  workedMinutes: 11880,
  lateOccurrences: 0,
  lateMinutes: 0,
  earlyLeaveOccurrences: 0,
  earlyLeaveMinutes: 0,
  overtimeMinutes: 180,
  approvedOvertimeMinutes: 180,
  paidOvertimeMinutes: 180,
  basicAmount: 120000,
  overtimeAmount: 2000,
  earningsTotal: 122000,
  deductionsTotal: 0,
  adjustmentTotal: 0,
  grossAmount: 122000,
  netAmount: 122000,
  earnings: [
    { code: 'BASIC', label: 'Basic salary', kind: 'BASIC', calc: 'FIXED', rate: null, units: 22, amount: 120000 },
    { code: 'OVERTIME', label: 'Overtime', kind: 'OVERTIME', calc: 'FIXED', rate: 666.67, units: 3, amount: 2000 },
  ],
  deductions: [],
  employee: {
    firstName: 'Ayesha',
    lastName: 'Khan',
    displayName: null,
    employeeNumber: 'E-001',
    department: { name: 'Engineering' },
  },
  run: {
    runId: 'run-1',
    period: { name: 'June 2026', startDate: new Date('2026-06-01T00:00:00Z'), endDate: new Date('2026-06-30T00:00:00Z'), payDate: null },
  },
};

const payslipFor = (employeeId: string, publishedAt: Date | null) => ({
  id: `slip-${employeeId}`,
  companyId: 'company-1',
  lineId: 'line-1',
  employeeId,
  number: 'PS-000001',
  issuedAt: new Date(),
  publishedAt,
  line: { ...LINE, employeeId },
});

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  emulateEmployeeTable();
  db.company.findUniqueOrThrow.mockResolvedValue({ currency: 'PKR', timezone: 'Asia/Karachi' });
  db.auditLog.create.mockResolvedValue({});
  db.payrollRun.findFirst.mockResolvedValue({ ...RUN });
});

afterEach(async () => {
  await app?.close();
  app = null;
});

// --------------------------------------------------------- finalized is final

describe('a finalized run', () => {
  it('cannot be recalculated, even by an administrator', async () => {
    app = await appAs(ADMIN);
    const res = await app.inject({ method: 'POST', url: '/payroll/runs/run-1/calculate' });
    expect(res.statusCode).toBe(409);
    expect(db.payrollRun.updateMany).not.toHaveBeenCalled();
    expect(db.payrollRun.update).not.toHaveBeenCalled();
  });

  it('cannot be approved again', async () => {
    app = await appAs(ADMIN);
    const res = await app.inject({ method: 'POST', url: '/payroll/runs/run-1/approve' });
    expect(res.statusCode).toBe(409);
    expect(db.payrollRun.update).not.toHaveBeenCalled();
  });

  it('cannot be finalized again', async () => {
    app = await appAs(ADMIN);
    const res = await app.inject({ method: 'POST', url: '/payroll/runs/run-1/finalize' });
    expect(res.statusCode).toBe(409);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('cannot be sent back to review', async () => {
    app = await appAs(ADMIN);
    const res = await app.inject({ method: 'POST', url: '/payroll/runs/run-1/review' });
    expect(res.statusCode).toBe(409);
    expect(db.payrollRun.update).not.toHaveBeenCalled();
  });

  it('cannot be cancelled', async () => {
    app = await appAs(ADMIN);
    const res = await app.inject({
      method: 'POST',
      url: '/payroll/runs/run-1/cancel',
      payload: { reason: 'Trying to undo a paid month' },
    });
    expect(res.statusCode).toBe(409);
    expect(db.payrollRun.update).not.toHaveBeenCalled();
  });

  it('has no delete route at all', async () => {
    app = await appAs(ADMIN);
    const res = await app.inject({ method: 'DELETE', url: '/payroll/runs/run-1' });
    expect(res.statusCode).toBe(404);
  });

  it('cannot have a paid adjustment withdrawn', async () => {
    app = await appAs(ADMIN);
    db.payrollAdjustment.findFirst.mockResolvedValue({
      id: 'adj-1',
      companyId: 'company-1',
      employeeId: 'employee-1',
      kind: 'EARNING',
      label: 'Bonus',
      amount: 5000,
      reason: 'Q2',
      appliedAt: new Date(),
    });
    const res = await app.inject({ method: 'DELETE', url: '/payroll/adjustments/adj-1' });
    expect(res.statusCode).toBe(409);
    expect(db.payrollAdjustment.delete).not.toHaveBeenCalled();
  });

  it('a period with a finalized run cannot get a second one', async () => {
    app = await appAs(ADMIN);
    // The route looks the period up, then asks for a finalized run on it.
    db.payrollPeriod.findFirst.mockResolvedValue({ id: 'period-1', companyId: 'company-1', name: 'June 2026' });
    db.payrollRun.findFirst.mockResolvedValueOnce({ id: 'run-1' });
    const res = await app.inject({ method: 'POST', url: '/payroll/runs', payload: { periodId: 'period-1' } });
    expect(res.statusCode).toBe(409);
  });
});

// -------------------------------------------------------------- permissions

describe('who may move a run', () => {
  const review = { ...RUN, status: 'REVIEW' };
  const approved = { ...RUN, status: 'APPROVED' };

  it('a clerk may calculate but not approve or finalize', async () => {
    app = await appAs(PAYROLL_CLERK);
    db.payrollRun.findFirst.mockResolvedValue(review);

    expect((await app.inject({ method: 'POST', url: '/payroll/runs/run-1/approve' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/payroll/runs/run-1/finalize' })).statusCode).toBe(403);
    expect(db.payrollRun.update).not.toHaveBeenCalled();
  });

  it('an approver may approve but not calculate or cancel', async () => {
    app = await appAs(APPROVER);
    db.payrollRun.findFirst.mockResolvedValue(review);
    db.payrollRun.update.mockResolvedValue({ ...approved });

    expect((await app.inject({ method: 'POST', url: '/payroll/runs/run-1/calculate' })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/payroll/runs/run-1/cancel', payload: { reason: 'x' } }))
        .statusCode,
    ).toBe(403);

    const res = await app.inject({ method: 'POST', url: '/payroll/runs/run-1/approve' });
    expect(res.statusCode).toBe(200);
    expect(db.payrollRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'APPROVED', approvedBy: 'user-1' }) }),
    );
  });

  it('approval is refused while a blocking exception stands', async () => {
    app = await appAs(APPROVER);
    db.payrollRun.findFirst.mockResolvedValue({ ...review, blockingCount: 2 });
    const res = await app.inject({ method: 'POST', url: '/payroll/runs/run-1/approve' });
    expect(res.statusCode).toBe(422);
    expect(db.payrollRun.update).not.toHaveBeenCalled();
  });

  it('a reader may look and do nothing else', async () => {
    app = await appAs(READ_ONLY);
    db.payrollRun.findFirst.mockResolvedValue(review);
    expect((await app.inject({ method: 'GET', url: '/payroll/runs/run-1' })).statusCode).toBe(200);
    for (const action of ['calculate', 'review', 'approve', 'finalize']) {
      expect((await app.inject({ method: 'POST', url: `/payroll/runs/run-1/${action}` })).statusCode).toBe(403);
    }
  });

  it('an employee cannot see runs at all', async () => {
    app = await appAs(EMPLOYEE, 'OWN');
    expect((await app.inject({ method: 'GET', url: '/payroll/runs/run-1' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/payroll/runs' })).statusCode).toBe(403);
  });

  it('the workflow cannot skip a step', async () => {
    app = await appAs(ADMIN);
    db.payrollRun.findFirst.mockResolvedValue(review);
    // REVIEW -> FINALIZED is not a transition.
    const res = await app.inject({ method: 'POST', url: '/payroll/runs/run-1/finalize' });
    expect(res.statusCode).toBe(409);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ payslips

describe('reading a payslip', () => {
  const released = new Date('2026-07-01T00:00:00Z');

  it('an employee reads their own, once it is published', async () => {
    app = await appAs(EMPLOYEE, 'OWN');
    db.payslip.findFirst.mockResolvedValue(payslipFor('employee-1', released));
    const res = await app.inject({ method: 'GET', url: '/payslips/slip-employee-1' });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.employeeId).toBe('employee-1');
    expect(body.line.netAmount).toBe(122000);
    expect(body.line.paidOvertimeMinutes).toBe(180);
  });

  it('an employee cannot read somebody else\'s', async () => {
    app = await appAs(EMPLOYEE, 'OWN');
    db.payslip.findFirst.mockResolvedValue(payslipFor('employee-2', released));
    const res = await app.inject({ method: 'GET', url: '/payslips/slip-employee-2' });
    expect(res.statusCode).toBe(403);
  });

  it('an employee does not see their own before it is released', async () => {
    app = await appAs(EMPLOYEE, 'OWN');
    db.payslip.findFirst.mockResolvedValue(payslipFor('employee-1', null));
    const res = await app.inject({ method: 'GET', url: '/payslips/slip-employee-1' });
    expect(res.statusCode).toBe(404);
  });

  it('a payroll reader sees an unreleased payslip, because checking it is their job', async () => {
    app = await appAs(READ_ONLY);
    db.payslip.findFirst.mockResolvedValue(payslipFor('employee-2', null));
    const res = await app.inject({ method: 'GET', url: '/payslips/slip-employee-2' });
    expect(res.statusCode).toBe(200);
  });

  it('the list is narrowed to the caller and to what has been released', async () => {
    app = await appAs(EMPLOYEE, 'OWN');
    db.payslip.count.mockResolvedValue(0);
    db.payslip.findMany.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/payslips' });
    expect(res.statusCode).toBe(200);

    const where = (db.payslip.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where.publishedAt).toEqual({ not: null });
    expect(where.employee).toEqual({ AND: [{ id: 'employee-1' }] });
  });

  it('a payroll reader\'s list is not narrowed by release', async () => {
    app = await appAs(READ_ONLY);
    db.payslip.count.mockResolvedValue(0);
    db.payslip.findMany.mockResolvedValue([]);
    await app.inject({ method: 'GET', url: '/payslips' });
    const where = (db.payslip.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where.publishedAt).toBeUndefined();
  });

  it('an employee cannot ask for another employee\'s list by id', async () => {
    app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/payslips?employeeId=employee-2' });
    expect(res.statusCode).toBe(403);
    expect(db.payslip.findMany).not.toHaveBeenCalled();
  });

  it('without payslip.read there is nothing', async () => {
    app = await appAs([PERMISSIONS.EMPLOYEE_READ], 'OWN');
    expect((await app.inject({ method: 'GET', url: '/payslips' })).statusCode).toBe(403);
  });

  it('only an approver releases payslips, and only from a finalized run', async () => {
    app = await appAs(PAYROLL_CLERK);
    expect(
      (await app.inject({ method: 'POST', url: '/payslips/publish', payload: { runId: 'run-1' } })).statusCode,
    ).toBe(403);
    await app.close();

    app = await appAs(ADMIN);
    db.payrollRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'APPROVED' });
    expect(
      (await app.inject({ method: 'POST', url: '/payslips/publish', payload: { runId: 'run-1' } })).statusCode,
    ).toBe(409);
    expect(db.payslip.updateMany).not.toHaveBeenCalled();

    db.payrollRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'FINALIZED' });
    db.payslip.updateMany.mockResolvedValue({ count: 2 });
    const res = await app.inject({ method: 'POST', url: '/payslips/publish', payload: { runId: 'run-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.published).toBe(2);
  });
});

// -------------------------------------------------------------- settings

describe('payroll settings', () => {
  const stored = {
    id: 'settings-1',
    companyId: 'company-1',
    frequency: 'MONTHLY',
    taxEnabled: false,
    basis: 'FIXED_DAYS',
    fixedBasisDays: 30,
    standardHoursPerDay: 8,
    overtimeMode: 'MULTIPLIER',
    overtimeMultiplier: 1.5,
    overtimeFixedRate: 0,
    requireApprovedOvertime: true,
    overtimeCapMinutes: null,
    fallbackScheduledMinutes: 480,
    deductUnpaidAbsence: true,
    deductUnpaidLeave: true,
    lateDeductionMode: 'NONE',
    lateDeductionRate: 0,
    lateGraceMinutes: 0,
    earlyLeaveDeductionMode: 'NONE',
    earlyLeaveDeductionRate: 0,
    earlyLeaveGraceMinutes: 0,
    roundingDecimals: 2,
    payslipPrefix: 'PS-',
    prorationMethod: 'CALENDAR_DAYS',
    payDay: null,
    overtimeWeekendMultiplier: null,
    overtimeHolidayMultiplier: null,
  };

  beforeEach(() => {
    db.payrollSettings.findUnique.mockResolvedValue({ ...stored });
    db.payrollSettings.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...stored,
      ...data,
    }));
  });

  it('exposes the working day, the cap and the multiplier to a reader', async () => {
    app = await appAs(READ_ONLY);
    const res = await app.inject({ method: 'GET', url: '/payroll/settings' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.standardHoursPerDay).toBe(8);
    expect(data.fallbackScheduledMinutes).toBe(480);
    expect(data.overtimeCapMinutes).toBeNull();
    expect(data.overtimeMultiplier).toBe(1.5);
    expect(data.requireApprovedOvertime).toBe(true);
    expect(data.deductUnpaidAbsence).toBe(true);
    expect(data.prorationMethod).toBe('CALENDAR_DAYS');
  });

  it('lets an administrator set a 9-hour, 540-minute day, a 2x multiplier and a 40-hour cap', async () => {
    app = await appAs(ADMIN);
    const res = await app.inject({
      method: 'PATCH',
      url: '/payroll/settings',
      payload: {
        standardHoursPerDay: 9,
        fallbackScheduledMinutes: 540,
        overtimeMultiplier: 2,
        overtimeCapMinutes: 2400,
        requireApprovedOvertime: false,
        deductUnpaidAbsence: false,
        prorationMethod: 'WORKING_DAYS',
      },
    });
    expect(res.statusCode).toBe(200);

    const written = (db.payrollSettings.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(written.standardHoursPerDay).toBe(9);
    expect(written.fallbackScheduledMinutes).toBe(540);
    expect(written.overtimeMultiplier).toBe(2);
    expect(written.overtimeCapMinutes).toBe(2400);
    expect(written.requireApprovedOvertime).toBe(false);
    expect(written.deductUnpaidAbsence).toBe(false);
    expect(written.prorationMethod).toBe('WORKING_DAYS');
    // Untouched fields keep what was stored, not the schema default.
    expect(written.deductUnpaidLeave).toBe(true);
    expect(written.payslipPrefix).toBe('PS-');
  });

  it('clears the cap with null', async () => {
    app = await appAs(ADMIN);
    db.payrollSettings.findUnique.mockResolvedValue({ ...stored, overtimeCapMinutes: 600 });
    const res = await app.inject({ method: 'PATCH', url: '/payroll/settings', payload: { overtimeCapMinutes: null } });
    expect(res.statusCode).toBe(200);
    const written = (db.payrollSettings.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(written.overtimeCapMinutes).toBeNull();
  });

  it('rejects a negative cap and a day shorter than an hour', async () => {
    app = await appAs(ADMIN);
    expect(
      (await app.inject({ method: 'PATCH', url: '/payroll/settings', payload: { overtimeCapMinutes: -1 } })).statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: 'PATCH', url: '/payroll/settings', payload: { fallbackScheduledMinutes: 30 } }))
        .statusCode,
    ).toBe(422);
    expect(db.payrollSettings.update).not.toHaveBeenCalled();
  });

  it('a reader cannot change them', async () => {
    app = await appAs(READ_ONLY);
    const res = await app.inject({ method: 'PATCH', url: '/payroll/settings', payload: { overtimeMultiplier: 3 } });
    expect(res.statusCode).toBe(403);
    expect(db.payrollSettings.update).not.toHaveBeenCalled();
  });

  it('a change is audited with what moved', async () => {
    app = await appAs(ADMIN);
    await app.inject({ method: 'PATCH', url: '/payroll/settings', payload: { overtimeCapMinutes: 1200 } });
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const entry = (db.auditLog.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(entry.action).toBe('payroll.settings.update');
    expect(String(entry.summary)).toContain('overtimeCapMinutes');
  });
});
