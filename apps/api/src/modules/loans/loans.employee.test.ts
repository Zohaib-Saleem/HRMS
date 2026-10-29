import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOAN_POLICY_DEFAULTS, PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The employee side of the loans module.
 *
 * An employee holds `loan.read` and `loan.request` with an OWN data scope, and
 * that pairing is what the whole self-service story rests on. These tests drive
 * the endpoints the way anyone with a session cookie and a terminal would, and
 * assert the four boundaries the UI cannot enforce:
 *
 *   - an application is always for the caller; the body has no employee id and
 *     adding one changes nothing;
 *   - a loan list is bounded by the data scope, and `?employeeId=` cannot get
 *     past it;
 *   - one employee cannot read, approve or cancel another's loan;
 *   - a PENDING loan reaches payroll's collector not at all, and an ACTIVE one
 *     reaches it through the same query it always has.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  company: { findUniqueOrThrow: vi.fn() },
  // Everything the loan policy gate reads. They are here so the REAL
  // eligibility engine runs against these tests rather than a stub of it: a
  // boundary test whose gate is faked is a test of a route that does not exist.
  loanPolicy: { findFirst: vi.fn(), upsert: vi.fn() },
  employeeSalary: { findFirst: vi.fn() },
  payrollSettings: { findUnique: vi.fn() },
  attendanceRecord: { findMany: vi.fn(), count: vi.fn() },
  attendancePolicyAssignment: { findMany: vi.fn() },
  attendanceRegularizationRequest: { findMany: vi.fn() },
  employeeShiftAssignment: { findMany: vi.fn() },
  leaveRequest: { findMany: vi.fn() },
  holiday: { findMany: vi.fn() },
  employeeLoan: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
  employeeLoanInstallment: { findFirst: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  approvalRequest: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  approvalWorkflow: { findFirst: vi.fn() },
  approvalStep: { findFirst: vi.fn(), updateMany: vi.fn() },
  approvalEvent: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  payrollPeriod: { findMany: vi.fn() },
  employeeLoanTransaction: { create: vi.fn(), createMany: vi.fn(), findFirst: vi.fn() },
  user: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { loanRoutes } = await import('./loans.routes.js');
const { dueInstallmentsForPeriod } = await import('./loans.service.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

/** What the Employee system role actually holds for loans. */
const EMPLOYEE: Permission[] = [PERMISSIONS.LOAN_READ, PERMISSIONS.LOAN_REQUEST];
/** HR: reads, creates and decides. */
const HR: Permission[] = [
  PERMISSIONS.LOAN_READ,
  PERMISSIONS.LOAN_REQUEST,
  PERMISSIONS.LOAN_MANAGE,
  PERMISSIONS.LOAN_APPROVE,
];

const SELF = { id: 'emp-self', departmentId: 'dep-1', firstName: 'Ayesha', lastName: 'Khan', locationId: null };

const APPLICATION = {
  principalAmount: 60_000,
  installmentCount: 6,
  startMonth: '2026-11',
  purpose: 'School fees for the year.',
};

async function appAs(
  permissions: Permission[],
  dataScope: 'ALL' | 'OWN' | 'REPORTS' | 'NONE' = 'OWN',
  userId = 'user-self',
): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId,
      companyId: 'company-1',
      email: 'ayesha@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(loanRoutes, { prefix: '/loans' });
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  // No payroll month is closed and nothing is on the ledger yet.
  db.payrollPeriod.findMany.mockResolvedValue([]);
  db.employeeLoanInstallment.findFirst.mockResolvedValue(null);
  db.user.findMany.mockResolvedValue([]);
  db.company.findUniqueOrThrow.mockResolvedValue({ currency: 'PKR', timezone: 'Asia/Karachi' });

  /*
   * One company row serves both readers: the loans routes take `currency`, and
   * `resolveAttendancePolicy` takes the timezone and thresholds. The mock
   * ignores `select`, so a single object answers both.
   */
  db.company.findUniqueOrThrow.mockResolvedValue({
    currency: 'PKR',
    timezone: 'Asia/Karachi',
    weekendDays: ['SATURDAY', 'SUNDAY'],
    graceMinutes: 10,
    halfDayMinutes: 240,
    fullDayMinutes: 480,
  });

  /*
   * The loan policy the gate measures against: the shipped defaults.
   *
   * At a 1x multiple and a 30% deduction ceiling, the 60,000-over-6-months
   * application below is comfortably eligible - so these tests exercise the
   * real gate and still assert what they were written to assert.
   */
  db.loanPolicy.findFirst.mockResolvedValue({
    id: 'pol-1',
    companyId: 'company-1',
    ...LOAN_POLICY_DEFAULTS,
    effectiveFrom: new Date(0),
    createdAt: new Date(0),
    createdBy: null,
  });
  db.employeeSalary.findFirst.mockResolvedValue({
    amount: 100_000,
    currency: 'PKR',
    salaryType: 'MONTHLY',
  });
  db.employee.findUniqueOrThrow.mockResolvedValue({ id: 'emp-self', locationId: null });

  // No attendance in the window. The engine reports it as unmeasured and
  // applies no attendance rule, which is the documented behaviour for somebody
  // with nothing on record - not a silent pass.
  db.attendanceRecord.findMany.mockResolvedValue([]);
  // No records at all, so the window holds no evidence and the attendance
  // rules are reported as unmeasured rather than scored at 0%.
  db.attendanceRecord.count.mockResolvedValue(0);
  db.attendancePolicyAssignment.findMany.mockResolvedValue([]);
  db.attendanceRegularizationRequest.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findMany.mockResolvedValue([]);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.holiday.findMany.mockResolvedValue([]);
  db.payrollSettings.findUnique.mockResolvedValue(null);

  /*
   * One employee row, serving two readers again: the loans routes want the
   * name and the approval chain, the eligibility engine wants the employment
   * facts. Kept complete rather than minimal - `isOnProbation` reads
   * `contracts` and is deliberately strict about it, because a policy control
   * that silently treats a missing field as "not on probation" is worse than
   * one that fails loudly.
   */
  db.employee.findFirst.mockResolvedValue({
    ...SELF,
    managerId: 'emp-manager',
    secondaryManagerId: null,
    department: { headEmployeeId: 'emp-head' },
    status: 'ACTIVE',
    hireDate: new Date('2020-01-01T00:00:00Z'),
    confirmationDate: new Date('2020-07-01T00:00:00Z'),
    employmentStatus: 'PERMANENT',
    locationId: null,
    contracts: [],
  });

  /*
   * The two questions resolving an approval chain now asks: is this company
   * using a configured chain (null = the built-in default, which for a loan is
   * the reporting line exactly as before), and which candidates are still
   * ACTIVE - because the resolver will not route a request to somebody who has
   * left, whatever a roster says. The stub answers with the ids it was asked
   * about; a test that wants a departed approver overrides it.
   */
  db.employee.findMany.mockImplementation((args: { where?: { id?: { in?: string[] } } }) =>
    Promise.resolve((args?.where?.id?.in ?? []).map((id: string) => ({ id }))),
  );
  db.approvalWorkflow.findFirst.mockResolvedValue(null);


  db.employeeLoan.findFirst.mockResolvedValue(null);
  db.employeeLoan.findMany.mockResolvedValue([]);
  db.employeeLoan.count.mockResolvedValue(0);
  db.employeeLoan.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'loan-1', ...data }),
  );
  db.employeeLoan.update.mockResolvedValue({ id: 'loan-1' });
  db.employeeLoanInstallment.createMany.mockResolvedValue({ count: 6 });
  db.employeeLoanInstallment.findMany.mockResolvedValue([]);

  db.approvalRequest.create.mockResolvedValue({ id: 'appr-1', steps: [{ stepOrder: 1 }] });
  db.approvalStep.findFirst.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});

  db.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : arg,
  );
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('POST /loans/apply - the deduction month', () => {
  /*
   * The month is the server's: the current payroll month (Asia/Karachi) by
   * default, never one before it, never one whose payroll is finalized. The
   * reported mismatch was a form defaulting from the browser clock and a
   * server that accepted whatever it was sent.
   */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T10:00:00+05:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const created = () =>
    db.employeeLoan.create.mock.calls[0]?.[0] as { data: { startMonth: Date } } | undefined;

  it('defaults to the payroll month the request is made in', async () => {
    app = await appAs(EMPLOYEE);
    const { startMonth: _omit, ...withoutMonth } = APPLICATION;
    const response = await app.inject({ method: 'POST', url: '/loans/apply', payload: withoutMonth });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.startMonth).toBe('2026-10');
    expect(created()!.data.startMonth).toEqual(new Date('2026-10-01T00:00:00Z'));
    const schedule = db.employeeLoanInstallment.createMany.mock.calls[0]?.[0] as {
      data: Array<{ dueMonth: Date }>;
    };
    expect(schedule.data[0]!.dueMonth).toEqual(new Date('2026-10-01T00:00:00Z'));
  });

  it('moves the default past a month whose payroll is already finalized', async () => {
    db.payrollPeriod.findMany.mockResolvedValue([
      { startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z') },
    ]);
    app = await appAs(EMPLOYEE);
    const { startMonth: _omit, ...withoutMonth } = APPLICATION;
    const response = await app.inject({ method: 'POST', url: '/loans/apply', payload: withoutMonth });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.startMonth).toBe('2026-11');
  });

  it('refuses a month before the current payroll month', async () => {
    app = await appAs(EMPLOYEE);
    const response = await app.inject({
      method: 'POST',
      url: '/loans/apply',
      payload: { ...APPLICATION, startMonth: '2026-09' },
    });
    expect(response.statusCode).toBe(422);
    expect(db.employeeLoan.create).not.toHaveBeenCalled();
  });

  it('refuses a closed month the employee picked, rather than quietly changing it', async () => {
    db.payrollPeriod.findMany.mockResolvedValue([
      { startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z') },
    ]);
    app = await appAs(EMPLOYEE);
    const response = await app.inject({
      method: 'POST',
      url: '/loans/apply',
      payload: { ...APPLICATION, startMonth: '2026-10' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.startMonth[0]).toMatch(/already finalized/);
  });

  it('tells the form the same rule', async () => {
    app = await appAs(EMPLOYEE);
    const response = await app.inject({ method: 'GET', url: '/loans/deduction-month' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      currentMonth: '2026-10',
      defaultMonth: '2026-10',
      closedMonths: [],
    });
  });
});

describe('POST /loans/apply - a salary advance is recovered from the month it is requested in', () => {
  const ADVANCE = {
    kind: 'SALARY_ADVANCE',
    principalAmount: 20_000,
    installmentCount: 1,
    purpose: 'Rent due this week.',
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  const applyAt = async (instant: string, payload: Record<string, unknown> = ADVANCE) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instant));
    app = await appAs(EMPLOYEE);
    return app.inject({ method: 'POST', url: '/loans/apply', payload });
  };
  const storedMonth = () =>
    (db.employeeLoan.create.mock.calls[0]?.[0] as { data: { startMonth: Date } }).data.startMonth
      .toISOString()
      .slice(0, 7);
  const scheduledMonth = () =>
    (
      db.employeeLoanInstallment.createMany.mock.calls[0]?.[0] as { data: Array<{ dueMonth: Date }> }
    ).data[0]!.dueMonth
      .toISOString()
      .slice(0, 7);

  it.each([
    ['25 October', '2026-10-25T10:00:00+05:00', '2026-10'],
    ['10 November', '2026-11-10T10:00:00+05:00', '2026-11'],
    ['30 December', '2026-12-30T10:00:00+05:00', '2026-12'],
  ])('applied for on %s, it is deducted from that month', async (_label, instant, month) => {
    const response = await applyAt(instant);
    expect(response.statusCode).toBe(201);
    expect(response.json().data.startMonth).toBe(month);
    expect(response.json().data.deductionDecisionMonth).toBeNull();
    expect(storedMonth()).toBe(month);
    expect(scheduledMonth()).toBe(month);
  });

  it('reads the month in the company timezone, not UTC or the browser', async () => {
    // 31 October 20:30 UTC is already 1 November in Karachi.
    const late = await applyAt('2026-10-31T20:30:00Z');
    expect(late.json().data.startMonth).toBe('2026-11');

    vi.clearAllMocks();
    db.employeeLoan.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'loan-1', ...data }),
    );
    db.payrollPeriod.findMany.mockResolvedValue([]);
    await app?.close();
    // 31 October 18:30 UTC is 23:30 on the 31st in Karachi: still October.
    const before = await applyAt('2026-10-31T18:30:00Z');
    expect(before.json().data.startMonth).toBe('2026-10');
  });

  it('keeps October when October payroll is already finalized, and flags it for a decision', async () => {
    db.payrollPeriod.findMany.mockResolvedValue([
      { startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z') },
    ]);
    db.employeeLoan.findUnique.mockResolvedValue({ kind: 'SALARY_ADVANCE', status: 'PENDING' });
    db.employeeLoanInstallment.findMany.mockResolvedValue([
      { status: 'SCHEDULED', dueMonth: new Date('2026-10-01T00:00:00Z') },
    ]);

    const response = await applyAt('2026-10-25T10:00:00+05:00');

    expect(response.statusCode).toBe(201);
    expect(response.json().data.startMonth).toBe('2026-10');
    expect(response.json().data.deductionDecisionMonth).toBe('2026-10');
    expect(storedMonth()).toBe('2026-10');
    const audit = db.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: { action: string; after: Record<string, unknown> } }).data)
      .find((a) => a.action === 'loan.apply');
    expect(audit?.after).toMatchObject({ startMonth: '2026-10', deductionDecisionMonth: '2026-10' });
  });

  it('the form is told the current month in the company timezone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T20:30:00Z'));
    app = await appAs(EMPLOYEE);
    const response = await app.inject({ method: 'GET', url: '/loans/deduction-month' });
    expect(response.json().data.currentMonth).toBe('2026-11');
  });
});

describe('POST /loans/apply', () => {
  it('files the application against the caller, ignoring an employee id in the body', async () => {
    app = await appAs(EMPLOYEE);

    const response = await app.inject({
      method: 'POST',
      url: '/loans/apply',
      payload: { ...APPLICATION, employeeId: 'emp-someone-else' },
    });

    expect(response.statusCode).toBe(201);
    const created = db.employeeLoan.create.mock.calls[0]?.[0] as {
      data: { employeeId: string; status: string };
    };
    expect(created.data.employeeId).toBe('emp-self');
    // PENDING, and PENDING is the status payroll never deducts against.
    expect(created.data.status).toBe('PENDING');
  });

  it('routes the application through the existing approval engine', async () => {
    app = await appAs(EMPLOYEE);

    await app.inject({ method: 'POST', url: '/loans/apply', payload: APPLICATION });

    const approval = db.approvalRequest.create.mock.calls[0]?.[0] as {
      data: {
        subjectType: string;
        requesterEmployeeId: string;
        steps: { create: Array<{ approverEmployeeId: string }> };
      };
    };
    expect(approval.data.subjectType).toBe('LOAN_REQUEST');
    expect(approval.data.requesterEmployeeId).toBe('emp-self');
    // The applicant is never an approver of their own application.
    expect(approval.data.steps.create.map((s) => s.approverEmployeeId)).toEqual(['emp-manager']);
  });

  /*
   * The gate is real in this file, not stubbed.
   *
   * These two prove it: the same fixtures that produce a 201 above produce a
   * refusal when the policy or the employee moves. Without them, a future
   * change that quietly removed `assertLoanAllowed` from the route would leave
   * every other test in this file passing.
   */
  it('is refused when the amount exceeds what the policy allows', async () => {
    app = await appAs(EMPLOYEE);

    // Salary 100,000 at a 1x multiple: 150,000 is over the ceiling.
    const response = await app.inject({
      method: 'POST',
      url: '/loans/apply',
      payload: { ...APPLICATION, principalAmount: 150_000 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('The most you can borrow');
    expect(db.employeeLoan.create).not.toHaveBeenCalled();
    expect(db.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('is refused when the repayment would exceed the deduction ceiling', async () => {
    app = await appAs(EMPLOYEE);

    // 90,000 over 2 months is 45,000 a month; 30% of 100,000 is 30,000.
    const response = await app.inject({
      method: 'POST',
      url: '/loans/apply',
      payload: { ...APPLICATION, principalAmount: 90_000, installmentCount: 2 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('The most that can be deducted');
    expect(db.employeeLoan.create).not.toHaveBeenCalled();
  });

  it('refuses an application from a login with no employee record', async () => {
    db.employee.findFirst.mockResolvedValue(null);
    app = await appAs(EMPLOYEE);

    const response = await app.inject({ method: 'POST', url: '/loans/apply', payload: APPLICATION });

    expect(response.statusCode).toBe(403);
    expect(db.employeeLoan.create).not.toHaveBeenCalled();
  });

  it('refuses without loan.request, however wide the data scope', async () => {
    app = await appAs([PERMISSIONS.LOAN_READ], 'ALL');

    const response = await app.inject({ method: 'POST', url: '/loans/apply', payload: APPLICATION });

    expect(response.statusCode).toBe(403);
    expect(db.employeeLoan.create).not.toHaveBeenCalled();
  });
});

describe('GET /loans', () => {
  it('narrows an OWN scope to the caller', async () => {
    app = await appAs(EMPLOYEE);

    const response = await app.inject({ method: 'GET', url: '/loans' });

    expect(response.statusCode).toBe(200);
    const where = (db.employeeLoan.findMany.mock.calls[0]?.[0] as {
      where: { AND: Array<Record<string, unknown>> };
    }).where;
    expect(where.AND).toContainEqual({ employee: { id: 'emp-self' } });
  });

  it('refuses an employeeId belonging to somebody else', async () => {
    db.employee.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve('AND' in where ? null : { ...SELF }),
    );
    app = await appAs(EMPLOYEE);

    const response = await app.inject({ method: 'GET', url: '/loans?employeeId=emp-someone-else' });

    expect(response.statusCode).toBe(403);
    expect(db.employeeLoan.findMany).not.toHaveBeenCalled();
  });
});

describe("another employee's loan", () => {
  const OTHERS_LOAN = {
    id: 'loan-other',
    companyId: 'company-1',
    employeeId: 'emp-someone-else',
    status: 'PENDING',
    currency: 'PKR',
    principalAmount: 10_000,
    installmentCount: 4,
    monthlyDeduction: 2_500,
    startMonth: new Date('2026-11-01T00:00:00Z'),
    approvalRequestId: null,
    reference: null,
    purpose: null,
    notes: null,
    requestedAt: null,
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    activatedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    employee: {
      id: 'emp-someone-else',
      firstName: 'Bilal',
      lastName: 'Ahmed',
      displayName: null,
      employeeNumber: 'E-002',
    },
    installments: [],
  };

  beforeEach(() => {
    db.employeeLoan.findFirst.mockResolvedValue(OTHERS_LOAN);
    // The scope lookup answers for the caller; the ownership assertion, which
    // queries with an AND, finds nothing.
    db.employee.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve('AND' in where ? null : { ...SELF }),
    );
  });

  it('cannot be read', async () => {
    app = await appAs(EMPLOYEE);
    const response = await app.inject({ method: 'GET', url: '/loans/loan-other' });
    expect(response.statusCode).toBe(403);
  });

  it('cannot be cancelled', async () => {
    app = await appAs(EMPLOYEE);
    const response = await app.inject({ method: 'POST', url: '/loans/loan-other/cancel', payload: {} });
    expect(response.statusCode).toBe(403);
    expect(db.employeeLoan.update).not.toHaveBeenCalled();
  });

  it('cannot be approved - an employee holds no loan.approve at all', async () => {
    app = await appAs(EMPLOYEE);
    const response = await app.inject({ method: 'POST', url: '/loans/loan-other/approve', payload: {} });
    expect(response.statusCode).toBe(403);
    expect(db.employeeLoan.update).not.toHaveBeenCalled();
  });
});

describe('approving your own loan', () => {
  it('is refused even for somebody who holds loan.approve', async () => {
    db.employeeLoan.findFirst.mockResolvedValue({
      id: 'loan-mine',
      companyId: 'company-1',
      employeeId: 'emp-self',
      status: 'PENDING',
      currency: 'PKR',
      principalAmount: 10_000,
      installmentCount: 4,
      startMonth: new Date('2026-11-01T00:00:00Z'),
      approvalRequestId: null,
      employee: {
        id: 'emp-self',
        firstName: 'Ayesha',
        lastName: 'Khan',
        displayName: null,
        employeeNumber: 'E-001',
      },
      installments: [],
    });
    app = await appAs(HR, 'ALL');

    const response = await app.inject({ method: 'POST', url: '/loans/loan-mine/approve', payload: {} });

    expect(response.statusCode).toBe(403);
    expect(db.employeeLoan.update).not.toHaveBeenCalled();
  });
});

describe('what payroll collects', () => {
  it('asks only for installments belonging to an ACTIVE loan', async () => {
    db.employeeLoanInstallment.findMany.mockResolvedValue([]);

    await dueInstallmentsForPeriod({
      companyId: 'company-1',
      employeeIds: ['emp-self'],
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-30T00:00:00Z'),
      runId: null,
    });

    const where = (db.employeeLoanInstallment.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    }).where;
    // The one gate between loans and money. A PENDING, APPROVED, REJECTED or
    // CANCELLED loan is not matched by this query at all.
    expect(where.loan).toEqual({ status: 'ACTIVE' });
  });

  it('returns an ACTIVE loan installment through the unchanged path', async () => {
    db.employeeLoanInstallment.findMany.mockResolvedValue([
      {
        id: 'inst-1',
        loanId: 'loan-1',
        employeeId: 'emp-self',
        sequence: 1,
        amount: 10_000,
        dueMonth: new Date('2026-11-01T00:00:00Z'),
        loan: { reference: 'LN-1', installmentCount: 6 },
      },
    ]);

    const due = await dueInstallmentsForPeriod({
      companyId: 'company-1',
      employeeIds: ['emp-self'],
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-30T00:00:00Z'),
      runId: null,
    });

    expect(due).toEqual([
      {
        id: 'inst-1',
        loanId: 'loan-1',
        employeeId: 'emp-self',
        sequence: 1,
        amount: 10_000,
        reference: 'LN-1',
        installmentCount: 6,
        dueMonth: '2026-11-01',
      },
    ]);
  });

  it('collects nothing when nobody is in the run', async () => {
    const due = await dueInstallmentsForPeriod({
      companyId: 'company-1',
      employeeIds: [],
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-30T00:00:00Z'),
      runId: null,
    });

    expect(due).toEqual([]);
    expect(db.employeeLoanInstallment.findMany).not.toHaveBeenCalled();
  });
});
