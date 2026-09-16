import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

/**
 * The lunch system: an order, and the money somebody hands over for it.
 *
 * This module is deliberately NOT a finance module, and the distinction is the
 * whole design rather than a note on it. Lunch here is what actually happens in
 * the office every day: an employee orders food, the office boy brings it, the
 * employee pays the office boy, and the office boy writes down that they paid.
 * The software's entire job is to be the paper that office boy would otherwise
 * be keeping in his pocket - a list of today's orders, what each one costs, who
 * has paid and what is still owed at the end of the day.
 *
 * So there is no payroll deduction, no salary deduction, no finance approval,
 * no finance reconciliation, no company subsidy, no payment gateway and no
 * online payment anywhere in this module, and none of those is an omission to
 * be filled in later. Each one would change what the thing IS: a deduction
 * makes lunch a payroll input and puts a month between ordering a biryani and
 * accounting for it; an approval step puts somebody between the office boy and
 * his own float. The money is cash in a hand at lunchtime, and the record of it
 * settles the same day.
 *
 * Two people use it and they can do different things, enforced server-side:
 *
 *   the EMPLOYEE     orders, sees their own order and its payment status, and
 *                    cancels an order nobody has paid for. They cannot mark it
 *                    paid, cannot change what it costs, cannot change how it
 *                    was paid, and cannot touch it at all once it is paid.
 *   the LUNCH        sees the day's orders and what they add up to, marks an
 *   OPERATOR         order paid with the method the money arrived in, and -
 *   (office boy)     with a second grant and a written reason - corrects a
 *                    payment that was recorded wrongly.
 *
 * The vocabulary below is shared by both sides and by the browser, so a button
 * cannot offer something the server refuses, and the six figures on the
 * collection screen cannot disagree with the list underneath them: they are
 * computed by one function here, from the same rows.
 */

// --- the day -----------------------------------------------------------------

/**
 * A lunch day, as `yyyy-MM-dd` in the COMPANY's timezone.
 *
 * Not UTC. Lunch is eaten at a wall clock, and a company in Karachi ordering at
 * 13:00 local is ordering at 08:00 UTC - close enough to midnight either side
 * of the year that a UTC day would eventually file an order under yesterday and
 * lose it off the office boy's screen.
 */
export const lunchDaySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-MM-dd date.');

// --- what an order is ---------------------------------------------------------

/**
 * Where an order is in its life.
 *
 * Four live states and one end. The four are the lunch round as it actually
 * runs: somebody orders, the kitchen starts on it, it is ready to hand over,
 * and it is handed over. They exist because the last of them is load-bearing
 * rather than decorative - DELIVERED is the line after which an order can no
 * longer simply be called off, because the food has been eaten. Everything
 * before it can be.
 *
 * CANCELLED is the one that carries weight, and it carries it in the money and
 * in the kitchen both: a cancelled order is excluded from the day's expected
 * collection, from what is outstanding, and from the plates the cook is told to
 * make. That exclusion is total and it is immediate, which is the point of the
 * status existing at all.
 *
 * Note what CANCELLED does not do: it does not erase a payment. An order that
 * was paid for and then cancelled keeps its payment record and gains a refund
 * decision beside it - see `LUNCH_REFUND_STATUSES`. Losing the fact that money
 * changed hands is the one outcome a cash system must never produce.
 */
export const LUNCH_ORDER_STATUSES = [
  'ORDERED',
  'PREPARING',
  'READY',
  'DELIVERED',
  'CANCELLED',
] as const;

export type LunchOrderStatus = (typeof LUNCH_ORDER_STATUSES)[number];

export const LUNCH_ORDER_STATUS_LABELS: Record<LunchOrderStatus, string> = {
  ORDERED: 'Ordered',
  PREPARING: 'Preparing',
  READY: 'Ready',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

/** What each state means to whoever is looking at the row. */
export const LUNCH_ORDER_STATUS_DESCRIPTIONS: Record<LunchOrderStatus, string> = {
  ORDERED: 'Placed and waiting for the kitchen.',
  PREPARING: 'Being cooked.',
  READY: 'Ready to hand over.',
  DELIVERED: 'Handed over.',
  CANCELLED: 'Called off. Nothing is owed and nothing is being made.',
};

/**
 * The order the lunch round moves in, forwards only.
 *
 * There is no way back along this list. An order that has been handed over has
 * been handed over, and a status that could be walked backwards would let the
 * DELIVERED rule below be stepped around by moving an order to READY first and
 * cancelling it there. Undoing a mistake on a delivered order is the correction
 * path, which is audited and says what it is.
 */
export const LUNCH_FULFILMENT_FLOW: readonly LunchOrderStatus[] = [
  'ORDERED',
  'PREPARING',
  'READY',
  'DELIVERED',
];

/** Where an order starts. Stated rather than implied by the array's first element. */
export const DEFAULT_LUNCH_ORDER_STATUS: LunchOrderStatus = 'ORDERED';

/**
 * The next state along, or null at the end of the line.
 *
 * Shared, so the button that advances an order and the endpoint that accepts it
 * are reading the same list rather than two copies of it.
 */
export function nextLunchOrderStatus(status: LunchOrderStatus): LunchOrderStatus | null {
  const index = LUNCH_FULFILMENT_FLOW.indexOf(status);
  if (index === -1 || index === LUNCH_FULFILMENT_FLOW.length - 1) return null;
  return LUNCH_FULFILMENT_FLOW[index + 1] ?? null;
}

/** Whether a fulfilment move is one the flow allows: exactly one step forward. */
export function canAdvanceLunchOrder(from: LunchOrderStatus, to: LunchOrderStatus): boolean {
  return nextLunchOrderStatus(from) === to;
}

/**
 * Whether the order is real enough to be owed money for, and to be cooked.
 *
 * The single rule behind "valid/non-cancelled", written once so the expected
 * total, the outstanding total, the list the office boy reads and the plates
 * the kitchen is told to make all mean the same thing by it. Every live status
 * counts; only CANCELLED does not.
 */
export function isLunchOrderPayable(status: LunchOrderStatus): boolean {
  return status !== 'CANCELLED';
}

/**
 * The statuses an operator may simply cancel an order out of.
 *
 * Everything before the food is handed over. DELIVERED is deliberately absent:
 * once somebody has eaten, "cancel" is no longer a description of anything that
 * happened, and pretending otherwise would take a real plate of food out of the
 * kitchen's count after it had been made and out of the day's expected
 * collection after it was owed. A delivered order that needs putting right goes
 * through the payment correction instead, which is audited and which does not
 * claim the lunch never existed.
 */
export const LUNCH_OPERATOR_CANCELLABLE_STATUSES: readonly LunchOrderStatus[] = [
  'ORDERED',
  'PREPARING',
  'READY',
];

/**
 * Whether the operator may cancel this order.
 *
 * Note what is NOT in here: the payment status. An operator can cancel a paid
 * order - that is the whole reason the refund decision exists - and refusing to
 * would leave the office boy with no way to record a lunch that was paid for
 * and then not wanted. What he cannot do is cancel one silently: the endpoint
 * requires him to say what happened to the money.
 */
export function canOperatorCancelLunchOrder(status: LunchOrderStatus): boolean {
  return LUNCH_OPERATOR_CANCELLABLE_STATUSES.includes(status);
}

// --- paying for it ------------------------------------------------------------

/**
 * Whether the money has arrived. Two values, and UNPAID is where every order
 * starts - an order is a promise to pay at lunchtime, not a payment.
 */
export const LUNCH_PAYMENT_STATUSES = ['UNPAID', 'PAID'] as const;

export type LunchPaymentStatus = (typeof LUNCH_PAYMENT_STATUSES)[number];

export const DEFAULT_LUNCH_PAYMENT_STATUS: LunchPaymentStatus = 'UNPAID';

export const LUNCH_PAYMENT_STATUS_LABELS: Record<LunchPaymentStatus, string> = {
  UNPAID: 'Unpaid',
  PAID: 'Paid',
};

/**
 * How the money arrived, recorded because the office boy has to reconcile a
 * cash box at the end of the day and a transfer is not in it.
 *
 * Three values and no more. CASH is what nearly every row will be; a transfer
 * happens when somebody has no change; OTHER is the honest bucket for the rest
 * rather than a list that grows until nobody picks the right one. Note what
 * these are NOT: they are not payment channels the software operates. Nothing
 * here initiates, verifies or settles anything - the money moved between two
 * people, and this is the word the office boy used to describe how.
 */
export const LUNCH_PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'OTHER'] as const;

export type LunchPaymentMethod = (typeof LUNCH_PAYMENT_METHODS)[number];

/** What the Mark paid dialog starts on, because it is what nearly always happens. */
export const DEFAULT_LUNCH_PAYMENT_METHOD: LunchPaymentMethod = 'CASH';

export const LUNCH_PAYMENT_METHOD_LABELS: Record<LunchPaymentMethod, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  OTHER: 'Other',
};

/**
 * What happened to the money when a PAID order was cancelled.
 *
 * This exists because "cancelled" and "paid" are both true of the same order
 * surprisingly often - somebody pays at noon and is called out at half past -
 * and because the wrong way to handle that is to quietly set the order back to
 * unpaid. That would erase the fact that cash left somebody's hand and entered
 * the office boy's, which is the one fact a cash system exists to remember.
 *
 * So the payment stays PAID, and this records the decision taken beside it:
 *
 *   NONE      no decision to take. Either the order was never paid for, or it
 *             was never cancelled.
 *   REFUNDED  the money went back. It leaves the day's collection.
 *   RETAINED  the money stayed with the office boy - the food was bought, or
 *             it was eaten by somebody else, or the employee said keep it.
 *
 * RETAINED is a value rather than the absence of one on purpose. "Paid,
 * cancelled and not refunded" and "paid, cancelled, and we decided together
 * that I am keeping it" are the same row if the decision is only ever inferred,
 * and the second is a thing somebody agreed to and should be able to point at.
 */
export const LUNCH_REFUND_STATUSES = ['NONE', 'REFUNDED', 'RETAINED'] as const;

export type LunchRefundStatus = (typeof LUNCH_REFUND_STATUSES)[number];

export const DEFAULT_LUNCH_REFUND_STATUS: LunchRefundStatus = 'NONE';

export const LUNCH_REFUND_STATUS_LABELS: Record<LunchRefundStatus, string> = {
  NONE: 'No refund',
  REFUNDED: 'Refunded',
  RETAINED: 'Payment retained',
};

/** What the operator is actually choosing between when cancelling a paid order. */
export const LUNCH_CANCEL_RESOLUTIONS = ['REFUND', 'RETAIN'] as const;

export type LunchCancelResolution = (typeof LUNCH_CANCEL_RESOLUTIONS)[number];

export const LUNCH_CANCEL_RESOLUTION_LABELS: Record<LunchCancelResolution, string> = {
  REFUND: 'Cancel + Refund',
  RETAIN: 'Cancel + Payment retained',
};

export const LUNCH_CANCEL_RESOLUTION_DESCRIPTIONS: Record<LunchCancelResolution, string> = {
  REFUND: 'The money goes back to them. It leaves today\u2019s collection.',
  RETAIN: 'The money stays with you. It is still in the box at the end of the day.',
};

/** The resolution, as the refund status it records. */
export const LUNCH_RESOLUTION_REFUND_STATUS: Record<LunchCancelResolution, LunchRefundStatus> = {
  REFUND: 'REFUNDED',
  RETAIN: 'RETAINED',
};

/** Shown when an operator tries to cancel a paid order without deciding. */
export const LUNCH_PAID_CANCEL_MESSAGE =
  'This order has already been paid. Choose whether the money is refunded or retained.';

// --- what each side may do ----------------------------------------------------

/**
 * Whether the person who ordered may still call it off.
 *
 * Unchanged by the arrival of the operator's own cancel, and deliberately so.
 * The rule is what it always was: an order nobody has started and nobody has
 * paid for. ORDERED is the state PLACED used to be - the moment before the
 * kitchen picks it up - so this permits exactly what it permitted before and
 * nothing more.
 *
 * It is NOT widened to PREPARING or READY. An employee cancelling food that is
 * already in a pan is a conversation with the office boy, not a button: he is
 * the one who has to decide whether the ingredients are gone. He can then
 * cancel it himself, which is audited and names him.
 *
 * And not a paid order, for the reason it never was: unpicking a payment is a
 * refund decision, and an employee who could make it would be writing money out
 * of the office boy's box without his knowing.
 *
 * Shared so the button and the endpoint cannot disagree.
 */
export function canEmployeeCancelLunchOrder(
  status: LunchOrderStatus,
  paymentStatus: LunchPaymentStatus,
): boolean {
  return status === 'ORDERED' && paymentStatus === 'UNPAID';
}

/**
 * Whether the operator may mark this one paid.
 *
 * Any live order that has not been paid for - which now spans the whole
 * fulfilment flow, DELIVERED included, because paying on delivery is the
 * ordinary case rather than an edge one: the food arrives, the money is handed
 * over, the row is ticked.
 *
 * Marking an already-paid order paid again is refused rather than ignored: the
 * second click is either a mistake or a second payment, and silently absorbing
 * it is how an office boy ends up certain he collected money he did not. A
 * cancelled order is refused too - nobody owes for a lunch that was called off.
 */
export function canMarkLunchOrderPaid(
  status: LunchOrderStatus,
  paymentStatus: LunchPaymentStatus,
): boolean {
  return isLunchOrderPayable(status) && paymentStatus === 'UNPAID';
}

// --- money --------------------------------------------------------------------

/**
 * Money, to the two decimal places the database column holds.
 *
 * Applied at every point a total is built rather than only at the end, so the
 * figure on the order matches the sum of its lines and the collection total
 * matches the sum of the orders. Floating point is fine at this scale - a day's
 * lunch is four figures, not a payroll - but only if the rounding happens in
 * one place and always the same way.
 */
export function roundLunchMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export const LUNCH_ORDER_MAX_LINES = 10;
export const LUNCH_ORDER_MAX_QUANTITY = 10;

/** One line of an order, priced as it was on the day. */
export interface LunchOrderItemRecord {
  id: string;
  /**
   * The menu item it came from, or null once that item has been removed from
   * the menu. The name and the price on this row are snapshots and do not
   * follow it: yesterday's chicken karahi cost what it cost yesterday, and a
   * price rise must not quietly rewrite what the office boy collected.
   */
  menuItemId: string | null;
  itemName: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

/** What an order comes to, from its lines. Used to price one before it exists. */
export function lunchOrderTotal(
  lines: ReadonlyArray<{ unitPrice: number; quantity: number }>,
): number {
  return roundLunchMoney(
    lines.reduce((sum, line) => sum + roundLunchMoney(line.unitPrice * line.quantity), 0),
  );
}

/**
 * The order as one readable line: `2 Chapati + Chicken Karahi`.
 *
 * Built here rather than in the browser because it is printed in three places -
 * the operator's list, the employee's own card and the confirmation before
 * money is taken - and those three must say the same thing about the same
 * order. A quantity of one is left off, because "1 Biryani" is how a receipt
 * talks and not how a person does.
 */
export function lunchItemSummary(
  items: ReadonlyArray<{ itemName: string; quantity: number }>,
): string {
  return items
    .map((item) => (item.quantity > 1 ? `${item.quantity} ${item.itemName}` : item.itemName))
    .join(' + ');
}

// --- the order number ---------------------------------------------------------

/** `LUNCH-2026-09-16-00042`. */
export const LUNCH_ORDER_NUMBER_PREFIX = 'LUNCH-';

export const LUNCH_ORDER_SEQUENCE_DIGITS = 5;

/**
 * The reference the office boy reads out, built from the DAY and a sequence
 * within it.
 *
 * Per day rather than per year, which is the one decision worth stating: an
 * order lives for a single lunchtime, the number is used to find a row on a
 * list of sixty, and `LUNCH-2026-09-16-00042` tells whoever is holding it which
 * day's money it belongs to without a lookup. A running annual sequence would
 * be five digits longer by March and would carry no information at all.
 */
export function formatLunchOrderNumber(day: string, sequence: number): string {
  return `${LUNCH_ORDER_NUMBER_PREFIX}${day}-${String(sequence).padStart(LUNCH_ORDER_SEQUENCE_DIGITS, '0')}`;
}

/** The `LUNCH-2026-09-16-` part, which a "highest so far" query matches on. */
export function lunchOrderNumberDayPrefix(day: string): string {
  return `${LUNCH_ORDER_NUMBER_PREFIX}${day}-`;
}

/**
 * Reads the sequence back out, or null if the value is not one of ours.
 *
 * Strict on purpose: the generator finds the highest number issued today by
 * parsing them, and a row it cannot parse is skipped rather than guessed at, so
 * one hand-edited value cannot reset the day's sequence onto a number already
 * in use.
 */
export function parseLunchOrderNumberSequence(orderNumber: string, day: string): number | null {
  const prefix = lunchOrderNumberDayPrefix(day);
  if (!orderNumber.startsWith(prefix)) return null;
  const suffix = orderNumber.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  return Number.parseInt(suffix, 10);
}

// --- the menu -----------------------------------------------------------------

const trimmed = (min: number, max: number, message: string) =>
  z.string().trim().min(min, message).max(max, `Keep this under ${max} characters.`);

/**
 * A price, as a number with at most two decimals.
 *
 * Refused above a limit that no plate of food reaches, because the field that
 * sets what an employee will be charged is worth a ceiling: a mistyped price is
 * the one configuration error in this module that takes money out of somebody's
 * pocket.
 */
const lunchPriceSchema = z.coerce
  .number({ invalid_type_error: 'Enter a price.' })
  .min(0, 'A price cannot be negative.')
  .max(100000, 'That is not a lunch price. Check the figure.')
  .refine((value) => Number.isFinite(value), 'Enter a price.')
  .transform(roundLunchMoney);

export const lunchMenuItemCreateSchema = z.object({
  name: trimmed(1, 120, 'Give the item a name.'),
  description: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  price: lunchPriceSchema,
  /** Display order on the order form. Ties fall back to name. */
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});

export type LunchMenuItemCreateInput = z.infer<typeof lunchMenuItemCreateSchema>;

export const lunchMenuItemUpdateSchema = lunchMenuItemCreateSchema.partial();

export type LunchMenuItemUpdateInput = z.infer<typeof lunchMenuItemUpdateSchema>;

export interface LunchMenuItemRecord {
  id: string;
  name: string;
  description: string | null;
  price: number;
  /**
   * Retired rather than deleted. Orders point at menu items, and a company that
   * stops selling chapati has not stopped having sold it on Tuesday.
   */
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// --- placing an order ---------------------------------------------------------

/**
 * One line of a new order: WHAT, and HOW MANY. Notably not how much.
 *
 * There is no price in this payload and there is no total either. The server
 * reads today's price off the menu row and does the arithmetic, so the only
 * thing a hand-built request can change is what was ordered - never what it
 * costs. "An employee cannot change the payment amount" is that absence, and it
 * is an absence rather than a check because a check is a thing somebody can
 * forget to write on the next endpoint.
 */
export const lunchOrderLineSchema = z.object({
  menuItemId: trimmed(1, 64, 'Choose an item.'),
  quantity: z.coerce
    .number()
    .int('Whole plates only.')
    .min(1, 'At least one.')
    .max(LUNCH_ORDER_MAX_QUANTITY, `At most ${LUNCH_ORDER_MAX_QUANTITY} of one item.`),
});

/**
 * Placing an order.
 *
 * Carries no employee id, which is the whole of the employee-side security
 * story for creation: the order is placed BY the caller FOR the caller, taken
 * from the session, and there is no field anybody could set to order in
 * somebody else's name and leave them owing for it. It carries no day either -
 * an order is for today, in the company's timezone, and a day parameter would
 * be a way to file lunch against a collection that has already been settled.
 */
export const lunchOrderCreateSchema = z.object({
  items: z
    .array(lunchOrderLineSchema)
    .min(1, 'Choose at least one item.')
    .max(LUNCH_ORDER_MAX_LINES, `At most ${LUNCH_ORDER_MAX_LINES} different items on one order.`),
  /** "No chillies." Goes to the kitchen, not to the money. */
  note: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
});

export type LunchOrderCreateInput = z.infer<typeof lunchOrderCreateSchema>;

export const lunchOrderCancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
});

export type LunchOrderCancelInput = z.infer<typeof lunchOrderCancelSchema>;

/**
 * The operator calling somebody else's order off.
 *
 * A separate schema from the employee's own cancel above, and the difference is
 * the point of it. An employee cancelling their own unpaid order owes nobody an
 * explanation, so their reason is optional. An operator is reaching into
 * somebody else's lunch - and possibly their money - so the reason is
 * compulsory, and it is shown to the employee afterwards rather than kept on
 * the desk's side. That is the whole reason for making it mandatory: the person
 * whose lunch disappeared gets to read why.
 *
 * `resolution` is absent unless the order was PAID. The server knows which, and
 * refuses a paid order that arrives without one rather than guessing - guessing
 * here means either inventing a refund that never happened or quietly keeping
 * money nobody agreed to keep.
 */
export const lunchOperatorCancelSchema = z.object({
  reason: trimmed(3, 500, 'Say why this order is being cancelled.'),
  /**
   * What happens to money already taken. Required when the order is paid,
   * meaningless when it is not.
   */
  resolution: z.enum(LUNCH_CANCEL_RESOLUTIONS).optional(),
  /**
   * The operator's own note on that decision - which is NOT sent to the
   * employee. The cancellation reason is theirs to read; this is working.
   */
  refundReason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
});

export type LunchOperatorCancelInput = z.infer<typeof lunchOperatorCancelSchema>;

/**
 * Moving an order along the lunch round.
 *
 * The target status is named rather than implied by a bare "advance", so two
 * people working the same screen cannot both step a row on and move it two.
 * The server checks it against `canAdvanceLunchOrder`, which permits exactly
 * one step forward and never back.
 */
export const lunchOrderStatusSchema = z.object({
  status: z.enum(LUNCH_ORDER_STATUSES),
});

export type LunchOrderStatusInput = z.infer<typeof lunchOrderStatusSchema>;

// --- taking the money ---------------------------------------------------------

/**
 * Marking one order paid.
 *
 * The amount is absent on purpose. An order is paid in full or it is not paid:
 * the office boy took the money for that plate, and letting him type a figure
 * would turn a tick into a ledger and the day's collection into something that
 * has to be explained rather than counted. Part payments, if a company ever
 * genuinely needs them, are a deliberate change to this shape and not an
 * optional field somebody can start using.
 */
export const lunchPaymentSchema = z.object({
  paymentMethod: z.enum(LUNCH_PAYMENT_METHODS).default(DEFAULT_LUNCH_PAYMENT_METHOD),
  note: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
});

export type LunchPaymentInput = z.infer<typeof lunchPaymentSchema>;

/**
 * Putting right a payment that was recorded wrongly.
 *
 * Its own endpoint, its own grant and a compulsory reason, because this is the
 * one action in the module that rewrites a fact about money that has already
 * been counted. Marking the wrong Ali paid happens; what must not happen is it
 * being quietly undone, so the reason is required, the change is audited with
 * both the before and the after, and there is no path to it from the ordinary
 * Mark paid button.
 *
 * Setting it back to UNPAID clears the method, the time and who took it,
 * because leaving those behind would leave a row that says nobody was paid by
 * somebody at half past one.
 */
export const lunchPaymentCorrectionSchema = z
  .object({
    paymentStatus: z.enum(LUNCH_PAYMENT_STATUSES),
    paymentMethod: z
      .enum(LUNCH_PAYMENT_METHODS)
      .nullish()
      .transform((value) => value ?? null),
    reason: trimmed(3, 500, 'Say why this payment is being corrected.'),
  })
  .superRefine((value, ctx) => {
    if (value.paymentStatus === 'PAID' && value.paymentMethod === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paymentMethod'],
        message: 'Say how the money arrived.',
      });
    }
  });

export type LunchPaymentCorrectionInput = z.infer<typeof lunchPaymentCorrectionSchema>;

// --- reading ------------------------------------------------------------------

/** One order, as both sides of the module read it. */
export interface LunchOrderRecord {
  id: string;
  orderNumber: string;
  /** The lunch day, `yyyy-MM-dd` in the company's timezone. */
  day: string;

  employeeId: string;
  employeeName: string;
  employeeNumber: string;

  status: LunchOrderStatus;
  items: LunchOrderItemRecord[];
  /** `2 Chapati + Chicken Karahi`, built once so every screen agrees. */
  itemSummary: string;
  totalAmount: number;

  paymentStatus: LunchPaymentStatus;
  paymentMethod: LunchPaymentMethod | null;
  paidAt: string | null;
  /** Who took the money. Null until somebody has. */
  paidByName: string | null;

  note: string | null;
  createdAt: string;

  // --- if it was called off ---------------------------------------------
  cancelledAt: string | null;
  /**
   * Who called it off, by name, and whether that was the person reading this.
   *
   * Both, because "Cancelled by Usman Ghani" and "Cancelled by you" are the
   * same fact and different sentences, and an employee looking at their own
   * cancelled order should not have to work out which of the two it was.
   */
  cancelledByName: string | null;
  cancelledBySelf: boolean;
  /**
   * Why. Shown to the employee as well as to the operator, deliberately: the
   * whole point of making the reason compulsory is that the person whose lunch
   * disappeared gets to read it.
   */
  cancellationReason: string | null;

  // --- and what happened to the money -----------------------------------
  refundStatus: LunchRefundStatus;
  refundedAt: string | null;
  /**
   * The operator's note on the refund decision.
   *
   * Null in anything an employee is sent - it is filtered out of the response
   * rather than hidden at render time, so it is absent rather than merely
   * invisible. The employee is told the decision (`refundStatus`) and the
   * reason the order was cancelled; the operator's own working on the money is
   * between him and the audit trail.
   */
  refundReason: string | null;

  /**
   * What the CALLER may do with this order, decided server-side from their
   * grants and the order's own state.
   *
   * On the record rather than worked out in the browser, because the browser
   * knowing the rule is how the rule drifts: the endpoint refuses what it
   * refuses, and these say so in advance rather than guessing alongside it.
   */
  canCancel: boolean;
  canMarkPaid: boolean;
  canCorrectPayment: boolean;
  /** The operator's cancel. False on a delivered order, and on a cancelled one. */
  canOperatorCancel: boolean;
  /** Whether the caller may move it along, and to where. Null at either end. */
  canAdvance: boolean;
  nextStatus: LunchOrderStatus | null;
}

/** The employee's own list. Their own orders; no parameter widens it. */
export const lunchOrderQuerySchema = paginationQuerySchema.extend({
  status: z.enum(LUNCH_ORDER_STATUSES).optional(),
  paymentStatus: z.enum(LUNCH_PAYMENT_STATUSES).optional(),
  from: lunchDaySchema.optional(),
  to: lunchDaySchema.optional(),
});

export type LunchOrderQuery = z.infer<typeof lunchOrderQuerySchema>;

export const LUNCH_ORDER_SORT_FIELDS = ['serviceDate', 'createdAt', 'totalAmount'] as const;

export type LunchOrderSortField = (typeof LUNCH_ORDER_SORT_FIELDS)[number];

/**
 * The operator's list: one day, filtered by whether the money is in.
 *
 * `day` defaults to today server-side rather than here, because "today" is a
 * question about the company's timezone and the browser is not authoritative
 * about it - a laptop that has travelled would otherwise ask for the wrong
 * day's collection and be answered.
 */
export const lunchCollectionQuerySchema = paginationQuerySchema.extend({
  day: lunchDaySchema.optional(),
  paymentStatus: z.enum(LUNCH_PAYMENT_STATUSES).optional(),
  status: z.enum(LUNCH_ORDER_STATUSES).optional(),
});

export type LunchCollectionQuery = z.infer<typeof lunchCollectionQuerySchema>;

/**
 * A day's collection, for the operator's screen and for the day's close.
 *
 * Two groups of figures and the line between them is the whole design. The
 * first group - expected, collected, outstanding - is the ACTIVE day: what is
 * owed and what is in the box for lunches that are actually happening. The
 * second - the cancelled figures - is money that was or was not involved in
 * lunches that are not happening, and it is reported ALONGSIDE the first group
 * rather than mixed into it.
 *
 * Keeping them apart is not tidiness. An office boy counting his box at six
 * o'clock needs `collected` to be what he should be holding; if a cancelled
 * paid order were folded into `expected` he would be short every time somebody
 * changed their mind, and if the money he retained were left out of the report
 * entirely he would be over and unable to say why.
 */
export interface LunchCollectionSummary {
  day: string;
  /** Orders that count: live, not cancelled. */
  totalOrders: number;
  paidOrders: number;
  unpaidOrders: number;

  /** What the live orders come to. Cancelled orders are not in it. */
  expectedCollection: number;
  /** What was taken for them. */
  collectedAmount: number;
  /** Expected minus collected: what is still owed for lunches happening today. */
  remainingAmount: number;

  // --- cancelled, reported beside the active day and never inside it -----
  /** Every cancelled order, whatever happened to the money. */
  cancelledOrders: number;
  /** Called off before anybody paid. No money was ever involved. */
  cancelledUnpaidOrders: number;
  cancelledUnpaidAmount: number;
  /**
   * Called off after being paid for. The office boy took this money and the
   * lunch is not happening, so where it went is the next two figures.
   */
  cancelledPaidOrders: number;
  cancelledPaidAmount: number;
  /** Of that, what went back to the employee. It has left the box. */
  refundedAmount: number;
  /** And what stayed. It is still in the box, and is not in `collected`. */
  retainedAmount: number;

  /**
   * What should actually be in the box: collected for live orders, plus what
   * was retained on cancelled ones.
   *
   * Here because it is the number the office boy counts against, and working it
   * out by adding two figures on a screen is exactly the arithmetic somebody
   * gets wrong at the end of a long day.
   */
  cashInHand: number;
}

/** The shape the summary is computed from - an order, reduced to its money. */
export interface LunchCollectableOrder {
  status: LunchOrderStatus;
  paymentStatus: LunchPaymentStatus;
  refundStatus: LunchRefundStatus;
  totalAmount: number;
}

/**
 * The day's figures, from the day's orders.
 *
 * One function, used by the collection screen, by the day's close and by the
 * tests, because the alternative is three places that each decide for
 * themselves what "expected" means and two of them being right. The rules it
 * encodes are the ones the office boy would apply on paper:
 *
 *   expected     what the live orders come to;
 *   collected    what the paid ones among them came to;
 *   remaining    the difference, which is what is still owed to him;
 *   cashInHand   collected, plus anything he kept on a cancelled order.
 *
 * Cancelled orders are excluded from the first three completely - from the
 * count, from expected and from remaining - rather than merely from expected.
 * An order nobody will eat is not a debt, and a "remaining" that included one
 * would send him looking for money nobody owes at the end of every day. They
 * are not thrown away either: they come back in their own figures below, split
 * by whether the money was refunded or kept, because those two mean opposite
 * things when he counts the box.
 */
export function summariseLunchCollection(
  day: string,
  orders: ReadonlyArray<LunchCollectableOrder>,
): LunchCollectionSummary {
  let totalOrders = 0;
  let paidOrders = 0;
  let expected = 0;
  let collected = 0;

  let cancelledOrders = 0;
  let cancelledUnpaidOrders = 0;
  let cancelledUnpaid = 0;
  let cancelledPaidOrders = 0;
  let cancelledPaid = 0;
  let refunded = 0;
  let retained = 0;

  for (const order of orders) {
    if (!isLunchOrderPayable(order.status)) {
      cancelledOrders += 1;

      if (order.paymentStatus === 'PAID') {
        cancelledPaidOrders += 1;
        cancelledPaid += order.totalAmount;
        /*
         * RETAINED and REFUNDED are both explicit decisions, and anything else
         * on a cancelled paid order is a decision nobody has recorded. It is
         * counted as retained, because the money is in the box until somebody
         * says it went back - assuming a refund that never happened is how a
         * report tells an office boy he is short when he is not.
         */
        if (order.refundStatus === 'REFUNDED') refunded += order.totalAmount;
        else retained += order.totalAmount;
      } else {
        cancelledUnpaidOrders += 1;
        cancelledUnpaid += order.totalAmount;
      }

      continue;
    }

    totalOrders += 1;
    expected += order.totalAmount;

    if (order.paymentStatus === 'PAID') {
      paidOrders += 1;
      collected += order.totalAmount;
    }
  }

  const expectedCollection = roundLunchMoney(expected);
  const collectedAmount = roundLunchMoney(collected);
  const retainedAmount = roundLunchMoney(retained);

  return {
    day,
    totalOrders,
    paidOrders,
    unpaidOrders: totalOrders - paidOrders,

    expectedCollection,
    collectedAmount,
    // Subtracting the rounded figures rather than rounding the difference, so
    // the three numbers on screen always add up to each other exactly.
    remainingAmount: roundLunchMoney(expectedCollection - collectedAmount),

    cancelledOrders,
    cancelledUnpaidOrders,
    cancelledUnpaidAmount: roundLunchMoney(cancelledUnpaid),
    cancelledPaidOrders,
    cancelledPaidAmount: roundLunchMoney(cancelledPaid),
    refundedAmount: roundLunchMoney(refunded),
    retainedAmount,

    cashInHand: roundLunchMoney(collectedAmount + retainedAmount),
  };
}

// --- what the kitchen is actually making -------------------------------------

/** One item, and how many plates of it the day needs. */
export interface LunchItemConsumption {
  /** Null once the menu item has been removed. The name is the record. */
  menuItemId: string | null;
  itemName: string;
  quantity: number;
  /** What those plates come to, at the prices they were ordered at. */
  amount: number;
}

/** The day's cooking, and what it is worth. */
export interface LunchFoodSummary {
  day: string;
  /** Live orders only. A cancelled order is not lunch for anybody. */
  totalOrders: number;
  totalPlates: number;
  items: LunchItemConsumption[];
}

/** An order as the kitchen reads it: a status, and what is on it. */
export interface LunchCookableOrder {
  status: LunchOrderStatus;
  items: ReadonlyArray<{
    menuItemId: string | null;
    itemName: string;
    quantity: number;
    lineTotal: number;
  }>;
}

/**
 * How many of each thing to make today.
 *
 * Cancelled orders contribute NOTHING here, and that is the rule this function
 * exists to hold: the moment an order is cancelled its plates leave the count,
 * whether or not anybody paid for it and whether or not that money was kept.
 * Retaining a payment is a decision about cash; it is not an instruction to
 * cook a lunch nobody is coming for.
 *
 * Grouped by the item NAME as it was ordered rather than by the menu row it
 * came from, so an item that has since been taken off the menu still totals
 * correctly, and so a renamed item does not silently merge with its old self in
 * the middle of a day.
 */
export function summariseLunchFood(
  day: string,
  orders: ReadonlyArray<LunchCookableOrder>,
): LunchFoodSummary {
  const byName = new Map<string, LunchItemConsumption>();
  let totalOrders = 0;
  let totalPlates = 0;

  for (const order of orders) {
    if (!isLunchOrderPayable(order.status)) continue;
    totalOrders += 1;

    for (const line of order.items) {
      const existing = byName.get(line.itemName);
      totalPlates += line.quantity;

      if (existing) {
        existing.quantity += line.quantity;
        existing.amount = roundLunchMoney(existing.amount + line.lineTotal);
      } else {
        byName.set(line.itemName, {
          menuItemId: line.menuItemId,
          itemName: line.itemName,
          quantity: line.quantity,
          amount: roundLunchMoney(line.lineTotal),
        });
      }
    }
  }

  return {
    day,
    totalOrders,
    totalPlates,
    // Most-cooked first: it is the order the kitchen would write the list in.
    items: [...byName.values()].sort(
      (a, b) => b.quantity - a.quantity || a.itemName.localeCompare(b.itemName),
    ),
  };
}

/** Zeroes, for a day nobody has ordered on. */
export function emptyLunchCollectionSummary(day: string): LunchCollectionSummary {
  return summariseLunchCollection(day, []);
}

/**
 * What the employee sees on the dashboard: their own lunch, today.
 *
 * `orders` rather than `order` because a second plate is a second order with
 * its own number and its own payment - the office boy collects per order, and
 * an employee who ordered again at two o'clock has two things to pay for.
 */
export interface LunchTodayView {
  day: string;
  orders: LunchOrderRecord[];
  /** What this person owes for today, over the orders nobody has paid for. */
  outstandingAmount: number;
  /** False when the caller's login has no employee record behind it. */
  canOrder: boolean;
}
