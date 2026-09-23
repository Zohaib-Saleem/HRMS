import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The dashboard's rows, in one place.
 *
 * Every row on a dashboard used to declare its own grid, and no two of them
 * agreed: the service cards broke to two columns at `md` and three at `xl`, the
 * month's tiles at `sm` and four at `xl`, the reference cards at `lg` and never
 * again. Between those breakpoints the column edges of one row landed nowhere
 * near the row above it, which is most of what "the dashboard looks uneven"
 * means. One ladder here - one column on a phone, two on a tablet, the row's
 * own count from `lg` up - and every row breaks at the same width.
 *
 * Two rules the rows also share, and which are the whole reason cards drifted
 * out of line before:
 *
 *   - `items-stretch` (the grid default, stated here because the row it
 *     replaced had opted out of it with `items-start`) plus `h-full` on each
 *     child. A card is then as tall as the tallest card beside it, and the
 *     bottoms of a row line up whatever any one card has to say. Height comes
 *     from the row, never from a fixed pixel figure that would be wrong on the
 *     next screen.
 *   - `min-w-0` on each child. A grid item's default `min-width: auto` refuses
 *     to shrink below its content, so one long asset name or a wide table used
 *     to push the whole row past the viewport and give the page a sideways
 *     scrollbar. Zero lets the column take the width the grid gives it and the
 *     `truncate` inside the cards do its job.
 *
 * Both are applied to the CHILDREN rather than asked of each card, so a card
 * written for one of these rows needs to know nothing about the row it is in -
 * including the ones that live in other feature folders.
 *
 * The third rule is about the headers. A card header that carries a button
 * centres its row, so the title of a card with a "View all" button beside it
 * sat five pixels lower than the title of the plain card next to it - and
 * lower again when the buttons wrapped onto a second line. Anchoring those
 * headers to the TOP instead puts every title in a row on the same line
 * whatever is beside it and whatever the column width does to it. Only headers
 * that lay their children in a row are touched; a stacked header's
 * `items-start` would be a horizontal instruction and would shrink-wrap it.
 */

/** From `lg` up. Below it every row is 1 column on a phone, 2 on a tablet. */
const WIDE_COLUMNS = {
  1: '',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
} as const;

export function DashboardGrid({
  columns = 3,
  className,
  children,
}: {
  /** Cards across the row on a wide screen. */
  columns?: keyof typeof WIDE_COLUMNS;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 items-stretch gap-4',
        columns > 1 && 'md:grid-cols-2',
        WIDE_COLUMNS[columns],
        '[&>*]:h-full [&>*]:min-w-0',
        '[&_[data-slot=card-header].flex-row]:items-start',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The vertical rhythm between rows.
 *
 * `space-y` rather than a margin on each section, because a margin is a
 * decision each section makes alone and they disagreed: the attendance card
 * carried `mb-6`, half the rows `mt-4`, and the reference grid nothing at all,
 * so it butted straight into the block above it. Stated once here, the gap
 * between two rows is the same gap as between two cards inside one.
 *
 * Sections that render themselves away contribute no element, so a dashboard
 * with no celebrations and no asset register has no holes where they would
 * have been.
 */
export function DashboardStack({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn('space-y-4', className)}>{children}</div>;
}
