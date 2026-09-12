import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEDICAL_POLICY_DEFAULTS,
  PERMISSIONS,
  defaultCategoryLimits,
  type Permission,
} from '@hrms/shared';

/**
 * The medical policy endpoints.
 *
 * Four things this file is here to hold down:
 *
 *   - Only a holder of `medical.policy.manage` can change the rules, and an
 *     employee cannot even read them. The screen hides what it must, but the
 *     endpoint is the gate and that is what is asserted.
 *   - Saving is an INSERT. A policy row is never updated, because the version
 *     that governed a claim already decided has to survive the change.
 *   - Invalid configuration is refused: negative limits, percentages outside
 *     0-100, and a contribution split that does not add up.
 *   - Changing the policy touches no claim, no dependent and no employee.
 */

const db = vi.hoisted(() => ({
  company: { findUniqueOrThrow: vi.fn() },
  employee: { findFirst: vi.fn(), findFirstOrThrow: vi.fn() },
  medicalPolicy: {
    findFirst: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  medicalDependent: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  medicalClaim: { aggregate: vi.fn(), count: vi.fn() },
  user: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { medicalPolicyRoutes } = await import('./medical-policy.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const SUPER_ADMIN: Permission[] = [
  PERMISSIONS.MEDICAL_READ,
  PERMISSIONS.MEDICAL_MANAGE,
  PERMISSIONS.MEDICAL_POLICY_READ,
  PERMISSIONS.MEDICAL_POLICY_MANAGE,
];
const HR_ADMIN: Permission[] = [
  PERMISSIONS.MEDICAL_READ,
  PERMISSIONS.MEDICAL_MANAGE,
  PERMISSIONS.MEDICAL_POLICY_READ,
];
const MANAGER: Permission[] = [PERMISSIONS.MEDICAL_READ];
const EMPLOYEE: Permission[] = [PERMISSIONS.MEDICAL_READ];

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
  await app.register(medicalPolicyRoutes, { prefix: '/medical/policy' });
  await app.ready();
  return app;
}

const categoryRows = () =>
  defaultCategoryLimits().map((c, index) => ({ id: `cat-${index}`, policyId: 'pol-1', ...c }));

const policyRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'pol-1',
  companyId: 'company-1',
  ...MEDICAL_POLICY_DEFAULTS,
  categories: categoryRows(),
  effectiveFrom: new Date('2020-01-01T00:00:00Z'),
  createdAt: new Date('2020-01-01T00:00:00Z'),
  updatedAt: new Date('2020-01-01T00:00:00Z'),
  createdBy: null,
  ...overrides,
});

/** A complete, valid policy body, as the settings form sends it. */
const POLICY_BODY = {
  ...MEDICAL_POLICY_DEFAULTS,
  categories: defaultCategoryLimits(),
};

beforeEach(() => {
  vi.clearAllMocks();
  db.company.findUniqueOrThrow.mockResolvedValue({ currency: 'PKR' });
  db.medicalPolicy.findFirst.mockResolvedValue(policyRow());
  db.medicalPolicy.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    policyRow({ id: 'pol-2', ...data, categories: categoryRows() }),
  );
  db.medicalPolicy.count.mockResolvedValue(0);
  db.medicalPolicy.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([]);
  db.auditLog.create.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('reading the policy', () => {
  it('lets a Super Admin read it, and says they may change it', async () => {
    const app = await appAs(SUPER_ADMIN);
    const res = await app.inject({ method: 'GET', url: '/medical/policy' });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.canManage).toBe(true);
    expect(body.policy.annualLimitPerEmployee).toBe(100_000);
    // The company's own currency, not a constant.
    expect(body.currency).toBe('PKR');
  });

  it('lets HR Admin read it, and says they may NOT change it', async () => {
    const app = await appAs(HR_ADMIN);
    const res = await app.inject({ method: 'GET', url: '/medical/policy' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.canManage).toBe(false);
  });

  it('reports every category, in the product order', async () => {
    const app = await appAs(SUPER_ADMIN);
    const res = await app.inject({ method: 'GET', url: '/medical/policy' });

    expect(res.json().data.policy.categories.map((c: { category: string }) => c.category)).toEqual([
      'OPD',
      'HOSPITALIZATION',
      'MEDICINES',
      'DIAGNOSTICS',
      'DENTAL',
      'OPTICAL',
      'EMERGENCY',
    ]);
  });

  it('refuses an employee, who holds no medical policy permission at all', async () => {
    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/policy' });

    expect(res.statusCode).toBe(403);
  });

  it('refuses a manager', async () => {
    const app = await appAs(MANAGER, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/policy' });

    expect(res.statusCode).toBe(403);
  });
});

describe('changing the policy', () => {
  it('lets a Super Admin save a new version', async () => {
    const app = await appAs(SUPER_ADMIN);
    const res = await app.inject({
      method: 'PUT',
      url: '/medical/policy',
      payload: { ...POLICY_BODY, annualLimitPerEmployee: 250_000 },
    });

    expect(res.statusCode).toBe(200);
    expect(db.medicalPolicy.create).toHaveBeenCalledTimes(1);
    expect(db.medicalPolicy.create.mock.calls[0]![0].data.annualLimitPerEmployee).toBe(250_000);
  });

  it('INSERTS rather than updating, so the previous version survives', async () => {
    const app = await appAs(SUPER_ADMIN);
    await app.inject({
      method: 'PUT',
      url: '/medical/policy',
      payload: { ...POLICY_BODY, minEmploymentMonths: 6 },
    });

    expect(db.medicalPolicy.create).toHaveBeenCalled();
    expect(db.medicalPolicy.update).not.toHaveBeenCalled();
  });

  it('writes the category rows with the version', async () => {
    const app = await appAs(SUPER_ADMIN);
    const categories = defaultCategoryLimits().map((c) =>
      c.category === 'DENTAL' ? { ...c, enabled: false } : c,
    );

    await app.inject({
      method: 'PUT',
      url: '/medical/policy',
      payload: { ...POLICY_BODY, categories },
    });

    const written = db.medicalPolicy.create.mock.calls[0]![0].data.categories.create;
    expect(written).toHaveLength(7);
    expect(written.find((c: { category: string }) => c.category === 'DENTAL').enabled).toBe(false);
  });

  it('records who changed it, and what it was before', async () => {
    const app = await appAs(SUPER_ADMIN);
    await app.inject({
      method: 'PUT',
      url: '/medical/policy',
      payload: { ...POLICY_BODY, annualLimitPerEmployee: 150_000 },
    });

    const audit = db.auditLog.create.mock.calls[0]![0].data;
    expect(audit.action).toBe('medical.policy.update');
    expect(audit.actorId).toBe('user-1');
    expect(audit.before.annualLimitPerEmployee).toBe(100_000);
    expect(audit.after.annualLimitPerEmployee).toBe(150_000);
  });

  it('refuses HR Admin, who may read the rules but not move them', async () => {
    const app = await appAs(HR_ADMIN);
    const res = await app.inject({ method: 'PUT', url: '/medical/policy', payload: POLICY_BODY });

    expect(res.statusCode).toBe(403);
    expect(db.medicalPolicy.create).not.toHaveBeenCalled();
  });

  it('lets an HR Admin who HAS been granted the permission save', async () => {
    const app = await appAs([...HR_ADMIN, PERMISSIONS.MEDICAL_POLICY_MANAGE]);
    const res = await app.inject({ method: 'PUT', url: '/medical/policy', payload: POLICY_BODY });

    expect(res.statusCode).toBe(200);
  });

  it('refuses an employee', async () => {
    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'PUT', url: '/medical/policy', payload: POLICY_BODY });

    expect(res.statusCode).toBe(403);
    expect(db.medicalPolicy.create).not.toHaveBeenCalled();
  });

  it('refuses a manager', async () => {
    const app = await appAs(MANAGER, 'OWN');
    const res = await app.inject({ method: 'PUT', url: '/medical/policy', payload: POLICY_BODY });

    expect(res.statusCode).toBe(403);
    expect(db.medicalPolicy.create).not.toHaveBeenCalled();
  });

  it('touches no claim, dependent or employee row', async () => {
    const app = await appAs(SUPER_ADMIN);
    await app.inject({
      method: 'PUT',
      url: '/medical/policy',
      payload: { ...POLICY_BODY, enabled: false },
    });

    expect(db.medicalClaim.aggregate).not.toHaveBeenCalled();
    expect(db.medicalDependent.update).not.toHaveBeenCalled();
    expect(db.medicalDependent.delete).not.toHaveBeenCalled();
    expect(db.employee.findFirst).not.toHaveBeenCalled();
  });
});

describe('what the policy will not accept', () => {
  const rejects = async (payload: Record<string, unknown>) => {
    const app = await appAs(SUPER_ADMIN);
    const res = await app.inject({ method: 'PUT', url: '/medical/policy', payload });
    expect(res.statusCode).toBe(422);
    expect(db.medicalPolicy.create).not.toHaveBeenCalled();
    return res.json().error.details as Record<string, string[]>;
  };

  it('rejects a negative annual limit', async () => {
    await rejects({ ...POLICY_BODY, annualLimitPerEmployee: -1 });
  });

  it('rejects a negative minimum employment period', async () => {
    await rejects({ ...POLICY_BODY, minEmploymentMonths: -1 });
  });

  it('rejects a negative maximum number of children', async () => {
    await rejects({ ...POLICY_BODY, maxChildren: -1 });
  });

  it('rejects negative backdated days', async () => {
    await rejects({ ...POLICY_BODY, maxBackdatedDays: -1 });
  });

  it('rejects a contribution percentage above 100', async () => {
    const categories = defaultCategoryLimits().map((c) =>
      c.category === 'OPD' ? { ...c, companyContributionPercent: 120, employeeContributionPercent: -20 } : c,
    );
    await rejects({ ...POLICY_BODY, categories });
  });

  it('rejects a contribution split that does not total 100', async () => {
    const categories = defaultCategoryLimits().map((c) =>
      c.category === 'OPD' ? { ...c, companyContributionPercent: 60, employeeContributionPercent: 20 } : c,
    );
    const details = await rejects({ ...POLICY_BODY, categories });
    expect(JSON.stringify(details)).toContain('100%');
  });

  it('accepts an 80/20 split, which is the point of having two fields', async () => {
    const app = await appAs(SUPER_ADMIN);
    const categories = defaultCategoryLimits().map((c) =>
      c.category === 'DENTAL'
        ? { ...c, companyContributionPercent: 80, employeeContributionPercent: 20 }
        : c,
    );
    const res = await app.inject({
      method: 'PUT',
      url: '/medical/policy',
      payload: { ...POLICY_BODY, categories },
    });

    expect(res.statusCode).toBe(200);
  });

  it('rejects a negative category limit', async () => {
    const categories = defaultCategoryLimits().map((c) =>
      c.category === 'OPD' ? { ...c, annualLimit: -5 } : c,
    );
    await rejects({ ...POLICY_BODY, categories });
  });

  it('rejects an empty policy name', async () => {
    await rejects({ ...POLICY_BODY, policyName: '   ' });
  });

  it('rejects a partial category list', async () => {
    await rejects({ ...POLICY_BODY, categories: defaultCategoryLimits().slice(0, 3) });
  });

  it('rejects carry-forward switched on with nothing to carry', async () => {
    await rejects({ ...POLICY_BODY, allowCarryForward: true, maxCarryForwardAmount: 0 });
  });

  it('rejects an invalid effective date', async () => {
    await rejects({ ...POLICY_BODY, effectiveFrom: 'the first of never' });
  });

  it('reads a BLANK effective date as "now" rather than as invalid', async () => {
    // The settings screen offers a date field that is blank until somebody
    // fills it in, and a browser sends an untouched date input as ''. Refusing
    // that would refuse every save that did not schedule a change.
    const app = await appAs(SUPER_ADMIN);
    const res = await app.inject({
      method: 'PUT',
      url: '/medical/policy',
      payload: { ...POLICY_BODY, effectiveFrom: '' },
    });

    expect(res.statusCode).toBe(200);
    const written = db.medicalPolicy.create.mock.calls[0]![0].data.effectiveFrom as Date;
    expect(written.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('accepts a future effective date, so a change can be announced', async () => {
    const app = await appAs(SUPER_ADMIN);
    const res = await app.inject({
      method: 'PUT',
      url: '/medical/policy',
      payload: { ...POLICY_BODY, effectiveFrom: '2027-01-01T00:00:00.000Z' },
    });

    expect(res.statusCode).toBe(200);
    expect(
      (db.medicalPolicy.create.mock.calls[0]![0].data.effectiveFrom as Date).toISOString(),
    ).toBe('2027-01-01T00:00:00.000Z');
  });

  it('accepts a blank category cap as "no cap"', async () => {
    const app = await appAs(SUPER_ADMIN);
    const categories = defaultCategoryLimits().map((c) =>
      c.category === 'OPD' ? { ...c, annualLimit: '' as unknown as null } : c,
    );
    const res = await app.inject({
      method: 'PUT',
      url: '/medical/policy',
      payload: { ...POLICY_BODY, categories },
    });

    expect(res.statusCode).toBe(200);
    const written = db.medicalPolicy.create.mock.calls[0]![0].data.categories.create;
    expect(written.find((c: { category: string }) => c.category === 'OPD').annualLimit).toBeNull();
  });
});

describe('the change history', () => {
  it('derives what moved between neighbouring versions', async () => {
    db.medicalPolicy.count.mockResolvedValue(2);
    db.medicalPolicy.findMany.mockResolvedValue([
      policyRow({
        id: 'pol-2',
        annualLimitPerEmployee: 200_000,
        effectiveFrom: new Date('2026-06-01T00:00:00Z'),
        createdBy: 'user-9',
      }),
      policyRow({ id: 'pol-1', annualLimitPerEmployee: 100_000 }),
    ]);
    db.user.findMany.mockResolvedValue([
      { id: 'user-9', firstName: 'Ayesha', lastName: 'Khan', email: 'a@x.com', employee: null },
    ]);

    const app = await appAs(SUPER_ADMIN);
    const res = await app.inject({ method: 'GET', url: '/medical/policy/history' });

    expect(res.statusCode).toBe(200);
    const entries = res.json().data;
    expect(entries[0].changedByName).toBe('Ayesha Khan');
    expect(entries[0].changes).toContainEqual({
      field: 'annualLimitPerEmployee',
      label: 'Annual medical limit per employee',
      from: '100000',
      to: '200000',
    });
  });

  it('reports a category change with the category named', async () => {
    const withDentalOff = categoryRows().map((c) =>
      c.category === 'DENTAL' ? { ...c, enabled: false } : c,
    );
    db.medicalPolicy.count.mockResolvedValue(2);
    db.medicalPolicy.findMany.mockResolvedValue([
      policyRow({
        id: 'pol-2',
        categories: withDentalOff,
        effectiveFrom: new Date('2026-06-01T00:00:00Z'),
      }),
      policyRow({ id: 'pol-1' }),
    ]);

    const app = await appAs(SUPER_ADMIN);
    const res = await app.inject({ method: 'GET', url: '/medical/policy/history' });

    expect(res.json().data[0].changes).toContainEqual({
      field: 'categories.DENTAL.enabled',
      label: 'Dental - Enabled',
      from: 'Yes',
      to: 'No',
    });
  });

  it('reports the first version as having changed nothing', async () => {
    db.medicalPolicy.count.mockResolvedValue(1);
    db.medicalPolicy.findMany.mockResolvedValue([policyRow()]);

    const app = await appAs(SUPER_ADMIN);
    const res = await app.inject({ method: 'GET', url: '/medical/policy/history' });

    expect(res.json().data[0].changes).toEqual([]);
  });

  it('refuses an employee', async () => {
    const app = await appAs(EMPLOYEE, 'OWN');
    const res = await app.inject({ method: 'GET', url: '/medical/policy/history' });

    expect(res.statusCode).toBe(403);
  });
});
