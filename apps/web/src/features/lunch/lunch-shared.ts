import type { BadgeProps } from '@/components/ui/badge';
import type { LunchOrderStatus, LunchPaymentStatus, LunchRefundStatus } from '@hrms/shared';

/**
 * Shared vocabulary for the lunch screens.
 *
 * The same order is read on three screens - the employee's own card, the
 * operator's list and the confirmation before money changes hands - and it has
 * to look the same on all three. Keeping the mapping here rather than repeating
 * a ternary is what stops an order reading "unpaid" in amber on one screen and
 * grey on another, the same reason `employment-shared` and `case-shared` exist.
 */

type Tone = NonNullable<BadgeProps['variant']>;

/**
 * Payment colours, chosen by whether somebody still has to do something.
 *
 * UNPAID is amber rather than red: money not yet handed over at half past
 * twelve is the ordinary state of every order on the screen, not a problem.
 * Painting it as one would make a normal lunchtime look like an incident.
 */
export const LUNCH_PAYMENT_TONE: Record<LunchPaymentStatus, Tone> = {
  UNPAID: 'warning',
  PAID: 'success',
};

/**
 * Where an order is along the round.
 *
 * Only DELIVERED gets a colour, because it is the only one that means the job
 * is done. The three before it are ordinary progress through a lunchtime and
 * painting them would turn a list of sixty normal orders into a traffic light.
 *
 * A cancelled order is not a failure either, it is an absence - so it is grey
 * and out of the way rather than red and shouting.
 */
export const LUNCH_ORDER_TONE: Record<LunchOrderStatus, Tone> = {
  ORDERED: 'neutral',
  PREPARING: 'neutral',
  READY: 'primary',
  DELIVERED: 'success',
  CANCELLED: 'neutral',
};

/**
 * What became of the money on a cancelled order.
 *
 * REFUNDED is neutral and RETAINED is a colour, which is the opposite of what
 * it first looks like it should be. A refund is the tidy outcome - the money
 * went back and nothing is outstanding. A retained payment is cash sitting in
 * the box against a lunch that never happened, and it is the figure the office
 * boy has to remember when he counts up, so it is the one worth spotting.
 */
export const LUNCH_REFUND_TONE: Record<LunchRefundStatus, Tone> = {
  NONE: 'neutral',
  REFUNDED: 'neutral',
  RETAINED: 'warning',
};

/** A `yyyy-MM-dd` lunch day, read as the calendar day it names. */
export function lunchDay(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The time money changed hands, which is the part anybody reconciling cares about. */
export function lunchTime(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Today, as the browser reckons it - only ever a DEFAULT for a date picker. */
export function todayForPicker(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

// --- what an order is, written short ----------------------------------------

/**
 * One line of an order, the way the desk reads it: `4× Tandoori Roti`.
 *
 * Deliberately NOT `lunchItemSummary` from the shared package. That function
 * produces the `itemSummary` field the API sends, which is a piece of order
 * data read by the employee's screen and by the confirmation before money
 * changes hands; rewriting it to suit a table would change what the API
 * returns. This is a rendering of `order.items`, which the record already
 * carries, and it stays on this side of the wire.
 *
 * The quantity is always shown, including when it is one. On a list of sixty
 * orders the eye is scanning a column of numbers, and an item that silently
 * drops its `1×` breaks that column - which is the whole reason the office boy
 * is looking at it.
 */
export function compactLunchItem(item: { itemName: string; quantity: number }): string {
  return `${item.quantity}× ${item.itemName}`;
}

/** Between items. A middle dot reads as a list without costing a line break. */
export const LUNCH_ITEM_SEPARATOR = ' · ';

/**
 * How many items go on the row before the rest become "+N more".
 *
 * Four, because four of them at the widths this column gets is about two lines,
 * and two lines is the height a row may grow to before a screenful of orders
 * stops being a screenful. The cap is on the COUNT rather than on the rendered
 * text so the "+N more" is an exact number rather than a guess about wrapping.
 */
export const LUNCH_ITEMS_INLINE_MAX = 4;

export interface CompactLunchItems {
  /** The items that fit on the row, already written out. */
  inline: string;
  /** How many were left off. Zero when the whole order is on the row. */
  hidden: number;
  /** Every item, for the tooltip and for the dialog behind "View all". */
  full: string;
}

/** Splits an order's items into what the row shows and what it defers. */
export function compactLunchItems(
  items: ReadonlyArray<{ itemName: string; quantity: number }>,
  max = LUNCH_ITEMS_INLINE_MAX,
): CompactLunchItems {
  const written = items.map(compactLunchItem);
  const hidden = Math.max(0, written.length - max);

  return {
    inline: written.slice(0, max).join(LUNCH_ITEM_SEPARATOR),
    hidden,
    full: written.join(LUNCH_ITEM_SEPARATOR),
  };
}
