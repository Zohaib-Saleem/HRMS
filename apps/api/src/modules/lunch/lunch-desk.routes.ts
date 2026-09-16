import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  LUNCH_CANCEL_RESOLUTION_LABELS,
  LUNCH_ORDER_SORT_FIELDS,
  LUNCH_ORDER_STATUS_LABELS,
  LUNCH_PAID_CANCEL_MESSAGE,
  LUNCH_PAYMENT_METHOD_LABELS,
  LUNCH_RESOLUTION_REFUND_STATUS,
  PERMISSIONS,
  canAdvanceLunchOrder,
  canMarkLunchOrderPaid,
  canOperatorCancelLunchOrder,
  idParamSchema,
  lunchCollectionQuerySchema,
  lunchDaySchema,
  lunchOperatorCancelSchema,
  lunchOrderStatusSchema,
  lunchPaymentCorrectionSchema,
  lunchPaymentSchema,
  type LunchOrderStatus,
  type LunchPaymentStatus,
} from '@hrms/shared';
import { z } from 'zod';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ForbiddenError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import {
  LUNCH_ORDER_INCLUDE,
  callerContext,
  collectionSummary,
  companyOrderOrThrow,
  dayKeyToDateColumn,
  foodSummary,
  lunchToday,
  resolveOrderer,
  toLunchOrderRecord,
} from './lunch.service.js';

/**
 * The lunch operator's side: the office boy's own screen.
 *
 * This is the other half of the module and it is its own routes, its own grants
 * and its own screen - not the employee's endpoints with a `view=all` on them.
 * The separation is the design: the employee's routes narrow to their own
 * employee id in the WHERE clause, and these narrow to a company and a DAY,
 * because a day's collection is what the office boy is actually holding in his
 * hand. A single set of handlers with a flag deciding which is a flag somebody
 * defaults wrong once.
 *
 * Three grants, and they are three because they are three different jobs:
 *
 *   `lunch.collection.read`   see the day's orders and what they come to. An
 *                             administrator may hold this for the figures
 *                             without ever touching the money.
 *   `lunch.payment.mark`      record that somebody handed the money over.
 *   `lunch.payment.correct`   put right a payment recorded wrongly, with a
 *                             written reason, audited. Never arrives with
 *                             `mark`: the person who can take money and the
 *                             person who can undo having taken it are worth
 *                             being able to keep apart.
 *
 * Nobody marks their OWN lunch paid here, whatever they hold. The office boy
 * eats too, and without that rule the one person able to record himself as
 * having paid would be the person collecting.
 *
 * What is not here matters as much: no approval step, no finance hand-off, no
 * posting to payroll, no end-of-day submission for somebody else to sign. The
 * day's close is a summary the office boy reads, not a document he files.
 */

/** The day being collected for, defaulting to the company's own today. */
const dayQuerySchema = z.object({ day: lunchDaySchema.optional() });

export const lunchDeskRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  /**
   * Today's collection: the six figures, and nothing else.
   *
   * Its own endpoint rather than a header on the list, because the figures are
   * about the whole day and the list below them is one page of it. Computing
   * them from the page would make "Expected" mean "expected from the twenty
   * orders you can currently see", which is the kind of number that gets
   * somebody blamed for a shortfall at six o'clock.
   */
  app.get(
    '/collection',
    { preHandler: requirePermission(PERMISSIONS.LUNCH_COLLECTION_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { day } = parseOrThrow(dayQuerySchema, request.query);
      const serviceDay = day ?? (await lunchToday(auth.companyId));

      return reply.send({ data: await collectionSummary(auth.companyId, serviceDay) });
    },
  );

  /**
   * What the kitchen has to make: plates per item, for the day.
   *
   * Its own endpoint rather than a field on the collection summary, because it
   * is a different question asked by a different person at a different time -
   * the cook wants it at eleven and the office boy wants the money at two.
   *
   * Cancelled orders contribute nothing to it. The moment an order is
   * cancelled its plates leave this count, whether or not it was paid for and
   * whether or not that money was retained: keeping the cash is a decision
   * about the box, not an instruction to cook a lunch nobody is coming for.
   */
  app.get(
    '/food',
    { preHandler: requirePermission(PERMISSIONS.LUNCH_COLLECTION_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { day } = parseOrThrow(dayQuerySchema, request.query);
      const serviceDay = day ?? (await lunchToday(auth.companyId));

      return reply.send({ data: await foodSummary(auth.companyId, serviceDay) });
    },
  );

  /**
   * The day's orders: who ordered what, what it costs, and who has paid.
   *
   * One day at a time, always. The day is a required part of the query in
   * effect - it defaults to today rather than being optional in the sense of
   * "all days" - because an unbounded list of orders is a report, and this
   * module is not a reporting module. Somebody who wants last Tuesday asks for
   * last Tuesday.
   *
   * The search covers the order number, the employee's name and their employee
   * number, which are the three things anybody standing at a desk with a plate
   * in one hand actually types.
   */
  app.get(
    '/orders',
    { preHandler: requirePermission(PERMISSIONS.LUNCH_COLLECTION_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const query = parseOrThrow(lunchCollectionQuerySchema, request.query);
      const serviceDay = query.day ?? (await lunchToday(auth.companyId));

      const where: Prisma.LunchOrderWhereInput = {
        AND: [
          { companyId: auth.companyId },
          { serviceDate: dayKeyToDateColumn(serviceDay) },
          query.status ? { status: query.status } : {},
          query.paymentStatus ? { paymentStatus: query.paymentStatus } : {},
          query.q
            ? {
                OR: [
                  { orderNumber: { contains: query.q, mode: 'insensitive' } },
                  { employee: { firstName: { contains: query.q, mode: 'insensitive' } } },
                  { employee: { lastName: { contains: query.q, mode: 'insensitive' } } },
                  { employee: { displayName: { contains: query.q, mode: 'insensitive' } } },
                  { employee: { employeeNumber: { contains: query.q, mode: 'insensitive' } } },
                ],
              }
            : {},
        ],
      };

      const orderBy = buildOrderBy(query.sort, query.order, LUNCH_ORDER_SORT_FIELDS, 'createdAt');
      const { skip, take } = toSkipTake(query.page, query.limit);

      const [total, rows] = await Promise.all([
        prisma.lunchOrder.count({ where }),
        prisma.lunchOrder.findMany({ where, skip, take, orderBy, include: LUNCH_ORDER_INCLUDE }),
      ]);

      /*
       * The caller's own employee record, read so the record's `canMarkPaid`
       * can come back false on the operator's own lunch. It is the only reason
       * this lookup happens on a desk route.
       */
      const self = await resolveOrderer(auth);
      const caller = callerContext(auth, self?.employeeId ?? null);

      return reply.send({
        data: rows.map((row) => toLunchOrderRecord(row, caller)),
        meta: buildMeta(query.page, query.limit, total),
      });
    },
  );

  /**
   * Mark paid: the one button this screen exists for.
   *
   * It records three things together - when, who took it, and how it arrived -
   * because they are one fact, and a row carrying two of them says nobody was
   * paid by somebody at half past one. The amount is not among them: an order
   * is paid in full or it is not paid, and the figure is the order's own total,
   * which the employee never had a hand in.
   *
   * Two refusals, both deliberate and both 409 rather than a silent success:
   *
   *   - an order that is already paid. The second click is either a mistake or
   *     a second payment, and absorbing it is how an office boy ends up certain
   *     he collected money he did not;
   *   - an order that has been cancelled. Nobody owes for a lunch that was
   *     called off, and letting one be marked paid would put money into the
   *     day's collected total that is not in the box.
   */
  app.post(
    '/orders/:id/pay',
    { preHandler: requirePermission(PERMISSIONS.LUNCH_PAYMENT_MARK) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(lunchPaymentSchema, request.body ?? {});

      const order = await companyOrderOrThrow(auth.companyId, id);
      const self = await resolveOrderer(auth);

      /*
       * Nobody takes their own money. Enforced here as well as on the record's
       * `canMarkPaid` flag, because the flag is what draws the button and this
       * is what refuses the request - and a button is not a gate.
       */
      if (self && order.employeeId === self.employeeId) {
        throw new ForbiddenError(
          'You cannot mark your own lunch order paid. Ask whoever is collecting to record it.',
        );
      }

      if (order.status === 'CANCELLED') {
        throw new ConflictError('That order was cancelled, so there is nothing to pay for it.');
      }

      if (
        !canMarkLunchOrderPaid(
          order.status as LunchOrderStatus,
          order.paymentStatus as LunchPaymentStatus,
        )
      ) {
        throw new ConflictError('That order is already marked paid.');
      }

      const paidAt = new Date();
      const updated = await prisma.lunchOrder.update({
        where: { id: order.id },
        data: {
          paymentStatus: 'PAID',
          paymentMethod: input.paymentMethod,
          paidAt,
          paidByUserId: auth.userId,
        },
        include: LUNCH_ORDER_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'lunch.payment.mark',
        entityType: 'LunchOrder',
        entityId: order.id,
        summary: `Recorded payment of ${Number(order.totalAmount)} for lunch order ${order.orderNumber} by ${LUNCH_PAYMENT_METHOD_LABELS[input.paymentMethod]}`,
        before: { paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod },
        after: {
          paymentStatus: updated.paymentStatus,
          paymentMethod: updated.paymentMethod,
          paidAt: paidAt.toISOString(),
          amount: Number(order.totalAmount),
          note: input.note ?? null,
        },
        request,
      });

      const caller = callerContext(auth, self?.employeeId ?? null);
      return reply.send({ data: toLunchOrderRecord(updated, caller) });
    },
  );

  /**
   * Moving an order along the lunch round.
   *
   * Forward one step, never back. `canAdvanceLunchOrder` is the shared rule and
   * it permits exactly one transition from any state, which matters more than
   * it looks: if an order could be walked backwards, the DELIVERED rule on the
   * cancel below could be stepped around by moving a delivered order to READY
   * and cancelling it there. A mistake on a delivered order is a payment
   * correction, which is audited and says what it is.
   */
  app.post(
    '/orders/:id/status',
    { preHandler: requirePermission(PERMISSIONS.LUNCH_ORDER_FULFIL) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(lunchOrderStatusSchema, request.body);

      const order = await companyOrderOrThrow(auth.companyId, id);
      const from = order.status as LunchOrderStatus;

      if (from === 'CANCELLED') {
        throw new ConflictError('That order was cancelled. It is not being made.');
      }

      if (!canAdvanceLunchOrder(from, input.status)) {
        throw new ConflictError(
          `An order that is ${LUNCH_ORDER_STATUS_LABELS[from].toLowerCase()} cannot be moved to ${LUNCH_ORDER_STATUS_LABELS[input.status].toLowerCase()}.`,
        );
      }

      const updated = await prisma.lunchOrder.update({
        where: { id: order.id },
        data: { status: input.status },
        include: LUNCH_ORDER_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'lunch.order.status',
        entityType: 'LunchOrder',
        entityId: order.id,
        summary: `Lunch order ${order.orderNumber} is now ${LUNCH_ORDER_STATUS_LABELS[input.status].toLowerCase()}`,
        before: { status: from },
        after: { status: updated.status },
        request,
      });

      const self = await resolveOrderer(auth);
      return reply.send({
        data: toLunchOrderRecord(updated, callerContext(auth, self?.employeeId ?? null)),
      });
    },
  );

  /**
   * The operator calling somebody's order off.
   *
   * A different act from the employee's own cancel next door, and a separate
   * endpoint behind a separate grant because of what it can reach: anybody's
   * order, and money that has already been collected. The employee's cancel is
   * untouched by this existing - it still reaches only their own, still only
   * while nobody has paid, and still refuses everything else.
   *
   * Three rules, in the order they are checked:
   *
   *   - NOT a delivered order. The food has been eaten; "cancel" has stopped
   *     describing anything that could happen, and pretending otherwise would
   *     take a plate the kitchen actually made out of the day's count and money
   *     that was actually owed out of the day's expected collection. A
   *     delivered order that needs putting right is a payment correction.
   *   - not one that is already cancelled, which would overwrite the reason and
   *     the canceller recorded the first time.
   *   - and if the order was PAID, the operator must say what happened to the
   *     money. This is the rule the whole endpoint is shaped around: the
   *     payment is never silently erased and `paymentStatus` is never rolled
   *     back to UNPAID, because cash changed hands and a system that forgets
   *     that has lost the only thing it was keeping. The decision is recorded
   *     BESIDE the payment, as a refund status.
   *
   * The order is never deleted. It keeps its number, its lines, its payment and
   * now its cancellation, and it stays on the day's report - in the cancelled
   * figures, apart from the active ones - so the office boy can reconcile a box
   * that no longer matches what he expected to collect.
   */
  app.post(
    '/orders/:id/cancel',
    { preHandler: requirePermission(PERMISSIONS.LUNCH_ORDER_CANCEL_ANY) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(lunchOperatorCancelSchema, request.body);

      /*
       * Company-scoped, and that is the IDOR boundary: an id belonging to
       * another company answers 404 whatever grants the caller holds, because
       * the tenant clause is in the WHERE rather than checked after the read.
       */
      const order = await companyOrderOrThrow(auth.companyId, id);
      const from = order.status as LunchOrderStatus;

      if (from === 'CANCELLED') {
        throw new ConflictError('That order is already cancelled.');
      }

      if (!canOperatorCancelLunchOrder(from)) {
        throw new ConflictError(
          'That order has already been delivered, so it cannot be cancelled. Correct the payment instead.',
        );
      }

      const wasPaid = order.paymentStatus === 'PAID';

      if (wasPaid && !input.resolution) {
        throw new ValidationError({ resolution: [LUNCH_PAID_CANCEL_MESSAGE] });
      }

      const refunded = wasPaid && input.resolution === 'REFUND';
      const now = new Date();

      const updated = await prisma.lunchOrder.update({
        where: { id: order.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledByUserId: auth.userId,
          cancellationReason: input.reason,
          /*
           * `paymentStatus` is deliberately absent from this update. A paid
           * order stays paid; what changes is the refund decision recorded
           * next to it. An unpaid order has no decision to record and keeps
           * NONE.
           */
          ...(wasPaid
            ? {
                refundStatus: LUNCH_RESOLUTION_REFUND_STATUS[input.resolution!],
                refundedAt: refunded ? now : null,
                refundedByUserId: refunded ? auth.userId : null,
                refundReason: input.refundReason ?? null,
              }
            : {}),
        },
        include: LUNCH_ORDER_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'lunch.order.cancel.operator',
        entityType: 'LunchOrder',
        entityId: order.id,
        summary: wasPaid
          ? `Cancelled lunch order ${order.orderNumber} (${LUNCH_CANCEL_RESOLUTION_LABELS[input.resolution!]}): ${input.reason}`
          : `Cancelled lunch order ${order.orderNumber}: ${input.reason}`,
        before: {
          status: from,
          paymentStatus: order.paymentStatus,
          refundStatus: order.refundStatus,
        },
        after: {
          orderId: order.id,
          employeeId: order.employeeId,
          employeeNumber: order.employee.employeeNumber,
          status: updated.status,
          /*
           * The money, spelled out rather than left to be inferred from two
           * columns. This entry is what somebody reads a month later when a
           * cash box did not balance, and "PAID, RETAINED, 290" is the whole
           * answer in one line.
           */
          paymentStatus: updated.paymentStatus,
          refundStatus: updated.refundStatus,
          amount: Number(order.totalAmount),
          resolution: input.resolution ?? null,
          refundReason: input.refundReason ?? null,
          cancellationReason: input.reason,
          cancelledByUserId: auth.userId,
          cancelledAt: now.toISOString(),
        },
        request,
      });

      const self = await resolveOrderer(auth);
      return reply.send({
        data: toLunchOrderRecord(updated, callerContext(auth, self?.employeeId ?? null)),
      });
    },
  );

  /**
   * Putting right a payment that was recorded wrongly.
   *
   * Its own endpoint, its own grant and a compulsory reason, because this is
   * the one action in the module that rewrites a fact about money already
   * counted. Marking the wrong Ali paid happens; what must not happen is it
   * being quietly undone, so the reason is required and the audit entry carries
   * both the before and the after - which is what makes the day's figures
   * explainable when they move after the fact.
   *
   * Setting an order back to UNPAID clears the method, the time and who took
   * it, together, for the same reason they are written together.
   *
   * An order corrected back to unpaid becomes the employee's again: it is
   * placed and unpaid, so they can cancel it if it was never really theirs.
   * That is the intended route out of a wrong order, and it is why there is no
   * operator cancel here - the operator corrects the MONEY, and the person who
   * ordered decides whether they wanted lunch.
   */
  app.post(
    '/orders/:id/payment-correction',
    { preHandler: requirePermission(PERMISSIONS.LUNCH_PAYMENT_CORRECT) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(lunchPaymentCorrectionSchema, request.body);

      const order = await companyOrderOrThrow(auth.companyId, id);
      const self = await resolveOrderer(auth);

      if (self && order.employeeId === self.employeeId) {
        throw new ForbiddenError(
          'You cannot correct the payment on your own lunch order. Ask somebody else who holds the grant.',
        );
      }

      /*
       * A cancelled order is not correctable here, in either direction, and
       * that is the boundary between the two mechanisms rather than an
       * oversight. Money on a cancelled order is governed by the refund
       * decision taken when it was cancelled: correcting it to PAID would
       * record money taken for food nobody brought, and correcting it to UNPAID
       * would erase the record of cash that really did change hands - which is
       * the exact outcome the cancellation design exists to prevent.
       *
       * One state, one mechanism. What this does NOT currently offer is a way
       * to change a refund decision after the fact; that would be its own
       * endpoint with its own audit, not a reuse of this one.
       */
      if (order.status === 'CANCELLED') {
        throw new ConflictError(
          'That order was cancelled. What happened to the money was decided when it was cancelled, and is recorded on the order.',
        );
      }

      if (order.paymentStatus === input.paymentStatus) {
        throw new ConflictError(
          input.paymentStatus === 'PAID'
            ? 'That order is already marked paid.'
            : 'That order is already marked unpaid.',
        );
      }

      const paid = input.paymentStatus === 'PAID';
      const paidAt = paid ? new Date() : null;

      const updated = await prisma.lunchOrder.update({
        where: { id: order.id },
        data: {
          paymentStatus: input.paymentStatus,
          // The three move together, in both directions.
          paymentMethod: paid ? input.paymentMethod : null,
          paidAt,
          paidByUserId: paid ? auth.userId : null,
        },
        include: LUNCH_ORDER_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'lunch.payment.correct',
        entityType: 'LunchOrder',
        entityId: order.id,
        summary: `Corrected payment on lunch order ${order.orderNumber} to ${input.paymentStatus}: ${input.reason}`,
        before: {
          paymentStatus: order.paymentStatus,
          paymentMethod: order.paymentMethod,
          paidAt: order.paidAt?.toISOString() ?? null,
          paidByUserId: order.paidByUserId,
        },
        after: {
          paymentStatus: updated.paymentStatus,
          paymentMethod: updated.paymentMethod,
          paidAt: paidAt?.toISOString() ?? null,
          paidByUserId: updated.paidByUserId,
          reason: input.reason,
        },
        request,
      });

      const caller = callerContext(auth, self?.employeeId ?? null);
      return reply.send({ data: toLunchOrderRecord(updated, caller) });
    },
  );
};
