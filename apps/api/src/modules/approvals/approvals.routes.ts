import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  APPROVAL_STAGE_LABELS,
  PERMISSIONS,
  type ApprovalDetail,
  type ApprovalListItem,
  type ApprovalStage,
  type ApprovalStageMode,
  type ApprovalStatus,
  type ApprovalStepRecord,
  type ApprovalSubjectType,
  approvalCancelSchema,
  approvalDecisionSchema,
  approvalQuerySchema,
  idParamSchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { NotFoundError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import {
  approvalVisibilityFilter,
  assertApprovalVisible,
  cancel,
  decide,
  isTerminal,
  syncSubjectStatus,
} from '../../core/approvals/approval.service.js';

const SORTABLE = ['createdAt', 'status', 'title'] as const;

const name = (e: { firstName: string; lastName: string; displayName?: string | null } | null) =>
  e ? (e.displayName ?? `${e.firstName} ${e.lastName}`.trim()) : '';

export const approvalRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.APPROVAL_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(approvalQuerySchema, request.query);

    const visibility = await approvalVisibilityFilter(auth);
    if (visibility === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    const self = await prisma.employee.findFirst({
      where: { companyId: auth.companyId, userId: auth.userId },
      select: { id: true },
    });

    // `inbox` = waiting on me right now; `mine` = things I raised.
    const viewClause: Prisma.ApprovalRequestWhereInput =
      query.view === 'inbox' && self
        ? {
            status: 'PENDING',
            /*
             * "Waiting on me" is a seat of mine that is still PENDING on the
             * step the request is actually sitting on. Reading the step's
             * display column instead would hide a request from two of the
             * three managers who may sign it.
             */
            steps: { some: { approvers: { some: { employeeId: self.id, status: 'PENDING' } } } },
          }
        : query.view === 'mine' && self
          ? { requesterEmployeeId: self.id }
          : {};

    const where: Prisma.ApprovalRequestWhereInput = {
      AND: [
        visibility,
        viewClause,
        query.status ? { status: query.status } : {},
        query.subjectType ? { subjectType: query.subjectType } : {},
        query.q
          ? {
              OR: [
                { title: { contains: query.q, mode: 'insensitive' } },
                { summary: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.approvalRequest.count({ where }),
      prisma.approvalRequest.findMany({
        where,
        skip,
        take,
        orderBy: buildOrderBy(query.sort, query.order, SORTABLE, 'createdAt'),
        include: {
          requesterEmployee: { select: { id: true, firstName: true, lastName: true, displayName: true } },
          steps: { orderBy: { stepOrder: 'asc' }, include: { approvers: true } },
        },
      }),
    ]);

    const data: ApprovalListItem[] = rows.map((row) => {
      const current = row.steps.find((s) => s.stepOrder === row.currentStep);
      return {
        id: row.id,
        subjectType: row.subjectType as ApprovalSubjectType,
        subjectId: row.subjectId,
        title: row.title,
        summary: row.summary,
        status: row.status as ApprovalStatus,
        currentStep: row.currentStep,
        totalSteps: row.steps.length,
        requesterName: name(row.requesterEmployee),
        requesterEmployeeId: row.requesterEmployeeId,
        createdAt: row.createdAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
        awaitingMyDecision:
          row.status === 'PENDING' &&
          current?.status === 'PENDING' &&
          Boolean(
            self && current?.approvers.some((a) => a.employeeId === self.id && a.status === 'PENDING'),
          ),
      };
    });

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  /** Badge counter for the approvals nav entry. */
  app.get('/pending-count', async (request, reply) => {
    const auth = requireAuthContext(request);

    const self = await prisma.employee.findFirst({
      where: { companyId: auth.companyId, userId: auth.userId },
      select: { id: true },
    });
    if (!self) return reply.send({ data: { count: 0 } });

    const count = await prisma.approvalRequest.count({
      where: {
        companyId: auth.companyId,
        status: 'PENDING',
        steps: { some: { approvers: { some: { employeeId: self.id, status: 'PENDING' } } } },
      },
    });

    return reply.send({ data: { count } });
  });

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    await assertApprovalVisible(auth, id);

    const row = await prisma.approvalRequest.findFirst({
      where: { id, companyId: auth.companyId },
      include: {
        requesterEmployee: { select: { id: true, firstName: true, lastName: true, displayName: true } },
        steps: {
          orderBy: { stepOrder: 'asc' },
          include: {
            approverEmployee: { select: { firstName: true, lastName: true, displayName: true } },
            approvers: {
              orderBy: { createdAt: 'asc' },
              include: {
                employee: { select: { id: true, firstName: true, lastName: true, displayName: true } },
              },
            },
          },
        },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!row) throw new NotFoundError('Approval request');

    const self = await prisma.employee.findFirst({
      where: { companyId: auth.companyId, userId: auth.userId },
      select: { id: true },
    });

    // Actor names for the history, resolved in one query.
    const actorIds = [...new Set(row.events.map((e) => e.actorUserId).filter((v): v is string => Boolean(v)))];
    const actors = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const actorName = new Map(actors.map((a) => [a.id, `${a.firstName} ${a.lastName}`.trim()]));

    const current = row.steps.find((s) => s.stepOrder === row.currentStep);
    const isOwner = Boolean(self && row.requesterEmployeeId === self.id);
    /*
     * ASSIGNED MEANS "I HAVE AN OPEN SEAT ON THE STAGE THAT IS WAITING".
     *
     * Both halves matter. A manager whose colleague has already signed an
     * ANY_ONE stage has a seat, but it was closed when the stage completed, so
     * they are shown a finished stage rather than a live Approve button - which
     * is what section 5 of the brief asks for, and the server refuses the call
     * as well if they send it anyway.
     */
    const isAssigned = Boolean(
      self && current?.approvers.some((a) => a.employeeId === self.id && a.status === 'PENDING'),
    );
    const isAdmin = auth.permissions.has(PERMISSIONS.APPROVAL_MANAGE);

    const detail: ApprovalDetail = {
      id: row.id,
      subjectType: row.subjectType as ApprovalSubjectType,
      subjectId: row.subjectId,
      title: row.title,
      summary: row.summary,
      status: row.status as ApprovalStatus,
      currentStep: row.currentStep,
      totalSteps: row.steps.length,
      requesterName: name(row.requesterEmployee),
      requesterEmployeeId: row.requesterEmployeeId,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      awaitingMyDecision: row.status === 'PENDING' && isAssigned && current?.status === 'PENDING',
      steps: row.steps.map((s): ApprovalStepRecord => {
        const stage = (s.stage as ApprovalStage | null) ?? null;
        return {
          id: s.id,
          stepOrder: s.stepOrder,
          status: s.status as ApprovalStatus,
          approverName: s.approverEmployee ? name(s.approverEmployee) : null,
          decidedAt: s.decidedAt?.toISOString() ?? null,
          comment: s.comment,
          stage,
          stageLabel: stage ? APPROVAL_STAGE_LABELS[stage] : `Step ${s.stepOrder}`,
          mode: s.mode as ApprovalStageMode,
          approvers: s.approvers.map((a) => ({
            employeeId: a.employeeId,
            name: name(a.employee),
            status: a.status as ApprovalStatus,
            decidedAt: a.decidedAt?.toISOString() ?? null,
            comment: a.comment,
            isMe: Boolean(self && a.employeeId === self.id),
          })),
          /*
           * Who actually signed. Read off the seats rather than off the step,
           * because the step records the LAST decision and an ALL stage is
           * carried by several - "approved by Manager A" on a rung two people
           * had to sign is a false sentence.
           */
          decidedByNames: s.approvers
            .filter((a) => a.status === 'APPROVED' || a.status === 'REJECTED')
            .map((a) => name(a.employee)),
        };
      }),
      events: row.events.map((e) => ({
        id: e.id,
        action: e.action,
        fromStatus: (e.fromStatus as ApprovalStatus | null) ?? null,
        toStatus: e.toStatus as ApprovalStatus,
        comment: e.comment,
        createdAt: e.createdAt.toISOString(),
        actorName: e.actorUserId ? (actorName.get(e.actorUserId) ?? null) : null,
      })),
      // Never offer a control the server would refuse: no self-approval, no
      // acting on a finished request, and no acting without the act permission.
      canDecide:
        !isTerminal(row.status) &&
        !isOwner &&
        (isAssigned || isAdmin) &&
        auth.permissions.has(PERMISSIONS.APPROVAL_ACT),
      canCancel: !isTerminal(row.status) && (isOwner || isAdmin),
    };

    return reply.send({ data: detail });
  });

  app.post(
    '/:id/approve',
    { preHandler: requirePermission(PERMISSIONS.APPROVAL_ACT) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const body = parseOrThrow(approvalDecisionSchema, request.body ?? {});

      const updated = await decide({
        auth,
        approvalId: id,
        decision: 'APPROVED',
        comment: body.comment ?? null,
        request,
      });

      await syncSubjectStatus(updated.subjectType, updated.subjectId, updated.status);
      return reply.send({ data: { id: updated.id, status: updated.status } });
    },
  );

  app.post(
    '/:id/reject',
    { preHandler: requirePermission(PERMISSIONS.APPROVAL_ACT) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const body = parseOrThrow(approvalDecisionSchema, request.body ?? {});

      const updated = await decide({
        auth,
        approvalId: id,
        decision: 'REJECTED',
        comment: body.comment ?? null,
        request,
      });

      await syncSubjectStatus(updated.subjectType, updated.subjectId, updated.status);
      return reply.send({ data: { id: updated.id, status: updated.status } });
    },
  );

  app.post('/:id/cancel', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const body = parseOrThrow(approvalCancelSchema, request.body ?? {});

    const updated = await cancel(auth, id, body.reason ?? null, request);
    await syncSubjectStatus(updated.subjectType, updated.subjectId, updated.status);

    return reply.send({ data: { id: updated.id, status: updated.status } });
  });
};
