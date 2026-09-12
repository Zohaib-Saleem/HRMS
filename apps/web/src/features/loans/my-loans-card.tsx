import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HandCoins } from 'lucide-react';
import {
  LOAN_STATUS_LABELS,
  PERMISSIONS,
  type LoanRecord,
  type LoanStatus,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { usePermissions, useSession } from '@/features/auth/session-context';
import { LOAN_STATUS_TONE, isoMonth, money } from '@/features/employment/employment-shared';
import { LoanApplyDialog } from './loan-dialogs';

/**
 * The employee's own loans, on their dashboard.
 *
 * Deliberately one card rather than a section: what somebody wants from a
 * dashboard is "do I owe anything, and where did my application get to", and
 * both fit in a few lines. The full schedule is one click away on /loans.
 *
 * `view=mine` is resolved from the session on the server, so this asks for the
 * caller's own loans rather than relying on the data scope to narrow a wider
 * question - which matters for a manager, whose scope reaches their reports.
 *
 * Every figure printed here is a field the API derived from the installment
 * rows. Nothing is recomputed in the browser, so the dashboard, the loans
 * screen and the payslip cannot disagree about what is owed.
 */

/** The statuses worth a headline. The rest are history and live in the list. */
const HEADLINE: readonly LoanStatus[] = ['ACTIVE', 'PENDING', 'APPROVED'];

export function MyLoansCard() {
  const { has } = usePermissions();
  const { session } = useSession();
  const [applying, setApplying] = React.useState(false);

  const canRead = has(PERMISSIONS.LOAN_READ);
  const canApply = has(PERMISSIONS.LOAN_REQUEST) && Boolean(session?.user.employee);
  const currency = session?.company.currency ?? 'USD';

  const query = useQuery({
    queryKey: ['loans', 'mine', 'dashboard'],
    queryFn: () => api.getPage<LoanRecord>('/loans', { query: { view: 'mine', limit: 20 } }),
    enabled: canRead,
    retry: false,
  });

  if (!canRead) return null;

  const rows = query.data?.data ?? [];
  const active = rows.find((row) => row.status === 'ACTIVE') ?? null;
  const live = rows.filter((row) => HEADLINE.includes(row.status));
  const recent = rows.slice(0, 4);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <HandCoins className="size-4" aria-hidden /> Loans
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          {canApply ? (
            <Button variant="outline" size="sm" onClick={() => setApplying(true)}>
              Apply for a loan
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" asChild>
            <Link to="/loans">Open</Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={HandCoins}
            title="No loans"
            description="You have no loans or salary advances on record. An application goes to your manager for approval; nothing is deducted from your pay until it is approved and released."
            action={
              canApply ? (
                <Button variant="outline" size="sm" onClick={() => setApplying(true)}>
                  Apply for a loan
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-4">
            {/* The live loan, in full. Only an ACTIVE loan is deducted, so
                only an ACTIVE loan gets the figures. */}
            {active ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-muted/40 px-4 py-3 sm:grid-cols-4">
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Outstanding
                  </dt>
                  <dd className="tabular text-[15px] font-semibold">
                    {money(active.remainingAmount, active.currency)}
                  </dd>
                  <dd className="text-[11px] text-muted-foreground">
                    of {money(active.principalAmount, active.currency)} borrowed
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Monthly installment
                  </dt>
                  <dd className="tabular text-[15px] font-semibold">
                    {money(active.monthlyDeduction, active.currency)}
                  </dd>
                  <dd className="text-[11px] text-muted-foreground">
                    {active.nextDueMonth
                      ? `Next due ${isoMonth(active.nextDueMonth)}`
                      : 'Nothing outstanding'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Installments
                  </dt>
                  <dd className="tabular text-[15px] font-semibold">
                    {active.paidInstallments} / {active.installmentCount}
                  </dd>
                  <dd className="text-[11px] text-muted-foreground">
                    {active.installmentCount - active.paidInstallments} remaining
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Released
                  </dt>
                  <dd className="text-[13px] font-medium">
                    {active.activatedAt ? formatDate(active.activatedAt) : '--'}
                  </dd>
                  <dd className="text-[11px] text-muted-foreground">
                    First deduction {isoMonth(active.startMonth)}
                  </dd>
                </div>
              </dl>
            ) : live.length > 0 ? (
              <p className="rounded-lg border border-border bg-surface-muted/40 px-4 py-3 text-[12.5px] text-muted-foreground">
                Nothing is being deducted from your pay. Only a loan that has been approved and
                released is collected by payroll.
              </p>
            ) : null}

            <ul className="divide-y divide-border">
              {recent.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="tabular truncate text-[13px] font-medium">
                      {money(row.principalAmount, row.currency)}
                      <span className="ml-2 font-normal text-muted-foreground">
                        over {row.installmentCount} month{row.installmentCount === 1 ? '' : 's'}
                      </span>
                    </p>
                    <p className="truncate text-[12px] text-muted-foreground">
                      {row.purpose ?? 'No purpose recorded'}
                    </p>
                  </div>
                  <Badge variant={LOAN_STATUS_TONE[row.status]}>
                    {LOAN_STATUS_LABELS[row.status]}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>

      <LoanApplyDialog open={applying} onClose={() => setApplying(false)} currency={currency} />
    </Card>
  );
}
