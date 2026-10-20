import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  CASE_PRIORITY_LABELS,
  CASE_SORT_FIELDS,
  CASE_STATUS_LABELS,
  PERMISSIONS,
  canRequesterReopen,
  canRequesterReply,
  canRequesterTransition,
  caseCreateSchema,
  caseMentionFeedQuerySchema,
  caseQuerySchema,
  caseReopenSchema,
  caseReplySchema,
  idParamSchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError } from '../../core/errors.js';
import { requireAuth, requireAnyPermission, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { notify } from '../../core/notifications/notification.service.js';
import {
  CASE_INCLUDE,
  EMPTY_CASE_SUMMARY,
  callerContext,
  caseCatalogue,
  caseSummaryFor,
  createCaseWithNumber,
  ownCaseOrThrow,
  requireRequester,
  resolveCategorySelection,
  resolveRequester,
  toCaseDetail,
  toCaseRecord,
} from './cases.service.js';
import { caseQueueOwners, caseResponsible, notifyDesk } from './case-notify.service.js';
import { MESSAGE_MENTIONS_SELECT, mentionFeed } from './case-mentions.service.js';

/**
 * Cases: the employee's side of the helpdesk.
 *
 * Phase 1 is one person's view of this module - their own cases and nothing
 * else - and the design follows from that rather than from a permission check
 * bolted onto a wider query. Every route below resolves the caller's own
 * employee record from the session and puts it in the WHERE clause, so there is
 * no code path here that is ever holding somebody else's case, and no branch
 * anybody can add later that forgets to narrow. Changing an id in a URL meets a
 * 404, and it meets a 404 rather than a 403 on purpose: refusing a guessed id
 * confirms the id exists, which is the fact the guesser was after.
 *
 * What is deliberately absent is as much of the design as what is here. There
 * is no `employeeId` parameter on any route, no `view=all`, no data-scope
 * widening. A manager holds a REPORTS_AND_OWN scope for employee records and it
 * buys them nothing at all in this module, because a reporting line is not a
 * reason to read what somebody asked HR about. Phase 2's agent side arrives as
 * its own routes with their own grants; none of these relax.
 *
 * The permissions are split four ways rather than one, and each split earns its
 * keep: a company can stop new cases during a freeze (`case.create`) without
 * silencing the open ones (`case.reply.own`), and can let people follow a case
 * (`case.read.own`) without letting them reopen a settled one
 * (`case.reopen.own`).
 */

/** A day, as the inclusive UTC instant the filter should start at. */
function startOfDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** A day, as the inclusive UTC instant the filter should end at. */
function endOfDay(day: string): Date {
  return new Date(`${day}T23:59:59.999Z`);
}

export const caseRoutes: FastifyPluginAsync = async (app) => {
  /*
   * Signed in is the whole of the plugin-level gate; each route carries its
   * own. Deliberately not one blanket `case.read.own`: raising a case and
   * reading one are separate grants, and a single hook would quietly make one
   * imply the other.
   */
  app.addHook('preHandler', requireAuth);

  /**
   * The create form's entire vocabulary: departments, categories, subcategories.
   *
   * Configuration, not content - it names no employee and no case - so reading
   * it needs only a reason to be on this screen at all. It is also what draws
   * the list's department and category filters, which is why `case.read.own`
   * reaches it as well as `case.create`.
   *
   * The departments in here are the company's OWN department rows. There is no
   * second list, and an employee cannot type one: the create endpoint takes
   * ids and re-reads every one of them.
   */
  app.get(
    '/categories',
    { preHandler: requireAnyPermission(PERMISSIONS.CASE_READ_OWN, PERMISSIONS.CASE_CREATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      return reply.send({ data: await caseCatalogue(auth.companyId) });
    },
  );

  /**
   * The dashboard card's figures: the caller's own cases, counted by status.
   *
   * Registered before `/:id` in source order for readability only - Fastify
   * matches a static segment ahead of a parameter whatever the order, which is
   * what makes `/cases/summary` unambiguous.
   */
  app.get(
    '/summary',
    { preHandler: requirePermission(PERMISSIONS.CASE_READ_OWN) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const requester = await resolveRequester(auth);

      // No employee record, so no cases. Zeroes rather than an error: the card
      // is one of many on a dashboard and must not take the page down.
      if (!requester) return reply.send({ data: EMPTY_CASE_SUMMARY });

      return reply.send({ data: await caseSummaryFor(requester) });
    },
  );

  /**
   * Where the caller has been tagged: the dashboard's "Mentions & follow-ups".
   *
   * Anybody who can read a case from either side may have been tagged in one,
   * so either grant reaches it. The rows are the caller's own mentions and
   * nobody else's, and each is re-checked against what the caller can open
   * now - see `mentionFeed`.
   */
  app.get(
    '/mentions',
    {
      preHandler: requireAnyPermission(
        PERMISSIONS.CASE_READ_OWN,
        PERMISSIONS.CASE_READ_DEPARTMENT,
        PERMISSIONS.CASE_READ_ALL,
      ),
    },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { limit } = parseOrThrow(caseMentionFeedQuerySchema, request.query);
      return reply.send({ data: await mentionFeed(auth, limit) });
    },
  );

  /**
   * My cases.
   *
   * Every filter is applied by the database and the page is a page: an employee
   * with four years of cases must not have them all sent to the browser so it
   * can hide most of them. The search covers the case number and the subject
   * only - not the description and not the conversation, which would make the
   * index useless and would turn the search box into a way to confirm what a
   * case says without opening it.
   */
  app.get(
    '/',
    { preHandler: requirePermission(PERMISSIONS.CASE_READ_OWN) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const query = parseOrThrow(caseQuerySchema, request.query);
      const requester = await resolveRequester(auth);

      if (!requester) {
        return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
      }

      /*
       * The first two clauses are the security boundary and everything after
       * them is the user's own filtering. They are stated first, unconditionally
       * and outside any ternary, so that no future edit to the filters can
       * accidentally widen them.
       */
      const where: Prisma.CaseWhereInput = {
        AND: [
          { companyId: requester.companyId },
          { requesterEmployeeId: requester.employeeId },
          query.status ? { status: query.status } : {},
          query.priority ? { priority: query.priority } : {},
          query.departmentId ? { departmentId: query.departmentId } : {},
          // Matches the case's category OR its subcategory, so filtering by
          // "Salary" finds the cases filed under it directly and the ones filed
          // under one of its children.
          query.categoryId
            ? {
                OR: [{ categoryId: query.categoryId }, { subcategoryId: query.categoryId }],
              }
            : {},
          query.from ? { createdAt: { gte: startOfDay(query.from) } } : {},
          query.to ? { createdAt: { lte: endOfDay(query.to) } } : {},
          query.q
            ? {
                OR: [
                  { caseNumber: { contains: query.q, mode: 'insensitive' } },
                  { subject: { contains: query.q, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      };

      /*
       * Sorting by priority works because PostgreSQL orders an enum by the
       * order its values were DECLARED, and `CasePriority` is declared
       * LOW..URGENT - so `priority desc` really is worst-first rather than
       * alphabetical. That is a property of the enum, so the declaration order
       * in the schema is not cosmetic.
       */
      const orderBy = buildOrderBy(query.sort, query.order, CASE_SORT_FIELDS, 'createdAt');

      const { skip, take } = toSkipTake(query.page, query.limit);
      const [total, rows] = await Promise.all([
        prisma.case.count({ where }),
        prisma.case.findMany({ where, skip, take, orderBy, include: CASE_INCLUDE }),
      ]);

      const caller = callerContext(auth);
      return reply.send({
        data: rows.map((row) => toCaseRecord(row, caller)),
        meta: buildMeta(query.page, query.limit, total),
      });
    },
  );

  /**
   * Raising a case.
   *
   * The body carries no employee id, and that is the whole of the creation
   * security story: the requester comes from the session, so there is no field
   * an employee could set to raise a case as somebody else. Phase 2's "raise on
   * behalf of" is a separate endpoint with its own permission rather than an
   * optional field here, because an optional field is exactly how that
   * permission gets forgotten.
   *
   * The department, category and subcategory are ids and every one of them is
   * re-read against the company's own rows - see `resolveCategorySelection`,
   * which also refuses a category that belongs to a different department and a
   * subcategory that belongs to a different category. A hand-built POST cannot
   * file an IT case against the Finance queue.
   */
  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.CASE_CREATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(caseCreateSchema, request.body);
      const requester = requireRequester(await resolveRequester(auth));

      const routing = await resolveCategorySelection(auth.companyId, {
        departmentId: input.departmentId,
        categoryId: input.categoryId,
        subcategoryId: input.subcategoryId,
      });

      const created = await createCaseWithNumber({
        companyId: auth.companyId,
        requesterEmployeeId: requester.employeeId,
        departmentId: routing.departmentId,
        categoryId: routing.categoryId,
        subcategoryId: routing.subcategoryId,
        subject: input.subject,
        description: input.description,
        priority: input.priority,
        // Stated rather than left to the column default, so the one status a
        // new case may have is visible at the call site.
        status: 'OPEN',
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'case.create',
        entityType: 'Case',
        entityId: created.id,
        summary: `Raised case ${created.caseNumber}: ${created.subject}`,
        after: {
          caseNumber: created.caseNumber,
          department: created.department.name,
          category: created.category.name,
          subcategory: created.subcategory?.name ?? null,
          priority: created.priority,
          status: created.status,
        },
        request,
      });

      /*
       * The receipt, in the requester's own inbox.
       *
       * Not noise: it is the durable record that the case was accepted and what
       * its number is, which is the thing somebody goes looking for a week
       * later. Best-effort by construction - `notify` never throws - so a
       * notification failure cannot lose a case that has already been written.
       */
      await notify({
        companyId: auth.companyId,
        userId: auth.userId,
        type: 'CASE_UPDATE',
        title: `Case ${created.caseNumber} raised`,
        message: `${created.subject} - filed with ${created.department.name} under ${created.category.name}.`,
        entityType: 'Case',
        entityId: created.id,
        logger: request.log,
      });

      /*
       * And the desk. A new case has nobody holding it, so the department's
       * queue owners are told - its own desk members and head, or the
       * company-wide dispatchers when the department has neither. See
       * `caseQueueOwners`: it is never everybody in the department.
       */
      await notifyDesk({
        companyId: auth.companyId,
        caseId: created.id,
        userIds: await caseQueueOwners(auth.companyId, created.departmentId),
        actorUserId: auth.userId,
        title: `New case ${created.caseNumber} for ${created.department.name}`,
        message: `${created.subject} - ${created.category.name}${
          created.subcategory ? ` · ${created.subcategory.name}` : ''
        }, ${CASE_PRIORITY_LABELS[created.priority].toLowerCase()} priority, raised by ${
          created.requester.displayName ??
          `${created.requester.firstName} ${created.requester.lastName}`.trim()
        }. Unassigned.`,
        logger: request.log,
      });

      return reply.status(201).send({ data: toCaseRecord(created, callerContext(auth)) });
    },
  );

  /**
   * One case, with its conversation.
   *
   * `ownCaseOrThrow` is the only way in, and it takes the requester rather than
   * just an id. Staff-only notes and the files attached to them are excluded by
   * the QUERY rather than by the render, so they are absent from the response
   * instead of merely invisible in it - a note filtered in the browser is a
   * note in the browser.
   */
  app.get(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.CASE_READ_OWN) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const requester = requireRequester(await resolveRequester(auth));

      const row = await ownCaseOrThrow(requester, id);

      const [messages, attachments] = await Promise.all([
        prisma.caseMessage.findMany({
          where: { caseId: row.id, isInternal: false },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            senderUserId: true,
            message: true,
            isInternal: true,
            createdAt: true,
            sender: { select: { id: true, firstName: true, lastName: true } },
            attachments: {
              where: { isInternal: false },
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
            mentions: MESSAGE_MENTIONS_SELECT,
          },
        }),
        // Files hung on the case itself rather than on any one reply - which is
        // what the create form produces.
        prisma.caseAttachment.findMany({
          where: { caseId: row.id, messageId: null, isInternal: false },
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
        data: toCaseDetail(row, callerContext(auth), {
          messages,
          attachments,
          requesterUserId: requester.userId,
        }),
      });
    },
  );

  /**
   * Replying to your own case.
   *
   * `isInternal: false` is written here rather than read from the body, so
   * there is no payload that turns an employee's reply into a staff note and
   * nothing to forget to check when phase 2 adds the agent-side form.
   *
   * A CLOSED case takes no replies - reopening it is the way back in, which is
   * a status change, is audited as one, and puts the case back on a queue
   * rather than adding a message nobody is watching. A RESOLVED one does take
   * them, because "that did not fix it" is the most useful sentence on a
   * helpdesk and making somebody reopen the case first buries it.
   */
  app.post(
    '/:id/messages',
    { preHandler: requirePermission(PERMISSIONS.CASE_REPLY_OWN) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(caseReplySchema, request.body);
      const requester = requireRequester(await resolveRequester(auth));

      const row = await ownCaseOrThrow(requester, id);

      if (!canRequesterReply(row.status)) {
        throw new ConflictError(
          'This case is closed. Reopen it if there is something still wrong.',
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
            isInternal: false,
          },
          select: { id: true, createdAt: true },
        }),
        /*
         * The case row is touched so `updatedAt` moves and `lastMessageAt`
         * records the reply. Without this a case that has been talked about all
         * morning shows on the list as untouched since it was raised, because a
         * message is a row in another table.
         */
        prisma.case.update({
          where: { id: row.id },
          data: { lastMessageAt: now },
        }),
      ]);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'case.reply',
        entityType: 'Case',
        entityId: row.id,
        summary: `Replied on case ${row.caseNumber}`,
        // The reply's TEXT is not written to the audit log. The trail records
        // that somebody replied and when; what they said lives in the case,
        // where the people entitled to read it already are.
        after: { messageId: message.id, characters: input.message.length },
        request,
      });

      // The requester answered: whoever holds the case, or its queue, acts next.
      await notifyDesk({
        companyId: auth.companyId,
        caseId: row.id,
        userIds: await caseResponsible(row),
        actorUserId: auth.userId,
        title: `Requester replied on case ${row.caseNumber}`,
        message: `${row.subject} - a new reply is waiting.`,
        logger: request.log,
      });

      return reply.status(201).send({ data: { id: message.id } });
    },
  );

  /**
   * Reopening your own settled case.
   *
   * The one status change that belongs to the requester, because they are the
   * only person who can tell whether the thing is actually fixed. Gated on its
   * own permission and checked against the shared transition map twice over -
   * once for what anybody may do from this status, once for what a REQUESTER
   * may - so holding `case.reopen.own` can never become a way to mark your own
   * case resolved or to lift it off somebody's queue.
   *
   * The reason becomes the first message of the reopened conversation rather
   * than a field nobody reads. `resolvedAt` and `closedAt` are cleared: they
   * describe a settlement that no longer stands, and leaving them behind would
   * put a resolution date on a live case.
   */
  app.post(
    '/:id/reopen',
    { preHandler: requirePermission(PERMISSIONS.CASE_REOPEN_OWN) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(caseReopenSchema, request.body);
      const requester = requireRequester(await resolveRequester(auth));

      const row = await ownCaseOrThrow(requester, id);

      if (!canRequesterReopen(row.status) || !canRequesterTransition(row.status, 'REOPENED')) {
        throw new ConflictError(
          `A case that is ${CASE_STATUS_LABELS[row.status].toLowerCase()} cannot be reopened.`,
        );
      }

      const now = new Date();
      const [updated] = await prisma.$transaction([
        prisma.case.update({
          where: { id: row.id },
          data: {
            status: 'REOPENED',
            resolvedAt: null,
            closedAt: null,
            lastMessageAt: now,
          },
          include: CASE_INCLUDE,
        }),
        prisma.caseMessage.create({
          data: {
            companyId: auth.companyId,
            caseId: row.id,
            senderUserId: auth.userId,
            message: input.reason,
            isInternal: false,
          },
          select: { id: true },
        }),
      ]);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'case.status.change',
        entityType: 'Case',
        entityId: row.id,
        summary: `Reopened case ${row.caseNumber}`,
        before: { status: row.status, resolvedAt: row.resolvedAt, closedAt: row.closedAt },
        after: { status: 'REOPENED', reason: input.reason },
        request,
      });

      await notifyDesk({
        companyId: auth.companyId,
        caseId: row.id,
        userIds: await caseResponsible(row),
        actorUserId: auth.userId,
        title: `Case ${row.caseNumber} reopened`,
        message: `${row.subject} - the requester says it is not settled.`,
        logger: request.log,
      });

      return reply.send({ data: toCaseRecord(updated, callerContext(auth)) });
    },
  );
};
