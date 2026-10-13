import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Who payroll tells, and when.
 *
 *   - Publishing payslips tells each employee whose payslip THAT call
 *     released - found by the timestamp it stamped, so publishing a run twice
 *     tells nobody twice - and says nothing about the amount.
 *   - A calculated run with no blocking exceptions tells the accounts that can
 *     approve it, except the person who ran the calculation.
 */

const db = vi.hoisted(() => ({
  payrollRun: { findFirst: vi.fn() },
  payslip: { updateMany: vi.fn(), findMany: vi.fn() },
  user: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));
vi.mock('../../core/db.js', () => ({ prisma: db }));
const notify = vi.hoisted(() => vi.fn());
vi.mock('../../core/notifications/notification.service.js', () => ({ notify }));
const service = vi.hoisted(() => ({ calculateRun: vi.fn() }));
vi.mock('./payroll.service.js', async (load) => ({
  ...(await load<typeof import('./payroll.service.js')>()),
  calculateRun: service.calculateRun,
}));

const { payrollRunRoutes, payslipRoutes } = await import('./payroll-runs.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const ADMIN: Permission[] = [
  PERMISSIONS.PAYROLL_READ,
  PERMISSIONS.PAYROLL_MANAGE,
  PERMISSIONS.PAYROLL_APPROVE,
  PERMISSIONS.PAYSLIP_READ,
];

let app: FastifyInstance | null = null;

async function appAs(permissions: Permission[]): Promise<FastifyInstance> {
  const instance = Fastify();
  registerErrorHandler(instance);
  instance.decorateRequest('auth', null);
  instance.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 's',
      userId: 'user-clerk',
      companyId: 'company-1',
      email: 'x@example.com',
      permissions: new Set(permissions),
      dataScope: 'ALL',
      mustChangePassword: false,
    };
  });
  await instance.register(payrollRunRoutes, { prefix: '/payroll/runs' });
  await instance.register(payslipRoutes, { prefix: '/payslips' });
  await instance.ready();
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.auditLog.create.mockResolvedValue({});
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('publishing payslips', () => {
  it('tells each employee whose payslip this call released, without a figure', async () => {
    db.payrollRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'FINALIZED' });
    db.payslip.updateMany.mockResolvedValue({ count: 2 });
    const period = { line: { run: { period: { name: 'October 2026' } } } };
    db.payslip.findMany.mockResolvedValue([
      { id: 'ps-1', employee: { userId: 'user-hira' }, ...period },
      { id: 'ps-2', employee: { userId: null }, ...period }, // no login: skipped
    ]);

    app = await appAs(ADMIN);
    const res = await app.inject({ method: 'POST', url: '/payslips/publish', payload: { runId: 'run-1' } });

    expect(res.statusCode).toBe(200);
    const stamped = db.payslip.updateMany.mock.calls[0]![0].data.publishedAt as Date;
    expect(db.payslip.findMany.mock.calls[0]![0].where).toEqual({
      companyId: 'company-1',
      publishedAt: stamped,
      line: { runId: 'run-1' },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      userId: 'user-hira',
      title: 'Your payslip is ready',
      message: 'Your payslip for October 2026 has been published.',
      entityType: 'Payslip',
      entityId: 'ps-1',
    });
  });
});

describe('a calculated run', () => {
  const OUTCOME = { lines: 80, exceptions: 0, blocking: 0, grossTotal: 1, netTotal: 1 };

  it('tells the payroll approvers, not the person who calculated it', async () => {
    service.calculateRun.mockResolvedValue(OUTCOME);
    db.payrollRun.findFirst.mockResolvedValue({ employeeCount: 80, period: { name: 'October 2026' } });
    db.user.findMany.mockResolvedValue([{ id: 'user-ceo' }]);

    app = await appAs(ADMIN);
    const res = await app.inject({ method: 'POST', url: '/payroll/runs/run-1/calculate' });

    expect(res.statusCode).toBe(200);
    const where = db.user.findMany.mock.calls[0]![0].where;
    expect(where.id).toEqual({ not: 'user-clerk' });
    expect(JSON.stringify(where)).toContain(PERMISSIONS.PAYROLL_APPROVE);
    expect(notify.mock.calls.map((c) => c[0].userId)).toEqual(['user-ceo']);
    expect(notify.mock.calls[0]![0]).toMatchObject({ entityType: 'PayrollRun', entityId: 'run-1' });
  });

  it('tells nobody while blocking exceptions remain - there is nothing to approve', async () => {
    service.calculateRun.mockResolvedValue({ ...OUTCOME, exceptions: 3, blocking: 2 });
    app = await appAs(ADMIN);
    await app.inject({ method: 'POST', url: '/payroll/runs/run-1/calculate' });
    expect(notify).not.toHaveBeenCalled();
  });
});
