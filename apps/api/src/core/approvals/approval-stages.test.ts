import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * A stage with several approvers, and what one decision does to it.
 *
 * This is the file that pins section 5 of the brief: a team with three
 * managers needs ONE of them to sign, and once one has, the other two are
 * looking at a finished stage rather than a second button. Everything here is
 * asserted on the WRITES the engine made, because "the screen hides the
 * button" is not the claim - the claim is that the server would refuse.
 */

const db = vi.hoisted(() => ({
  approvalRequest: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
  approvalStep: { update: vi.fn(), findFirst: vi.fn() },
  approvalStepApprover: { update: vi.fn(), updateMany: vi.fn() },
  approvalEvent: { create: vi.fn() },
  employee: { findFirst: vi.fn() },
  auditLog: { create: vi.fn() },
  notification: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: db }));
vi.mock('../../modules/time/attendance.service.js', () => ({
  applyRegularization: vi.fn(),
  applyShiftChange: vi.fn(),
}));
vi.mock('../../modules/loans/loans.routes.js', () => ({ applyLoanDecision: vi.fn() }));

const { decide } = await import('./approval.service.js');

const COMPANY = 'company-1';

const MANAGER_A = { employeeId: 'mgr-a', userId: 'user-a' };
const MANAGER_B = { employeeId: 'mgr-b', userId: 'user-b' };
const MANAGER_C = { employeeId: 'mgr-c', userId: 'user-c' };

function auth(userId: string, permissions: Permission[] = [PERMISSIONS.APPROVAL_ACT]) {
  return {
    sessionId: 'session-1',
    userId,
    companyId: COMPANY,
    email: 'someone@example.com',
    permissions: new Set(permissions),
    dataScope: 'OWN' as const,
    mustChangePassword: false,
  };
}

/** A seat, as `approval_step_approvers` holds one. */
const seat = (employeeId: string, status = 'PENDING') => ({
  id: `seat-${employeeId}`,
  employeeId,
  status,
  decidedByUserId: (status === 'PENDING' ? null : `user-${employeeId.slice(4)}`) as string | null,
});

/**
 * A live request: one rung filled by three team managers, then an HR rung.
 * Two steps, so "does this finish the request" and "does this finish the
 * stage" can be told apart.
 */
function pendingRequest(mode: 'ANY_ONE' | 'ALL', seats = [seat('mgr-a'), seat('mgr-b'), seat('mgr-c')]) {
  const step = (
    stepOrder: number,
    stage: string,
    stepMode: string,
    approvers: ReturnType<typeof seat>[],
  ) => ({
    id: `step-${stepOrder}`,
    stepOrder,
    stage,
    mode: stepMode,
    status: 'PENDING',
    decidedByUserId: null as string | null,
    approvers,
  });

  return {
    id: 'appr-1',
    companyId: COMPANY,
    status: 'PENDING',
    currentStep: 1,
    title: 'Annual Leave: 12-14 October',
    requesterEmployeeId: 'emp-ayesha',
    subjectType: 'LEAVE_REQUEST',
    subjectId: 'leave-1',
    steps: [
      step(1, 'TEAM_MANAGER', mode, seats),
      step(2, 'HR_MANAGER', 'ANY_ONE', [seat('emp-hr')]),
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.approvalRequest.update.mockResolvedValue({ id: 'appr-1', status: 'PENDING', currentStep: 2, subjectType: 'LEAVE_REQUEST', subjectId: 'leave-1', steps: [] });
  db.approvalRequest.findUnique.mockResolvedValue(null);
  db.approvalStep.findFirst.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
  db.approvalEvent.create.mockResolvedValue({});
  db.approvalStepApprover.update.mockResolvedValue({});
  db.approvalStepApprover.updateMany.mockResolvedValue({ count: 0 });
  db.approvalStep.update.mockResolvedValue({});
  db.approvalRequest.count.mockResolvedValue(1);
});

/** Who the caller is, and the visibility check the engine runs afterwards. */
function callerIs(employeeId: string) {
  db.employee.findFirst.mockResolvedValue({ id: employeeId, departmentId: null, teamId: null });
}

describe('ANY_ONE: one of three managers signs for the team', () => {
  beforeEach(() => {
    db.approvalRequest.findFirst.mockResolvedValue(pendingRequest('ANY_ONE'));
    callerIs(MANAGER_A.employeeId);
  });

  it('completes the stage on the first approval', async () => {
    await decide({ auth: auth(MANAGER_A.userId), approvalId: 'appr-1', decision: 'APPROVED' });

    expect(db.approvalStep.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'step-1' },
        data: expect.objectContaining({ status: 'APPROVED', decidedByUserId: MANAGER_A.userId }),
      }),
    );
  });

  /**
   * The other two seats are CLOSED, not left pending.
   *
   * Left open they would sit in two inboxes for ever and `pending-count` - a
   * query over exactly these rows - would keep counting a stage that is
   * finished. CANCELLED rather than APPROVED because neither of them approved
   * anything; their seat simply stopped being needed.
   */
  it('closes the seats nobody used, so the stage leaves their inbox', async () => {
    await decide({ auth: auth(MANAGER_A.userId), approvalId: 'appr-1', decision: 'APPROVED' });

    expect(db.approvalStepApprover.updateMany).toHaveBeenCalledWith({
      where: { approvalStepId: 'step-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'CANCELLED' }),
    });
  });

  it('moves the request on to the next rung rather than finishing it', async () => {
    await decide({ auth: auth(MANAGER_A.userId), approvalId: 'appr-1', decision: 'APPROVED' });

    expect(db.approvalRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING', currentStep: 2 }),
      }),
    );
  });

  /**
   * And the second manager arriving a minute later is refused BY THE SERVER.
   *
   * The screen shows them a completed stage, but the screen is not the gate.
   * Here the step is already APPROVED, and the engine will not reopen it.
   */
  it('refuses a second manager once the stage is done', async () => {
    const decided = pendingRequest('ANY_ONE');
    decided.steps[0]!.status = 'APPROVED';
    db.approvalRequest.findFirst.mockResolvedValue(decided);
    callerIs(MANAGER_B.employeeId);

    await expect(
      decide({ auth: auth(MANAGER_B.userId), approvalId: 'appr-1', decision: 'APPROVED' }),
    ).rejects.toThrow(/already been decided/i);

    expect(db.approvalStep.update).not.toHaveBeenCalled();
  });

  it('refuses somebody who is not on the stage at all', async () => {
    callerIs('emp-stranger');

    await expect(
      decide({ auth: auth('user-stranger'), approvalId: 'appr-1', decision: 'APPROVED' }),
    ).rejects.toThrow(/only an approver named on this stage/i);
  });
});

describe('ALL: every manager has to sign', () => {
  beforeEach(() => {
    db.approvalRequest.findFirst.mockResolvedValue(pendingRequest('ALL'));
    callerIs(MANAGER_A.employeeId);
  });

  it('closes the caller’s own seat and leaves the stage open', async () => {
    await decide({ auth: auth(MANAGER_A.userId), approvalId: 'appr-1', decision: 'APPROVED' });

    expect(db.approvalStepApprover.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'seat-mgr-a' },
        data: expect.objectContaining({ status: 'APPROVED' }),
      }),
    );
    expect(db.approvalStep.update).not.toHaveBeenCalled();
  });

  it('keeps the request on the same rung until the last seat closes', async () => {
    await decide({ auth: auth(MANAGER_A.userId), approvalId: 'appr-1', decision: 'APPROVED' });

    expect(db.approvalRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currentStep: 1 }) }),
    );
  });

  it('completes the stage when the last outstanding approver signs', async () => {
    db.approvalRequest.findFirst.mockResolvedValue(
      pendingRequest('ALL', [seat('mgr-a', 'APPROVED'), seat('mgr-b', 'APPROVED'), seat('mgr-c')]),
    );
    callerIs(MANAGER_C.employeeId);

    await decide({ auth: auth(MANAGER_C.userId), approvalId: 'appr-1', decision: 'APPROVED' });

    expect(db.approvalStep.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'APPROVED' }) }),
    );
    expect(db.approvalRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currentStep: 2 }) }),
    );
  });

  /** Nobody satisfies a two-person rung on their own. */
  it('refuses an approver who has already signed this stage', async () => {
    db.approvalRequest.findFirst.mockResolvedValue(
      pendingRequest('ALL', [seat('mgr-a', 'APPROVED'), seat('mgr-b')]),
    );
    callerIs(MANAGER_A.employeeId);

    await expect(
      decide({ auth: auth(MANAGER_A.userId), approvalId: 'appr-1', decision: 'APPROVED' }),
    ).rejects.toThrow(/already decided this stage/i);
  });
});

describe('a rejection is a decision about the request', () => {
  it('ends the whole request from the first rung, in ANY_ONE mode', async () => {
    db.approvalRequest.findFirst.mockResolvedValue(pendingRequest('ANY_ONE'));
    callerIs(MANAGER_A.employeeId);

    await decide({ auth: auth(MANAGER_A.userId), approvalId: 'appr-1', decision: 'REJECTED' });

    expect(db.approvalRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED' }) }),
    );
  });

  /** One rejection, not a vote: the other two are never asked. */
  it('ends it in ALL mode too, without waiting for the other approvers', async () => {
    db.approvalRequest.findFirst.mockResolvedValue(pendingRequest('ALL'));
    callerIs(MANAGER_A.employeeId);

    await decide({ auth: auth(MANAGER_A.userId), approvalId: 'appr-1', decision: 'REJECTED' });

    expect(db.approvalRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED' }) }),
    );
    expect(db.approvalStepApprover.updateMany).toHaveBeenCalled();
  });
});

describe('separation of duties survives the stages', () => {
  /**
   * The escape hatch that must not become a bypass.
   *
   * `approval.manage` lets an administrator stand in for an approver who has
   * left. It must not let one person carry a request through every rung of a
   * chain that exists so several people sign it.
   */
  it('refuses an administrator who already decided an earlier rung', async () => {
    const request = pendingRequest('ANY_ONE');
    request.currentStep = 2;
    request.steps[0]!.status = 'APPROVED';
    request.steps[0]!.decidedByUserId = 'user-admin';
    request.steps[0]!.approvers = [{ ...seat('mgr-a', 'APPROVED'), decidedByUserId: 'user-admin' }];
    db.approvalRequest.findFirst.mockResolvedValue(request);
    callerIs('emp-admin');

    await expect(
      decide({
        auth: auth('user-admin', [PERMISSIONS.APPROVAL_ACT, PERMISSIONS.APPROVAL_MANAGE]),
        approvalId: 'appr-1',
        decision: 'APPROVED',
      }),
    ).rejects.toThrow(/already decided an earlier stage/i);
  });

  it('never lets the requester decide their own request', async () => {
    db.approvalRequest.findFirst.mockResolvedValue(pendingRequest('ANY_ONE'));
    callerIs('emp-ayesha');

    await expect(
      decide({ auth: auth('user-ayesha'), approvalId: 'appr-1', decision: 'APPROVED' }),
    ).rejects.toThrow(/cannot decide your own request/i);
  });
});
