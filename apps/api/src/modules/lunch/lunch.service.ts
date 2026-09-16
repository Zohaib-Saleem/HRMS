import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  canAdvanceLunchOrder,
  canEmployeeCancelLunchOrder,
  canMarkLunchOrderPaid,
  canOperatorCancelLunchOrder,
  emptyLunchCollectionSummary,
  isLunchOrderPayable,
  formatLunchOrderNumber,
  lunchItemSummary,
  lunchOrderNumberDayPrefix,
  lunchOrderTotal,
  nextLunchOrderStatus,
  parseLunchOrderNumberSequence,
  roundLunchMoney,
  summariseLunchCollection,
  summariseLunchFood,
  type LunchCollectionSummary,
  type LunchFoodSummary,
  type LunchMenuItemRecord,
  type LunchOrderCreateInput,
  type LunchOrderRecord,
  type LunchOrderStatus,
  type LunchPaymentMethod,
  type LunchPaymentStatus,
  type LunchRefundStatus,
  type Permission,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import type { AuthContext } from '../../auth/session.js';
import { dateColumnToDayKey, dayKeyToDateColumn, todayInZone, type DayKey } from '../../core/zoned-time.js';

/**
 * The lunch module's data layer.
 *
 * Two sides share this file and they share it carefully. Everything an EMPLOYEE
 * reaches goes through `ownOrderOrThrow`, which puts their own employee id in
 * the WHERE clause rather than checking it after the read - so there is no
 * moment at which an employee route is holding somebody else's order, and no
 * branch anybody can add later that forgets to narrow. Everything the OPERATOR
 * reaches is scoped to a company and a DAY, because the office boy's job is a
 * day's collection and a query that could span a month is a query that will
 * eventually be asked to.
 *
 * The money is computed here and only here. `priceOrder` reads today's menu
 * prices off the menu rows and does the arithmetic; nothing a client sends
 * contributes a figure. That is what makes "an employee cannot change the
 * payment amount" true by construction rather than by a check somebody has to
 * remember to write on the next endpoint.
 */

// --- who is asking -----------------------------------------------------------

export interface LunchOrderer {
  employeeId: string;
  userId: string;
  companyId: string;
}

/**
 * The caller's own employee record, which is what an order hangs off.
 *
 * A login with no employee record behind it cannot order lunch: an order is a
 * debt owed by a person on the roster, and there is nothing to attach one to.
 * Returned as null rather than thrown, so a list can answer "none" while a
 * create answers with a message that names the problem.
 */
export async function resolveOrderer(auth: AuthContext): Promise<LunchOrderer | null> {
  const employee = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true },
  });

  if (!employee) return null;
  return { employeeId: employee.id, userId: auth.userId, companyId: auth.companyId };
}

/** The message for a caller with no employee record. Used by every write path. */
export const NO_EMPLOYEE_RECORD_MESSAGE =
  'Your login is not linked to an employee record yet, so you cannot order lunch. Ask an administrator to link it.';

// --- the day -----------------------------------------------------------------

/**
 * Today, as the company reckons it.
 *
 * Lunch is eaten at a wall clock. A company in Karachi orders at 13:00 local,
 * which is 08:00 UTC, and reading the day in UTC would file the late orders of
 * one lunchtime under the day before and lose them off the office boy's screen.
 * The browser is not asked either: a laptop that has travelled would ask for
 * the wrong day's collection and be answered.
 */
export async function lunchToday(companyId: string, now = new Date()): Promise<DayKey> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { timezone: true },
  });

  return todayInZone(company?.timezone ?? 'UTC', now);
}

export { dateColumnToDayKey, dayKeyToDateColumn };

// --- reading an order --------------------------------------------------------

export const LUNCH_ORDER_INCLUDE = {
  employee: {
    select: { id: true, firstName: true, lastName: true, displayName: true, employeeNumber: true },
  },
  paidBy: {
    select: { id: true, email: true, employee: { select: { firstName: true, lastName: true, displayName: true } } },
  },
  /*
   * Who cancelled it, and who recorded the refund. Read so a cancelled order
   * can name the person responsible for it on BOTH sides of the module - the
   * employee is told who called their lunch off, not merely that somebody did.
   */
  cancelledBy: {
    select: { id: true, email: true, employee: { select: { firstName: true, lastName: true, displayName: true } } },
  },
  refundedBy: {
    select: { id: true, email: true, employee: { select: { firstName: true, lastName: true, displayName: true } } },
  },
  items: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.LunchOrderInclude;

export type LunchOrderRow = Prisma.LunchOrderGetPayload<{ include: typeof LUNCH_ORDER_INCLUDE }>;

const personName = (p: { firstName: string; lastName: string; displayName?: string | null }) =>
  p.displayName ?? `${p.firstName} ${p.lastName}`.trim();

/** A Decimal column as the number that goes over the wire. */
const toNumber = (value: Prisma.Decimal | number): number => roundLunchMoney(Number(value));

/**
 * Who is reading, which is what decides the three `can...` flags on a record.
 *
 * `employeeId` is the CALLER's own employee record, and it is on here for one
 * reason: an operator must not be able to mark their own lunch paid. That rule
 * cannot be expressed with permissions alone - the office boy holds
 * `lunch.payment.mark` and also eats - so it is a comparison between the order's
 * employee and the caller's, made here and enforced again at the endpoint.
 */
export interface LunchCaller {
  employeeId: string | null;
  /** The signed-in account, which is who "cancelled by you" is about. */
  userId: string;
  permissions: ReadonlySet<Permission>;
}

export function callerContext(auth: AuthContext, employeeId: string | null): LunchCaller {
  return { employeeId, userId: auth.userId, permissions: auth.permissions };
}

/**
 * Whether this caller may take the money for this order.
 *
 * Three things, all of which have to hold: the grant, the order's own state,
 * and that the order is not the caller's own. The last is the one worth
 * spelling out - an office boy holds `lunch.payment.mark` and also eats lunch,
 * so without it the person who collects the money would be the one person able
 * to record themselves as having paid.
 */
export function mayMarkPaid(row: LunchOrderRow, caller: LunchCaller): boolean {
  if (!caller.permissions.has(PERMISSIONS.LUNCH_PAYMENT_MARK)) return false;
  if (caller.employeeId !== null && row.employeeId === caller.employeeId) return false;
  return canMarkLunchOrderPaid(row.status as LunchOrderStatus, row.paymentStatus as LunchPaymentStatus);
}

/**
 * The same rule for a correction, which is the other way to write this row.
 *
 * With one addition: a CANCELLED order is not correctable here. Its money is
 * governed by the refund decision taken when it was cancelled, and letting a
 * correction reach it would be a second path to the same figures - one that
 * could set `paymentStatus` back to UNPAID and erase the record of cash that
 * changed hands, which is the outcome the whole cancellation design exists to
 * prevent. One state, one mechanism.
 */
export function mayCorrectPayment(row: LunchOrderRow, caller: LunchCaller): boolean {
  if (!caller.permissions.has(PERMISSIONS.LUNCH_PAYMENT_CORRECT)) return false;
  if (caller.employeeId !== null && row.employeeId === caller.employeeId) return false;
  return isLunchOrderPayable(row.status as LunchOrderStatus);
}

/**
 * Whether this caller may cancel this order on somebody else's behalf.
 *
 * The grant, and the order's own state. Deliberately NOT narrowed to orders
 * belonging to other people, unlike the two payment rules above: the office boy
 * cancelling his own lunch is somebody deciding not to eat, which is exactly
 * what this endpoint is for, and there is no money to be made by doing it - a
 * cancellation takes an order OUT of the collection rather than settling it.
 *
 * The delivered case lives in `canOperatorCancelLunchOrder`, shared with the
 * browser so the button and the endpoint agree about where the line is.
 */
export function mayOperatorCancel(row: LunchOrderRow, caller: LunchCaller): boolean {
  if (!caller.permissions.has(PERMISSIONS.LUNCH_ORDER_CANCEL_ANY)) return false;
  return canOperatorCancelLunchOrder(row.status as LunchOrderStatus);
}

/** Whether this caller may move the order one step along the lunch round. */
export function mayAdvance(row: LunchOrderRow, caller: LunchCaller): boolean {
  if (!caller.permissions.has(PERMISSIONS.LUNCH_ORDER_FULFIL)) return false;
  return nextLunchOrderStatus(row.status as LunchOrderStatus) !== null;
}

/** Re-exported so the routes check the flow through one function, not two. */
export { canAdvanceLunchOrder, canOperatorCancelLunchOrder };

export function toLunchOrderRecord(row: LunchOrderRow, caller: LunchCaller): LunchOrderRecord {
  const status = row.status as LunchOrderStatus;
  const paymentStatus = row.paymentStatus as LunchPaymentStatus;
  const isOwn = caller.employeeId !== null && row.employeeId === caller.employeeId;

  const items = row.items.map((item) => ({
    id: item.id,
    menuItemId: item.menuItemId,
    itemName: item.itemName,
    unitPrice: toNumber(item.unitPrice),
    quantity: item.quantity,
    lineTotal: toNumber(item.lineTotal),
  }));

  return {
    id: row.id,
    orderNumber: row.orderNumber,
    day: dateColumnToDayKey(row.serviceDate),

    employeeId: row.employeeId,
    employeeName: personName(row.employee),
    employeeNumber: row.employee.employeeNumber,

    status,
    items,
    itemSummary: lunchItemSummary(items),
    totalAmount: toNumber(row.totalAmount),

    paymentStatus,
    paymentMethod: (row.paymentMethod as LunchPaymentMethod | null) ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    paidByName: row.paidBy
      ? (row.paidBy.employee ? personName(row.paidBy.employee) : row.paidBy.email)
      : null,

    note: row.note,
    createdAt: row.createdAt.toISOString(),

    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledByName: row.cancelledBy
      ? (row.cancelledBy.employee ? personName(row.cancelledBy.employee) : row.cancelledBy.email)
      : null,
    /*
     * Compared on the USER id rather than the employee id, because this is a
     * question about who clicked: an employee cancelling their own order is the
     * same person reading the row back, and an operator who happens to share
     * their employee record with nobody still needs to be named.
     */
    cancelledBySelf: row.cancelledByUserId !== null && row.cancelledByUserId === caller.userId,
    cancellationReason: row.cancellationReason,

    refundStatus: row.refundStatus as LunchRefundStatus,
    refundedAt: row.refundedAt?.toISOString() ?? null,
    /*
     * Desk-only. Filtered out of the response rather than hidden at render
     * time, so it is ABSENT from what an employee is sent rather than merely
     * invisible in it - the same arrangement a case's internal note has. What
     * the employee is told is the decision and why their order was cancelled;
     * the operator's working on the money is between him and the audit trail.
     */
    refundReason: caller.permissions.has(PERMISSIONS.LUNCH_COLLECTION_READ)
      ? row.refundReason
      : null,

    /*
     * Decided here rather than in the browser, from the caller's grants and the
     * order's own state. Cancelling is the employee's and only ever their own;
     * the two payment actions are somebody else's and never their own.
     */
    canCancel:
      isOwn &&
      caller.permissions.has(PERMISSIONS.LUNCH_ORDER_CANCEL_OWN) &&
      canEmployeeCancelLunchOrder(status, paymentStatus),
    canMarkPaid: mayMarkPaid(row, caller),
    canCorrectPayment: mayCorrectPayment(row, caller),
    canOperatorCancel: mayOperatorCancel(row, caller),
    canAdvance: mayAdvance(row, caller),
    nextStatus: nextLunchOrderStatus(status),
  };
}

/**
 * One of the caller's OWN orders, or a 404.
 *
 * The whole IDOR defence, in one query and one place. `employeeId` is in the
 * WHERE clause rather than checked after the read, and the company id is in
 * there too: a tenant boundary is not a permission question and is not left to
 * one.
 *
 * Somebody else's order is reported as NOT FOUND rather than as forbidden,
 * deliberately. A 403 on a guessed id confirms that the id exists, which is
 * exactly the fact the guesser was after.
 */
export async function ownOrderOrThrow(
  orderer: LunchOrderer,
  orderId: string,
): Promise<LunchOrderRow> {
  const row = await prisma.lunchOrder.findFirst({
    where: { id: orderId, companyId: orderer.companyId, employeeId: orderer.employeeId },
    include: LUNCH_ORDER_INCLUDE,
  });

  if (!row) throw new NotFoundError('Lunch order');
  return row;
}

/** One order in this company, whoever placed it. The operator's lookup. */
export async function companyOrderOrThrow(
  companyId: string,
  orderId: string,
): Promise<LunchOrderRow> {
  const row = await prisma.lunchOrder.findFirst({
    where: { id: orderId, companyId },
    include: LUNCH_ORDER_INCLUDE,
  });

  if (!row) throw new NotFoundError('Lunch order');
  return row;
}

// --- the menu ----------------------------------------------------------------

export function toMenuItemRecord(row: {
  id: string;
  name: string;
  description: string | null;
  price: Prisma.Decimal | number;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}): LunchMenuItemRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: toNumber(row.price),
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The order form's vocabulary: what is on the menu today, in order. */
export async function activeMenu(companyId: string): Promise<LunchMenuItemRecord[]> {
  const rows = await prisma.lunchMenuItem.findMany({
    where: { companyId, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });

  return rows.map(toMenuItemRecord);
}

// --- pricing an order --------------------------------------------------------

/** One priced line, ready to be written as a `lunch_order_items` row. */
export interface PricedLunchLine {
  menuItemId: string;
  itemName: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface PricedLunchOrder {
  lines: PricedLunchLine[];
  totalAmount: number;
}

/**
 * Turns what somebody chose into what it costs.
 *
 * The prices come from the menu rows, read here, and the request contributes
 * nothing but ids and quantities. Two rules are enforced while doing it and
 * both are refusals rather than corrections:
 *
 *   - an item that is not on this company's menu, or has been retired from it,
 *     is refused by name rather than quietly dropped. An order that came back
 *     cheaper than the person expected is worse than one that came back
 *     refused;
 *   - the same item twice on one order is refused. It is always a double
 *     submit or a confused form, and merging the lines would hide which.
 */
export async function priceOrder(
  companyId: string,
  items: LunchOrderCreateInput['items'],
): Promise<PricedLunchOrder> {
  const seen = new Set<string>();
  for (const line of items) {
    if (seen.has(line.menuItemId)) {
      throw new ValidationError({
        items: ['That item is on the order twice. Change the quantity instead.'],
      });
    }
    seen.add(line.menuItemId);
  }

  const menuItems = await prisma.lunchMenuItem.findMany({
    where: { companyId, id: { in: [...seen] } },
  });

  const byId = new Map(menuItems.map((item) => [item.id, item]));

  const lines: PricedLunchLine[] = items.map((line) => {
    const menuItem = byId.get(line.menuItemId);

    if (!menuItem || !menuItem.isActive) {
      throw new ValidationError({
        items: ['One of those items is no longer on the menu. Refresh and order again.'],
      });
    }

    const unitPrice = toNumber(menuItem.price);
    return {
      menuItemId: menuItem.id,
      itemName: menuItem.name,
      unitPrice,
      quantity: line.quantity,
      lineTotal: roundLunchMoney(unitPrice * line.quantity),
    };
  });

  return { lines, totalAmount: lunchOrderTotal(lines) };
}

// --- the order number --------------------------------------------------------

/**
 * The next order number for a company, on a given day.
 *
 * Reads the highest issued today and adds one, exactly as case numbers and
 * claim numbers are generated. The read is not the guarantee - two people
 * ordering in the same second both read the same highest - so the unique index
 * on (companyId, orderNumber) is, and the caller retries on it. See
 * `createLunchOrderWithNumber`.
 */
export async function nextLunchOrderNumber(companyId: string, day: DayKey): Promise<string> {
  const prefix = lunchOrderNumberDayPrefix(day);

  const existing = await prisma.lunchOrder.findMany({
    where: { companyId, orderNumber: { startsWith: prefix } },
    select: { orderNumber: true },
  });

  let highest = 0;
  for (const { orderNumber } of existing) {
    const sequence = parseLunchOrderNumberSequence(orderNumber, day);
    if (sequence !== null) highest = Math.max(highest, sequence);
  }

  return formatLunchOrderNumber(day, highest + 1);
}

/** Raised by `createLunchOrderWithNumber` when the retries are exhausted. */
export class LunchOrderNumberExhaustedError extends Error {
  constructor() {
    super('Could not allocate a lunch order number after several attempts.');
    this.name = 'LunchOrderNumberExhaustedError';
  }
}

/**
 * Creates the order and its lines, retrying if somebody took the number first.
 *
 * The lines are a NESTED create rather than a second statement, so the order and
 * what is on it arrive in one transaction. An order row with no lines is an
 * order for nothing at a price somebody owes, which is the one inconsistency
 * this table must never be able to show the office boy.
 *
 * Five attempts, because the window is a single round trip and a company that
 * loses five in a row has a problem no amount of retrying will fix.
 */
export async function createLunchOrderWithNumber(
  input: {
    companyId: string;
    employeeId: string;
    day: DayKey;
    note?: string;
  },
  priced: PricedLunchOrder,
): Promise<LunchOrderRow> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const orderNumber = await nextLunchOrderNumber(input.companyId, input.day);

    try {
      return await prisma.lunchOrder.create({
        data: {
          companyId: input.companyId,
          employeeId: input.employeeId,
          orderNumber,
          serviceDate: dayKeyToDateColumn(input.day),
          totalAmount: priced.totalAmount,
          /*
           * Stated rather than left to the column default, so the one payment
           * state a new order may be in is visible at the call site - this is
           * the line somebody would have to change on purpose to create an
           * order that was already paid for, and it should be impossible to do
           * that by accident.
           */
          status: 'ORDERED',
          paymentStatus: 'UNPAID',
          note: input.note ?? null,
          items: {
            create: priced.lines.map((line) => ({
              companyId: input.companyId,
              menuItemId: line.menuItemId,
              itemName: line.itemName,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              lineTotal: line.lineTotal,
            })),
          },
        },
        include: LUNCH_ORDER_INCLUDE,
      });
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }

  throw new LunchOrderNumberExhaustedError();
}

/**
 * A Prisma unique-constraint failure, recognised without importing the runtime
 * error class - which is a value import that would drag the client into every
 * test that mocks it.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

// --- the day's collection ----------------------------------------------------

/**
 * A day's six figures.
 *
 * Computed from the day's own rows in one pass rather than from four aggregate
 * queries, and that is a deliberate choice about correctness rather than a
 * shortcut. The figures are read together and have to agree with each other and
 * with the list of orders printed underneath them; four separate aggregates can
 * be individually right and collectively inconsistent if a payment lands
 * between two of them. A day is sixty rows on one index, so reading them is
 * cheap, and the arithmetic itself lives in `summariseLunchCollection` in the
 * shared package, where it is the same function the tests exercise.
 */
export async function collectionSummary(
  companyId: string,
  day: DayKey,
): Promise<LunchCollectionSummary> {
  const rows = await prisma.lunchOrder.findMany({
    where: { companyId, serviceDate: dayKeyToDateColumn(day) },
    select: { status: true, paymentStatus: true, refundStatus: true, totalAmount: true },
  });

  if (rows.length === 0) return emptyLunchCollectionSummary(day);

  return summariseLunchCollection(
    day,
    rows.map((row) => ({
      status: row.status as LunchOrderStatus,
      paymentStatus: row.paymentStatus as LunchPaymentStatus,
      refundStatus: row.refundStatus as LunchRefundStatus,
      totalAmount: toNumber(row.totalAmount),
    })),
  );
}

/**
 * What the kitchen has to make today.
 *
 * Its own read rather than a field on the collection summary, because it is a
 * different question asked by a different person at a different time: the cook
 * wants it at eleven and the office boy wants the money at two. Sharing one
 * endpoint would mean one of them waiting on the other's arithmetic.
 *
 * The exclusion rule is the same one and comes from the same place:
 * `summariseLunchFood` drops cancelled orders entirely, so the moment an order
 * is cancelled its plates leave this count - whether or not it was paid for,
 * and whether or not that money was retained. Keeping the cash is a decision
 * about the box; it is not an instruction to cook a lunch nobody is coming for.
 */
export async function foodSummary(companyId: string, day: DayKey): Promise<LunchFoodSummary> {
  const rows = await prisma.lunchOrder.findMany({
    where: { companyId, serviceDate: dayKeyToDateColumn(day) },
    select: {
      status: true,
      items: { select: { menuItemId: true, itemName: true, quantity: true, lineTotal: true } },
    },
  });

  return summariseLunchFood(
    day,
    rows.map((row) => ({
      status: row.status as LunchOrderStatus,
      items: row.items.map((item) => ({
        menuItemId: item.menuItemId,
        itemName: item.itemName,
        quantity: item.quantity,
        lineTotal: toNumber(item.lineTotal),
      })),
    })),
  );
}

/** What one person still owes for a day, over their unpaid, live orders. */
export function outstandingFor(orders: ReadonlyArray<LunchOrderRecord>): number {
  return roundLunchMoney(
    orders
      .filter((order) => order.status !== 'CANCELLED' && order.paymentStatus === 'UNPAID')
      .reduce((sum, order) => sum + order.totalAmount, 0),
  );
}
