import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  CASE_LIVE_STATUSES,
  CASE_PRIORITY_LABELS,
  CASE_SORT_FIELDS,
  CASE_STATUS_LABELS,
  PERMISSIONS,
  canDeskReply,
  canTransitionCase,
  caseAssignSchema,
  caseDeskReplySchema,
  casePriorityChangeSchema,
  caseQueueQuerySchema,
  caseRouteSchema,
  caseStatusChangeSchema,
  idParamSchema,
  type CasePriority,
  type CaseStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ForbiddenError } from '../../core/errors.js';
import {
  requireAuth,
  requireAnyPermission,
  requireAuthContext,
  requirePermission,
} from '../../auth/guards.js';
import { notify } from '../../core/notifications/notification.service.js';
import {
  CASE_INCLUDE,
  callerContext,
  resolveCategorySelection,
  toCaseRecord,
  type CaseRow,
} from './cases.service.js';
import {
  assertAssignable,
  assignableAgents,
  deskCaseOrThrow,
  deskQueueSummary,
  deskScopeFilter,
  resolveDeskAgent,
  toDeskDetail,
  type CaseDeskAgent,
} from './case-desk.service.js';
import { caseQueueOwners, notifyDesk } from './case-notify.service.js';

/**
 * The desk: the people who answer cases.
 *
 * Its own routes under `/cases/queue` rather than a widening parameter on the
 * employee's, and that is the single most important thing about this file. The
 * routes next door narrow every query to the caller's own employee id; these
 * narrow to the queues the caller is allowed to work. Those are two different
 * sentences about who may read what, and writing them as one route with a flag
 * is how a flag ends up defaulted wrong in a hurry one afternoon.
 *
 * Reading is gated on `case.read.department` or `case.read.all`, and how wide
 * that is comes from `resolveDeskAgent` - see `case-desk.service.ts`, which is
 * the only place in the module that decides. Every write goes through
 * `deskCaseOrThrow` first, so an agent who holds `case.update` but can only
 * read the HR queue gets a 404 on a Finance case rather than a status change.
 *
 * Every state change writes three things: the change itself, a message on the
 * case so the conversation shows what happened, and an audit entry. The message
 * matters more than it looks. A case that silently changes status is the thing
 * people ring up about, and a thread that records "moved to On hold - waiting
 * on the vendor" answers the phone call before it happens.
 */

/** A day, as the inclusive UTC instant the filter should start at. */
function startOfDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** A day, as the inclusive UTC instant the filter should end at. */
function endOfDay(day: string): Date {
  return new Date(`${day}T23:59:59.999Z`);
}

/**
 * The timestamps a status carries with it.
 *
 * Derived from the destination rather than patched in by each caller, because
 * "resolved on" and "closed on" are facts about the status and a case that is
 * live again with a resolution date on it is a case that lies on a report.
 */
function statusTimestamps(to: CaseStatus, now: Date): Prisma.CaseUpdateInput {
  if (to === 'RESOLVED') return { resolvedAt: now, closedAt: null };
  if (to === 'CLOSED') return { closedAt: now };
  // Anything else is a live status: whatever settlement was recorded no longer
  // stands, and leaving the dates behind would put one on a working case.
  return { resolvedAt: null, closedAt: null };
}

/**
 * Writes an event into the conversation.
 *
 * `senderUserId` is null, which is what marks a message as the system's own
 * account of what happened rather than something a person typed. They live in
 * the same stream as the replies because a case is read as one thread, and an
 * event that scrolls somewhere else is an event nobody reads.
 */
function eventMessage(
  companyId: string,
  caseId: string,
  message: string,
  internal: boolean,
): Prisma.PrismaPromise<{ id: string }> {
  return prisma.caseMessage.create({
    data: { companyId, caseId, senderUserId: null, message, isInternal: internal },
    select: { id: true },
  });
}

/** The requester's login, or null when their record has no account behind it. */
function requesterUserId(row: CaseRow): string | null {
  return row.requester.userId;
}

/**
 * Tells the requester something happened on their case.
 *
 * Best-effort by construction - `notify` never throws - and skipped entirely
 * for an employee with no login, who has nowhere to be told. Never called for
 * anything internal: an internal note is not merely hidden from the requester,
 * it is not sent to them.
 */
async function tellRequester(
  row: CaseRow,
  title: string,
  message: string,
  logger: Parameters<typeof notify>[0]['logger'],
): Promise<void> {
  const userId = requesterUserId(row);
  if (!userId) return;

  await notify({
    companyId: row.companyId,
    userId,
    type: 'CASE_UPDATE',
    title,
    message,
    entityType: 'Case',
    entityId: row.id,
    logger,
  });
}

/** The desk caller, or a refusal that explains which grant is missing. */
async function requireAgent(
  request: Parameters<typeof requireAuthContext>[0],
): Promise<CaseDeskAgent> {
  const agent = await resolveDeskAgent(requireAuthContext(request));
  if (!agent) {
    throw new ForbiddenError('You do not have permission to work the case queue.');
  }
  return agent;
}

export const caseDeskRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  /** Either read grant reaches every read below; the width differs, not the door. */
  const canRead = requireAnyPermission(
    PERMISSIONS.CASE_READ_DEPARTMENT,
    PERMISSIONS.CASE_READ_ALL,
  );

  /**
   * The queue's headline figures.
   *
   * Registered before `/queue/:id` for readability only - Fastify matches a
   * static segment ahead of a parameter whatever the order.
   */
  app.get('/queue/summary', { preHandler: canRead }, async (request, reply) => {
    const agent = await requireAgent(request);
    return reply.send({ data: await deskQueueSummary(agent) });
  });

  /**
   * Who a case can be handed to.
   *
   * The accounts that actually hold a desk grant, not every login in the
   * company: a case assigned to somebody who cannot open it looks handled and
   * is not. Gated on `case.assign`, because it is the assign control's list and
   * nothing else reads it.
   */
  app.get(
    '/queue/agents',
    { preHandler: requirePermission(PERMISSIONS.CASE_ASSIGN) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      await requireAgent(request);
      return reply.send({ data: await assignableAgents(auth.companyId) });
    },
  );

  /**
   * The queue.
   *
   * The scope filter is the first clause and is built outside every ternary
   * below it, so no later edit to the filters can widen it by accident. A
   * caller whose scope resolves to nothing gets an empty page rather than an
   * error: "you are on no desk" is a legitimate state, not a fault.
   */
  app.get('/queue', { preHandler: canRead }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const agent = await requireAgent(request);
    const query = parseOrThrow(caseQueueQuerySchema, request.query);

    const scope = deskScopeFilter(agent);
    if (!scope) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    /*
     * `me` and `unassigned` are resolved here rather than in the browser. The
     * screen asks the question in the words a person would use; the server
     * turns it into a user id, which is the only place that can be trusted to
     * know whose session this is.
     */
    const assigneeClause: Prisma.CaseWhereInput = !query.assignee
      ? {}
      : query.assignee === 'me'
        ? { assignedUserId: agent.userId }
        : query.assignee === 'unassigned'
          ? { assignedUserId: null }
          : { assignedUserId: query.assignee };

    const where: Prisma.CaseWhereInput = {
      AND: [
        scope,
        assigneeClause,
        query.live ? { status: { in: [...CASE_LIVE_STATUSES] } } : {},
        query.status ? { status: query.status } : {},
        query.priority ? { priority: query.priority } : {},
        query.departmentId ? { departmentId: query.departmentId } : {},
        query.categoryId
          ? { OR: [{ categoryId: query.categoryId }, { subcategoryId: query.categoryId }] }
          : {},
        query.from ? { createdAt: { gte: startOfDay(query.from) } } : {},
        query.to ? { createdAt: { lte: endOfDay(query.to) } } : {},
        /*
         * The desk searches one more column than the requester does - the
         * requester's name - because "the case Ayesha rang about" is how the
         * desk actually looks for one. It still does not search the
         * description or the conversation: that would make the index useless,
         * and a search box that reads case bodies is a way to find out what a
         * case says without opening it and leaving a trail.
         */
        query.q
          ? {
              OR: [
                { caseNumber: { contains: query.q, mode: 'insensitive' } },
                { subject: { contains: query.q, mode: 'insensitive' } },
                { requester: { firstName: { contains: query.q, mode: 'insensitive' } } },
                { requester: { lastName: { contains: query.q, mode: 'insensitive' } } },
                { requester: { employeeNumber: { contains: query.q, mode: 'insensitive' } } },
              ],
            }
          : {},
      ],
    };

    /*
     * Worst first by default, which is the order a queue is worked in. The
     * enum is declared LOW..URGENT in the schema, so `priority desc` really is
     * most-urgent-first rather than alphabetical - a property of the
     * declaration order, which is therefore not cosmetic.
     */
    const orderBy = query.sort
      ? buildOrderBy(query.sort, query.order, CASE_SORT_FIELDS, 'createdAt')
      : [{ priority: 'desc' as const }, { createdAt: 'asc' as const }];

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.case.count({ where }),
      prisma.case.findMany({ where, skip, take, orderBy, include: CASE_INCLUDE }),
    ]);

    const caller = callerContext(auth, false);
    return reply.send({
      data: rows.map((row) => toCaseRecord(row, caller)),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  /**
   * One case, as the desk reads it.
   *
   * The whole thread, internal notes included - which is the difference between
   * this and the employee's view of the same case, and the reason it is a
   * different endpoint rather than the same one with a wider query.
   */
  app.get('/queue/:id', { preHandler: canRead }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const agent = await requireAgent(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await deskCaseOrThrow(agent, id);

    const [messages, attachments] = await Promise.all([
      prisma.caseMessage.findMany({
        where: { caseId: row.id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          senderUserId: true,
          message: true,
          isInternal: true,
          createdAt: true,
          sender: { select: { id: true, firstName: true, lastName: true } },
          attachments: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              messageId: true,
              fileName: true,
              contentType: true,
              sizeBytes: true,
              createdAt: true,
              uploadedBy: { select: { firstName: true, lastName: true } },
            },
          },
        },
      }),
      prisma.caseAttachment.findMany({
        where: { caseId: row.id, messageId: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          messageId: true,
          fileName: true,
          contentType: true,
          sizeBytes: true,
          createdAt: true,
          uploadedBy: { select: { firstName: true, lastName: true } },
        },
      }),
    ]);

    return reply.send({
      data: toDeskDetail(row, auth, {
        messages,
        attachments,
        // Whose side of the conversation a message sits on is decided against
        // the REQUESTER's account, not the reader's - so the employee's words
        // are the employee's words however senior the person reading is.
        requesterUserId: requesterUserId(row),
      }),
    });
  });

  /**
   * Taking a case, handing it over, or putting it back.
   *
   * The assignee is re-read against the accounts that hold a desk grant, so a
   * case cannot be assigned into a hole. The event is written as an INTERNAL
   * note: who is holding a case is queue mechanics, the requester already sees
   * the current owner on their own view of the case, and a thread that fills up
   * with reassignments is one nobody reads to the end.
   */
  app.post(
    '/queue/:id/assign',
    { preHandler: requirePermission(PERMISSIONS.CASE_ASSIGN) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const agent = await requireAgent(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(caseAssignSchema, request.body);

      const row = await deskCaseOrThrow(agent, id);

      if (input.assignedUserId) await assertAssignable(auth.companyId, input.assignedUserId);

      const assignee = input.assignedUserId
        ? await prisma.user.findFirst({
            where: { id: input.assignedUserId, companyId: auth.companyId },
            select: { id: true, firstName: true, lastName: true },
          })
        : null;

      const assigneeName = assignee ? `${assignee.firstName} ${assignee.lastName}`.trim() : null;
      const event = assigneeName
        ? `Assigned to ${assigneeName}.`
        : 'Unassigned and put back on the queue.';

      const [updated] = await prisma.$transaction([
        prisma.case.update({
          where: { id: row.id },
          data: {
            assignedUserId: input.assignedUserId,
            assignedAt: input.assignedUserId ? new Date() : null,
            lastMessageAt: new Date(),
          },
          include: CASE_INCLUDE,
        }),
        eventMessage(auth.companyId, row.id, event, true),
      ]);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'case.assign',
        entityType: 'Case',
        entityId: row.id,
        summary: `${event.replace(/\.$/, '')} on case ${row.caseNumber}`,
        before: { assignedUserId: row.assignedUserId },
        after: { assignedUserId: input.assignedUserId },
        request,
      });

      /*
       * The new owner is told, unless they are the person who just took it -
       * a notification about your own click is noise, and noise is what makes
       * people stop reading the inbox the real ones arrive in. A case put back
       * on the queue goes to the queue's owners instead, so "nobody's" never
       * means "nobody knows". The old assignee is not told either way: they
       * are no longer the person who has to act.
       */
      if (input.assignedUserId) {
        await notifyDesk({
          companyId: auth.companyId,
          caseId: row.id,
          userIds: [input.assignedUserId],
          actorUserId: auth.userId,
          title: `Case ${row.caseNumber} assigned to you`,
          message: `${row.subject} - ${CASE_PRIORITY_LABELS[row.priority as CasePriority].toLowerCase()} priority, filed with ${row.department.name}.`,
          logger: request.log,
        });
      } else if (row.assignedUserId) {
        await notifyDesk({
          companyId: auth.companyId,
          caseId: row.id,
          userIds: await caseQueueOwners(auth.companyId, row.departmentId),
          actorUserId: auth.userId,
          title: `Case ${row.caseNumber} is unassigned`,
          message: `${row.subject} - put back on the ${row.department.name} queue and waiting for somebody to pick it up.`,
          logger: request.log,
        });
      }

      return reply.send({ data: toCaseRecord(updated, callerContext(auth, false)) });
    },
  );

  /**
   * Moving a case along.
   *
   * Checked against the shared transition map, which is the only statement of
   * the workflow anywhere - so this grant buys the workflow rather than a free
   * hand, and a status the map does not allow is refused however the request
   * was built. The optional note becomes a message, because a status that
   * changes with no explanation is the thing people ring up about.
   */
  app.post(
    '/queue/:id/status',
    { preHandler: requirePermission(PERMISSIONS.CASE_UPDATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const agent = await requireAgent(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(caseStatusChangeSchema, request.body);

      const row = await deskCaseOrThrow(agent, id);
      const from = row.status as CaseStatus;

      if (from === input.status) {
        throw new ConflictError(`This case is already ${CASE_STATUS_LABELS[from].toLowerCase()}.`);
      }
      if (!canTransitionCase(from, input.status)) {
        throw new ConflictError(
          `A case that is ${CASE_STATUS_LABELS[from].toLowerCase()} cannot be marked ${CASE_STATUS_LABELS[input.status].toLowerCase()}.`,
        );
      }

      /*
       * Refused rather than quietly published. Somebody who ticked "internal"
       * and had their words sent to the requester is the worst failure this
       * endpoint could have, so a note that cannot be written internally is not
       * written at all.
       */
      if (input.internal && !auth.permissions.has(PERMISSIONS.CASE_NOTE_INTERNAL)) {
        throw new ForbiddenError('You do not have permission to write an internal note.');
      }

      const now = new Date();
      const writes: Prisma.PrismaPromise<unknown>[] = [
        prisma.case.update({
          where: { id: row.id },
          data: {
            status: input.status,
            ...statusTimestamps(input.status, now),
            // The event below is a message, so this moves whether or not a note
            // came with it - `lastMessageAt` means the last message of ANY
            // kind, and a case that has just changed hands is not untouched.
            lastMessageAt: now,
          },
          include: CASE_INCLUDE,
        }),
        eventMessage(
          auth.companyId,
          row.id,
          `Status changed from ${CASE_STATUS_LABELS[from]} to ${CASE_STATUS_LABELS[input.status]}.`,
          false,
        ),
      ];

      if (input.note) {
        writes.push(
          prisma.caseMessage.create({
            data: {
              companyId: auth.companyId,
              caseId: row.id,
              senderUserId: auth.userId,
              message: input.note,
              isInternal: input.internal,
            },
            select: { id: true },
          }),
        );
      }

      const [updated] = (await prisma.$transaction(writes)) as [CaseRow, ...unknown[]];

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'case.status.change',
        entityType: 'Case',
        entityId: row.id,
        summary: `Case ${row.caseNumber} moved to ${CASE_STATUS_LABELS[input.status]}`,
        before: { status: from, resolvedAt: row.resolvedAt, closedAt: row.closedAt },
        // The note's text is not written here. The trail records that the case
        // moved and who moved it; what was said lives on the case, where the
        // people entitled to read it already are.
        after: { status: input.status, noted: Boolean(input.note), internal: input.internal },
        request,
      });

      await tellRequester(
        row,
        input.status === 'PENDING'
          ? `Case ${row.caseNumber} is waiting on you`
          : `Case ${row.caseNumber} is now ${CASE_STATUS_LABELS[input.status].toLowerCase()}`,
        // The note travels only when it was a public one. An internal note is
        // not sent, not summarised, and not hinted at.
        input.note && !input.internal
          ? `${row.subject} - ${input.note}`
          : input.status === 'PENDING'
            ? `${row.subject} - the desk needs more information from you. Reply on the case.`
            : `${row.subject} - ${CASE_STATUS_LABELS[input.status]}.`,
        request.log,
      );

      // Somebody else moved the assignee's case: they are the one who acts on it.
      await notifyDesk({
        companyId: auth.companyId,
        caseId: row.id,
        userIds: [row.assignedUserId],
        actorUserId: auth.userId,
        title: `Case ${row.caseNumber} moved to ${CASE_STATUS_LABELS[input.status].toLowerCase()}`,
        message: `${row.subject} - ${CASE_STATUS_LABELS[from]} to ${CASE_STATUS_LABELS[input.status]}.`,
        logger: request.log,
      });

      return reply.send({ data: toCaseRecord(updated, callerContext(auth, false)) });
    },
  );

  /**
   * Re-judging how urgent a case is.
   *
   * The desk's call once they have seen it, and recorded as an internal event:
   * a requester who marked their own case Urgent and watches it silently become
   * Normal learns only that the form was pointless. What they are owed is an
   * answer, and that is a reply.
   */
  app.post(
    '/queue/:id/priority',
    { preHandler: requirePermission(PERMISSIONS.CASE_UPDATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const agent = await requireAgent(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(casePriorityChangeSchema, request.body);

      const row = await deskCaseOrThrow(agent, id);
      const from = row.priority as CasePriority;

      if (from === input.priority) {
        throw new ConflictError(
          `This case is already ${CASE_PRIORITY_LABELS[from].toLowerCase()} priority.`,
        );
      }

      const [updated] = await prisma.$transaction([
        prisma.case.update({
          where: { id: row.id },
          data: { priority: input.priority, lastMessageAt: new Date() },
          include: CASE_INCLUDE,
        }),
        eventMessage(
          auth.companyId,
          row.id,
          `Priority changed from ${CASE_PRIORITY_LABELS[from]} to ${CASE_PRIORITY_LABELS[input.priority]}.`,
          true,
        ),
      ]);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'case.priority.change',
        entityType: 'Case',
        entityId: row.id,
        summary: `Case ${row.caseNumber} set to ${CASE_PRIORITY_LABELS[input.priority]} priority`,
        before: { priority: from },
        after: { priority: input.priority },
        request,
      });

      await notifyDesk({
        companyId: auth.companyId,
        caseId: row.id,
        userIds: [row.assignedUserId],
        actorUserId: auth.userId,
        title: `Case ${row.caseNumber} is now ${CASE_PRIORITY_LABELS[input.priority].toLowerCase()} priority`,
        message: `${row.subject} - priority changed from ${CASE_PRIORITY_LABELS[from]} to ${CASE_PRIORITY_LABELS[input.priority]}.`,
        logger: request.log,
      });

      return reply.send({ data: toCaseRecord(updated, callerContext(auth, false)) });
    },
  );

  /**
   * Re-routing a misfiled case.
   *
   * The commonest thing that happens to a real ticket, and the alternative is a
   * desk that closes cases with "raise this with IT instead" - which loses the
   * conversation and makes the requester do the routing twice.
   *
   * The selection goes through `resolveCategorySelection`, the same function
   * the create form's does, so a re-route cannot put a case somewhere a new
   * case could not have been filed.
   *
   * A case can be routed OUT of the caller's own scope, and that is deliberate:
   * handing a case to another department is the point of the control. What
   * follows is that the caller may no longer be able to open it - which is
   * correct, and is why the response carries the case one last time.
   */
  app.post(
    '/queue/:id/route',
    { preHandler: requirePermission(PERMISSIONS.CASE_UPDATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const agent = await requireAgent(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(caseRouteSchema, request.body);

      const row = await deskCaseOrThrow(agent, id);

      if (!canDeskReply(row.status)) {
        throw new ConflictError('This case is closed, so it cannot be re-routed. Reopen it first.');
      }

      const routing = await resolveCategorySelection(auth.companyId, {
        departmentId: input.departmentId,
        categoryId: input.categoryId,
        subcategoryId: input.subcategoryId,
      });

      const unchanged =
        routing.departmentId === row.departmentId &&
        routing.categoryId === row.categoryId &&
        routing.subcategoryId === row.subcategoryId;
      if (unchanged) throw new ConflictError('This case is already filed there.');

      const destination = await prisma.caseCategory.findFirst({
        where: { id: routing.categoryId },
        select: { name: true, department: { select: { name: true } } },
      });

      const now = new Date();
      const moved = `Moved to ${destination?.department.name ?? 'another department'} · ${destination?.name ?? 'another queue'}.`;

      const writes: Prisma.PrismaPromise<unknown>[] = [
        prisma.case.update({
          where: { id: row.id },
          data: {
            departmentId: routing.departmentId,
            categoryId: routing.categoryId,
            subcategoryId: routing.subcategoryId,
            /*
             * A re-routed case goes back to nobody. The person holding it was
             * on the old desk, and leaving them on it would hide the case from
             * the new department's unassigned queue - which is precisely where
             * it now needs to be seen.
             */
            assignedUserId: null,
            assignedAt: null,
            lastMessageAt: now,
          },
          include: CASE_INCLUDE,
        }),
        eventMessage(auth.companyId, row.id, moved, false),
      ];

      if (input.note) {
        writes.push(
          prisma.caseMessage.create({
            data: {
              companyId: auth.companyId,
              caseId: row.id,
              senderUserId: auth.userId,
              message: input.note,
              isInternal: false,
            },
            select: { id: true },
          }),
        );
      }

      const [updated] = (await prisma.$transaction(writes)) as [CaseRow, ...unknown[]];

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'case.route',
        entityType: 'Case',
        entityId: row.id,
        summary: `Case ${row.caseNumber} re-routed to ${destination?.department.name ?? 'another department'}`,
        before: {
          departmentId: row.departmentId,
          categoryId: row.categoryId,
          subcategoryId: row.subcategoryId,
          assignedUserId: row.assignedUserId,
        },
        after: routing,
        request,
      });

      await tellRequester(
        row,
        `Case ${row.caseNumber} moved to ${destination?.department.name ?? 'another team'}`,
        input.note ? `${row.subject} - ${input.note}` : `${row.subject} - ${moved}`,
        request.log,
      );

      // The case arrives on the new department's queue with nobody holding it.
      await notifyDesk({
        companyId: auth.companyId,
        caseId: row.id,
        userIds: await caseQueueOwners(auth.companyId, routing.departmentId),
        actorUserId: auth.userId,
        title: `Case ${row.caseNumber} routed to ${destination?.department.name ?? 'your queue'}`,
        message: `${row.subject} - ${moved.replace(/\.$/, '')}, unassigned.`,
        logger: request.log,
      });

      return reply.send({ data: toCaseRecord(updated, callerContext(auth, false)) });
    },
  );

  /**
   * The desk's reply, and the desk's note.
   *
   * One endpoint for both, because they are written in the same box on the same
   * screen about the same case - but they are two different acts and are gated
   * separately. A reply needs `case.respond` and reaches the requester; a note
   * needs `case.note.internal`, is filtered out of every employee query, and is
   * never notified. Holding one grant does not get you the other's behaviour by
   * sending the other's flag.
   */
  app.post(
    '/queue/:id/messages',
    {
      preHandler: requireAnyPermission(
        PERMISSIONS.CASE_RESPOND,
        PERMISSIONS.CASE_NOTE_INTERNAL,
      ),
    },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const agent = await requireAgent(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(caseDeskReplySchema, request.body);

      const row = await deskCaseOrThrow(agent, id);

      if (!canDeskReply(row.status)) {
        throw new ConflictError('This case is closed. Reopen it to carry on the conversation.');
      }

      const needed = input.internal ? PERMISSIONS.CASE_NOTE_INTERNAL : PERMISSIONS.CASE_RESPOND;
      if (!auth.permissions.has(needed)) {
        throw new ForbiddenError(
          input.internal
            ? 'You do not have permission to write an internal note.'
            : 'You do not have permission to reply to the requester.',
        );
      }

      const now = new Date();
      const [message] = await prisma.$transaction([
        prisma.caseMessage.create({
          data: {
            companyId: auth.companyId,
            caseId: row.id,
            senderUserId: auth.userId,
            message: input.message,
            isInternal: input.internal,
          },
          select: { id: true, createdAt: true },
        }),
        /*
         * An internal note moves `lastMessageAt` too. It is the desk's list
         * that column sorts, and a case somebody has been annotating all
         * morning is not untouched - the requester's view of the same case
         * shows them only the messages they can see, which is the separation
         * that matters.
         */
        prisma.case.update({ where: { id: row.id }, data: { lastMessageAt: now } }),
      ]);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: input.internal ? 'case.note' : 'case.respond',
        entityType: 'Case',
        entityId: row.id,
        summary: input.internal
          ? `Wrote an internal note on case ${row.caseNumber}`
          : `Replied to the requester on case ${row.caseNumber}`,
        after: { messageId: message.id, characters: input.message.length },
        request,
      });

      if (!input.internal) {
        await tellRequester(
          row,
          `New reply on case ${row.caseNumber}`,
          `${row.subject} - there is a reply waiting for you.`,
          request.log,
        );
      }

      // A colleague wrote on the assignee's case. The text stays on the case.
      await notifyDesk({
        companyId: auth.companyId,
        caseId: row.id,
        userIds: [row.assignedUserId],
        actorUserId: auth.userId,
        title: input.internal
          ? `Internal note on case ${row.caseNumber}`
          : `Reply sent on case ${row.caseNumber}`,
        message: `${row.subject} - a colleague added to the case you hold.`,
        logger: request.log,
      });

      return reply.status(201).send({ data: { id: message.id, internal: input.internal } });
    },
  );
};
