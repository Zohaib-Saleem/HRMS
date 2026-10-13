import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { HandCoins, Plus } from 'lucide-react';
import {
  LOAN_STATUS_LABELS,
  PERMISSIONS,
  type LoanKind,
  type LoanRecord,
  type LoanStatus,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { usePermissions, useSession } from '@/features/auth/session-context';
import { LOAN_STATUS_TONE, isoMonth, money } from '@/features/employment/employment-shared';
import { LoanApplyDialog, LoanCreateDialog } from './loan-dialogs';
import { LoanDetailPanel } from './loan-detail-panel';

/**
 * One employee's loans, on their profile.
 *
 * Every loan they have ever had, not just the live one - a settled loan is
 * part of the answer to "what has been taken off this person's pay?", and
 * hiding it once it completes makes a payslip from last year unexplainable.
 *
 * Nothing here computes a balance. Every figure on this tab is a field of the
 * `LoanRecord` the API already derives from the installment rows, so the
 * profile, the company-wide list and the payslip cannot disagree about what
 * somebody owes.
 */

/** The loans that still cost the employee something, newest concern first. */
const LIVE_STATUSES: readonly LoanStatus[] = ['ACTIVE', 'PENDING', 'APPROVED'];

/**
 * The status tallies worth a headline. Rejected and cancelled loans are in the
 * list below but not here: they are history, not a figure anybody acts on.
 */
const SUMMARY_STATUSES: readonly LoanStatus[] = ['ACTIVE', 'PENDING', 'APPROVED', 'COMPLETED'];

export function EmployeeLoans({
  employeeId,
  employeeName,
}: {
  employeeId: string;
  employeeName: string;
}) {
  const { has } = usePermissions();
  const { session } = useSession();
  const canRead = has(PERMISSIONS.LOAN_READ);
  const canManage = has(PERMISSIONS.LOAN_MANAGE);
  // Applying is for yourself only - the endpoint takes no employee id and
  // always files the application against the caller. So the button belongs on
  // your own profile and nowhere else.
  const isOwnProfile = session?.user.employee?.id === employeeId;
  const canApply = isOwnProfile && has(PERMISSIONS.LOAN_REQUEST);

  // Which kind the open dialog is for; null while none is open.
  const [creating, setCreating] = React.useState<LoanKind | null>(null);
  const [applying, setApplying] = React.useState<LoanKind | null>(null);
  const [openLoanId, setOpenLoanId] = React.useState<string | null>(null);

  const query = useQuery({
    queryKey: ['loans', { employeeId }],
    queryFn: () => api.getPage<LoanRecord>('/loans', { query: { employeeId, limit: 50 } }),
    enabled: canRead && employeeId !== '',
  });

  const currency = session?.company.currency ?? 'USD';

  if (!canRead) return null;

  if (query.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Loans</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32" />
        </CardContent>
      </Card>
    );
  }

  const rows = query.data?.data ?? [];
  const live = rows.filter((row) => LIVE_STATUSES.includes(row.status));
  const settled = rows.filter((row) => !LIVE_STATUSES.includes(row.status));

  // Opening a live loan by default saves a click in the case that matters: an
  // employee with one running loan wants the schedule, not a list of one.
  const selected = openLoanId ?? live[0]?.id ?? settled[0]?.id ?? null;

  const outstanding = rows
    .filter((row) => row.status === 'ACTIVE')
    .reduce((total, row) => total + row.remainingAmount, 0);
  const monthly = rows
    .filter((row) => row.status === 'ACTIVE')
    .reduce((total, row) => total + row.monthlyDeduction, 0);

  const actions = (
    <div className="flex flex-wrap gap-2">
      {canApply ? (
        <>
          <Button size="sm" variant="outline" onClick={() => setApplying('SALARY_ADVANCE')}>
            Request an advance
          </Button>
          <Button size="sm" variant="outline" onClick={() => setApplying('LOAN')}>
            Apply for a loan
          </Button>
        </>
      ) : null}
      {canManage ? (
        <>
          <Button size="sm" variant="outline" onClick={() => setCreating('SALARY_ADVANCE')}>
            <Plus className="size-4" aria-hidden /> Record an advance
          </Button>
          <Button size="sm" onClick={() => setCreating('LOAN')}>
            <Plus className="size-4" aria-hidden /> Record a loan
          </Button>
        </>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <HandCoins className="size-4" aria-hidden /> Loans
          </CardTitle>
          {actions}
        </CardHeader>
        <CardContent className="p-0">
          {query.isError ? (
            <div className="p-5">
              <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={HandCoins}
              title="No loans"
              description={
                canManage
                  ? `${employeeName} has no loans or salary advances on record. Record one to set up a repayment schedule payroll collects automatically.`
                  : canApply
                    ? 'You have no loans or salary advances on record. Apply for one and it goes to your manager for approval.'
                    : 'Loans and salary advances appear here once one is recorded.'
              }
            />
          ) : (
            <>
              {/* What the record adds up to, before the loan-by-loan list. Only
                  ACTIVE loans contribute: nothing else is deducted from pay. */}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-border px-5 py-4 sm:grid-cols-3 lg:grid-cols-6">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Outstanding
                  </dt>
                  <dd className="tabular text-[15px] font-semibold">
                    {money(outstanding, rows[0]?.currency ?? currency)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Deducted monthly
                  </dt>
                  <dd className="tabular text-[15px] font-semibold">
                    {money(monthly, rows[0]?.currency ?? currency)}
                  </dd>
                </div>
                {SUMMARY_STATUSES.map((status) => (
                  <div key={status}>
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      {LOAN_STATUS_LABELS[status]}
                    </dt>
                    <dd className="tabular text-[15px] font-semibold">
                      {rows.filter((row) => row.status === status).length}
                    </dd>
                  </div>
                ))}
              </dl>

              <ul className="divide-y divide-border">
                {[...live, ...settled].map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => setOpenLoanId(row.id === selected ? null : row.id)}
                      aria-expanded={row.id === selected}
                      className="flex w-full flex-wrap items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-accent/45"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="tabular text-[13.5px] font-medium">
                          {money(row.principalAmount, row.currency)}
                          <span className="ml-2 font-normal text-muted-foreground">
                            {row.kind === 'SALARY_ADVANCE' ? (
                              <>salary advance · recovered from {isoMonth(row.startMonth)}</>
                            ) : (
                              <>
                                over {row.installmentCount} month
                                {row.installmentCount === 1 ? '' : 's'}
                                {' · '}
                                {money(row.monthlyDeduction, row.currency)}/month
                              </>
                            )}
                          </span>
                        </p>
                        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                          {row.paidInstallments}/{row.installmentCount} paid ·{' '}
                          {money(row.remainingAmount, row.currency)} remaining ·{' '}
                          {row.nextDueMonth
                            ? `next due ${isoMonth(row.nextDueMonth)}`
                            : 'nothing outstanding'}
                        </p>
                      </div>
                      <Badge variant={LOAN_STATUS_TONE[row.status]}>
                        {LOAN_STATUS_LABELS[row.status]}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {selected ? <LoanDetailPanel loanId={selected} /> : null}

      <LoanCreateDialog
        open={creating !== null}
        kind={creating ?? 'LOAN'}
        onClose={() => setCreating(null)}
        employees={[]}
        fixedEmployeeId={employeeId}
        currency={currency}
      />
      <LoanApplyDialog
        open={applying !== null}
        kind={applying ?? 'LOAN'}
        onClose={() => setApplying(null)}
        currency={currency}
      />
    </div>
  );
}
