import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  LUNCH_ORDER_SORT_FIELDS,
  PERMISSIONS,
  canEmployeeCancelLunchOrder,
  idParamSchema,
  lunchOrderCancelSchema,
  lunchOrderCreateSchema,
  lunchOrderQuerySchema,
  type LunchOrderStatus,
  type LunchPaymentStatus,
  type LunchTodayView,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAnyPermission, requireAuthContext, requirePermission } from '../../auth/guards.js';
import {
  LUNCH_ORDER_INCLUDE,
  NO_EMPLOYEE_RECORD_MESSAGE,
  activeMenu,
  callerContext,
  createLunchOrderWithNumber,
  dayKeyToDateColumn,
  lunchToday,
  outstandingFor,
  ownOrderOrThrow,
  priceOrder,
  resolveOrderer,
  toLunchOrderRecord,
} from './lunch.service.js';

/**
 * Lunch: the employee's side.
 *
 * An employee does three things here - order, look at what they ordered, and
 * call it off if nobody has paid for it - and the security story behind all
 * three is one sentence: the employee comes from the session and goes into the
 * WHERE clause. There is no `employeeId` parameter on any route below, no
 * `view=all`, and no data scope that widens one: a manager's REPORTS_AND_OWN
 * scope buys them nothing in this module, because a reporting line is not a
 * reason to read what somebody had for lunch or what they still owe for it.
 *
 * What is deliberately absent from the write paths is the money. The create
 * endpoint takes ids and quantities and prices the order itself; there is no
 * endpoint here that takes an amount, a payment status or a payment method, so
 * the four things an employee must not be able to do - mark their own order
 * paid, change what it costs, change how it was paid, touch it once it is paid
 * - are not refused by a check on this side. They have no endpoint at all.
 */

export const lunchOrderRoutes: FastifyPluginAsync = async (app) => {
  /*
   * Signed in is the whole of the plugin-level gate; each route carries its
   * own. Deliberately not one blanket grant: ordering lunch and reading your
   * orders are separate permissions, and a single hook would quietly make one
   * imply the other.
   */
  app.addHook('preHandler', requireAuth);

  /**
   * The order form's entire vocabulary: what is on the menu, and what it costs.
   *
   * Configuration, not content - it names nobody and no order - so reading it
   * needs only a reason to be on this screen. Retired items are absent from the
   * response rather than hidden by the browser, so an order form cannot offer
   * something the create endpoint will refuse.
   */
  app.get(
    '/menu',
    {
      preHandler: requireAnyPermission(
        PERMISSIONS.LUNCH_ORDER_READ_OWN,
        PERMISSIONS.LUNCH_ORDER_CREATE,
      ),
    },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      return reply.send({ data: await activeMenu(auth.companyId) });
    },
  );

  /**
   * My lunch, today.
   *
   * The whole of what an employee needs at one o'clock: what they ordered, what
   * it comes to, and whether it is paid for. `orders` is a list rather than one
   * order because a second plate is a second order with its own number and its
   * own payment - the office boy collects per order, and somebody who ordered
   * again at two has two things to pay for.
   *
   * Registered before `/orders/:id` in source order for readability only -
   * Fastify matches a static segment ahead of a parameter whatever the order.
   */
  app.get(
    '/today',
    { preHandler: requirePermission(PERMISSIONS.LUNCH_ORDER_READ_OWN) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const day = await lunchToday(auth.companyId);
      const orderer = await resolveOrderer(auth);

      // No employee record, so no lunch. An empty day rather than an error: the
      // card is one of several on a dashboard and must not take the page down.
      if (!orderer) {
        const empty: LunchTodayView = { day, orders: [], outstandingAmount: 0, canOrder: false };
        return reply.send({ data: empty });
      }

      const rows = await prisma.lunchOrder.findMany({
        where: {
          companyId: orderer.companyId,
          employeeId: orderer.employeeId,
          serviceDate: dayKeyToDateColumn(day),
        },
        orderBy: { createdAt: 'asc' },
        include: LUNCH_ORDER_INCLUDE,
      });

      const caller = callerContext(auth, orderer.employeeId);
      const orders = rows.map((row) => toLunchOrderRecord(row, caller));

      const view: LunchTodayView = {
        day,
        orders,
        outstandingAmount: outstandingFor(orders),
        canOrder: true,
      };

      return reply.send({ data: view });
    },
  );

  /**
   * My orders.
   *
   * Every filter is applied by the database and the page is a page: somebody
   * who has eaten here for two years must not have five hundred orders sent to
   * the browser so it can hide most of them. The search covers the order number
   * only - it is the one thing on an order anybody quotes.
   */
  app.get(
    '/orders',
    { preHandler: requirePermission(PERMISSIONS.LUNCH_ORDER_READ_OWN) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const query = parseOrThrow(lunchOrderQuerySchema, request.query);
      const orderer = await resolveOrderer(auth);

      if (!orderer) {
        return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
      }

      /*
       * The first two clauses are the security boundary and everything after
       * them is the user's own filtering. They are stated first,
       * unconditionally and outside any ternary, so no future edit to the
       * filters can accidentally widen them.
       */
      const where: Prisma.LunchOrderWhereInput = {
        AND: [
          { companyId: orderer.companyId },
          { employeeId: orderer.employeeId },
          query.status ? { status: query.status } : {},
          query.paymentStatus ? { paymentStatus: query.paymentStatus } : {},
          query.from ? { serviceDate: { gte: dayKeyToDateColumn(query.from) } } : {},
          query.to ? { serviceDate: { lte: dayKeyToDateColumn(query.to) } } : {},
          query.q ? { orderNumber: { contains: query.q, mode: 'insensitive' } } : {},
        ],
      };

      const orderBy = buildOrderBy(query.sort, query.order, LUNCH_ORDER_SORT_FIELDS, 'serviceDate');
      const { skip, take } = toSkipTake(query.page, query.limit);

      const [total, rows] = await Promise.all([
        prisma.lunchOrder.count({ where }),
        prisma.lunchOrder.findMany({ where, skip, take, orderBy, include: LUNCH_ORDER_INCLUDE }),
      ]);

      const caller = callerContext(auth, orderer.employeeId);
      return reply.send({
        data: rows.map((row) => toLunchOrderRecord(row, caller)),
        meta: buildMeta(query.page, query.limit, total),
      });
    },
  );

  /**
   * Placing an order.
   *
   * For the caller, for today, at today's prices - and none of those three
   * comes from the request. The employee is the session's own employee record;
   * the day is the company's own today; the prices are read off the menu rows
   * by `priceOrder`. What the body carries is what was chosen and how many of
   * it, which is the only part of an order an employee gets to decide.
   *
   * The order is created UNPAID, which is the column default and is left to be
   * exactly that. There is no field on this endpoint that could create a paid
   * order, and adding one would be the single most dangerous change anybody
   * could make to this module.
   */
  app.post(
    '/orders',
    { preHandler: requirePermission(PERMISSIONS.LUNCH_ORDER_CREATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(lunchOrderCreateSchema, request.body);

      const orderer = await resolveOrderer(auth);
      if (!orderer) throw new ValidationError({ items: [NO_EMPLOYEE_RECORD_MESSAGE] });

      const day = await lunchToday(auth.companyId);
      const priced = await priceOrder(auth.companyId, input.items);

      const created = await createLunchOrderWithNumber(
        {
          companyId: auth.companyId,
          employeeId: orderer.employeeId,
          day,
          note: input.note,
        },
        priced,
      );

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'lunch.order.create',
        entityType: 'LunchOrder',
        entityId: created.id,
        summary: `Placed lunch order ${created.orderNumber} for ${priced.totalAmount}`,
        after: {
          orderNumber: created.orderNumber,
          day,
          items: priced.lines.map((line) => `${line.quantity} x ${line.itemName}`).join(', '),
          totalAmount: priced.totalAmount,
          paymentStatus: created.paymentStatus,
        },
        request,
      });

      const caller = callerContext(auth, orderer.employeeId);
      return reply.code(201).send({ data: toLunchOrderRecord(created, caller) });
    },
  );

  /**
   * Calling off your own order.
   *
   * Unpaid only, and refused with a message that says why rather than a 403:
   * once money has changed hands the order stops being the employee's to touch,
   * because undoing a payment is a REFUND - something that happens between two
   * people and is then recorded by the operator as a correction with a reason
   * on it. An employee who could cancel a paid order would be writing money out
   * of the office boy's box without his knowing.
   *
   * A cancelled order leaves the day's collection entirely: it is not counted,
   * not expected and not outstanding.
   */
  app.post(
    '/orders/:id/cancel',
    { preHandler: requirePermission(PERMISSIONS.LUNCH_ORDER_CANCEL_OWN) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(lunchOrderCancelSchema, request.body ?? {});

      const orderer = await resolveOrderer(auth);
      if (!orderer) throw new ValidationError({ reason: [NO_EMPLOYEE_RECORD_MESSAGE] });

      const order = await ownOrderOrThrow(orderer, id);

      if (order.status === 'CANCELLED') {
        throw new ConflictError('That order is already cancelled.');
      }

      if (
        !canEmployeeCancelLunchOrder(
          order.status as LunchOrderStatus,
          order.paymentStatus as LunchPaymentStatus,
        )
      ) {
        /*
         * Two different refusals, and they are told apart because they need
         * two different things from the person reading them: one is about
         * money and the other is about a pan. Both point at the same person -
         * whoever is running the lunch round can cancel either, which is what
         * the operator's own cancel is for.
         */
        throw new ConflictError(
          order.paymentStatus === 'PAID'
            ? 'That order has been paid for, so it cannot be cancelled here. Speak to whoever took the money.'
            : 'That order is already being prepared, so it cannot be cancelled here. Speak to whoever is bringing it.',
        );
      }

      const updated = await prisma.lunchOrder.update({
        where: { id: order.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          /*
           * Recorded for an employee's own cancel as well as an operator's, so
           * "cancelled by" is answerable from the row rather than inferred
           * from who happens to hold a grant. The reason stays OPTIONAL here -
           * somebody calling off their own unpaid lunch owes nobody an
           * explanation, and that rule is unchanged by the operator's cancel
           * existing, where it is compulsory.
           */
          cancelledByUserId: auth.userId,
          cancellationReason: input.reason ?? null,
        },
        include: LUNCH_ORDER_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'lunch.order.cancel',
        entityType: 'LunchOrder',
        entityId: order.id,
        summary: `Cancelled lunch order ${order.orderNumber}`,
        before: { status: order.status },
        after: { status: updated.status, reason: input.reason ?? null },
        request,
      });

      const caller = callerContext(auth, orderer.employeeId);
      return reply.send({ data: toLunchOrderRecord(updated, caller) });
    },
  );
};
