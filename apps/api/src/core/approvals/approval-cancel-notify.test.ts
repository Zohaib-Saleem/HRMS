import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Who is told when a request is withdrawn.
 *
 * Before, nobody: a cancelled leave request left "Approval needed" in each
 * approver's bell pointing at something that no longer wanted a decision, and
 * an employee whose request HR cancelled found out by looking. Now the
 * approvers it was still waiting on hear it was withdrawn, the requester hears
 * when somebody else cancelled it, and the person who cancelled hears nothing.
 */

const db = vi.hoisted(() => ({
  approvalRequest: { findFirst: vi.fn(), update: vi.fn() },
  approvalStepApprover: { findMany: vi.fn(), updateMany: vi.fn() },
  approvalEvent: { create: vi.fn() },
  employee: { findFirst: vi.fn(), findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../db.js', () => ({ prisma: db }));
vi.mock('../audit.js', () => ({ recordAudit: vi.fn() }));
const notify = vi.hoisted(() => vi.fn());
vi.mock('../notifications/notification.service.js', () => ({ notify }));
vi.mock('../../modules/time/attendance.service.js', () => ({
  applyRegularization: vi.fn(),
  applyShiftChange: vi.fn(),
}));
vi.mock('../../modules/loans/loans.routes.js', () => ({ applyLoanDecision: vi.fn() }));
vi.mock('../../modules/leave/leave-reconciliation.service.js', () => ({ reconcileLeaveRequest: vi.fn() }));

const { cancel } = await import('./approval.service.js');

const APPROVAL = {
  id: 'appr-1',
  companyId: 'company-1',
  title: 'Casual Leave: 2026-10-20 to 2026-10-20 (1 day)',
  status: 'PENDING',
  requesterEmployeeId: 'emp-hira',
};

function authAs(userId: string, permissions: Permission[] = []) {
  return {
    sessionId: 's',
    userId,
    companyId: 'company-1',
    email: 'x@example.com',
    permissions: new Set(permissions),
    dataScope: 'ALL' as const,
    mustChangePassword: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.approvalRequest.findFirst.mockResolvedValue(APPROVAL);
  db.approvalStepApprover.findMany.mockResolvedValue([
    { employee: { userId: 'u-manager' } },
    { employee: { userId: 'u-hr' } },
    { employee: { userId: 'u-manager' } }, // the same person in two seats
    { employee: { userId: null } }, // an approver with no login
  ]);
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  db.approvalRequest.update.mockResolvedValue({ ...APPROVAL, status: 'CANCELLED', steps: [] });
  db.employee.findUnique.mockResolvedValue({ userId: 'u-hira' });
});

const recipients = () => notify.mock.calls.map((call) => call[0].userId);

describe('a request withdrawn by the person who raised it', () => {
  it('tells each approver it was waiting on, once, and not the requester', async () => {
    db.employee.findFirst.mockResolvedValue({ id: 'emp-hira' });

    await cancel(authAs('u-hira'), 'appr-1', null);

    expect(recipients()).toEqual(['u-manager', 'u-hr']);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      type: 'APPROVAL_CANCELLED',
      title: 'Request withdrawn',
      entityType: 'ApprovalRequest',
      entityId: 'appr-1',
    });
  });

  it('reads the waiting seats before closing them', async () => {
    db.employee.findFirst.mockResolvedValue({ id: 'emp-hira' });
    await cancel(authAs('u-hira'), 'appr-1', null);
    expect(db.approvalStepApprover.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      db.approvalStepApprover.updateMany.mock.invocationCallOrder[0]!,
    );
  });
});

describe('a request cancelled by an administrator', () => {
  it('tells the requester, with the reason, and the other approvers - never the administrator', async () => {
    db.employee.findFirst.mockResolvedValue({ id: 'emp-hr' });

    await cancel(authAs('u-hr', [PERMISSIONS.APPROVAL_MANAGE]), 'appr-1', 'Office closed that day');

    expect(recipients()).toEqual(['u-manager', 'u-hira']);
    expect(notify.mock.calls.at(-1)![0]).toMatchObject({
      userId: 'u-hira',
      title: 'Request cancelled',
      message: `${APPROVAL.title} - Office closed that day`,
    });
  });
});
