import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEDICAL_POLICY_DEFAULTS, PERMISSIONS, defaultCategoryLimits, type Permission } from '@hrms/shared';

/**
 * The employee side of the medical module.
 *
 * What this file is here to hold down, in one sentence: an employee sees their
 * own medical record and nobody else's, and neither a wide data scope nor a
 * hand-typed `?employeeId=` changes that.
 *
 * The access rule is deliberately stricter than the rest of the product. Every
 * other module answers "which employees may I see?" from the data scope alone,
 * which is right for attendance and wrong for dependents - a manager's
 * reporting line is not a reason to read somebody's family. So reaching another
 * employee's medical record needs `medical.manage` AS WELL AS the scope, and
 * the manager case below is the one that proves it.
 */

const db = vi.hoisted(() => ({
  company: { findUniqueOrThrow: vi.fn() },
  employee: { findFirst: vi.fn(), findFirstOrThrow: vi.fn() },
  medicalPolicy: { findFirst: vi.fn(), upsert: vi.fn(), create: vi.fn() },
  medicalDependent: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  medicalClaim: { findMany: vi.fn(), aggregate: vi.fn(), count: vi.fn() },
  user: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { medicalRoutes } = await import('./medical.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const HR_ADMIN: Permission[] = [PERMISSIONS.MEDICAL_READ, PERMISSIONS.MEDICAL_MANAGE];
const MANAGER: Permission[] = [PERMISSIONS.MEDICAL_READ];
const EMPLOYEE: Permission[] = [PERMISSIONS.MEDICAL_READ];

/** Who is signed in, and which employee record their login belongs to. */
let callerEmployeeId: string | null = 'emp-self';

async function appAs(
  permissions: Permission[],
  dataScope: 'ALL' | 'OWN' | 'REPORTS_AND_OWN' = 'ALL',
): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-1',
      companyId: 'company-1',
      email: 'someone@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(medicalRoutes, { prefix: '/medical' });
  await app.ready();
  return app;
}

const policy = (overrides: Record<string, unknown> = {}) => ({
  id: 'pol-1',
  companyId: 'company-1',
  ...MEDICAL_POLICY_DEFAULTS,
  categories: defaultCategoryLimits().map((c, i) => ({ id: `cat-${i}`, policyId: 'pol-1', ...c })),
  effectiveFrom: new Date('2020-01-01T00:00:00Z'),
  createdAt: new Date('2020-01-01T00:00:00Z'),
  updatedAt: new Date('2020-01-01T00:00:00Z'),
  createdBy: null,
  ...overrides,
});

/** A claim row, as the balance arithmetic reads one. */
const claimRow = (overrides: Record<string, unknown> = {}) => ({
  status: 'PAID',
  companyAmount: 0,
  requestedAmount: 0,
  treatmentDate: new Date('2026-03-01T00:00:00Z'),
  submittedAt: new Date('2026-03-02T00:00:00Z'),
  category: 'OPD',
  policy: { id: 'pol-1' },
  ...overrides,
});

const dependent = (overrides: Record<string, unknown> = {}) => ({
  id: 'dep-1',
  companyId: 'company-1',
  employeeId: 'emp-self',
  name: 'A Dependent',
  relationship: 'CHILD',
  dateOfBirth: new Date('2018-05-04T00:00:00Z'),
  gender: null,
  status: 'ACTIVE',
  createdBy: null,
  updatedBy: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

/**
 * Employee lookups, answered the way the database would.
 *
 * Faithful rather than convenient: the scope check in `auth/scope.ts` is real
 * code here, not a stub, so a test that says a manager cannot reach a colleague
 * is testing the actual filter rather than a mock that agrees with the author.
 */
function employeeLookups() {
  db.employee.findFirst.mockImplementation(async ({ where }: { where: Record<string, any> }) => {
    // The caller's own record, resolved from the session.
    if (where.userId) {
      return callerEmployeeId
        ? { id: callerEmployeeId, departmentId: 'dept-1' }
        : null;
    }
    // The eligibility engine, asking about one employee by id.
    if (where.id && where.companyId && !where.AND) {
      return {
        id: where.id,
        status: 'ACTIVE',
        hireDate: new Date('2024-01-15T00:00:00Z'),
        confirmationDate: new Date('2024-04-15T00:00:00Z'),
        confirmationStatus: 'Permanent',
        contracts: [],
      };
    }
    // assertEmployeeInScope: [{ id, companyId }, scopeFilter]
    if (Array.isArray(where.AND)) {
      const [identity, filter] = where.AND as [Record<string, any>, Record<string, any>];
      if (identity.companyId !== 'company-1') return null;
      // ALL scope sends an empty filter.
      if (Object.keys(filter).length === 0) return { id: identity.id };
      if (filter.id) return filter.id === identity.id ? { id: identity.id } : null;
      // REPORTS / REPORTS_AND_OWN send an OR list. Nobody in these tests
      // reports to anybody, so only the caller's own record matches.
      if (Array.isArray(filter.OR)) {
        const ownId = filter.OR.find((clause: Record<string, any>) => clause.id)?.id;
        return ownId === identity.id ? { id: identity.id } : null;
      }
      return null;
    }
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  callerEmployeeId = 'emp-self';
  employeeLookups();
  db.employee.findFirstOrThrow.mockResolvedValue({
    firstName: 'Sana',
    lastName: 'Iqbal',
    displayName: null,
  });
  db.company.findUniqueOrThrow.mockResolvedValue({ currency: 'PKR' });
  db.medicalPolicy.findFirst.mockResolvedValue(policy());
  db.medicalDependent.findMany.mockResolvedValue([]);
  db.medicalClaim.findMany.mockResolvedValue([]);
  db.medicalClaim.count.mockResolvedValue(0);
  db.auditLog.create.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the benefit summary', () => {
  it('shows an employee their own limit, with nothing used', async () => {
    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit' });

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.annualLimit).toBe(100_000);
    expect(data.used).toBe(0);
    expect(data.remaining).toBe(100_000);
    expect(data.currency).toBe('PKR');
    expect(data.eligibility.eligible).toBe(true);
  });

  it('counts settled claims as used and undecided ones as pending', async () => {
    db.medicalClaim.findMany.mockResolvedValue([
      claimRow({ status: 'PAID', companyAmount: 25_000 }),
      claimRow({ status: 'PENDING', requestedAmount: 10_000 }),
    ]);

    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit' });

    const data = res.json().data;
    // Spent: only what has actually been agreed.
    expect(data.used).toBe(25_000);
    expect(data.remaining).toBe(75_000);
    // Reserved: what a claim nobody has decided could still cost.
    expect(data.pending).toBe(10_000);
    expect(data.available).toBe(65_000);
  });

  it('leaves a rejected or cancelled claim out of both figures', async () => {
    db.medicalClaim.findMany.mockResolvedValue([
      claimRow({ status: 'REJECTED', companyAmount: 0, requestedAmount: 40_000 }),
      claimRow({ status: 'CANCELLED', companyAmount: 0, requestedAmount: 40_000 }),
    ]);

    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit' });

    const data = res.json().data;
    expect(data.used).toBe(0);
    expect(data.pending).toBe(0);
    expect(data.remaining).toBe(100_000);
  });

  it('never reports a negative remaining balance', async () => {
    db.medicalClaim.findMany.mockResolvedValue([
      claimRow({ status: 'PAID', companyAmount: 140_000 }),
    ]);

    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit' });

    expect(res.json().data.remaining).toBe(0);
  });

  it('reads the limit from the policy, not from a constant', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ annualLimitPerEmployee: 300_000 }));

    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit' });

    expect(res.json().data.annualLimit).toBe(300_000);
  });

  it('reports per-category consumption alongside the headline figures', async () => {
    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit' });

    const usage = res.json().data.categoryUsage;
    expect(usage).toHaveLength(7);
    expect(usage[0]).toMatchObject({ category: 'OPD', used: 0, pending: 0, available: null });
  });

  it('says whether this caller may submit a claim against it', async () => {
    const app = await appAs([...EMPLOYEE, PERMISSIONS.MEDICAL_CLAIM_REQUEST], 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit' });

    expect(res.json().data.canSubmitClaim).toBe(true);
  });

  it('refuses a caller with no medical permission at all', async () => {
    const app = await appAs([], 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit' });

    expect(res.statusCode).toBe(403);
  });

  it('tells a login with no employee record why there is nothing to show', async () => {
    callerEmployeeId = null;

    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit' });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('not linked to an employee record');
  });
});

describe('one employee cannot reach another employee', () => {
  it('refuses an employee naming a colleague', async () => {
    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit?employeeId=emp-other' });

    expect(res.statusCode).toBe(403);
    expect(db.medicalClaim.aggregate).not.toHaveBeenCalled();
  });

  it('refuses an employee even when their data scope is wide', async () => {
    // The belt-and-braces case: a scope misconfiguration alone must not open
    // medical data, because medical.manage is a separate, missing key.
    const app = await appAs(EMPLOYEE, 'ALL');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit?employeeId=emp-other' });

    expect(res.statusCode).toBe(403);
  });

  it('refuses a MANAGER naming one of their own reports', async () => {
    const app = await appAs(MANAGER, 'REPORTS_AND_OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit?employeeId=emp-report' });

    expect(res.statusCode).toBe(403);
  });

  it('still lets that manager see their own', async () => {
    const app = await appAs(MANAGER, 'REPORTS_AND_OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.employeeId).toBe('emp-self');
  });

  it('lets HR, who holds medical.manage and a full scope, see a colleague', async () => {
    const app = await appAs(HR_ADMIN, 'ALL');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit?employeeId=emp-other' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.employeeId).toBe('emp-other');
  });

  it('refuses HR when the employee is outside their data scope', async () => {
    const app = await appAs(HR_ADMIN, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/benefit?employeeId=emp-other' });

    expect(res.statusCode).toBe(403);
  });

  it('refuses without confirming whether the employee exists', async () => {
    const app = await appAs(EMPLOYEE, 'OWN');
    const real = await app.inject({ method: 'GET', url: '/medical/benefit?employeeId=emp-other' });
    const fictional = await app.inject({ method: 'GET', url: '/medical/benefit?employeeId=nope' });

    expect(real.json().error.message).toBe(fictional.json().error.message);
  });
});

describe('dependent coverage, derived from the policy in force', () => {
  const children = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      dependent({
        id: `dep-${i + 1}`,
        name: `Child ${i + 1}`,
        createdAt: new Date(Date.UTC(2026, 0, i + 1)),
      }),
    );

  it('covers children up to the policy maximum, in registration order', async () => {
    db.medicalDependent.findMany.mockResolvedValue(children(3));
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ maxChildren: 2 }));

    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/dependents' });

    const rows = res.json().data;
    expect(rows.map((d: { covered: boolean }) => d.covered)).toEqual([true, true, false]);
    expect(rows[2].coverageNote).toContain('2 children');
  });

  it('covers the third child the moment the maximum is raised', async () => {
    db.medicalDependent.findMany.mockResolvedValue(children(3));
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ maxChildren: 3 }));

    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/dependents' });

    expect(res.json().data.every((d: { covered: boolean }) => d.covered)).toBe(true);
  });

  it('covers nobody of a relationship the policy excludes', async () => {
    db.medicalDependent.findMany.mockResolvedValue([
      dependent({ id: 'dep-p', relationship: 'PARENT', name: 'A Parent' }),
    ]);

    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/dependents' });

    const row = res.json().data[0];
    expect(row.covered).toBe(false);
    expect(row.coverageNote).toContain('does not cover a parent');
  });

  it('covers a parent once the policy says so', async () => {
    db.medicalDependent.findMany.mockResolvedValue([
      dependent({ id: 'dep-p', relationship: 'PARENT', name: 'A Parent' }),
    ]);
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ parentsCovered: true, maxParents: 1 }));

    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/dependents' });

    expect(res.json().data[0].covered).toBe(true);
  });

  it('never covers an inactive dependent, nor lets one consume a slot', async () => {
    db.medicalDependent.findMany.mockResolvedValue([
      dependent({ id: 'dep-1', status: 'INACTIVE', createdAt: new Date(Date.UTC(2026, 0, 1)) }),
      dependent({ id: 'dep-2', createdAt: new Date(Date.UTC(2026, 0, 2)) }),
    ]);
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ maxChildren: 1 }));

    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/dependents' });

    const rows = res.json().data;
    expect(rows[0].covered).toBe(false);
    expect(rows[1].covered).toBe(true);
  });

  it('covers nobody while the benefit is switched off', async () => {
    db.medicalDependent.findMany.mockResolvedValue(children(1));
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ enabled: false }));

    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/dependents' });

    expect(res.json().data[0].covered).toBe(false);
  });
});

describe('maintaining dependents', () => {
  const body = { name: 'Zara', relationship: 'CHILD', dateOfBirth: '2019-03-02' };

  it('lets HR add one', async () => {
    db.medicalDependent.create.mockResolvedValue(dependent({ id: 'dep-new', name: 'Zara' }));
    db.medicalDependent.findMany.mockResolvedValue([dependent({ id: 'dep-new', name: 'Zara' })]);

    const app = await appAs(HR_ADMIN, 'ALL');
    const res = await app.inject({ method: 'POST', url: '/medical/dependents', payload: body });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.name).toBe('Zara');
  });

  it('records one over the policy maximum rather than refusing it', async () => {
    // The record is the family's real shape. Coverage is a separate question,
    // and the answer to it moves when the policy moves.
    const existing = [
      dependent({ id: 'd1', createdAt: new Date(Date.UTC(2026, 0, 1)) }),
      dependent({ id: 'd2', createdAt: new Date(Date.UTC(2026, 0, 2)) }),
    ];
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ maxChildren: 2 }));
    db.medicalDependent.create.mockResolvedValue(
      dependent({ id: 'd3', createdAt: new Date(Date.UTC(2026, 0, 3)) }),
    );
    db.medicalDependent.findMany.mockResolvedValue([
      ...existing,
      dependent({ id: 'd3', createdAt: new Date(Date.UTC(2026, 0, 3)) }),
    ]);

    const app = await appAs(HR_ADMIN, 'ALL');
    const res = await app.inject({ method: 'POST', url: '/medical/dependents', payload: body });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.covered).toBe(false);
  });

  it('refuses an employee adding one to their own record', async () => {
    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'POST', url: '/medical/dependents', payload: body });

    expect(res.statusCode).toBe(403);
    expect(db.medicalDependent.create).not.toHaveBeenCalled();
  });

  it('refuses an employee adding one to somebody else', async () => {
    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({
      method: 'POST',
      url: '/medical/dependents',
      payload: { ...body, employeeId: 'emp-other' },
    });

    expect(res.statusCode).toBe(403);
    expect(db.medicalDependent.create).not.toHaveBeenCalled();
  });

  it('refuses a nameless dependent', async () => {
    const app = await appAs(HR_ADMIN, 'ALL');
    const res = await app.inject({
      method: 'POST',
      url: '/medical/dependents',
      payload: { ...body, name: '  ' },
    });

    expect(res.statusCode).toBe(422);
  });

  it('refuses a relationship the policy cannot express', async () => {
    const app = await appAs(HR_ADMIN, 'ALL');
    const res = await app.inject({
      method: 'POST',
      url: '/medical/dependents',
      payload: { ...body, relationship: 'COUSIN' },
    });

    expect(res.statusCode).toBe(422);
  });

  it('refuses an employee editing somebody else’s dependent', async () => {
    db.medicalDependent.findFirst.mockResolvedValue(dependent({ employeeId: 'emp-other' }));

    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({
      method: 'PATCH',
      url: '/medical/dependents/dep-1',
      payload: { name: 'Renamed' },
    });

    expect(res.statusCode).toBe(403);
    expect(db.medicalDependent.update).not.toHaveBeenCalled();
  });

  it('deletes a dependent with no claim history', async () => {
    db.medicalDependent.findFirst.mockResolvedValue(dependent());
    db.medicalClaim.count.mockResolvedValue(0);

    const app = await appAs(HR_ADMIN, 'ALL');
    const res = await app.inject({ method: 'DELETE', url: '/medical/dependents/dep-1' });

    expect(res.statusCode).toBe(204);
    expect(db.medicalDependent.delete).toHaveBeenCalled();
  });

  it('deactivates rather than deletes one a claim refers to', async () => {
    db.medicalDependent.findFirst.mockResolvedValue(dependent());
    db.medicalClaim.count.mockResolvedValue(2);

    const app = await appAs(HR_ADMIN, 'ALL');
    const res = await app.inject({ method: 'DELETE', url: '/medical/dependents/dep-1' });

    expect(res.statusCode).toBe(204);
    expect(db.medicalDependent.delete).not.toHaveBeenCalled();
    expect(db.medicalDependent.update.mock.calls[0]![0].data.status).toBe('INACTIVE');
  });

  it('leaves an audit trail that does not name the dependent', async () => {
    db.medicalDependent.create.mockResolvedValue(dependent({ id: 'dep-new' }));
    db.medicalDependent.findMany.mockResolvedValue([dependent({ id: 'dep-new' })]);

    const app = await appAs(HR_ADMIN, 'ALL');
    await app.inject({ method: 'POST', url: '/medical/dependents', payload: body });

    const audit = db.auditLog.create.mock.calls[0]![0].data;
    expect(audit.action).toBe('medical.dependent.create');
    expect(audit.summary).not.toContain('Zara');
  });
});
