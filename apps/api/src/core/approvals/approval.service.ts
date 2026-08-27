import type { FastifyRequest } from 'fastify';
import type { ApprovalStatus, ApprovalSubjectType, Prisma } from '@prisma/client';
import { PERMISSIONS } from '@hrms/shared';
import { prisma } from '../db.js';
import { recordAudit } from '../audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { notify } from '../notifications/notification.service.js';
import type { AuthContext } from '../../auth/session.js';
import { employeeScopeFilter } from '../../auth/scope.js';

/**
 * Approval engine.
 *
 * Generic on purpose: it stores (subjectType, subjectId) and never imports a
 * domain module. Attendance regularisation, shift changes and timesheets all
 * drive this same state machine rather than growing their own.
 *
 * State machine:
 *   PENDING -> APPROVED   all steps approved
 *   PENDING -> REJECTED   any step rejected
 *   PENDING -> CANCELLED  requester withdraws
 *   APPROVED/REJECTED/CANCELLED are terminal - no transition leaves them.
 */

export interface CreateApprovalInput {
  companyId: string;
  subjectType: ApprovalSubjectType;
  subjectId: string;
  requesterEmployeeId: string;
  requesterUserId?: string | null;
  title: string;
  summary?: string | null;
  /** Ordered chain. Step 1 decides first. */
  approverEmployeeIds: readonly string[];
  request?: FastifyRequest;
}

const TERMINAL: readonly ApprovalStatus[] = ['APPROVED', 'REJECTED', 'CANCELLED'];

export function isTerminal(status: ApprovalStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * Default approver chain: the requester's primary manager, then their
 * secondary manager if there is one. Falls back to the department head so a
 * request never becomes unactionable just because a manager is unset.
 */
export async function resolveDefaultApprovers(
  companyId: string,
  employeeId: string,
): Promise<string[]> {
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, companyId },
    select: {
      managerId: true,
      secondaryManagerId: true,
      department: { select: { headEmployeeId: true } },
    },
  });
  if (!employee) return [];

  const chain: string[] = [];
  const add = (id: string | null | undefined) => {
    // Never route a request to its own author, and never duplicate a step.
    if (id && id !== employeeId && !chain.includes(id)) chain.push(id);
  };

  add(employee.managerId);
  add(employee.secondaryManagerId);
  if (chain.length === 0) add(employee.department?.headEmployeeId);

  return chain;
}

export async function createApprovalRequest(input: CreateApprovalInput) {
  if (input.approverEmployeeIds.length === 0) {
    throw new ValidationError({
      _: [
        'No approver could be determined for this request. Assign a reporting manager or a department head first.',
      ],
    });
  }

  if (input.approverEmployeeIds.includes(input.requesterEmployeeId)) {
    throw new ValidationError({ _: ['A request cannot be approved by the person who raised it.'] });
  }

  const approval = await prisma.approvalRequest.create({
    data: {
      companyId: input.companyId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      requesterEmployeeId: input.requesterEmployeeId,
      requesterUserId: input.requesterUserId ?? null,
      title: input.title,
      summary: input.summary ?? null,
      status: 'PENDING',
      currentStep: 1,
      steps: {
        create: input.approverEmployeeIds.map((approverEmployeeId, index) => ({
          stepOrder: index + 1,
          approverEmployeeId,
          status: 'PENDING' as ApprovalStatus,
        })),
      },
      events: {
        create: {
          actorUserId: input.requesterUserId ?? null,
          action: 'approval.submitted',
          toStatus: 'PENDING' as ApprovalStatus,
        },
      },
    },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });

  await recordAudit({
    companyId: input.companyId,
    actorId: input.requesterUserId ?? null,
    action: 'approval.submit',
    entityType: 'ApprovalRequest',
    entityId: approval.id,
    summary: `Submitted for approval: ${input.title}`,
    after: { subjectType: input.subjectType, subjectId: input.subjectId, steps: approval.steps.length },
    request: input.request,
  });

  await notifyApprover(approval.id, 1, input.request);

  return approval;
}

/** Tells whoever owns the given step that something is waiting for them. */
async function notifyApprover(
  approvalRequestId: string,
  stepOrder: number,
  request?: FastifyRequest,
): Promise<void> {
  const step = await prisma.approvalStep.findFirst({
    where: { approvalRequestId, stepOrder },
    include: {
      approverEmployee: { select: { id: true, userId: true, workEmail: true, user: { select: { email: true } } } },
      approvalRequest: { select: { id: true, companyId: true, title: true, summary: true } },
    },
  });

  const approver = step?.approverEmployee;
  if (!step || !approver?.userId) return;

  await notify({
    companyId: step.approvalRequest.companyId,
    userId: approver.userId,
    type: 'APPROVAL_REQUESTED',
    title: 'Approval needed',
    message: step.approvalRequest.title,
    entityType: 'ApprovalRequest',
    entityId: step.approvalRequest.id,
    logger: request?.log,
    email: approver.user?.email
      ? {
          to: approver.user.email,
          subject: `Approval needed: ${step.approvalRequest.title}`,
          text: `A request is waiting for your decision.\n\n${step.approvalRequest.title}\n${step.approvalRequest.summary ?? ''}`.trim(),
        }
      : undefined,
  });
}

/**
 * Visibility filter.
 *
 * A caller may see a request when they raised it, when they are an assigned
 * approver, or when the requester falls inside their employee data scope.
 * `approval.manage` widens this to the whole company.
 *
 * Returns null when the caller can see nothing, which callers must treat as an
 * empty result rather than an absent filter.
 */
export async function approvalVisibilityFilter(
  auth: AuthContext,
): Promise<Prisma.ApprovalRequestWhereInput | null> {
  if (auth.permissions.has(PERMISSIONS.APPROVAL_MANAGE)) return { companyId: auth.companyId };

  const self = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true },
  });

  const scopeFilter = await employeeScopeFilter(auth);

  const clauses: Prisma.ApprovalRequestWhereInput[] = [];
  if (self) {
    clauses.push({ requesterEmployeeId: self.id });
    clauses.push({ steps: { some: { approverEmployeeId: self.id } } });
  }
  if (scopeFilter !== null) {
    clauses.push({ requesterEmployee: scopeFilter });
  }

  if (clauses.length === 0) return null;
  return { companyId: auth.companyId, OR: clauses };
}

export async function assertApprovalVisible(auth: AuthContext, approvalId: string): Promise<void> {
  const filter = await approvalVisibilityFilter(auth);
  if (filter === null) throw new ForbiddenError('You do not have access to that request.');

  const match = await prisma.approvalRequest.findFirst({
    where: { AND: [{ id: approvalId }, filter] },
    select: { id: true },
  });
  if (!match) throw new ForbiddenError('You do not have access to that request.');
}

export interface DecisionInput {
  auth: AuthContext;
  approvalId: string;
  decision: 'APPROVED' | 'REJECTED';
  comment?: string | null;
  request?: FastifyRequest;
}

/**
 * Approve or reject the current step.
 *
 * Refuses, in this order: an already-finished request, a caller who is not the
 * assigned approver of the current step, a caller acting on their own request,
 * and a request whose requester is outside the caller's data scope.
 */
export async function decide(input: DecisionInput) {
  const { auth, approvalId, decision } = input;

  const approval = await prisma.approvalRequest.findFirst({
    where: { id: approvalId, companyId: auth.companyId },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });
  if (!approval) throw new NotFoundError('Approval request');

  if (isTerminal(approval.status)) {
    throw new ConflictError(
      `That request is already ${approval.status.toLowerCase()} and cannot be changed.`,
    );
  }

  const self = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true },
  });

  if (self && approval.requesterEmployeeId === self.id) {
    throw new ForbiddenError('You cannot decide your own request.');
  }

  const step = approval.steps.find((s) => s.stepOrder === approval.currentStep);
  if (!step) throw new ConflictError('That request has no step awaiting a decision.');

  if (step.status !== 'PENDING') {
    throw new ConflictError('That step has already been decided.');
  }

  const isAdmin = auth.permissions.has(PERMISSIONS.APPROVAL_MANAGE);
  const isAssignedApprover = Boolean(self && step.approverEmployeeId === self.id);

  if (!isAdmin && !isAssignedApprover) {
    throw new ForbiddenError('Only the assigned approver can decide this request.');
  }

  /*
   * Separation of duties.
   *
   * A multi-step chain exists so that several different people sign off. The
   * administrative override in the check above would otherwise let one person
   * approve step 1 as an override, land on step 2 as the assigned approver,
   * and approve that too - satisfying a two-person chain single-handedly and
   * quietly defeating the whole point of the chain.
   *
   * Nobody decides two steps of the same request, whatever they hold.
   */
  const alreadyDecidedEarlierStep = approval.steps.some(
    (s) => s.status !== 'PENDING' && s.decidedByUserId === auth.userId,
  );
  if (alreadyDecidedEarlierStep) {
    throw new ForbiddenError(
      'You have already decided an earlier step of this request. Another approver must decide this one.',
    );
  }

  // An override is a legitimate operational escape hatch - an approver who has
  // left, say - but it must never look like the assigned approver acted.
  const isOverride = isAdmin && !isAssignedApprover;

  // Even an administrator stays inside their data scope.
  await assertApprovalVisible(auth, approvalId);

  const now = new Date();
  const isLastStep = approval.currentStep >= approval.steps.length;
  const nextStatus: ApprovalStatus =
    decision === 'REJECTED' ? 'REJECTED' : isLastStep ? 'APPROVED' : 'PENDING';

  const updated = await prisma.$transaction(async (tx) => {
    await tx.approvalStep.update({
      where: { id: step.id },
      data: {
        status: decision,
        decidedByUserId: auth.userId,
        decidedAt: now,
        comment: input.comment ?? null,
      },
    });

    await tx.approvalEvent.create({
      data: {
        approvalRequestId: approval.id,
        actorUserId: auth.userId,
        action:
          (decision === 'APPROVED' ? 'approval.step.approved' : 'approval.step.rejected') +
          (isOverride ? '.override' : ''),
        fromStatus: approval.status,
        toStatus: nextStatus,
        comment: isOverride
          ? `[administrative override] ${input.comment ?? ''}`.trim()
          : (input.comment ?? null),
      },
    });

    return tx.approvalRequest.update({
      where: { id: approval.id },
      data: {
        status: nextStatus,
        currentStep: nextStatus === 'PENDING' ? approval.currentStep + 1 : approval.currentStep,
        ...(nextStatus !== 'PENDING'
          ? { decidedAt: now, decidedByUserId: auth.userId }
          : {}),
      },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
  });

  await recordAudit({
    companyId: auth.companyId,
    actorId: auth.userId,
    action:
      (decision === 'APPROVED' ? 'approval.approve' : 'approval.reject') +
      (isOverride ? '.override' : ''),
    entityType: 'ApprovalRequest',
    entityId: approval.id,
    summary: `${decision === 'APPROVED' ? 'Approved' : 'Rejected'} step ${approval.currentStep} of "${approval.title}"${isOverride ? ' (administrative override)' : ''}`,
    before: { status: approval.status, currentStep: approval.currentStep },
    after: { status: nextStatus, comment: input.comment ?? null },
    request: input.request,
  });

  if (nextStatus === 'PENDING') {
    await notifyApprover(approval.id, updated.currentStep, input.request);
  } else {
    await notifyRequester(updated.id, nextStatus, input.comment ?? null, input.request);
  }

  return updated;
}

/** Withdraw a request. Only the requester may do this, and only while pending. */
export async function cancel(
  auth: AuthContext,
  approvalId: string,
  reason: string | null,
  request?: FastifyRequest,
) {
  const approval = await prisma.approvalRequest.findFirst({
    where: { id: approvalId, companyId: auth.companyId },
  });
  if (!approval) throw new NotFoundError('Approval request');

  if (isTerminal(approval.status)) {
    throw new ConflictError(
      `That request is already ${approval.status.toLowerCase()} and cannot be cancelled.`,
    );
  }

  const self = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true },
  });

  const isOwner = Boolean(self && approval.requesterEmployeeId === self.id);
  const isAdmin = auth.permissions.has(PERMISSIONS.APPROVAL_MANAGE);
  if (!isOwner && !isAdmin) {
    throw new ForbiddenError('Only the person who raised a request can cancel it.');
  }

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    await tx.approvalEvent.create({
      data: {
        approvalRequestId: approval.id,
        actorUserId: auth.userId,
        action: 'approval.cancelled',
        fromStatus: approval.status,
        toStatus: 'CANCELLED',
        comment: reason,
      },
    });

    return tx.approvalRequest.update({
      where: { id: approval.id },
      data: { status: 'CANCELLED', cancelledAt: now, decidedByUserId: auth.userId },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
  });

  await recordAudit({
    companyId: auth.companyId,
    actorId: auth.userId,
    action: 'approval.cancel',
    entityType: 'ApprovalRequest',
    entityId: approval.id,
    summary: `Cancelled "${approval.title}"`,
    before: { status: approval.status },
    after: { status: 'CANCELLED', reason },
    request,
  });

  return updated;
}

async function notifyRequester(
  approvalId: string,
  status: ApprovalStatus,
  comment: string | null,
  request?: FastifyRequest,
): Promise<void> {
  const approval = await prisma.approvalRequest.findUnique({
    where: { id: approvalId },
    include: {
      requesterEmployee: { select: { userId: true, user: { select: { email: true } } } },
    },
  });

  const userId = approval?.requesterEmployee?.userId;
  if (!approval || !userId) return;

  const approved = status === 'APPROVED';
  await notify({
    companyId: approval.companyId,
    userId,
    type: approved ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
    title: approved ? 'Request approved' : 'Request rejected',
    message: comment ? `${approval.title} - ${comment}` : approval.title,
    entityType: 'ApprovalRequest',
    entityId: approval.id,
    logger: request?.log,
    email: approval.requesterEmployee?.user?.email
      ? {
          to: approval.requesterEmployee.user.email,
          subject: `${approved ? 'Approved' : 'Rejected'}: ${approval.title}`,
          text: `Your request was ${approved ? 'approved' : 'rejected'}.\n\n${approval.title}${comment ? `\n\nComment: ${comment}` : ''}`,
        }
      : undefined,
  });
}

/**
 * Called by domain modules after a decision so their own status column stays in
 * step with the engine. Keeps the mirrored status honest without the engine
 * needing to know which tables exist.
 */
export async function syncSubjectStatus(
  subjectType: ApprovalSubjectType,
  subjectId: string,
  status: ApprovalStatus,
): Promise<void> {
  switch (subjectType) {
    case 'ATTENDANCE_REGULARIZATION':
      await prisma.attendanceRegularizationRequest.updateMany({
        where: { id: subjectId },
        data: { status },
      });
      return;
    case 'SHIFT_CHANGE':
      await prisma.shiftChangeRequest.updateMany({ where: { id: subjectId }, data: { status } });
      return;
    case 'TIMESHEET':
      await prisma.timesheet.updateMany({
        where: { id: subjectId },
        data: {
          status: status === 'APPROVED' ? 'APPROVED' : status === 'REJECTED' ? 'REJECTED' : 'SUBMITTED',
        },
      });
      return;
    case 'LEAVE_REQUEST':
      await prisma.leaveRequest.updateMany({
        where: { id: subjectId },
        data: {
          status,
          // Timestamps make the decision legible on the leave screen without
          // having to join the approval tables.
          ...(status === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
          ...(status === 'APPROVED' || status === 'REJECTED' ? { decidedAt: new Date() } : {}),
        },
      });
      return;
    default:
      return;
  }
}
