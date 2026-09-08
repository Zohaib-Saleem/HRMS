import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Salary management: enabling and disabling a component, and the overview the
 * list screen reads. Both driven through the routes with a mocked database,
 * so what is asserted is the gate and the write, not the UI that hides them.
 */

const db = vi.hoisted(() => ({
  company: { findUniqueOrThrow: vi.fn() },
  employee: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  employeeSalary: { findMany: vi.fn(), count: vi.fn() },
  employeeSalaryComponent: { findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  auditLog: { create: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { payrollSalaryRoutes } = await import('./payroll.routes.js');
const { employeeComponentRoutes } = await import('./payroll-runs.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const SUPER_ADMIN: Permission[] = [PERMISSIONS.PAYROLL_READ, PERMISSIONS.PAYROLL_MANAGE];
const HR_ADMIN: Permission[] = [PERMISSIONS.PAYROLL_READ, PERMISSIONS.PAYROLL_MANAGE];
const READ_ONLY: Permission[] = [PERMISSIONS.PAYROLL_READ];
const MANAGER: Permission[] = [PERMISSIONS.EMPLOYEE_READ];
const EMPLOYEE: Permission[] = [PERMISSIONS.PAYSLIP_READ];

const ASSIGNMENT = {
  id: 'assign-1',
  companyId: 'company-1',
  employeeId: 'employee-1',
  componentId: 'comp-1',
  value: 5000,
  frequency: 'RECURRING',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null as Date | null,
  isActive: true,
  note: null as string | null,
  component: { name: 'House rent' },
};

async function appAs(permissions: Permission[]): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 's', userId: 'user-1', companyId: 'company-1', email: 'x@example.com',
      permissions: new Set(permissions), dataScope: 'ALL', mustChangePassword: false,
    };
  });
  await app.register(payrollSalaryRoutes, { prefix: '/payroll/salaries' });
  await app.register(employeeComponentRoutes, { prefix: '/payroll/employee-components' });
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  db.employee.findFirst.mockResolvedValue({ id: 'employee-1', departmentId: 'd' });
  db.employeeSalaryComponent.findFirst.mockResolvedValue({ ...ASSIGNMENT });
  db.employeeSalaryComponent.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...ASSIGNMENT,
    ...data,
  }));
  db.auditLog.create.mockResolvedValue({});
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('disabling and enabling a component', () => {
  it('lets a payroll admin disable one', async () => {
    app = await appAs(HR_ADMIN);

    const res = await app.inject({
      method: 'PATCH', url: '/payroll/employee-components/assign-1', payload: { isActive: false },
    });

    expect(res.statusCode).toBe(200);
    const written = db.employeeSalaryComponent.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(written.isActive).toBe(false);
  });

  it('records the change as an audit entry with old and new value', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({ method: 'PATCH', url: '/payroll/employee-components/assign-1', payload: { isActive: false } });

    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const entry = db.auditLog.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(entry.action).toBe('payroll.allowance.update');
    expect(entry.actorId).toBe('user-1');
    expect((entry.before as Record<string, unknown>).isActive).toBe(true);
    expect((entry.after as Record<string, unknown>).isActive).toBe(false);
    expect(String(entry.summary)).toMatch(/^Disabled "House rent"/);
  });

  it('writes no audit entry when nothing changed', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({ method: 'PATCH', url: '/payroll/employee-components/assign-1', payload: { isActive: true } });

    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('can change the value and dates in the same call', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({
      method: 'PATCH', url: '/payroll/employee-components/assign-1',
      payload: { value: 7500, effectiveTo: '2026-12-31' },
    });

    const written = db.employeeSalaryComponent.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(written.value).toBe(7500);
    expect(written.effectiveTo).toEqual(new Date('2026-12-31T00:00:00.000Z'));
  });

  it('rejects an end date before the start', async () => {
    app = await appAs(SUPER_ADMIN);

    const res = await app.inject({
      method: 'PATCH', url: '/payroll/employee-components/assign-1', payload: { effectiveTo: '2025-06-01' },
    });

    expect(res.statusCode).toBe(422);
    expect(db.employeeSalaryComponent.update).not.toHaveBeenCalled();
  });

  it('refuses a reader who cannot manage', async () => {
    app = await appAs(READ_ONLY);
    const res = await app.inject({ method: 'PATCH', url: '/payroll/employee-components/assign-1', payload: { isActive: false } });
    expect(res.statusCode).toBe(403);
    expect(db.employeeSalaryComponent.update).not.toHaveBeenCalled();
  });

  it('refuses a manager and an employee', async () => {
    for (const perms of [MANAGER, EMPLOYEE]) {
      app = await appAs(perms);
      const res = await app.inject({ method: 'PATCH', url: '/payroll/employee-components/assign-1', payload: { isActive: false } });
      expect(res.statusCode).toBe(403);
      await app.close();
      app = null;
    }
    expect(db.employeeSalaryComponent.update).not.toHaveBeenCalled();
  });

  it('404s on an assignment belonging to another company', async () => {
    db.employeeSalaryComponent.findFirst.mockResolvedValue(null);
    app = await appAs(SUPER_ADMIN);
    const res = await app.inject({ method: 'PATCH', url: '/payroll/employee-components/other', payload: { isActive: false } });
    expect(res.statusCode).toBe(404);
  });
});

describe('the salary overview', () => {
  const employees = [
    { id: 'employee-1', firstName: 'Muhammad', lastName: 'A', displayName: null, employeeNumber: '1001', department: { name: 'Design' } },
    { id: 'employee-2', firstName: 'Sara', lastName: 'B', displayName: null, employeeNumber: '1002', department: null },
  ];

  beforeEach(() => {
    db.employee.count.mockResolvedValue(2);
    db.employee.findMany.mockResolvedValue(employees);
    db.employeeSalary.findMany.mockResolvedValue([
      { id: 's2', employeeId: 'employee-1', amount: 120000, currency: 'PKR', salaryType: 'MONTHLY',
        effectiveFrom: new Date('2026-09-01T00:00:00Z'), effectiveTo: null },
      { id: 's1', employeeId: 'employee-1', amount: 100000, currency: 'PKR', salaryType: 'MONTHLY',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: new Date('2026-08-31T00:00:00Z') },
    ]);
    db.employeeSalaryComponent.findMany.mockResolvedValue([
      { employeeId: 'employee-1', value: 10000, component: { kind: 'EARNING', calc: 'FIXED' } },
      { employeeId: 'employee-1', value: 10, component: { kind: 'EARNING', calc: 'PERCENT_OF_BASIC' } },
      { employeeId: 'employee-1', value: 5000, component: { kind: 'DEDUCTION', calc: 'FIXED' } },
    ]);
  });

  it('folds salary and components into one row per employee', async () => {
    app = await appAs(READ_ONLY);

    const res = await app.inject({ method: 'GET', url: '/payroll/salaries/overview' });

    expect(res.statusCode).toBe(200);
    const [muhammad, sara] = res.json().data;
    expect(muhammad.currentSalary.amount).toBe(120000);
    expect(muhammad.currentSalary.effectiveFrom).toBe('2026-09-01');
    expect(muhammad.status).toBe('ACTIVE');
    // The 10% allowance is counted, not summed: its money is not known yet.
    expect(muhammad.allowanceCount).toBe(2);
    expect(muhammad.fixedAllowanceTotal).toBe(10000);
    expect(muhammad.deductionCount).toBe(1);
    expect(muhammad.fixedDeductionTotal).toBe(5000);
    expect(muhammad.lastRevisionAt).toBe('2026-09-01');

    expect(sara.currentSalary).toBeNull();
    expect(sara.status).toBe('NONE');
  });

  it('is readable with payroll.read alone', async () => {
    app = await appAs(READ_ONLY);
    expect((await app.inject({ method: 'GET', url: '/payroll/salaries/overview' })).statusCode).toBe(200);
  });

  it('refuses a manager and an employee', async () => {
    for (const perms of [MANAGER, EMPLOYEE]) {
      app = await appAs(perms);
      expect((await app.inject({ method: 'GET', url: '/payroll/salaries/overview' })).statusCode).toBe(403);
      await app.close();
      app = null;
    }
  });
});
