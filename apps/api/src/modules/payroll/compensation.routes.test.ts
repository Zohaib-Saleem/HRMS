import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Compensation: who may read a salary, who may set one, and what the effective
 * dating actually guarantees.
 *
 * Salary is the most sensitive figure in the system and the People screen now
 * shows it, so the gate is asserted against the endpoints rather than against
 * the tab that hides them. A manager can open any of their reports' profiles;
 * none of them may read what that person is paid.
 */

const db = vi.hoisted(() => ({
  company: { findUniqueOrThrow: vi.fn() },
  employee: { findFirst: vi.fn() },
  employeeSalary: { findMany: vi.fn(), count: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
  employeeSalaryComponent: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  salaryComponent: { findFirst: vi.fn() },
  auditLog: { create: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { payrollSalaryRoutes } = await import('./payroll.routes.js');
const { employeeComponentRoutes } = await import('./payroll-runs.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const SUPER_ADMIN: Permission[] = [PERMISSIONS.PAYROLL_READ, PERMISSIONS.PAYROLL_MANAGE];
/** HR Admin is the "authorised payroll admin": it holds both, like Super Admin. */
const HR_ADMIN: Permission[] = [PERMISSIONS.PAYROLL_READ, PERMISSIONS.PAYROLL_MANAGE];
/** A manager may read their reports, and may not read what they are paid. */
const MANAGER: Permission[] = [PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.ATTENDANCE_READ];
/** An employee sees their own payslips, not the salary record behind them. */
const EMPLOYEE: Permission[] = [PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.PAYSLIP_READ];
/** Read but not write: proves the two permissions are actually distinct. */
const READ_ONLY: Permission[] = [PERMISSIONS.PAYROLL_READ];

const SALARY = {
  employeeId: 'employee-1',
  salaryType: 'MONTHLY' as const,
  amount: 120000,
  currency: 'PKR',
  effectiveFrom: '2026-07-01',
};

async function appAs(permissions: Permission[]): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-1',
      companyId: 'company-1',
      email: 'caller@example.com',
      permissions: new Set(permissions),
      dataScope: 'ALL',
      mustChangePassword: false,
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
  db.company.findUniqueOrThrow.mockResolvedValue({ currency: 'PKR' });
  // Scope resolution: the caller's own employee row, and the target lookup.
  db.employee.findFirst.mockResolvedValue({ id: 'employee-1', departmentId: 'dept-1' });
  db.employeeSalary.findMany.mockResolvedValue([]);
  db.employeeSalary.count.mockResolvedValue(0);
  db.employeeSalary.create.mockResolvedValue({ id: 'salary-new' });
  db.employeeSalaryComponent.findMany.mockResolvedValue([]);
  db.employeeSalaryComponent.count.mockResolvedValue(0);
  db.auditLog.create.mockResolvedValue({});
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('reading a salary', () => {
  it('lets Super Admin read', async () => {
    app = await appAs(SUPER_ADMIN);
    const res = await app.inject({ method: 'GET', url: '/payroll/salaries?employeeId=employee-1' });
    expect(res.statusCode).toBe(200);
  });

  it('lets the authorised payroll admin read', async () => {
    app = await appAs(HR_ADMIN);
    expect((await app.inject({ method: 'GET', url: '/payroll/salaries' })).statusCode).toBe(200);
  });

  it('refuses a manager', async () => {
    app = await appAs(MANAGER);
    const res = await app.inject({ method: 'GET', url: '/payroll/salaries?employeeId=employee-1' });
    expect(res.statusCode).toBe(403);
  });

  it('refuses an employee, even for their own record', async () => {
    // Their own compensation reaches them as a payslip, which is a separate
    // permission and a separate endpoint. payroll.read is company-wide.
    app = await appAs(EMPLOYEE);
    const res = await app.inject({ method: 'GET', url: '/payroll/salaries?employeeId=employee-1' });
    expect(res.statusCode).toBe(403);
  });
});

describe('setting a salary', () => {
  it('lets Super Admin create one', async () => {
    app = await appAs(SUPER_ADMIN);

    const res = await app.inject({ method: 'POST', url: '/payroll/salaries', payload: SALARY });

    expect(res.statusCode).toBe(201);
    expect(db.employeeSalary.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a reader who cannot manage', async () => {
    app = await appAs(READ_ONLY);

    const res = await app.inject({ method: 'POST', url: '/payroll/salaries', payload: SALARY });

    expect(res.statusCode).toBe(403);
    expect(db.employeeSalary.create).not.toHaveBeenCalled();
  });

  it('refuses a manager', async () => {
    app = await appAs(MANAGER);
    const res = await app.inject({ method: 'POST', url: '/payroll/salaries', payload: SALARY });
    expect(res.statusCode).toBe(403);
    expect(db.employeeSalary.create).not.toHaveBeenCalled();
  });

  it('refuses an employee setting their own salary', async () => {
    app = await appAs(EMPLOYEE);
    const res = await app.inject({
      method: 'POST',
      url: '/payroll/salaries',
      payload: { ...SALARY, amount: 999999 },
    });
    expect(res.statusCode).toBe(403);
    expect(db.employeeSalary.create).not.toHaveBeenCalled();
  });

  it('defaults the currency from the company when none is given', async () => {
    app = await appAs(SUPER_ADMIN);

    const { currency: _omitted, ...withoutCurrency } = SALARY;
    await app.inject({ method: 'POST', url: '/payroll/salaries', payload: withoutCurrency });

    const written = db.employeeSalary.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(written.currency).toBe('PKR');
  });

  it('rejects a negative salary', async () => {
    app = await appAs(SUPER_ADMIN);

    const res = await app.inject({
      method: 'POST',
      url: '/payroll/salaries',
      payload: { ...SALARY, amount: -1 },
    });

    expect(res.statusCode).toBe(422);
    expect(db.employeeSalary.create).not.toHaveBeenCalled();
  });

  it('rejects an end date before the start', async () => {
    app = await appAs(SUPER_ADMIN);

    const res = await app.inject({
      method: 'POST',
      url: '/payroll/salaries',
      payload: { ...SALARY, effectiveTo: '2026-06-01' },
    });

    expect(res.statusCode).toBe(422);
    expect(db.employeeSalary.create).not.toHaveBeenCalled();
  });
});

describe('effective dating protects payroll history', () => {
  /** The existing salary: 100,000 from January, still open. */
  const january = {
    id: 'salary-jan',
    salaryType: 'MONTHLY' as const,
    amount: 100000,
    currency: 'PKR',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null as Date | null,
  };

  it('refuses a raise that would overlap the open record', async () => {
    // The July raise cannot simply be added while January is still open: two
    // salaries claiming July is not something a run should have to guess at.
    db.employeeSalary.findMany.mockResolvedValue([january]);
    app = await appAs(SUPER_ADMIN);

    const res = await app.inject({
      method: 'POST',
      url: '/payroll/salaries',
      payload: { ...SALARY, amount: 120000, effectiveFrom: '2026-07-01' },
    });

    expect(res.statusCode).toBe(422);
    expect(db.employeeSalary.create).not.toHaveBeenCalled();
  });

  it('accepts the raise once the previous record has been closed off', async () => {
    db.employeeSalary.findMany.mockResolvedValue([
      { ...january, effectiveTo: new Date('2026-06-30T00:00:00Z') },
    ]);
    app = await appAs(SUPER_ADMIN);

    const res = await app.inject({
      method: 'POST',
      url: '/payroll/salaries',
      payload: { ...SALARY, amount: 120000, effectiveFrom: '2026-07-01' },
    });

    expect(res.statusCode).toBe(201);
  });

  it('never rewrites the earlier record', async () => {
    db.employeeSalary.findMany.mockResolvedValue([
      { ...january, effectiveTo: new Date('2026-06-30T00:00:00Z') },
    ]);
    app = await appAs(SUPER_ADMIN);

    await app.inject({
      method: 'POST',
      url: '/payroll/salaries',
      payload: { ...SALARY, amount: 120000, effectiveFrom: '2026-07-01' },
    });

    // June still reads 100,000 because nothing updated it. A raise is a new
    // row, never an edit to the row payroll already paid from.
    expect(db.employeeSalary.create).toHaveBeenCalledTimes(1);
    const written = db.employeeSalary.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(written.amount).toBe(120000);
    expect(written.effectiveFrom).toEqual(new Date('2026-07-01T00:00:00.000Z'));
  });
});

describe('allowances and deductions', () => {
  it('refuses a manager reading them', async () => {
    app = await appAs(MANAGER);
    const res = await app.inject({
      method: 'GET',
      url: '/payroll/employee-components?employeeId=employee-1',
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets an authorised payroll admin read them', async () => {
    app = await appAs(HR_ADMIN);
    const res = await app.inject({
      method: 'GET',
      url: '/payroll/employee-components?employeeId=employee-1',
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a reader who cannot manage from adding one', async () => {
    app = await appAs(READ_ONLY);

    const res = await app.inject({
      method: 'POST',
      url: '/payroll/employee-components',
      payload: {
        employeeId: 'employee-1',
        componentId: 'component-1',
        value: 5000,
        effectiveFrom: '2026-07-01',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(db.employeeSalaryComponent.create).not.toHaveBeenCalled();
  });
});

describe('audit', () => {
  it('records who set the salary, for whom, and from when', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({ method: 'POST', url: '/payroll/salaries', payload: SALARY });

    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const entry = db.auditLog.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(entry.action).toBe('payroll.salary.create');
    expect(entry.actorId).toBe('user-1');
    expect(entry.entityType).toBe('EmployeeSalary');
    const after = entry.after as Record<string, unknown>;
    expect(after.employeeId).toBe('employee-1');
    expect(after.amount).toBe(120000);
    expect(after.effectiveFrom).toBe('2026-07-01');
  });

  it('records nothing when the request was refused', async () => {
    app = await appAs(MANAGER);

    await app.inject({ method: 'POST', url: '/payroll/salaries', payload: SALARY });

    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});
