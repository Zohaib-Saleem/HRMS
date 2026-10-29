import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Who may correct a loan's history, and what they have to say when they do.
 *
 * The ledger arithmetic is tested against a store in loan-ledger.service.test;
 * here the service is stubbed and the routes are driven the way a session
 * would, so what is asserted is the boundary: both loan and payroll authority
 * for anything that rewrites what was repaid, a reason for every correction,
 * and an audit row with the before and after.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findUnique: vi.fn() },
  employeeLoan: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
  employeeLoanInstallment: { findFirst: vi.fn() },
  company: { findUniqueOrThrow: vi.fn() },
  user: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
  payrollPeriod: { findMany: vi.fn() },
  payrollSettings: { findUnique: vi.fn(async () => null) },
  $transaction: vi.fn(),
}));
vi.mock('../../core/db.js', () => ({ prisma: db }));

const ledger = vi.hoisted(() => ({
  canCorrectLoans: (p: ReadonlySet<string>) => p.has('loan.manage') && p.has('payroll.manage'),
  advanceAwaitingDecision: vi.fn(),
  carryForwardPastClosedMonths: vi.fn(),
  recordManualPayment: vi.fn(),
  rescheduleLoan: vi.fn(),
  reverseManualPayment: vi.fn(),
  settleHistoricalInstallments: vi.fn(),
  waiveInstallment: vi.fn(),
}));
vi.mock('./loan-ledger.service.js', () => ledger);
const notify = vi.hoisted(() => vi.fn());
vi.mock('../../core/notifications/notification.service.js', () => ({ notify }));

const { loanRoutes } = await import('./loans.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const HR_LOANS_ONLY: Permission[] = [PERMISSIONS.LOAN_READ, PERMISSIONS.LOAN_MANAGE];
const PAYROLL_ADMIN: Permission[] = [
  PERMISSIONS.LOAN_READ,
  PERMISSIONS.LOAN_MANAGE,
  PERMISSIONS.PAYROLL_MANAGE,
];
const EMPLOYEE: Permission[] = [PERMISSIONS.LOAN_READ, PERMISSIONS.LOAN_REQUEST];

const LOAN = {
  id: 'loan-1',
  companyId: 'company-1',
  employeeId: 'emp-1051',
  kind: 'LOAN',
  status: 'ACTIVE',
  currency: 'PKR',
  principalAmount: 70000,
  installmentCount: 6,
  monthlyDeduction: 11666.66,
  startMonth: new Date('2026-04-01T00:00:00Z'),
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
  createdAt: new Date('2026-10-06T00:00:00Z'),
  employee: { id: 'emp-1051', firstName: 'Sana', lastName: 'Iqbal', displayName: null, employeeNumber: '1051' },
  installments: [
    {
      id: 'inst-1',
      sequence: 1,
      dueMonth: new Date('2026-04-01T00:00:00Z'),
      amount: 11666.66,
      status: 'SCHEDULED',
      payrollRunId: null,
      paidAt: null,
      note: null,
    },
  ],
  transactions: [],
};

let app: FastifyInstance | null = null;

async function appAs(permissions: Permission[], dataScope: 'ALL' | 'OWN' = 'ALL') {
  const instance = Fastify();
  registerErrorHandler(instance);
  instance.decorateRequest('auth', null);
  instance.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 's',
      userId: 'user-accounts',
      companyId: 'company-1',
      email: 'accounts@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await instance.register(loanRoutes, { prefix: '/loans' });
  await instance.ready();
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The scope check finds the borrower; the caller has no employee record of
  // their own, so nothing here is their own loan.
  db.employee.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
    Promise.resolve('AND' in args.where ? { id: 'emp-1051' } : null),
  );
  db.employee.findUnique.mockResolvedValue({ userId: 'user-sana' });
  db.employeeLoan.findFirst.mockResolvedValue(LOAN);
  db.employeeLoan.findUniqueOrThrow.mockResolvedValue(LOAN);
  db.employeeLoanInstallment.findFirst.mockResolvedValue({
    sequence: 1,
    amount: 11666.66,
    status: 'PENDING_PAYROLL',
    dueMonth: new Date('2026-04-01T00:00:00Z'),
    payrollRunId: 'run-sep',
  });
  db.company.findUniqueOrThrow.mockResolvedValue({ timezone: 'Asia/Karachi' });
  db.payrollPeriod.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([]);
  db.auditLog.create.mockResolvedValue({});
  ledger.recordManualPayment.mockResolvedValue({
    installmentId: 'inst-1',
    loanCompleted: false,
    releasedFromRunId: 'run-sep',
  });
  ledger.waiveInstallment.mockResolvedValue({
    installmentId: 'inst-1',
    sequence: 1,
    amount: 11666.66,
    employeeId: 'emp-1051',
    loanCompleted: false,
  });
  ledger.rescheduleLoan.mockResolvedValue({ moves: [{ sequence: 1, from: '2026-04', to: '2026-09' }] });
});

afterEach(async () => {
  await app?.close();
  app = null;
});

const PAYMENT = { paidOn: '2026-04-30', reference: 'Voucher 17', reason: 'Deducted in the old payroll system' };

describe('recording a repayment made outside payroll', () => {
  it('needs payroll authority as well as loan authority', async () => {
    app = await appAs(HR_LOANS_ONLY);
    const response = await app.inject({
      method: 'POST',
      url: '/loans/loan-1/installments/inst-1/record-payment',
      payload: PAYMENT,
    });
    expect(response.statusCode).toBe(403);
    expect(ledger.recordManualPayment).not.toHaveBeenCalled();
  });

  it('is refused to an employee outright', async () => {
    app = await appAs(EMPLOYEE, 'OWN');
    const response = await app.inject({
      method: 'POST',
      url: '/loans/loan-1/installments/inst-1/record-payment',
      payload: PAYMENT,
    });
    expect(response.statusCode).toBe(403);
  });

  it('requires a reason', async () => {
    app = await appAs(PAYROLL_ADMIN);
    const response = await app.inject({
      method: 'POST',
      url: '/loans/loan-1/installments/inst-1/record-payment',
      payload: { paidOn: '2026-04-30' },
    });
    expect(response.statusCode).toBe(422);
    expect(ledger.recordManualPayment).not.toHaveBeenCalled();
  });

  it('records it, audits the before and after, and says which run must be recalculated', async () => {
    app = await appAs(PAYROLL_ADMIN);
    const response = await app.inject({
      method: 'POST',
      url: '/loans/loan-1/installments/inst-1/record-payment',
      payload: PAYMENT,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.runNeedsRecalculation).toBe('run-sep');
    expect(ledger.recordManualPayment).toHaveBeenCalledWith(
      expect.objectContaining({ installmentId: 'inst-1', paidOn: '2026-04-30', reason: PAYMENT.reason }),
    );
    const audit = db.auditLog.create.mock.calls[0]![0] as {
      data: { action: string; before: Record<string, unknown>; after: Record<string, unknown> };
    };
    expect(audit.data.action).toBe('loan.installment.record_payment');
    expect(audit.data.before).toMatchObject({ status: 'PENDING_PAYROLL', payrollRunId: 'run-sep' });
    expect(audit.data.after).toMatchObject({ status: 'PAID', reason: PAYMENT.reason, releasedFromRunId: 'run-sep' });
  });
});

describe('waiving', () => {
  it('requires a reason now - it is a financial decision, not a button', async () => {
    app = await appAs(HR_LOANS_ONLY);
    const response = await app.inject({
      method: 'POST',
      url: '/loans/loan-1/installments/inst-1/waive',
      payload: {},
    });
    expect(response.statusCode).toBe(422);
    expect(ledger.waiveInstallment).not.toHaveBeenCalled();
  });

  it('waives with the reason on the audit trail', async () => {
    app = await appAs(HR_LOANS_ONLY);
    const response = await app.inject({
      method: 'POST',
      url: '/loans/loan-1/installments/inst-1/waive',
      payload: { reason: 'Hardship relief, approved by the CEO' },
    });
    expect(response.statusCode).toBe(200);
    const audit = db.auditLog.create.mock.calls[0]![0] as { data: { action: string; after: { reason: string } } };
    expect(audit.data.action).toBe('loan.installment.waive');
    expect(audit.data.after.reason).toBe('Hardship relief, approved by the CEO');
  });
});

describe('changing the deduction month', () => {
  it('needs both authorities and a reason, and tells the employee the new month', async () => {
    app = await appAs(HR_LOANS_ONLY);
    const refused = await app.inject({
      method: 'POST',
      url: '/loans/loan-1/reschedule',
      payload: { startMonth: '2026-09', reason: 'Entered with the wrong start month' },
    });
    expect(refused.statusCode).toBe(403);
    await app.close();

    app = await appAs(PAYROLL_ADMIN);
    const noReason = await app.inject({
      method: 'POST',
      url: '/loans/loan-1/reschedule',
      payload: { startMonth: '2026-09' },
    });
    expect(noReason.statusCode).toBe(422);

    const response = await app.inject({
      method: 'POST',
      url: '/loans/loan-1/reschedule',
      payload: { startMonth: '2026-09', reason: 'Entered with the wrong start month' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.moved).toBe(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-sana', title: 'Your loan deduction month changed' }),
    );
    // The adjustment is on the record: who, the reason, the original and the
    // revised month. The ledger row carries the same, with its timestamp.
    const audit = db.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((a) => a.action === 'loan.reschedule') as
      | { actorId: string; before: unknown; after: unknown }
      | undefined;
    const moves = [{ from: '2026-04', to: '2026-09' }];
    expect(audit).toMatchObject({
      actorId: 'user-accounts',
      before: { months: [{ dueMonth: moves[0]!.from }] },
      after: { months: [{ dueMonth: moves[0]!.to }], reason: 'Entered with the wrong start month' },
    });
    expect(notify.mock.calls.at(-1)![0].message).toContain(`instead of ${moves[0]!.from}`);
  });
});

describe('what the detail tells the screen', () => {
  it('offers payment actions only to a caller who may correct, and never labels an action as a status', async () => {
    app = await appAs(HR_LOANS_ONLY);
    const hr = await app.inject({ method: 'GET', url: '/loans/loan-1' });
    const [row] = hr.json().data.installments;
    expect(row.actions).toEqual(['WAIVE']);
    expect(row.displayStatus).toBe('OVERDUE');
    expect(hr.json().data.statusLabel).toBe('Disbursed');
    await app.close();

    app = await appAs(PAYROLL_ADMIN);
    const admin = await app.inject({ method: 'GET', url: '/loans/loan-1' });
    expect(admin.json().data.installments[0].actions).toEqual(['RECORD_PAYMENT', 'WAIVE']);
    expect(admin.json().data.canCorrect).toBe(true);
  });
});
