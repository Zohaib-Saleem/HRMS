import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Sandwich, Plus } from 'lucide-react';
import {
  LUNCH_ORDER_STATUS_LABELS,
  LUNCH_PAYMENT_METHOD_LABELS,
  LUNCH_PAYMENT_STATUS_LABELS,
  LUNCH_REFUND_STATUS_LABELS,
  PERMISSIONS,
  type LunchOrderRecord,
  type LunchTodayView,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/field';
import { Pagination } from '@/components/ui/pagination';
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { usePermissions, useSession } from '@/features/auth/session-context';
import { money } from '@/features/employment/employment-shared';
import {
  LUNCH_ORDER_TONE,
  LUNCH_PAYMENT_TONE,
  LUNCH_REFUND_TONE,
  lunchDay,
  lunchTime,
} from './lunch-shared';
import { LunchOrderDialog } from './lunch-order-dialog';

/**
 * My lunch.
 *
 * One screen and it is genuinely one person's: the endpoints behind it return
 * the caller's own orders and there is no parameter that widens them. So there
 * is no "whose lunch" control and no employee column, because there is nothing
 * to switch between - the operator's collection screen is a different screen
 * with a different grant rather than a toggle bolted onto this one.
 *
 * The language here is deliberately the language of a canteen and not of a
 * finance system. Nothing on this page says deduction, payroll, invoice,
 * settlement or approval, because none of those happens: somebody brings the
 * food and is paid for it. What an employee needs to know is what they ordered,
 * what it costs, and whether they have handed the money over yet.
 */

const INITIAL = { paymentStatus: '', page: 1, limit: 20 };

export function LunchPage() {
  const { has } = usePermissions();
  const { session } = useSession();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const currency = session?.company.currency ?? 'PKR';
  const canOrder = has(PERMISSIONS.LUNCH_ORDER_CREATE);

  const [ordering, setOrdering] = React.useState(false);
  const [filters, setFilters] = React.useState(INITIAL);

  const today = useQuery({
    queryKey: ['lunch', 'today'],
    queryFn: () => api.get<LunchTodayView>('/lunch/today'),
  });

  const history = useQuery({
    queryKey: ['lunch', 'orders', filters],
    queryFn: () =>
      api.getPage<LunchOrderRecord>('/lunch/orders', {
        query: {
          paymentStatus: filters.paymentStatus || undefined,
          page: filters.page,
          limit: filters.limit,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const cancel = useMutation({
    mutationFn: (order: LunchOrderRecord) =>
      api.post<LunchOrderRecord>(`/lunch/orders/${order.id}/cancel`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lunch'] });
      toast.success('Order cancelled.');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const askToCancel = async (order: LunchOrderRecord) => {
    const ok = await confirm({
      title: 'Cancel this order?',
      description: `${order.itemSummary} — ${money(order.totalAmount, currency)}. Nobody will bring it and you will owe nothing for it.`,
      confirmLabel: 'Cancel order',
      tone: 'destructive',
    });
    if (ok) cancel.mutate(order);
  };

  const orders = today.data?.orders ?? [];
  const rows = history.data?.data ?? [];
  const meta = history.data?.meta;

  return (
    <>
      <PageHeader
        title="Lunch"
        description="What you have ordered today, and what you still owe for it. Pay whoever brings it."
        actions={
          canOrder ? (
            <Button size="sm" onClick={() => setOrdering(true)}>
              <Plus className="size-4" aria-hidden />
              Order lunch
            </Button>
          ) : undefined
        }
      />

      {/* --- today ------------------------------------------------------- */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Today&rsquo;s lunch</CardTitle>
          {today.data ? (
            <p className="text-[13px] text-muted-foreground">{lunchDay(today.data.day)}</p>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-3">
          {today.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : today.isError ? (
            <ErrorState error={today.error} onRetry={() => void today.refetch()} />
          ) : orders.length === 0 ? (
            <EmptyState
              icon={Sandwich}
              title="Nothing ordered yet"
              description={
                today.data?.canOrder === false
                  ? 'Your login is not linked to an employee record yet, so you cannot order lunch.'
                  : 'Order something and pay for it when it arrives.'
              }
              action={
                canOrder && today.data?.canOrder ? (
                  <Button size="sm" onClick={() => setOrdering(true)}>
                    Order lunch
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              {orders.map((order) => (
                <div
                  key={order.id}
                  className="flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="tabular text-xs text-muted-foreground">{order.orderNumber}</p>
                    <p className="text-[15px] font-medium">{order.itemSummary}</p>
                    {order.note ? (
                      <p className="text-[13px] text-muted-foreground">{order.note}</p>
                    ) : null}

                    {/*
                     * Who called it off and why, to the person whose lunch it
                     * was. This is the reason the operator's reason is
                     * compulsory: somebody's lunch disappeared and they are
                     * owed a sentence about it, not a status change.
                     */}
                    {order.status === 'CANCELLED' ? (
                      <p className="text-[13px] text-muted-foreground">
                        {order.cancelledBySelf
                          ? 'Cancelled by you'
                          : order.cancelledByName
                            ? `Cancelled by ${order.cancelledByName}`
                            : 'Cancelled'}
                        {order.cancellationReason ? ` · ${order.cancellationReason}` : ''}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-4">
                    <div className="text-right">
                      <p className="tabular text-lg font-semibold leading-none">
                        {money(order.totalAmount, currency)}
                      </p>
                      <p className="mt-1.5 text-[13px]">
                        {order.status === 'CANCELLED' ? (
                          <>
                            <Badge variant={LUNCH_ORDER_TONE.CANCELLED}>Cancelled</Badge>
                            {/*
                             * A cancelled order that was paid for still says
                             * so, and says what happened to the money. Dropping
                             * the payment off the card because the lunch is not
                             * happening is how somebody comes to believe they
                             * were never charged.
                             */}
                            {order.paymentStatus === 'PAID' ? (
                              <Badge
                                className="ml-1.5"
                                variant={
                                  order.refundStatus === 'NONE'
                                    ? LUNCH_PAYMENT_TONE.PAID
                                    : LUNCH_REFUND_TONE[order.refundStatus]
                                }
                              >
                                {order.refundStatus === 'NONE'
                                  ? 'Paid'
                                  : LUNCH_REFUND_STATUS_LABELS[order.refundStatus]}
                              </Badge>
                            ) : null}
                          </>
                        ) : order.paymentStatus === 'PAID' ? (
                          /*
                           * The receipt, in the words the spec asks for: paid,
                           * how much, and how. No reference to payroll, finance
                           * or a settlement, because none of those happened.
                           */
                          <span className="inline-flex items-center gap-1.5 font-medium text-success">
                            <CheckCircle2 className="size-4" aria-hidden />
                            {/* One string rather than three nodes: this is the
                                receipt somebody reads, and it should be one
                                sentence to a screen reader as well as to an
                                eye. */}
                            {`Paid ${money(order.totalAmount, currency)}${
                              order.paymentMethod
                                ? ` · ${LUNCH_PAYMENT_METHOD_LABELS[order.paymentMethod]}`
                                : ''
                            }`}
                          </span>
                        ) : (
                          <Badge variant={LUNCH_PAYMENT_TONE.UNPAID}>Unpaid</Badge>
                        )}
                      </p>
                    </div>

                    {/*
                     * Drawn from the server's own answer rather than from a
                     * permission check here: `canCancel` is false on a paid
                     * order whoever is looking at it, and the endpoint refuses
                     * it either way.
                     */}
                    {order.canCancel ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void askToCancel(order)}
                        disabled={cancel.isPending}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}

              {today.data && today.data.outstandingAmount > 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  Still to pay today:{' '}
                  <span className="tabular font-medium text-foreground">
                    {money(today.data.outstandingAmount, currency)}
                  </span>
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {/* --- everything before today -------------------------------------- */}
      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <h2 className="text-[13.5px] font-medium">Your orders</h2>
          <NativeSelect
            aria-label="Payment status"
            className="w-40"
            value={filters.paymentStatus}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, paymentStatus: event.target.value, page: 1 }))
            }
          >
            <option value="">All orders</option>
            <option value="UNPAID">Unpaid</option>
            <option value="PAID">Paid</option>
          </NativeSelect>
        </div>

        <TableWrapper>
          <Table>
            <THead>
              <TR>
                <TH>Day</TH>
                <TH>Order</TH>
                <TH>Items</TH>
                <TH className="text-right">Amount</TH>
                <TH>Payment</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {history.isLoading ? (
                <TableSkeleton rows={5} columns={6} />
              ) : history.isError ? (
                <TR>
                  <TD colSpan={6}>
                    <ErrorState error={history.error} onRetry={() => void history.refetch()} />
                  </TD>
                </TR>
              ) : rows.length === 0 ? (
                <TR>
                  <TD colSpan={6}>
                    <EmptyState icon={Sandwich} title="No orders yet" />
                  </TD>
                </TR>
              ) : (
                rows.map((order) => (
                  <TR key={order.id}>
                    <TD className="whitespace-nowrap">{lunchDay(order.day)}</TD>
                    <TD className="tabular whitespace-nowrap text-muted-foreground">
                      {order.orderNumber}
                    </TD>
                    <TD>{order.itemSummary}</TD>
                    <TD className="tabular text-right">{money(order.totalAmount, currency)}</TD>
                    <TD>
                      <Badge variant={LUNCH_PAYMENT_TONE[order.paymentStatus]}>
                        {LUNCH_PAYMENT_STATUS_LABELS[order.paymentStatus]}
                      </Badge>
                      {order.paidAt ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {lunchTime(order.paidAt)}
                          {order.paymentMethod
                            ? ` · ${LUNCH_PAYMENT_METHOD_LABELS[order.paymentMethod]}`
                            : ''}
                        </span>
                      ) : null}
                    </TD>
                    <TD>
                      <Badge variant={LUNCH_ORDER_TONE[order.status]}>
                        {LUNCH_ORDER_STATUS_LABELS[order.status]}
                      </Badge>
                      {order.refundStatus !== 'NONE' ? (
                        <Badge className="ml-1.5" variant={LUNCH_REFUND_TONE[order.refundStatus]}>
                          {LUNCH_REFUND_STATUS_LABELS[order.refundStatus]}
                        </Badge>
                      ) : null}
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
            onLimitChange={(limit) => setFilters((prev) => ({ ...prev, limit, page: 1 }))}
            disabled={history.isFetching}
          />
        ) : null}
      </Card>

      <LunchOrderDialog
        open={ordering}
        onClose={() => setOrdering(false)}
        currency={currency}
      />
    </>
  );
}
