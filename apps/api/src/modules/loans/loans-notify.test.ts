import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The employee hears what HR did to their loan or advance from the loans
 * screen. Decisions made on the Approvals screen are told by the approval
 * engine; these routes bypass it, and before this told nobody - an advance
 * could be released and the person it was for would find out from their bank.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findUnique: vi.fn() },
  employeeLoan: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
  employeeLoanInstallment: { updateMany: vi.fn() },
  approvalRequest: { updateMany: vi.fn() },
  approvalStep: { updateMany: vi.fn() },
  approvalEvent: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../../core/db.js', () => ({ prisma: db }));
const notify = vi.hoisted(() => vi.fn());
vi.mock('../../core/notifications/notification.service.js', () => ({ notify }));

const { loanRoutes } = await import('./loans.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const HR: Permission[] = [
  PERMISSIONS.LOAN_READ,
  PERMISSIONS.LOAN_REQUEST,
  PERMISSIONS.LOAN_MANAGE,
  PERMISSIONS.LOAN_APPROVE,
];

const LOAN = {
  id: 'loan-1',
  companyId: 'company-1',
  employeeId: 'emp-bilal',
  kind: 'SALARY_ADVANCE',
  status: 'APPROVED',
  currency: 'PKR',
  principalAmount: 50_000,
  installmentCount: 1,
  monthlyDeduction: 50_000,
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
  employee: { id: 'emp-bilal', firstName: 'Bilal', lastName: 'Ahmed', displayName: null, employeeNumber: 'E-002' },
  installments: [],
};

let app: FastifyInstance | null = null;

async function appAsHr(): Promise<FastifyInstance> {
  const instance = Fastify();
  registerErrorHandler(instance);
  instance.decorateRequest('auth', null);
  instance.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 's',
      userId: 'user-hr',
      companyId: 'company-1',
      email: 'hr@example.com',
      permissions: new Set(HR),
      dataScope: 'ALL',
      mustChangePassword: false,
    };
  });
  await instance.register(loanRoutes, { prefix: '/loans' });
  await instance.ready();
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.employee.findFirst.mockResolvedValue({ id: 'emp-hr', departmentId: 'dep-1' });
  db.employee.findUnique.mockResolvedValue({ userId: 'user-bilal' });
  db.employeeLoan.update.mockResolvedValue({});
  db.auditLog.create.mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('loan notices to the employee', () => {
  it('tells them the advance was released, and when it is recovered', async () => {
    db.employeeLoan.findFirst.mockResolvedValue(LOAN);
    db.employeeLoan.findUniqueOrThrow.mockResolvedValue({ ...LOAN, status: 'ACTIVE' });

    app = await appAsHr();
    const response = await app.inject({ method: 'POST', url: '/loans/loan-1/activate' });

    expect(response.statusCode).toBe(200);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      userId: 'user-bilal',
      title: 'Your salary advance has been released',
      message: 'PKR 50000 - recovered in full from the 2026-11 payslip.',
      entityType: 'EmployeeLoan',
      entityId: 'loan-1',
    });
  });

  it('tells them it was declined, with the reason', async () => {
    db.employeeLoan.findFirst.mockResolvedValue({ ...LOAN, status: 'PENDING' });

    app = await appAsHr();
    const response = await app.inject({
      method: 'POST',
      url: '/loans/loan-1/reject',
      payload: { reason: 'Outside the policy limit this month.' },
    });

    expect(response.statusCode).toBe(200);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      userId: 'user-bilal',
      title: 'Your salary advance request was declined',
      message: 'Outside the policy limit this month.',
    });
  });

  it('skips an employee with no login, and the release still succeeds', async () => {
    db.employeeLoan.findFirst.mockResolvedValue(LOAN);
    db.employeeLoan.findUniqueOrThrow.mockResolvedValue({ ...LOAN, status: 'ACTIVE' });
    db.employee.findUnique.mockResolvedValue({ userId: null });

    app = await appAsHr();
    const response = await app.inject({ method: 'POST', url: '/loans/loan-1/activate' });

    expect(response.statusCode).toBe(200);
    expect(notify).not.toHaveBeenCalled();
  });
});
