import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Ban,
  Banknote,
  ChefHat,
  HandCoins,
  Receipt,
  Sandwich,
  Undo2,
  Wallet,
} from 'lucide-react';
import {
  LUNCH_ORDER_STATUSES,
  LUNCH_ORDER_STATUS_LABELS,
  LUNCH_PAYMENT_METHOD_LABELS,
  LUNCH_PAYMENT_STATUS_LABELS,
  LUNCH_REFUND_STATUS_LABELS,
  type LunchCollectionSummary,
  type LunchFoodSummary,
  type LunchOrderRecord,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useSession } from '@/features/auth/session-context';
import { money } from '@/features/employment/employment-shared';
import {
  LUNCH_ORDER_TONE,
  LUNCH_PAYMENT_TONE,
  LUNCH_REFUND_TONE,
  lunchDay,
  lunchTime,
} from './lunch-shared';
import { LunchMarkPaidDialog } from './lunch-mark-paid-dialog';
import { LunchCorrectPaymentDialog } from './lunch-correct-payment-dialog';
import { LunchCancelOrderDialog } from './lunch-cancel-order-dialog';

/**
 * Today's collection: the office boy's own screen.
 *
 * Six figures at the top and the orders they were computed from underneath, and
 * the two are deliberately fetched separately: the figures are about the WHOLE
 * day and the list is one page of it. Computing the totals from the rows on
 * screen would make "Expected" mean "expected from the twenty orders you can
 * currently see" - the kind of number somebody gets blamed for at six o'clock.
 *
 * Everything on this page is one day. The day is a date picker rather than a
 * range, because a collection is a day's worth of cash in a box: it is counted,
 * it is settled, and tomorrow is a different box. A month view would be a
 * finance report, which this module deliberately is not.
 */

const INITIAL = { q: '', paymentStatus: '', status: '', page: 1, limit: 50 };

export function LunchCollectionPage() {
  const { session } = useSession();
  const currency = session?.company.currency ?? 'PKR';

  /*
   * Empty means "today, as the company reckons it", and the SERVER decides
   * which day that is. The browser's clock is not asked: a laptop that has
   * travelled would otherwise open yesterday's collection and be answered.
   */
  const [day, setDay] = React.useState('');
  const [filters, setFilters] = React.useState(INITIAL);
  const [paying, setPaying] = React.useState<LunchOrderRecord | null>(null);
  const [correcting, setCorrecting] = React.useState<LunchOrderRecord | null>(null);
  const [cancelling, setCancelling] = React.useState<LunchOrderRecord | null>(null);

  const debouncedQuery = useDebounced(filters.q, 350);

  const summary = useQuery({
    queryKey: ['lunch', 'collection', day],
    queryFn: () =>
      api.get<LunchCollectionSummary>('/lunch/desk/collection', {
        query: { day: day || undefined },
      }),
  });

  const queryClient = useQueryClient();

  const food = useQuery({
    queryKey: ['lunch', 'food', day],
    queryFn: () =>
      api.get<LunchFoodSummary>('/lunch/desk/food', { query: { day: day || undefined } }),
  });

  /**
   * Moving an order along the round.
   *
   * One button that names the next state rather than a dropdown of all of
   * them: the flow is forward-only on the server, so offering the other four
   * would be offering three refusals and one action.
   */
  const advance = useMutation({
    mutationFn: (order: LunchOrderRecord) =>
      api.post<LunchOrderRecord>(`/lunch/desk/orders/${order.id}/status`, {
        status: order.nextStatus,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['lunch'] }),
    onError: (error) => toast.error(errorMessage(error)),
  });

  const orders = useQuery({
    queryKey: ['lunch', 'desk-orders', day, { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<LunchOrderRecord>('/lunch/desk/orders', {
        query: {
          day: day || undefined,
          q: debouncedQuery || undefined,
          paymentStatus: filters.paymentStatus || undefined,
          status: filters.status || undefined,
          page: filters.page,
          limit: filters.limit,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = orders.data?.data ?? [];
  const meta = orders.data?.meta;
  const figures = summary.data;
  const hasActiveFilters =
    filters.q !== '' || filters.paymentStatus !== '' || filters.status !== '';

  const update = (patch: Partial<typeof INITIAL>) =>
    setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) }));

  return (
    <>
      <PageHeader
        title="Lunch collection"
        description="Today's orders, and the cash to collect for them. Mark an order paid when the money is handed over."
        actions={
          <div className="flex items-center gap-2">
            <label className="text-[13px] text-muted-foreground" htmlFor="lunch-day">
              Day
            </label>
            <Input
              id="lunch-day"
              type="date"
              className="w-44"
              value={day || figures?.day || ''}
              onChange={(event) => {
                setDay(event.target.value);
                update({ page: 1 });
              }}
            />
          </div>
        }
      />

      {/* --- the six figures ---------------------------------------------- */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Orders"
          value={figures?.totalOrders}
          icon={Sandwich}
          hint={
            figures
              ? `${figures.paidOrders} paid · ${figures.unpaidOrders} unpaid${
                  figures.cancelledOrders > 0 ? ` · ${figures.cancelledOrders} cancelled` : ''
                }`
              : undefined
          }
          loading={summary.isLoading}
        />
        <StatCard
          label="Expected"
          value={figures ? money(figures.expectedCollection, currency) : undefined}
          icon={Receipt}
          hint="What today's orders come to"
          loading={summary.isLoading}
        />
        <StatCard
          label="Collected"
          value={figures ? money(figures.collectedAmount, currency) : undefined}
          icon={Wallet}
          tone="success"
          hint="Money actually taken"
          loading={summary.isLoading}
        />
        <StatCard
          label="Remaining"
          value={figures ? money(figures.remainingAmount, currency) : undefined}
          icon={HandCoins}
          tone={figures && figures.remainingAmount > 0 ? 'warning' : 'default'}
          hint="Still owed to you"
          loading={summary.isLoading}
        />
        <StatCard
          label="Cash in hand"
          value={figures ? money(figures.cashInHand, currency) : undefined}
          icon={Banknote}
          tone="success"
          hint="Collected, plus anything retained on a cancelled order"
          loading={summary.isLoading}
        />
        <StatCard
          label="Cancelled"
          value={figures?.cancelledOrders}
          icon={Ban}
          hint={
            figures
              ? `${figures.cancelledUnpaidOrders} unpaid · ${figures.cancelledPaidOrders} paid`
              : undefined
          }
          loading={summary.isLoading}
        />
      </div>

      {/* --- cancelled money, reported apart from the active day ---------- */}
      {figures && figures.cancelledPaidOrders > 0 ? (
        <Card className="mb-6 p-5">
          <div className="mb-3 flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning-foreground">
              <Ban className="size-4.5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-[13.5px] font-medium">Cancelled paid orders</h2>
              <p className="text-[13px] text-muted-foreground">
                Lunches that were paid for and then called off. None of this is in Expected or
                Collected above &mdash; it is here so the box balances.
              </p>
            </div>
          </div>

          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md bg-muted px-3 py-2.5">
              <dt className="text-xs text-muted-foreground">Cancelled paid</dt>
              <dd className="tabular text-base font-semibold">
                {money(figures.cancelledPaidAmount, currency)}
              </dd>
            </div>
            <div className="rounded-md bg-muted px-3 py-2.5">
              <dt className="text-xs text-muted-foreground">Refunded &mdash; left the box</dt>
              <dd className="tabular text-base font-semibold">
                {money(figures.refundedAmount, currency)}
              </dd>
            </div>
            <div className="rounded-md bg-warning-soft px-3 py-2.5">
              <dt className="text-xs text-warning-foreground">Retained &mdash; still with you</dt>
              <dd className="tabular text-base font-semibold text-warning-foreground">
                {money(figures.retainedAmount, currency)}
              </dd>
            </div>
          </dl>
        </Card>
      ) : null}

      {/* --- what the kitchen is making ---------------------------------- */}
      <Card className="mb-6 p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
              <ChefHat className="size-4.5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-[13.5px] font-medium">Food to make</h2>
              <p className="text-[13px] text-muted-foreground">
                Cancelled orders are not counted, whatever happened to the money.
              </p>
            </div>
          </div>
          {food.data ? (
            <p className="tabular shrink-0 text-[13px] text-muted-foreground">
              {`${food.data.totalPlates} plates · ${food.data.totalOrders} orders`}
            </p>
          ) : null}
        </div>

        {food.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : food.isError ? (
          <ErrorState error={food.error} onRetry={() => void food.refetch()} />
        ) : (food.data?.items.length ?? 0) === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nothing to make for this day.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {food.data?.items.map((item) => (
              <li
                key={item.itemName}
                className="flex items-baseline gap-2 rounded-md border border-border px-3 py-1.5 text-[13px]"
              >
                <span className="tabular font-semibold">{item.quantity}</span>
                <span>{item.itemName}</span>
                <span className="tabular text-xs text-muted-foreground">
                  {money(item.amount, currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {summary.isError ? (
        <Card className="mb-6">
          <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
        </Card>
      ) : null}

      {/* --- the orders themselves ---------------------------------------- */}
      <Card>
        <ListToolbar
          search={filters.q}
          onSearchChange={(value) => update({ q: value })}
          placeholder="Search name, employee number or order"
          hasActiveFilters={hasActiveFilters}
          onReset={() => setFilters(INITIAL)}
          filters={
            <>
              <NativeSelect
                aria-label="Payment status"
                className="w-36"
                value={filters.paymentStatus}
                onChange={(event) => update({ paymentStatus: event.target.value })}
              >
                <option value="">All payments</option>
                <option value="UNPAID">Unpaid</option>
                <option value="PAID">Paid</option>
              </NativeSelect>
              <NativeSelect
                aria-label="Order status"
                className="w-36"
                value={filters.status}
                onChange={(event) => update({ status: event.target.value })}
              >
                <option value="">All orders</option>
                {LUNCH_ORDER_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {LUNCH_ORDER_STATUS_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            </>
          }
        />

        <TableWrapper>
          <Table>
            <THead>
              <TR>
                <TH>Employee</TH>
                <TH>Order #</TH>
                <TH>Items</TH>
                <TH className="text-right">Amount</TH>
                <TH>Payment</TH>
                <TH>Method</TH>
                <TH>Order</TH>
                <TH className="text-right">Action</TH>
              </TR>
            </THead>
            <TBody>
              {orders.isLoading ? (
                <TableSkeleton rows={6} columns={8} />
              ) : orders.isError ? (
                <TR>
                  <TD colSpan={8}>
                    <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />
                  </TD>
                </TR>
              ) : rows.length === 0 ? (
                <TR>
                  <TD colSpan={8}>
                    <EmptyState
                      icon={Sandwich}
                      title={hasActiveFilters ? 'No orders match' : 'No orders for this day'}
                      description={
                        hasActiveFilters
                          ? 'Clear the filters to see the rest of the day.'
                          : `Nothing has been ordered for ${lunchDay(figures?.day ?? day)}.`
                      }
                    />
                  </TD>
                </TR>
              ) : (
                rows.map((order) => (
                  <TR key={order.id}>
                    <TD>
                      <p className="font-medium">{order.employeeName}</p>
                      <p className="tabular text-xs text-muted-foreground">
                        {order.employeeNumber}
                      </p>
                    </TD>
                    <TD className="tabular whitespace-nowrap text-muted-foreground">
                      {order.orderNumber}
                    </TD>
                    <TD>
                      {order.itemSummary}
                      {order.note ? (
                        <p className="text-xs text-muted-foreground">{order.note}</p>
                      ) : null}
                    </TD>
                    <TD className="tabular text-right font-medium">
                      {money(order.totalAmount, currency)}
                    </TD>
                    <TD>
                      <Badge variant={LUNCH_PAYMENT_TONE[order.paymentStatus]}>
                        {LUNCH_PAYMENT_STATUS_LABELS[order.paymentStatus]}
                      </Badge>
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {order.paymentMethod
                        ? `${LUNCH_PAYMENT_METHOD_LABELS[order.paymentMethod]} · ${lunchTime(order.paidAt)}`
                        : '—'}
                    </TD>
                    <TD>
                      <Badge variant={LUNCH_ORDER_TONE[order.status]}>
                        {LUNCH_ORDER_STATUS_LABELS[order.status]}
                      </Badge>
                      {/*
                        * What happened to the money, on the row rather than
                        * behind a click: an office boy reconciling a box needs
                        * to see which cancelled orders he is still holding cash
                        * for without opening sixty of them.
                        */}
                      {order.refundStatus !== 'NONE' ? (
                        <Badge className="ml-1.5" variant={LUNCH_REFUND_TONE[order.refundStatus]}>
                          {LUNCH_REFUND_STATUS_LABELS[order.refundStatus]}
                        </Badge>
                      ) : null}
                      {order.cancellationReason ? (
                        <p className="mt-1 max-w-[16rem] truncate text-xs text-muted-foreground">
                          {order.cancellationReason}
                        </p>
                      ) : null}
                    </TD>
                    <TD className="text-right">
                      {/*
                       * Every control here is drawn from the server's own
                       * answer rather than from a permission check in the
                       * browser. `canMarkPaid` is false on an order already
                       * paid, on a cancelled one and on the reader's OWN lunch;
                       * `canOperatorCancel` is false once an order is
                       * delivered; `canAdvance` is false at the end of the
                       * round. The endpoints refuse the same things.
                       */}
                      <div className="flex justify-end gap-2">
                        {order.canAdvance && order.nextStatus ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={advance.isPending}
                            onClick={() => advance.mutate(order)}
                          >
                            {LUNCH_ORDER_STATUS_LABELS[order.nextStatus]}
                          </Button>
                        ) : null}

                        {order.canMarkPaid ? (
                          <Button size="sm" onClick={() => setPaying(order)}>
                            Mark paid
                          </Button>
                        ) : order.paymentStatus === 'PAID' && order.canCorrectPayment ? (
                          <Button size="sm" variant="outline" onClick={() => setCorrecting(order)}>
                            <Undo2 className="size-3.5" aria-hidden />
                            Correct
                          </Button>
                        ) : null}

                        {order.canOperatorCancel ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setCancelling(order)}
                          >
                            <Ban className="size-3.5" aria-hidden />
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </TableWrapper>

        {meta ? (
          <Pagination
            meta={meta}
            onPageChange={(page) => setFilters((prev) => ({ ...prev, page }))}
            onLimitChange={(limit) => update({ limit })}
            disabled={orders.isFetching}
          />
        ) : null}
      </Card>

      <LunchMarkPaidDialog
        order={paying}
        onClose={() => setPaying(null)}
        currency={currency}
      />

      <LunchCorrectPaymentDialog
        order={correcting}
        onClose={() => setCorrecting(null)}
        currency={currency}
      />

      <LunchCancelOrderDialog
        order={cancelling}
        onClose={() => setCancelling(null)}
        currency={currency}
      />
    </>
  );
}
