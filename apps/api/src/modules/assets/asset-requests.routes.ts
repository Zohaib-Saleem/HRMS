import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  ASSET_CONDITION_LABELS,
  PERMISSIONS,
  assetRequestCancelSchema,
  assetRequestCreateSchema,
  assetRequestDeclineItemSchema,
  assetRequestFulfilSchema,
  assetRequestQuerySchema,
  idParamSchema,
  type AssetCondition,
  type AssetRequestDetail,
  type AssetRequestListItem,
  type AssetStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { teamScopeFilter } from '../../auth/scope.js';
import { notify } from '../../core/notifications/notification.service.js';
import {
  assertChainUsable,
  cancel as cancelApproval,
  createApprovalRequest,
  notifyApprover,
  resolveChain,
  syncSubjectStatus,
} from '../../core/approvals/approval.service.js';
import {
  assertAssignable,
  claimAssetForAssignment,
  dayColumn,
} from './asset-lifecycle.service.js';
import {
  ASSET_REQUEST_INCLUDE,
  approvalSnapshots,
  isFullySettled,
  toDetail,
  toListItem,
  type AssetRequestRow,
} from './asset-requests.service.js';

/**
 * Asking the company for equipment, and - separately - being given it.
 *
 * THE SEPARATION IS THE FEATURE. Read these four routes as two pairs:
 *
 *   POST /  and  POST /:id/cancel      what the EMPLOYEE may do
 *   POST /:id/fulfil  and  /decline    what the ASSET MANAGER may do
 *
 * and notice what is in neither pair: approving. There is no approve endpoint
 * in this file at all. A request is decided through `/approvals`, by the
 * people the hierarchy resolved, and the asset manager is not among them
 * unless somebody appointed them for other reasons. `asset.request.fulfil`
 * moves nothing through the chain - the fulfilment route refuses outright
 * unless the request is already APPROVED, which only the chain can make it.
 *
 * That is the answer to "the IT person should not automatically become the
 * approver": they are not, because the grant they hold cannot approve, and the
 * grant that can approve is one nobody gave them.
 */

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

async function callerEmployee(companyId: string, userId: string) {
  return prisma.employee.findFirst({
    where: { companyId, userId },
    select: { id: true, firstName: true, lastName: true, displayName: true, userId: true },
  });
}

async function requestOrThrow(companyId: string, id: string): Promise<AssetRequestRow> {
  const row = await prisma.assetRequest.findFirst({
    where: { id, companyId },
    include: ASSET_REQUEST_INCLUDE,
  });
  if (!row) throw new NotFoundError('Asset request');
  return row;
}

/** Recomputes the request's settled state after a fulfilment or a decline. */
async function settleIfComplete(
  row: AssetRequestRow,
  userId: string,
): Promise<'FULFILLED' | 'APPROVED'> {
  if (!isFullySettled(row)) return 'APPROVED';

  await prisma.assetRequest.updateMany({
    where: { id: row.id, status: 'APPROVED' },
    data: { status: 'FULFILLED', fulfilledAt: new Date(), fulfilledByUserId: userId },
  });
  return 'FULFILLED';
}

export const assetRequestRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  // ------------------------------------------------------------------ read

  app.get(
    '/',
    { preHandler: requirePermission(PERMISSIONS.ASSET_REQUEST_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const query = parseOrThrow(assetRequestQuerySchema, request.query);

      const self = await callerEmployee(auth.companyId, auth.userId);
      const seesAll = auth.permissions.has(PERMISSIONS.ASSET_REQUEST_READ_ALL);

      /*
       * Who this caller may see, in one expression.
       *
       * `asset.request.read.all` is the whole company - the fulfilment queue.
       * Everybody else gets their own requests UNIONED with whatever their
       * employee scope reaches, which for a team manager is their teams. The
       * union is what lets an ordinary employee with an OWN scope still see
       * the thing they raised.
       */
      let visibility: Prisma.AssetRequestWhereInput;
      if (seesAll) {
        visibility = {};
      } else {
        const scope = await teamScopeFilter(auth);
        const clauses: Prisma.AssetRequestWhereInput[] = [];
        if (self) clauses.push({ employeeId: self.id });
        if (scope !== null) clauses.push({ employee: scope });
        if (clauses.length === 0) {
          return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
        }
        visibility = { OR: clauses };
      }

      const where: Prisma.AssetRequestWhereInput = {
        AND: [
          { companyId: auth.companyId },
          visibility,
          query.view === 'mine' && self ? { employeeId: self.id } : {},
          /*
           * The queue is "agreed, not yet delivered" - and it is only served
           * to somebody who may see every request, because a queue narrowed to
           * one team is not a queue.
           */
          query.view === 'queue' && seesAll ? { status: 'APPROVED' } : {},
          query.status ? { status: query.status } : {},
          query.employeeId ? { employeeId: query.employeeId } : {},
          query.q
            ? {
                OR: [
                  { justification: { contains: query.q, mode: 'insensitive' } },
                  { employee: { firstName: { contains: query.q, mode: 'insensitive' } } },
                  { employee: { lastName: { contains: query.q, mode: 'insensitive' } } },
                  { items: { some: { category: { name: { contains: query.q, mode: 'insensitive' } } } } },
                ],
              }
            : {},
        ],
      };

      const { skip, take } = toSkipTake(query.page, query.limit);
      const [total, rows] = await Promise.all([
        prisma.assetRequest.count({ where }),
        prisma.assetRequest.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: 'desc' },
          include: ASSET_REQUEST_INCLUDE,
        }),
      ]);

      const approvals = await approvalSnapshots(rows.map((row) => row.approvalRequestId));
      const data: AssetRequestListItem[] = rows.map((row) =>
        toListItem(row, self?.id ?? null, approvals.get(row.approvalRequestId ?? '')),
      );

      return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
    },
  );

  app.get(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.ASSET_REQUEST_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const row = await requestOrThrow(auth.companyId, id);
      const self = await callerEmployee(auth.companyId, auth.userId);

      const isOwner = Boolean(self && row.employeeId === self.id);
      if (!isOwner && !auth.permissions.has(PERMISSIONS.ASSET_REQUEST_READ_ALL)) {
        /*
         * Not the requester and not the queue: the only way in is the employee
         * scope, which for a team manager includes their teams. Checked with a
         * real query rather than by comparing ids, so the answer is the same
         * one the list would give.
         */
        const scope = await teamScopeFilter(auth);
        const visible =
          scope !== null &&
          (await prisma.employee.count({
            where: { AND: [{ id: row.employeeId, companyId: auth.companyId }, scope] },
          })) > 0;
        if (!visible) throw new ForbiddenError('You do not have access to that request.');
      }

      const approvals = await approvalSnapshots([row.approvalRequestId]);
      const data: AssetRequestDetail = toDetail(
        row,
        self?.id ?? null,
        auth.permissions.has(PERMISSIONS.ASSET_REQUEST_FULFIL) &&
          auth.permissions.has(PERMISSIONS.ASSET_ASSIGN),
        approvals.get(row.approvalRequestId ?? ''),
      );

      return reply.send({ data });
    },
  );

  // ------------------------------------------------------- what an employee does

  /**
   * Ask for equipment.
   *
   * Carries no employee id: the requester is the session, so this endpoint
   * cannot produce a request in somebody else's name.
   *
   * The chain is resolved and checked BEFORE anything is written, for the
   * reason the leave module learned the hard way - a request row committed
   * beside a chain that turned out to be empty is a request nobody can decide
   * and nobody can withdraw.
   */
  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.ASSET_REQUEST_CREATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(assetRequestCreateSchema, request.body);

      const self = await callerEmployee(auth.companyId, auth.userId);
      if (!self) {
        throw new ForbiddenError('Your login is not linked to an employee record.');
      }

      const categories = await prisma.assetCategory.findMany({
        where: {
          companyId: auth.companyId,
          id: { in: input.items.map((item) => item.categoryId) },
          isActive: true,
        },
        select: { id: true, name: true },
      });
      const byId = new Map(categories.map((c) => [c.id, c]));
      for (const [index, item] of input.items.entries()) {
        if (!byId.has(item.categoryId)) {
          throw new ValidationError({
            [`items.${index}.categoryId`]: ['That kind of equipment does not exist or is retired.'],
          });
        }
      }

      const chain = await resolveChain(auth.companyId, 'ASSET_REQUEST', self.id);
      assertChainUsable(chain, self.id);

      const summary = input.items
        .map((item) => `${item.quantity} x ${byId.get(item.categoryId)?.name ?? 'item'}`)
        .join(', ');

      const { created, approval } = await prisma.$transaction(async (tx) => {
        const created = await tx.assetRequest.create({
          data: {
            companyId: auth.companyId,
            employeeId: self.id,
            status: 'PENDING',
            justification: input.justification,
            neededBy: input.neededBy ? dayColumn(input.neededBy) : null,
            items: {
              create: input.items.map((item) => ({
                companyId: auth.companyId,
                categoryId: item.categoryId,
                quantity: item.quantity,
                notes: item.notes,
              })),
            },
          },
        });

        const approval = await createApprovalRequest({
          companyId: auth.companyId,
          subjectType: 'ASSET_REQUEST',
          subjectId: created.id,
          requesterEmployeeId: self.id,
          requesterUserId: auth.userId,
          title: `Equipment request: ${summary}`,
          summary: input.justification,
          chain,
          request,
          client: tx,
          deferAudit: true,
        });

        await tx.assetRequest.update({
          where: { id: created.id },
          data: { approvalRequestId: approval.id },
        });

        return { created, approval };
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.request.create',
        entityType: 'AssetRequest',
        entityId: created.id,
        summary: `${displayName(self)} requested ${summary}`,
        after: { items: summary, approvalRequestId: approval.id },
        request,
      });
      await notifyApprover(approval.id, 1, request);

      return reply.status(201).send({ data: { id: created.id, approvalRequestId: approval.id } });
    },
  );

  /** Withdraw a request nobody has decided yet. */
  app.post(
    '/:id/cancel',
    { preHandler: requirePermission(PERMISSIONS.ASSET_REQUEST_CREATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const body = parseOrThrow(assetRequestCancelSchema, request.body ?? {});

      const row = await requestOrThrow(auth.companyId, id);
      const self = await callerEmployee(auth.companyId, auth.userId);

      if (!self || row.employeeId !== self.id) {
        throw new ForbiddenError('Only the person who raised a request can withdraw it.');
      }
      if (row.status !== 'PENDING') {
        throw new ConflictError(
          `That request is already ${row.status.toLowerCase()} and cannot be withdrawn.`,
        );
      }
      if (!row.approvalRequestId) throw new NotFoundError('Approval record for this request');

      const updated = await cancelApproval(auth, row.approvalRequestId, body.reason ?? null, request);
      await syncSubjectStatus('ASSET_REQUEST', row.id, updated.status);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.request.cancel',
        entityType: 'AssetRequest',
        entityId: row.id,
        summary: `Withdrew their equipment request${body.reason ? ` (${body.reason})` : ''}`,
        request,
      });

      return reply.send({ data: { id: row.id, status: 'CANCELLED' } });
    },
  );

  // --------------------------------------------- what the asset manager does

  /**
   * Issue one asset against one approved line.
   *
   * Requires BOTH `asset.request.fulfil` and `asset.assign`, because it does
   * two things: it answers a request, and it hands over company property. The
   * second half is the ordinary assignment path - the same conditional update
   * on the asset row that `/assets/:id/assign` uses, so two people issuing the
   * same laptop in the same second still produce one assignment and one 422.
   *
   * IT REFUSES ANYTHING THAT IS NOT ALREADY APPROVED. That single line is what
   * keeps fulfilment from being an approval: an asset manager handed a PENDING
   * request cannot push it forward, they can only wait for the people who
   * decide.
   */
  app.post(
    '/:id/fulfil',
    {
      preHandler: requirePermission(PERMISSIONS.ASSET_REQUEST_FULFIL, PERMISSIONS.ASSET_ASSIGN),
    },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(assetRequestFulfilSchema, request.body);

      const row = await requestOrThrow(auth.companyId, id);

      if (row.status !== 'APPROVED') {
        throw new ConflictError(
          row.status === 'PENDING'
            ? 'That request has not finished the approval chain yet. Issuing equipment is not an approval.'
            : `That request is ${row.status.toLowerCase()} and cannot be fulfilled.`,
        );
      }

      const item = row.items.find((i) => i.id === input.itemId);
      if (!item) throw new ValidationError({ itemId: ['That line is not on this request.'] });
      if (item.declinedAt) {
        throw new ConflictError('That line was declined. Nothing further can be issued against it.');
      }
      if (item.assignments.length >= item.quantity) {
        throw new ConflictError(
          `All ${item.quantity} of that line have already been issued.`,
        );
      }

      const asset = await prisma.asset.findFirst({
        where: { id: input.assetId, companyId: auth.companyId },
      });
      if (!asset) throw new ValidationError({ assetId: ['That asset does not exist.'] });
      assertAssignable(asset.status as AssetStatus);

      const employee = await prisma.employee.findFirst({
        where: { id: row.employeeId, companyId: auth.companyId },
        select: { id: true, firstName: true, lastName: true, displayName: true, userId: true, status: true },
      });
      if (!employee) throw new NotFoundError('Employee');
      if (employee.status === 'TERMINATED') {
        throw new ValidationError({
          assetId: ['That employee has left the company and cannot be issued equipment.'],
        });
      }

      const assignment = await prisma.$transaction(async (tx) => {
        const won = await claimAssetForAssignment(
          tx,
          auth.companyId,
          asset.id,
          input.conditionAtAssignment as AssetCondition,
        );
        if (!won) {
          throw new ConflictError(
            'Somebody else issued that asset a moment ago. Refresh and pick another.',
          );
        }

        return tx.assetAssignment.create({
          data: {
            companyId: auth.companyId,
            assetId: asset.id,
            employeeId: employee.id,
            assignedAt: dayColumn(input.assignedOn),
            assignedById: auth.userId,
            conditionAtAssignment: input.conditionAtAssignment as AssetCondition,
            accessoriesIssued: input.accessories,
            accessoriesReturned: [],
            accessoriesMissing: [],
            notes: input.notes,
            status: 'ACTIVE',
            acknowledgementStatus: 'PENDING',
            // The link that makes this handover an ANSWER rather than just a
            // handover. Everything else about the row is an ordinary issue.
            assetRequestItemId: item.id,
          },
        });
      });

      const after = await requestOrThrow(auth.companyId, id);
      const settled = await settleIfComplete(after, auth.userId);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.request.fulfil',
        entityType: 'AssetRequest',
        entityId: row.id,
        summary: `Issued ${asset.assetTag} - ${asset.name} to ${displayName(employee)} against their approved request, in ${ASSET_CONDITION_LABELS[input.conditionAtAssignment as AssetCondition]} condition`,
        after: {
          assignmentId: assignment.id,
          itemId: item.id,
          assetId: asset.id,
          requestStatus: settled,
        },
        request,
      });

      if (employee.userId) {
        await notify({
          companyId: auth.companyId,
          userId: employee.userId,
          type: 'SYSTEM',
          title: 'Your equipment request has been fulfilled',
          message: `${asset.name} (${asset.assetTag}) has been issued to you. Please confirm you have it.`,
          entityType: 'AssetRequest',
          entityId: row.id,
          logger: request.log,
        });
      }

      return reply.status(201).send({
        data: { id: row.id, assignmentId: assignment.id, status: settled },
      });
    },
  );

  /**
   * Answer a line the company cannot supply.
   *
   * A reason is compulsory. An approved request with a line nobody ever
   * answers is worse than a refusal: the employee is told yes and then hears
   * nothing, and the request sits in the queue for ever because it can never
   * be fully delivered.
   */
  app.post(
    '/:id/decline-item',
    { preHandler: requirePermission(PERMISSIONS.ASSET_REQUEST_FULFIL) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(assetRequestDeclineItemSchema, request.body);

      const row = await requestOrThrow(auth.companyId, id);
      if (row.status !== 'APPROVED') {
        throw new ConflictError(
          'Only an approved request can have a line declined. Declining is not a rejection - the chain decides that.',
        );
      }

      const item = row.items.find((i) => i.id === input.itemId);
      if (!item) throw new ValidationError({ itemId: ['That line is not on this request.'] });
      if (item.declinedAt) throw new ConflictError('That line has already been declined.');

      await prisma.assetRequestItem.update({
        where: { id: item.id },
        data: {
          declinedAt: new Date(),
          declinedByUserId: auth.userId,
          declineReason: input.reason,
        },
      });

      const after = await requestOrThrow(auth.companyId, id);
      const settled = await settleIfComplete(after, auth.userId);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.request.decline_item',
        entityType: 'AssetRequest',
        entityId: row.id,
        summary: `Declined ${item.quantity} x ${item.category.name} on an approved request: ${input.reason}`,
        after: { itemId: item.id, reason: input.reason, requestStatus: settled },
        request,
      });

      const employee = await prisma.employee.findFirst({
        where: { id: row.employeeId },
        select: { userId: true },
      });
      if (employee?.userId) {
        await notify({
          companyId: auth.companyId,
          userId: employee.userId,
          type: 'SYSTEM',
          title: 'Part of your equipment request cannot be supplied',
          message: `${item.category.name}: ${input.reason}`,
          entityType: 'AssetRequest',
          entityId: row.id,
          logger: request.log,
        });
      }

      return reply.send({ data: { id: row.id, itemId: item.id, status: settled } });
    },
  );
};
