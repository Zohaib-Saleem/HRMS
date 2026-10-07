import type { FastifyRequest } from 'fastify';
import type { ApprovalStatus, ApprovalSubjectType, Prisma } from '@prisma/client';
import { APPROVAL_STAGE_LABELS, PERMISSIONS } from '@hrms/shared';
import { prisma } from '../db.js';
import { recordAudit } from '../audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { notify } from '../notifications/notification.service.js';
import type { AuthContext } from '../../auth/session.js';
import { teamScopeFilter } from '../../auth/scope.js';
import {
  describeSkip,
  resolveApprovalChain,
  type ResolvedChain,
  type ResolvedStage,
} from './hierarchy.service.js';
import { applyRegularization, applyShiftChange } from '../../modules/time/attendance.service.js';
import { applyLoanDecision } from '../../modules/loans/loans.routes.js';
import { reconcileLeaveRequest } from '../../modules/leave/leave-reconciliation.service.js';

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
 *
 * A STEP IS A STAGE, AND A STAGE MAY HAVE SEVERAL APPROVERS.
 *
 * Step 1 used to mean "one named person decides". It now means "one rung of
 * the hierarchy decides", and the rung carries a set of candidates in
 * `approval_step_approvers` plus a mode:
 *
 *   ANY_ONE  the first approval carries the rung. A team with three managers
 *            needs one of them, and the other two are shown a completed stage
 *            rather than a second button.
 *   ALL      every candidate must approve before the rung is done.
 *
 * Either way ONE REJECTION ENDS THE REQUEST, at any rung, whatever the mode:
 * a rejection is a decision about the request, not a vote about the stage.
 *
 * Authority is the approver SET, never `approverEmployeeId` - that column
 * survives as the display name of a single-approver step and as the shape
 * every row written before stages existed still has. The migration copied each
 * one into the set, so both kinds of row are decided by the same code.
 */

export interface CreateApprovalInput {
  companyId: string;
  subjectType: ApprovalSubjectType;
  subjectId: string;
  requesterEmployeeId: string;
  requesterUserId?: string | null;
  title: string;
  summary?: string | null;
  /**
   * The resolved chain, in order. Stage 1 decides first.
   *
   * Resolved by the caller rather than here, because a caller has to be able
   * to find out whether a chain EXISTS before it writes the row the approval
   * will hang off - see `assertChainUsable`.
   */
  chain: ResolvedChain;
  request?: FastifyRequest;
  /**
   * Runs the write on a transaction client instead of the global one, so a
   * caller can make "subject row + approval record" a single atomic unit. The
   * audit entry and the approver notification are deliberately NOT part of it:
   * both are side effects that must happen only once the transaction has
   * actually committed, and a failing notification must never roll back a
   * legitimately submitted request.
   */
  client?: Prisma.TransactionClient;
  /** Caller will record the audit entry itself, after its transaction commits. */
  deferAudit?: boolean;
}

const TERMINAL: readonly ApprovalStatus[] = ['APPROVED', 'REJECTED', 'CANCELLED'];

export function isTerminal(status: ApprovalStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * The chain for one request, resolved from the company's hierarchy.
 *
 * A thin pass-through to `resolveApprovalChain`, kept here so that every
 * domain module reaches the hierarchy through the approval engine rather than
 * importing the resolver itself - the engine stays the one door.
 */
export async function resolveChain(
  companyId: string,
  subjectType: ApprovalSubjectType,
  requesterEmployeeId: string,
): Promise<ResolvedChain> {
  return resolveApprovalChain(companyId, subjectType, requesterEmployeeId);
}

/**
 * Every reason a chain can be refused, checked without writing anything.
 *
 * Callers run this BEFORE creating the row the approval will hang off. The
 * checks used to live only inside `createApprovalRequest`, which meant a caller
 * that had already inserted its subject row was left with an orphan when the
 * chain turned out to be empty.
 */
export function assertChainUsable(chain: ResolvedChain, requesterEmployeeId: string): void {
  if (chain.stages.length === 0) {
    throw new ValidationError({
      _: [
        'No approver could be determined for this request. Appoint a manager for this team, name an HR Manager or a CEO on the approval hierarchy, or set a reporting manager on the employee record.',
      ],
    });
  }

  for (const stage of chain.stages) {
    if (stage.approverEmployeeIds.includes(requesterEmployeeId)) {
      throw new ValidationError({ _: ['A request cannot be approved by the person who raised it.'] });
    }
    if (stage.approverEmployeeIds.length === 0) {
      throw new ValidationError({ _: ['One stage of this approval chain has nobody to fill it.'] });
    }
  }
}

/** The `steps` payload for one resolved stage. */
function stepData(stage: ResolvedStage, index: number) {
  return {
    stepOrder: index + 1,
    stage: stage.stage,
    mode: stage.mode,
    /*
     * The display column, and ONLY when the stage has exactly one approver.
     * Writing the first of three managers into it would name one person as
     * "the" approver of a rung any of them may sign, which is the sentence the
     * screen would then show and the wrong one.
     */
    approverEmployeeId:
      stage.approverEmployeeIds.length === 1 ? stage.approverEmployeeIds[0] : null,
    status: 'PENDING' as ApprovalStatus,
    approvers: {
      create: stage.approverEmployeeIds.map((employeeId) => ({
        employeeId,
        status: 'PENDING' as ApprovalStatus,
      })),
    },
  };
}

export async function createApprovalRequest(input: CreateApprovalInput) {
  assertChainUsable(input.chain, input.requesterEmployeeId);

  const db = input.client ?? prisma;

  const approval = await db.approvalRequest.create({
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
      steps: { create: input.chain.stages.map(stepData) },
      events: {
        create: [
          {
            actorUserId: input.requesterUserId ?? null,
            action: 'approval.submitted',
            toStatus: 'PENDING' as ApprovalStatus,
            comment: describeChain(input.chain),
          },
          /*
           * A skipped stage is written into the history as its own event.
           *
           * Silence here is the failure mode worth spending a row on: leave
           * that never reached the CEO because nobody is named as CEO looks
           * exactly like leave the CEO approved, six months later, to somebody
           * reading the trail. This says which rung was not asked, and why.
           */
          ...input.chain.skipped.map((skip) => ({
            actorUserId: input.requesterUserId ?? null,
            action: 'approval.stage.skipped',
            toStatus: 'PENDING' as ApprovalStatus,
            comment: describeSkip(skip),
          })),
        ],
      },
    },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });

  if (!input.deferAudit) {
    await recordAudit({
      companyId: input.companyId,
      actorId: input.requesterUserId ?? null,
      action: 'approval.submit',
      entityType: 'ApprovalRequest',
      entityId: approval.id,
      summary: `Submitted for approval: ${input.title}`,
      after: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        steps: approval.steps.length,
        chain: describeChain(input.chain),
      },
      request: input.request,
    });

    await notifyApprover(approval.id, 1, input.request);
  }

  return approval;
}

/** "Team Manager (any one of 3), then HR Manager, then CEO". */
export function describeChain(chain: ResolvedChain): string {
  if (chain.stages.length === 0) return 'No approval stages.';
  return chain.stages
    .map((stage) => {
      const label = APPROVAL_STAGE_LABELS[stage.stage];
      const count = stage.approverEmployeeIds.length;
      if (count === 1) return label;
      return stage.mode === 'ALL'
        ? `${label} (all ${count})`
        : `${label} (any one of ${count})`;
    })
    .join(' -> ');
}

/**
 * Tells everybody who can decide the given step that it is waiting for them.
 *
 * All of them, not one of them. A stage filled by three team managers in
 * ANY_ONE mode is waiting for whichever gets there first, and notifying only
 * the first name in the set would make the other two's ability to sign a
 * secret. The first to act completes the stage and the others find it closed,
 * which is the intended outcome and is what the decision path enforces.
 *
 * Best-effort throughout: `notify` never throws, and an approver with no login
 * account is skipped rather than blocking the rest.
 */
export async function notifyApprover(
  approvalRequestId: string,
  stepOrder: number,
  request?: FastifyRequest,
): Promise<void> {
  const step = await prisma.approvalStep.findFirst({
    where: { approvalRequestId, stepOrder },
    include: {
      approvers: {
        where: { status: 'PENDING' },
        include: {
          employee: { select: { id: true, userId: true, user: { select: { email: true } } } },
        },
      },
      approvalRequest: {
        select: { id: true, companyId: true, subjectType: true, title: true, summary: true },
      },
    },
  });

  if (!step) return;

  const notice = approverNotice(step.approvalRequest);

  const seen = new Set<string>();
  for (const seat of step.approvers) {
    const userId = seat.employee.userId;
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);

    await notify({
      companyId: step.approvalRequest.companyId,
      userId,
      type: 'APPROVAL_REQUESTED',
      title: notice.title,
      message: notice.message,
      entityType: 'ApprovalRequest',
      entityId: step.approvalRequest.id,
      logger: request?.log,
      email: seat.employee.user?.email
        ? {
            to: seat.employee.user.email,
            subject: step.approvalRequest.title.startsWith(notice.title)
              ? step.approvalRequest.title
              : `${notice.title}: ${step.approvalRequest.title}`,
            text: `A request is waiting for your decision.\n\n${step.approvalRequest.title}\n${step.approvalRequest.summary ?? ''}`.trim(),
          }
        : undefined,
    });
  }
}

/**
 * The notification an approver receives.
 *
 * An attendance correction carries the request itself - employee, date,
 * correction, current and requested times, reason - because the approver has
 * to know exactly what they are approving, and the approval's summary is where
 * the submitting route wrote it. Other subjects keep the short form.
 */
export function approverNotice(approval: {
  subjectType: string;
  title: string;
  summary: string | null;
}): { title: string; message: string } {
  if (approval.subjectType === 'ATTENDANCE_REGULARIZATION' && approval.summary) {
    return { title: 'Attendance Correction Request', message: approval.summary };
  }
  return { title: 'Approval needed', message: approval.title };
}

/**
 * Visibility filter.
 *
 * A caller may see a request when they raised it, when they are one of the
 * named approvers on ANY of its steps, or when the requester falls inside the
 * employee records they may read - including, for a team manager, the teams
 * they have been appointed to. `approval.manage` widens this to the company.
 *
 * "One of the named approvers" reads the approver SET, not the step's display
 * column. A manager who shares a rung with two colleagues must be able to open
 * the request they may sign, and the display column names at most one of them.
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

  const scopeFilter = await teamScopeFilter(auth);

  const clauses: Prisma.ApprovalRequestWhereInput[] = [];
  if (self) {
    clauses.push({ requesterEmployeeId: self.id });
    clauses.push({ steps: { some: { approvers: { some: { employeeId: self.id } } } } });
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
 * Approve or reject the current stage.
 *
 * Refuses, in this order: an already-finished request, a caller who is not one
 * of the stage's named approvers, a caller acting on their own request, a
 * caller who has already decided an earlier stage, and a request whose
 * requester is outside what the caller may see.
 *
 * WHAT A DECISION DOES TO A STAGE:
 *
 *   REJECTED, in either mode, ends the whole request. A rejection is a
 *   decision about the request rather than a vote about the rung, so the first
 *   one wins and nobody else is asked.
 *
 *   APPROVED in ANY_ONE mode completes the stage. The other approvers' seats
 *   are closed - not left PENDING - so the screen can say "approved by Manager
 *   A" to all three of them, and so a second manager arriving a minute later
 *   is told the stage is done rather than being shown a live button.
 *
 *   APPROVED in ALL mode closes only the caller's own seat. The stage stays
 *   open, the request stays on the same step, and the remaining approvers are
 *   reminded. It completes when the last seat closes.
 */
export async function decide(input: DecisionInput) {
  const { auth, approvalId, decision } = input;

  const approval = await prisma.approvalRequest.findFirst({
    where: { id: approvalId, companyId: auth.companyId },
    include: { steps: { orderBy: { stepOrder: 'asc' }, include: { approvers: true } } },
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
  const seat = self ? step.approvers.find((a) => a.employeeId === self.id) : undefined;
  const isAssignedApprover = Boolean(seat);

  if (!isAdmin && !isAssignedApprover) {
    throw new ForbiddenError('Only an approver named on this stage can decide it.');
  }

  /*
   * A seat that has already been used cannot be used again.
   *
   * In ANY_ONE mode this is unreachable - the first approval closes the whole
   * step - but in ALL mode it is the rule that stops one approver approving
   * twice and satisfying a rung on their own. It is checked on the SEAT rather
   * than on the step for exactly that reason.
   */
  if (seat && seat.status !== 'PENDING') {
    throw new ConflictError('You have already decided this stage.');
  }

  /*
   * Separation of duties.
   *
   * A multi-stage chain exists so that several different people sign off. The
   * administrative override in the check above would otherwise let one person
   * approve stage 1 as an override, land on stage 2 as a named approver, and
   * approve that too - satisfying a three-rung chain single-handedly and
   * quietly defeating the whole point of it.
   *
   * Nobody decides two stages of the same request, whatever they hold. The
   * resolver keeps this from biting honest configurations: a person who fills
   * two rungs is struck from the later one when the chain is built, so this
   * only ever fires on an override.
   */
  const alreadyDecidedEarlierStep = approval.steps.some(
    (s) =>
      s.stepOrder !== step.stepOrder &&
      (s.decidedByUserId === auth.userId ||
        s.approvers.some((a) => a.status !== 'PENDING' && a.decidedByUserId === auth.userId)),
  );
  if (alreadyDecidedEarlierStep) {
    throw new ForbiddenError(
      'You have already decided an earlier stage of this request. Another approver must decide this one.',
    );
  }

  // An override is a legitimate operational escape hatch - an approver who has
  // left, say - but it must never look like the assigned approver acted.
  const isOverride = isAdmin && !isAssignedApprover;

  // Even an administrator stays inside what they may see.
  await assertApprovalVisible(auth, approvalId);

  const now = new Date();

  /*
   * Does this decision finish the rung?
   *
   * ANY_ONE: yes, on the first approval. ALL: only when every OTHER seat has
   * already approved - computed from the rows read above rather than from a
   * second query, so the answer cannot drift between the check and the write.
   * An override always completes the rung: an administrator standing in for an
   * absent approver is not signing one of three seats, they are unblocking the
   * stage.
   */
  const othersOutstanding = step.approvers.filter(
    (a) => a.id !== seat?.id && a.status === 'PENDING',
  ).length;
  const stageCompletes =
    decision === 'REJECTED' || isOverride || step.mode === 'ANY_ONE' || othersOutstanding === 0;

  const isLastStep = approval.currentStep >= approval.steps.length;
  const nextStatus: ApprovalStatus =
    decision === 'REJECTED'
      ? 'REJECTED'
      : stageCompletes && isLastStep
        ? 'APPROVED'
        : 'PENDING';

  const stageLabel = step.stage ? APPROVAL_STAGE_LABELS[step.stage] : `Step ${step.stepOrder}`;

  const updated = await prisma.$transaction(async (tx) => {
    if (seat) {
      await tx.approvalStepApprover.update({
        where: { id: seat.id },
        data: {
          status: decision,
          decidedByUserId: auth.userId,
          decidedAt: now,
          comment: input.comment ?? null,
        },
      });
    }

    if (stageCompletes) {
      await tx.approvalStep.update({
        where: { id: step.id },
        data: {
          status: decision,
          decidedByUserId: auth.userId,
          decidedAt: now,
          comment: input.comment ?? null,
        },
      });

      /*
       * Close the seats nobody used.
       *
       * Left PENDING they would sit in three other people's inboxes for ever,
       * and `awaitingMyDecision` - which is a query over exactly these rows -
       * would keep saying yes to a stage that is finished. CANCELLED rather
       * than APPROVED because these people did not approve anything; the seat
       * simply stopped being needed.
       */
      await tx.approvalStepApprover.updateMany({
        where: { approvalStepId: step.id, status: 'PENDING' },
        data: { status: 'CANCELLED', decidedAt: now },
      });
    }

    await tx.approvalEvent.create({
      data: {
        approvalRequestId: approval.id,
        actorUserId: auth.userId,
        action:
          (decision === 'APPROVED' ? 'approval.step.approved' : 'approval.step.rejected') +
          (isOverride ? '.override' : ''),
        fromStatus: approval.status,
        toStatus: nextStatus,
        comment: [
          isOverride ? '[administrative override]' : null,
          stageCompletes ? `${stageLabel} stage ${decision.toLowerCase()}` : `${stageLabel}: one of ${step.approvers.length} approvals recorded`,
          input.comment ?? null,
        ]
          .filter(Boolean)
          .join(' - '),
      },
    });

    return tx.approvalRequest.update({
      where: { id: approval.id },
      data: {
        status: nextStatus,
        currentStep:
          nextStatus === 'PENDING' && stageCompletes
            ? approval.currentStep + 1
            : approval.currentStep,
        ...(nextStatus !== 'PENDING' ? { decidedAt: now, decidedByUserId: auth.userId } : {}),
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
    summary: `${decision === 'APPROVED' ? 'Approved' : 'Rejected'} the ${stageLabel} stage of "${approval.title}"${isOverride ? ' (administrative override)' : ''}`,
    before: { status: approval.status, currentStep: approval.currentStep },
    after: {
      status: nextStatus,
      stage: step.stage,
      mode: step.mode,
      stageCompleted: stageCompletes,
      comment: input.comment ?? null,
    },
    request: input.request,
  });

  if (nextStatus === 'PENDING') {
    // A completed rung moves on and tells the next one; an ALL rung still
    // waiting tells the people it is still waiting for.
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
    /*
     * Close every seat still waiting on this request.
     *
     * A withdrawn request that leaves PENDING approver rows behind stays in
     * the inbox of everybody who was going to decide it, and `pending-count` -
     * a query over exactly those rows - keeps counting it. The request is
     * gone; the seats go with it.
     */
    await tx.approvalStepApprover.updateMany({
      where: { approvalStep: { approvalRequestId: approval.id }, status: 'PENDING' },
      data: { status: 'CANCELLED', decidedAt: now },
    });

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
      // Mirroring the status is not enough: an approved correction has to
      // actually reach the attendance record, or the decision changes nothing
      // anyone reads.
      if (status === 'APPROVED') await applyRegularization(subjectId);
      return;
    case 'SHIFT_CHANGE':
      await prisma.shiftChangeRequest.updateMany({ where: { id: subjectId }, data: { status } });
      if (status === 'APPROVED') await applyShiftChange(subjectId);
      return;
    case 'TIMESHEET':
      await prisma.timesheet.updateMany({
        where: { id: subjectId },
        data: {
          status: status === 'APPROVED' ? 'APPROVED' : status === 'REJECTED' ? 'REJECTED' : 'SUBMITTED',
        },
      });
      return;
    case 'LOAN_REQUEST':
      // Approving agrees to the loan; it does not release it. The loan module
      // owns that distinction - the engine only reports the decision.
      if (status === 'APPROVED' || status === 'REJECTED' || status === 'CANCELLED') {
        await applyLoanDecision(subjectId, status);
      }
      return;
    case 'ASSET_REQUEST':
      /*
       * APPROVED here means the company has AGREED to the request. It does not
       * mean anybody has been handed a laptop, and this function must never
       * write FULFILLED - that status belongs to the fulfilment path and to
       * nobody else. The guard on `status: 'PENDING'` says so in SQL: a
       * request that has somehow already moved on is left exactly as it is.
       */
      await prisma.assetRequest.updateMany({
        where: { id: subjectId, status: 'PENDING' },
        data: {
          status,
          ...(status === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
          ...(status === 'APPROVED' || status === 'REJECTED' ? { decidedAt: new Date() } : {}),
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
      // Leave approved for a day the person has already been seen at work is
      // reconciled at once, not at the next import. Never fails the decision.
      if (status === 'APPROVED') {
        await reconcileLeaveRequest(subjectId).catch((error: unknown) => {
          console.error('leave reconciliation on approval failed', { subjectId, error });
        });
      }
      return;
    default:
      return;
  }
}
