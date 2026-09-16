import * as React from "react";
import type { LunchOrderRecord } from "@hrms/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { money } from "@/features/employment/employment-shared";
import { compactLunchItem, compactLunchItems } from "./lunch-shared";

/**
 * What an order is, in the width of a table cell.
 *
 * The desk's list is sixty rows and the office boy reads it standing up, so the
 * thing that matters about this column is that a row stays a row. Written out
 * in full, a five-item order is a paragraph - and because the column has no
 * width of its own in an eight-column auto-layout table, that paragraph wraps
 * at every space it can find and the row becomes six lines tall. Sixty of those
 * is a page nobody can scan.
 *
 * So: four items inline, the rest counted, and the whole order one click away.
 * Nothing is lost - the count is exact, the tooltip carries the full text, and
 * the dialog behind "View all" lists every line with its own money.
 */

/** Detects a clamped paragraph that is actually hiding something. */
function useIsOverflowing(deps: React.DependencyList) {
  const ref = React.useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = React.useState(false);

  React.useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      // In jsdom both are 0, so this reads false and the count-based rule below
      // is what the tests see - which is the rule worth testing anyway.
      setOverflowing(el.scrollHeight > el.clientHeight + 1);
    };

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ref, overflowing };
}

interface LunchItemsCellProps {
  order: LunchOrderRecord;
  currency: string;
}

export function LunchItemsCell({ order, currency }: LunchItemsCellProps) {
  const [open, setOpen] = React.useState(false);
  const { inline, hidden, full } = React.useMemo(
    () => compactLunchItems(order.items),
    [order.items],
  );
  const { ref, overflowing } = useIsOverflowing([inline, hidden]);

  /*
   * Offered when the row is demonstrably not showing everything: either items
   * were counted off, or the two-line clamp bit into the ones that were kept.
   * The second case is rare - four ordinary names fit - but it is the case a
   * tooltip cannot rescue on a phone, where there is no hover.
   */
  const truncated = hidden > 0 || overflowing;

  return (
    <div className="min-w-[19rem] max-w-[28rem]">
      <p ref={ref} className="line-clamp-2 text-[13px] leading-5" title={full}>
        {inline}
        {hidden > 0 ? (
          <span className="text-muted-foreground"> + {hidden} more</span>
        ) : null}
      </p>

      {/*
       * The note and "View all" share ONE line rather than taking one each.
       * Two lines of items is the budget; a third line for the kitchen note
       * and a fourth for a link is how a 64px row became a 101px row, which
       * is the same excess this whole cell exists to remove.
       */}
      {order.note || truncated ? (
        <div className="flex items-baseline gap-2 text-xs">
          {order.note ? (
            <span className="truncate text-muted-foreground" title={order.note}>
              {order.note}
            </span>
          ) : null}
          {truncated ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="shrink-0 font-medium text-primary underline-offset-2 hover:underline"
            >
              View all
            </button>
          ) : null}
        </div>
      ) : null}

      {truncated ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{order.employeeName}</DialogTitle>
              <DialogDescription>
                {order.orderNumber} · {order.items.length} items
              </DialogDescription>
            </DialogHeader>

            <DialogBody>
              <ul className="divide-y divide-border text-[13px]">
                {order.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-baseline justify-between gap-4 py-2"
                  >
                    <span>{compactLunchItem(item)}</span>
                    <span className="tabular shrink-0 text-muted-foreground">
                      {money(item.lineTotal, currency)}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex items-baseline justify-between gap-4 border-t border-border pt-3 text-[13px] font-medium">
                <span>Total</span>
                <span className="tabular">
                  {money(order.totalAmount, currency)}
                </span>
              </div>

              {order.note ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  {order.note}
                </p>
              ) : null}
            </DialogBody>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
