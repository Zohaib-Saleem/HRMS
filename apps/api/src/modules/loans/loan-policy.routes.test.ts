import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOAN_POLICY_DEFAULTS, PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The loan policy endpoints, and the gate they put in front of an application.
 *
 * Four things this file is here to hold down:
 *
 *   - Only a holder of `loan.policy.manage` can change the rules, and an
 *     employee cannot even read them. The screen hides what it must, but the
 *     endpoint is the gate and that is what is asserted.
 *   - Saving is an INSERT. A policy row is never updated, because the version
 *     that governed an application already granted has to survive the change.
 *   - Changing the policy touches no loan. Not the principal, not the
 *     schedule, not an installment, not a status.
 *   - An employee cannot get past a refusal, and an authorised user can only
 *     get past one deliberately, with a reason, and on the record.
 */

const db = vi.hoisted(() => ({
  company: { findUniqueOrThrow: vi.fn() },
  employee: { findFirst: vi.fn(), findMany: vi.fn() },
  employeeSalary: { findFirst: vi.fn() },
  employeeLoan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  employeeLoanInstallment: { findFirst: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  attendanceRegularizationRequest: { findMany: vi.fn() },
  loanPolicy: { findFirst: vi.fn(), upsert: vi.fn(), create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  approvalRequest: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  approvalWorkflow: { findFirst: vi.fn() },
  approvalStep: { findFirst: vi.fn(), updateMany: vi.fn() },
  approvalEvent: { create: vi.fn() },
  user: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
  payrollPeriod: { findMany: vi.fn() },
  payrollSettings: { findUnique: vi.fn(async () => null) },
  employeeLoanTransaction: { create: vi.fn(), createMany: vi.fn(), findFirst: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

/**
 * The engine is stubbed here on purpose.
 *
 * These are ROUTE tests: what they assert is what the endpoints do with an
 * answer, not how the answer is reached. The engine is driven against real
 * attendance, salary and policy fixtures in loan-eligibility.test.ts.
 */
const eligibility = vi.hoisted(() => ({ evaluateLoanEligibility: vi.fn() }));
vi.mock('./loan-eligibility.service.js', () => eligibility);

const { loanPolicyRoutes, loanEligibilityRoutes } = await import('./loan-policy.routes.js');
const { loanRoutes } = await import('./loans.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const SUPER_ADMIN: Permission[] = [
  PERMISSIONS.LOAN_READ,
  PERMISSIONS.LOAN_MANAGE,
  PERMISSIONS.LOAN_APPROVE,
  PERMISSIONS.LOAN_POLICY_READ,
  PERMISSIONS.LOAN_POLICY_MANAGE,
];
const HR_ADMIN: Permission[] = [
  PERMISSIONS.LOAN_READ,
  PERMISSIONS.LOAN_MANAGE,
  PERMISSIONS.LOAN_APPROVE,
  PERMISSIONS.LOAN_POLICY_READ,
];
const EMPLOYEE: Permission[] = [PERMISSIONS.LOAN_READ, PERMISSIONS.LOAN_REQUEST];

async function appAs(
  permissions: Permission[],
  dataScope: 'ALL' | 'OWN' = 'ALL',
): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-1',
      companyId: 'company-1',
      email: 'admin@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(loanPolicyRoutes, { prefix: '/loans/policy' });
  await app.register(loanEligibilityRoutes, { prefix: '/loans' });
  await app.register(loanRoutes, { prefix: '/loans' });
  await app.ready();
  return app;
}

const policyRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'pol-1',
  companyId: 'company-1',
  ...LOAN_POLICY_DEFAULTS,
  effectiveFrom: new Date('2020-01-01T00:00:00Z'),
  createdAt: new Date('2020-01-01T00:00:00Z'),
  createdBy: null,
  ...overrides,
});

/** A complete, valid policy body. */
const POLICY_BODY = { ...LOAN_POLICY_DEFAULTS, maxSalaryMultiplier: 2 };

const ELIGIBLE = {
  eligible: true,
  maxAllowedAmount: 200_000,
  maxMonthlyDeduction: 30_000,
  monthlySalary: 100_000,
  currency: 'PKR',
  maxTenureMonths: 12,
  maxInstallments: 12,
  estimatedMonthlyDeduction: 10_000,
  reasons: [],
  failedRules: [],
  failures: [],
  warnings: [],
  evaluation: {
    months: 3,
    from: '2026-04-01',
    to: '2026-06-30',
    attendancePercentage: 97,
    unapprovedAbsences: 0,
    lateDays: 1,
    missingPunches: 0,
    measured: true,
  },
  overrideAllowed: true,
};

const INELIGIBLE = {
  ...ELIGIBLE,
  eligible: false,
  reasons: [
    'Your attendance is 84%. The minimum required is 90%.',
    'You have 5 unapproved absences. The maximum allowed is 3.',
  ],
  failedRules: ['ATTENDANCE_PERCENT', 'UNAPPROVED_ABSENCES'],
  failures: [
    { rule: 'ATTENDANCE_PERCENT', message: 'Your attendance is 84%. The minimum required is 90%.' },
    {
      rule: 'UNAPPROVED_ABSENCES',
      message: 'You have 5 unapproved absences. The maximum allowed is 3.',
    },
  ],
};

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  // No payroll month is closed and nothing is on the ledger yet.
  db.payrollPeriod.findMany.mockResolvedValue([]);
  db.employeeLoanInstallment.findFirst.mockResolvedValue(null);
  db.user.findMany.mockResolvedValue([]);
  db.company.findUniqueOrThrow.mockResolvedValue({ currency: 'PKR', timezone: 'Asia/Karachi' });

  db.company.findUniqueOrThrow.mockResolvedValue({ currency: 'PKR' });
  /*
   * Discriminates the way the real queries do.
   *
   * `currentLoanPolicy` asks for `effectiveFrom <= now` and
   * `scheduledLoanPolicy` asks for `> now`; a single mockResolvedValue answers
   * both and invents a scheduled version that does not exist. Reading the
   * clause keeps the fixture honest about which question is being asked.
   */
  db.loanPolicy.findFirst.mockImplementation((args: { where: { effectiveFrom?: unknown } }) => {
    const clause = args.where.effectiveFrom as { gt?: Date; lte?: Date } | undefined;
    if (clause?.gt) return Promise.resolve(null);
    return Promise.resolve(policyRow());
  });
  db.loanPolicy.upsert.mockResolvedValue(policyRow());
  db.loanPolicy.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...policyRow(), id: 'pol-2', ...data }),
  );
  db.loanPolicy.findMany.mockResolvedValue([]);
  db.loanPolicy.count.mockResolvedValue(0);
  db.user.findMany.mockResolvedValue([]);
  db.auditLog.create.mockResolvedValue({});

  db.employee.findFirst.mockResolvedValue({
    id: 'emp-self',
    firstName: 'Ayesha',
    lastName: 'Khan',
    displayName: null,
    managerId: 'emp-manager',
    secondaryManagerId: null,
    department: { headEmployeeId: null },
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
  db.employeeLoan.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'loan-1', ...data }),
  );
  db.employeeLoan.update.mockResolvedValue({ id: 'loan-1' });
  // The create route reads the loan back to return a detail payload.
  db.employeeLoan.findUniqueOrThrow.mockResolvedValue({
    id: 'loan-1',
    employeeId: 'emp-self',
    reference: null,
    principalAmount: 50_000,
    currency: 'PKR',
    installmentCount: 6,
    monthlyDeduction: 8_333.33,
    startMonth: new Date('2026-10-01T00:00:00Z'),
    status: 'ACTIVE',
    purpose: null,
    notes: null,
    requestedByUserId: null,
    requestedAt: null,
    approvalRequestId: null,
    approvedByUserId: null,
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    activatedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdBy: 'user-1',
    createdAt: new Date('2026-09-12T00:00:00Z'),
    updatedAt: new Date('2026-09-12T00:00:00Z'),
    employee: {
      id: 'emp-self',
      firstName: 'Ayesha',
      lastName: 'Khan',
      displayName: null,
      employeeNumber: 'E-001',
    },
    installments: [],
  });
  db.employeeLoanInstallment.createMany.mockResolvedValue({ count: 6 });
  db.approvalRequest.create.mockResolvedValue({ id: 'appr-1', steps: [{ stepOrder: 1 }] });
  db.approvalStep.findFirst.mockResolvedValue(null);
  db.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : arg,
  );

  eligibility.evaluateLoanEligibility.mockResolvedValue(ELIGIBLE);
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('who may see and change the policy', () => {
  it('lets Super Admin read it, and says they may change it', async () => {
    app = await appAs(SUPER_ADMIN);

    const response = await app.inject({ method: 'GET', url: '/loans/policy' });

    expect(response.statusCode).toBe(200);
    const { data } = response.json();
    expect(data.canManage).toBe(true);
    expect(data.policy.maxSalaryMultiplier).toBe(1);
  });

  it('answers in the envelope the web client expects, with every field the view needs', async () => {
    app = await appAs(SUPER_ADMIN);

    const response = await app.inject({ method: 'GET', url: '/loans/policy' });
    const body = response.json();

    /*
     * The top level is `{ data }` and nothing else.
     *
     * `api.get` on the web side unwraps exactly this one level, so a `meta` or
     * `totals` sibling appearing here later would silently strip itself on the
     * way to the screen. Asserting the envelope keeps the two halves of the
     * contract written down in one place.
     */
    expect(Object.keys(body)).toEqual(['data']);

    // Every field LoanPolicyView declares, present and of the right kind.
    expect(Object.keys(body.data).sort()).toEqual(['canManage', 'currency', 'policy', 'scheduled']);
    expect(typeof body.data.canManage).toBe('boolean');
    expect(typeof body.data.currency).toBe('string');
    expect(body.data.scheduled).toBeNull();

    const policy = body.data.policy;
    for (const field of [
      'id',
      'maxSalaryMultiplier',
      'minEmploymentMonths',
      'allowProbation',
      'minAttendancePercent',
      'maxUnapprovedAbsences',
      'maxLateDays',
      'maxMissingPunches',
      'evaluationMonths',
      'maxMonthlyDeductionPercent',
      'oneActiveLoan',
      'onePendingLoan',
      'blockTerminated',
      'blockResigned',
      'minSalary',
      'maxTenureMonths',
      'maxInstallments',
      'allowHrOverride',
      'requireOverrideReason',
      'effectiveFrom',
      'createdAt',
      'createdByName',
      'isCurrent',
    ]) {
      expect(policy, `policy.${field} is missing`).toHaveProperty(field);
    }

    // Decimals come back as numbers, not Prisma Decimal objects or strings -
    // the form binds them to number inputs.
    expect(typeof policy.maxSalaryMultiplier).toBe('number');
    expect(typeof policy.minAttendancePercent).toBe('number');
    expect(typeof policy.minSalary).toBe('number');
  });

  it('answers the history in a paginated envelope, not a bare array', async () => {
    app = await appAs(SUPER_ADMIN);

    const response = await app.inject({ method: 'GET', url: '/loans/policy/history' });
    const body = response.json();

    // `data` has a `meta` sibling here, which is why the web side reads this
    // one with `getPage` rather than `get`.
    expect(Object.keys(body).sort()).toEqual(['data', 'meta']);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toMatchObject({ page: 1, limit: expect.any(Number) });
  });

  it('lets HR read it but not change it', async () => {
    app = await appAs(HR_ADMIN);

    const read = await app.inject({ method: 'GET', url: '/loans/policy' });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.canManage).toBe(false);

    const write = await app.inject({ method: 'PUT', url: '/loans/policy', payload: POLICY_BODY });
    expect(write.statusCode).toBe(403);
    expect(db.loanPolicy.create).not.toHaveBeenCalled();
  });

  it('refuses an employee outright, for reading as well as writing', async () => {
    app = await appAs(EMPLOYEE, 'OWN');

    expect((await app.inject({ method: 'GET', url: '/loans/policy' })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'PUT', url: '/loans/policy', payload: POLICY_BODY })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/loans/policy/history' })).statusCode,
    ).toBe(403);
    expect(db.loanPolicy.create).not.toHaveBeenCalled();
  });

  it('seeds the first version through an upsert, so a race cannot make two', async () => {
    db.loanPolicy.findFirst.mockResolvedValue(null);
    app = await appAs(SUPER_ADMIN);

    const response = await app.inject({ method: 'GET', url: '/loans/policy' });

    expect(response.statusCode).toBe(200);
    expect(db.loanPolicy.upsert).toHaveBeenCalledTimes(1);
    expect(db.loanPolicy.create).not.toHaveBeenCalled();
    // Seeded at the epoch, so every application ever made has a policy behind it.
    const call = db.loanPolicy.upsert.mock.calls[0]?.[0] as {
      where: { companyId_effectiveFrom: { effectiveFrom: Date } };
    };
    expect(call.where.companyId_effectiveFrom.effectiveFrom.getTime()).toBe(0);
  });
});

describe('saving a policy', () => {
  it('inserts a new version and never updates the old one', async () => {
    app = await appAs(SUPER_ADMIN);

    const response = await app.inject({ method: 'PUT', url: '/loans/policy', payload: POLICY_BODY });

    expect(response.statusCode).toBe(200);
    expect(db.loanPolicy.create).toHaveBeenCalledTimes(1);
    const created = db.loanPolicy.create.mock.calls[0]?.[0] as {
      data: { maxSalaryMultiplier: number; createdBy: string };
    };
    expect(created.data.maxSalaryMultiplier).toBe(2);
    expect(created.data.createdBy).toBe('user-1');
  });

  it('changes no loan, no installment and no employee', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({ method: 'PUT', url: '/loans/policy', payload: POLICY_BODY });

    expect(db.employeeLoan.update).not.toHaveBeenCalled();
    expect(db.employeeLoan.create).not.toHaveBeenCalled();
    expect(db.employeeLoanInstallment.createMany).not.toHaveBeenCalled();
    expect(db.employeeLoanInstallment.updateMany).not.toHaveBeenCalled();
  });

  it('records the change in the audit log, with what it was and what it became', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({ method: 'PUT', url: '/loans/policy', payload: POLICY_BODY });

    const audit = db.auditLog.create.mock.calls[0]?.[0] as {
      data: { action: string; before: Record<string, unknown>; after: Record<string, unknown> };
    };
    expect(audit.data.action).toBe('loan.policy.update');
    expect(audit.data.before.maxSalaryMultiplier).toBe(1);
    expect(audit.data.after.maxSalaryMultiplier).toBe(2);
  });

  it('honours an effective date in the future rather than starting now', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({
      method: 'PUT',
      url: '/loans/policy',
      payload: { ...POLICY_BODY, effectiveFrom: '2027-01-01T00:00:00.000Z' },
    });

    const created = db.loanPolicy.create.mock.calls[0]?.[0] as {
      data: { effectiveFrom: Date };
    };
    expect(created.data.effectiveFrom.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('turns a collision on the same instant into a conflict, not a crash', async () => {
    const { Prisma } = await import('@prisma/client');
    db.loanPolicy.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    app = await appAs(SUPER_ADMIN);

    const response = await app.inject({ method: 'PUT', url: '/loans/policy', payload: POLICY_BODY });

    expect(response.statusCode).toBe(409);
  });

  it('rejects values outside their bounds instead of storing them', async () => {
    app = await appAs(SUPER_ADMIN);

    const response = await app.inject({
      method: 'PUT',
      url: '/loans/policy',
      payload: { ...POLICY_BODY, minAttendancePercent: 900, evaluationMonths: 7 },
    });

    expect(response.statusCode).toBe(422);
    expect(db.loanPolicy.create).not.toHaveBeenCalled();
  });
});

describe('which version governs an application', () => {
  it('asks for the newest version at or before the moment in question', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({ method: 'GET', url: '/loans/policy' });

    const call = db.loanPolicy.findFirst.mock.calls[0]?.[0] as {
      where: { companyId: string; effectiveFrom: { lte: Date } };
      orderBy: { effectiveFrom: string };
    };
    // The whole resolution rule, expressed in one query: at-or-before, newest
    // first. A version dated in the future cannot be picked up by it, which is
    // what makes a scheduled change scheduled.
    expect(call.where.effectiveFrom.lte).toBeInstanceOf(Date);
    expect(call.orderBy).toEqual({ effectiveFrom: 'desc' });
    expect(call.where.companyId).toBe('company-1');
  });

  it('offers a scheduled future version separately from the one in force', async () => {
    db.loanPolicy.findFirst.mockImplementation((args: { where: { effectiveFrom: unknown } }) => {
      const clause = args.where.effectiveFrom as { gt?: Date; lte?: Date };
      if (clause?.gt) {
        return Promise.resolve(
          policyRow({ id: 'pol-future', effectiveFrom: new Date('2027-01-01T00:00:00Z') }),
        );
      }
      return Promise.resolve(policyRow());
    });
    app = await appAs(SUPER_ADMIN);

    const response = await app.inject({ method: 'GET', url: '/loans/policy' });

    const { data } = response.json();
    expect(data.policy.id).toBe('pol-1');
    expect(data.scheduled.id).toBe('pol-future');
  });
});

describe('policy history', () => {
  it('reports what moved between one version and the one before it', async () => {
    db.loanPolicy.count.mockResolvedValue(2);
    db.loanPolicy.findMany.mockResolvedValue([
      policyRow({
        id: 'pol-2',
        maxSalaryMultiplier: 2,
        effectiveFrom: new Date('2026-09-01T00:00:00Z'),
        createdAt: new Date('2026-09-01T00:00:00Z'),
        createdBy: 'user-1',
      }),
      policyRow({ id: 'pol-1', maxSalaryMultiplier: 1 }),
    ]);
    db.user.findMany.mockResolvedValue([
      { id: 'user-1', firstName: 'Sara', lastName: 'Iqbal', email: 's@x.com', employee: null },
    ]);
    app = await appAs(SUPER_ADMIN);

    const response = await app.inject({ method: 'GET', url: '/loans/policy/history' });

    expect(response.statusCode).toBe(200);
    const entries = response.json().data as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.changedByName).toBe('Sara Iqbal');
    expect(entries[0]!.changes).toEqual([
      { field: 'maxSalaryMultiplier', label: 'Maximum loan multiple', from: '1', to: '2' },
    ]);
    // The oldest version replaced nothing, so it reports no changes.
    expect(entries[1]!.changes).toEqual([]);
  });
});

describe('the eligibility endpoint', () => {
  it('answers for the caller when no employee is named', async () => {
    app = await appAs(EMPLOYEE, 'OWN');

    const response = await app.inject({ method: 'GET', url: '/loans/eligibility' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.eligible).toBe(true);
    expect(eligibility.evaluateLoanEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'emp-self' }),
    );
  });

  it('will not answer for somebody else when the scope does not reach them', async () => {
    // An OWN scope narrows the lookup to the caller's own row, so the scope
    // check finds nothing for anybody else - which is the 403 below.
    db.employee.findFirst.mockImplementation((args: { where: unknown }) => {
      const json = JSON.stringify(args.where);
      return Promise.resolve(json.includes('emp-someone-else') ? null : { id: 'emp-self' });
    });
    app = await appAs(EMPLOYEE, 'OWN');

    const response = await app.inject({
      method: 'GET',
      url: '/loans/eligibility?employeeId=emp-someone-else',
    });

    expect(response.statusCode).toBe(403);
  });

  it('needs loan.read - the loans module hook does not reach this plugin', async () => {
    app = await appAs([], 'OWN');

    const response = await app.inject({ method: 'GET', url: '/loans/eligibility' });

    expect(response.statusCode).toBe(403);
  });
});

describe('the gate in front of an application', () => {
  it('refuses an employee the rules refuse, and tells them which rules', async () => {
    eligibility.evaluateLoanEligibility.mockResolvedValue(INELIGIBLE);
    app = await appAs(EMPLOYEE, 'OWN');

    const response = await app.inject({
      method: 'POST',
      url: '/loans/apply',
      payload: {
        principalAmount: 50_000,
        installmentCount: 6,
        startMonth: '2026-10',
        purpose: 'Family expenses',
      },
    });

    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.json())).toContain('attendance is 84%');
    // Nothing was written: no loan, no schedule, no approval.
    expect(db.employeeLoan.create).not.toHaveBeenCalled();
    expect(db.employeeLoanInstallment.createMany).not.toHaveBeenCalled();
    expect(db.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('gives an employee no way to override their own refusal', async () => {
    eligibility.evaluateLoanEligibility.mockResolvedValue(INELIGIBLE);
    app = await appAs(EMPLOYEE, 'OWN');

    const response = await app.inject({
      method: 'POST',
      url: '/loans/apply',
      // Everything an employee might try. None of it is read.
      payload: {
        principalAmount: 50_000,
        installmentCount: 6,
        startMonth: '2026-10',
        purpose: 'Family expenses',
        overrideReason: 'please',
        eligible: true,
        maxAllowedAmount: 9_999_999,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(db.employeeLoan.create).not.toHaveBeenCalled();
  });

  it('lets an application through untouched when the rules allow it', async () => {
    app = await appAs(EMPLOYEE, 'OWN');

    const response = await app.inject({
      method: 'POST',
      url: '/loans/apply',
      payload: {
        principalAmount: 50_000,
        installmentCount: 6,
        startMonth: '2026-10',
        purpose: 'Family expenses',
      },
    });

    expect(response.statusCode).toBe(201);
    const created = db.employeeLoan.create.mock.calls[0]?.[0] as {
      data: { employeeId: string; status: string };
    };
    expect(created.data.employeeId).toBe('emp-self');
    expect(created.data.status).toBe('PENDING');
    expect(db.approvalRequest.create).toHaveBeenCalledTimes(1);
  });
});

describe('the HR override', () => {
  const CREATE_BODY = {
    employeeId: 'emp-self',
    principalAmount: 50_000,
    installmentCount: 6,
    startMonth: '2026-10',
  };

  it('refuses an ineligible loan when no override is offered', async () => {
    eligibility.evaluateLoanEligibility.mockResolvedValue(INELIGIBLE);
    app = await appAs(HR_ADMIN);

    const response = await app.inject({ method: 'POST', url: '/loans', payload: CREATE_BODY });

    expect(response.statusCode).toBe(422);
    expect(db.employeeLoan.create).not.toHaveBeenCalled();
  });

  it('is impossible when the policy switches it off', async () => {
    eligibility.evaluateLoanEligibility.mockResolvedValue(INELIGIBLE);
    db.loanPolicy.findFirst.mockResolvedValue(policyRow({ allowHrOverride: false }));
    app = await appAs(HR_ADMIN);

    const response = await app.inject({
      method: 'POST',
      url: '/loans',
      payload: { ...CREATE_BODY, overrideReason: 'Board approved a hardship advance.' },
    });

    expect(response.statusCode).toBe(403);
    expect(db.employeeLoan.create).not.toHaveBeenCalled();
  });

  it('demands a reason when the policy requires one', async () => {
    eligibility.evaluateLoanEligibility.mockResolvedValue(INELIGIBLE);
    app = await appAs(HR_ADMIN);

    const response = await app.inject({
      method: 'POST',
      url: '/loans',
      payload: { ...CREATE_BODY, overrideReason: '' },
    });

    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.json())).toContain('reason');
    expect(db.employeeLoan.create).not.toHaveBeenCalled();
  });

  it('allows the loan with a reason, and puts the exception on the record', async () => {
    eligibility.evaluateLoanEligibility.mockResolvedValue(INELIGIBLE);
    app = await appAs(HR_ADMIN);

    const response = await app.inject({
      method: 'POST',
      url: '/loans',
      payload: { ...CREATE_BODY, overrideReason: 'Board approved a hardship advance.' },
    });

    expect(response.statusCode).toBe(201);

    const override = db.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.action === 'loan.eligibility.override');

    expect(override).toBeDefined();
    expect(override!.actorId).toBe('user-1');
    expect(JSON.stringify(override!.after)).toContain('Board approved a hardship advance.');
    expect(JSON.stringify(override!.after)).toContain('ATTENDANCE_PERCENT');
  });

  it('is out of an employee\'s reach entirely - the route needs loan.manage', async () => {
    eligibility.evaluateLoanEligibility.mockResolvedValue(INELIGIBLE);
    app = await appAs(EMPLOYEE, 'OWN');

    const response = await app.inject({
      method: 'POST',
      url: '/loans',
      payload: { ...CREATE_BODY, overrideReason: 'I would like the money.' },
    });

    // 403 before any of the override logic is reached: an employee cannot
    // grant themselves an exception by finding the endpoint that offers one.
    expect(response.statusCode).toBe(403);
    expect(db.employeeLoan.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('accepts a reasonless override only when the policy stops requiring one', async () => {
    eligibility.evaluateLoanEligibility.mockResolvedValue(INELIGIBLE);
    db.loanPolicy.findFirst.mockResolvedValue(policyRow({ requireOverrideReason: false }));
    app = await appAs(HR_ADMIN);

    const response = await app.inject({
      method: 'POST',
      url: '/loans',
      payload: { ...CREATE_BODY, overrideReason: '' },
    });

    expect(response.statusCode).toBe(201);
  });
});
