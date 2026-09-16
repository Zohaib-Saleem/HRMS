import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sandwich } from 'lucide-react';
import {
  LUNCH_PAYMENT_STATUS_LABELS,
  PERMISSIONS,
  type LunchOrderRecord,
  type LunchTodayView,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions, useSession } from '@/features/auth/session-context';
import { money } from '@/features/employment/employment-shared';
import { LUNCH_PAYMENT_TONE, compactLunchItems } from './lunch-shared';

/**
 * Today's lunch, on the employee's dashboard.
 *
 * Lunch is a decision with a deadline inside the working day, which makes it
 * the one thing on this dashboard that is useless the moment it is late. It
 * used to have no presence here at all - an employee had to remember lunch
 * existed and go and find it in the sidebar - so it sits in the top row beside
 * attendance and cases rather than among the reference cards at the foot.
 *
 * Three states and no fourth: nothing ordered, ordered and owing, ordered and
 * paid. Each is small. A card that took a quarter of the screen to say "you
 * have not ordered lunch" would be the same mistake as burying it.
 *
 * What this card deliberately does NOT say is when ordering closes. There is no
 * cutoff in this product - no setting, no column, nothing that enforces one -
 * so a line reading "order before 10:30" would be a deadline the software does
 * not keep, printed for eighty people. If a cutoff is added, `canOrder` on this
 * very payload is where it will surface.
 */

/** The reader's own orders for today, reduced to the one line a card can hold. */
function orderLine(orders: readonly LunchOrderRecord[]): string {
  if (orders.length === 1) return compactLunchItems(orders[0]!.items, 3).inline;

  const plates = orders.reduce(
    (sum, order) => sum + order.items.reduce((n, item) => n + item.quantity, 0),
    0,
  );
  return `${orders.length} orders · ${plates} item${plates === 1 ? '' : 's'}`;
}

export function LunchTodayCard() {
  const { has } = usePermissions();
  const { session } = useSession();

  const canRead = has(PERMISSIONS.LUNCH_ORDER_READ_OWN);
  const currency = session?.company.currency ?? 'PKR';

  const query = useQuery({
    queryKey: ['lunch', 'today'],
    queryFn: () => api.get<LunchTodayView>('/lunch/today'),
    enabled: canRead,
    staleTime: 60_000,
    // A card on a dashboard of half a dozen. Losing lunch to a failed request
    // must cost the reader lunch, never their attendance and their leave.
    retry: false,
  });

  if (!canRead) return null;

  const view = query.data ?? null;
  /*
   * Cancelled orders are not lunch. The desk drops them from the day's cooking
   * and its collection, and an employee who called theirs off has not ordered -
   * so the card offers to order again rather than reporting a lunch nobody is
   * bringing.
   */
  const live = (view?.orders ?? []).filter((order) => order.status !== 'CANCELLED');
  const total = live.reduce((sum, order) => sum + order.totalAmount, 0);
  const allPaid = live.length > 0 && live.every((order) => order.paymentStatus === 'PAID');

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Today&rsquo;s lunch</CardTitle>
        {live.length > 0 ? (
          <Badge variant={LUNCH_PAYMENT_TONE[allPaid ? 'PAID' : 'UNPAID']}>
            {LUNCH_PAYMENT_STATUS_LABELS[allPaid ? 'PAID' : 'UNPAID']}
          </Badge>
        ) : null}
      </CardHeader>

      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : live.length === 0 ? (
          /*
           * Compact on purpose - two lines and a button. This is the state the
           * card is in every morning, so it is the one that must not take up
           * room.
           */
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13.5px] font-medium">Not ordered</p>
              <p className="text-xs text-muted-foreground">
                {view?.canOrder === false
                  ? 'Your login is not linked to an employee record.'
                  : "Pick from today's menu."}
              </p>
            </div>
            {view?.canOrder === false ? null : (
              <Button size="sm" asChild>
                <Link to="/lunch">Order lunch</Link>
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[13.5px] font-medium" title={orderLine(live)}>
                {orderLine(live)}
              </p>
              <p className="tabular text-xs text-muted-foreground">
                {money(total, currency)}
                {allPaid ? null : ` · ${money(view?.outstandingAmount ?? total, currency)} to pay`}
              </p>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link to="/lunch">View order</Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The icon the dashboard uses when it needs one for this card. */
export const LUNCH_TODAY_ICON = Sandwich;
