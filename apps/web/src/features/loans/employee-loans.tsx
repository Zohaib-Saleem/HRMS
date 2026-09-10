import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { HandCoins, Plus } from 'lucide-react';
import { LOAN_STATUS_LABELS, PERMISSIONS, type LoanRecord } from '@hrms/shared';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import { LOAN_STATUS_TONE, isoMonth, money } from '@/features/employment/employment-shared';
import { LoanCreateDialog } from './loan-dialogs';
import { LoanDetailPanel } from './loan-detail-panel';

/**
 * One employee's loans, on their profile.
 *
 * Every loan they have ever had, not just the live one - a settled loan is
 * part of the answer to "what has been taken off this person's pay?", and
 * hiding it once it completes makes a payslip from last year unexplainable.
 */
export function EmployeeLoans({
  employeeId,
  employeeName,
}: {
  employeeId: string;
  employeeName: string;
}) {
  const { has } = usePermissions();
  const canRead = has(PERMISSIONS.LOAN_READ);
  const canManage = has(PERMISSIONS.LOAN_MANAGE);
  const [creating, setCreating] = React.useState(false);
  const [openLoanId, setOpenLoanId] = React.useState<string | null>(null);

  const query = useQuery({
    queryKey: ['loans', { employeeId }],
    queryFn: () => api.getPage<LoanRecord>('/loans', { query: { employeeId, limit: 50 } }),
    enabled: canRead && employeeId !== '',
  });

  const company = useQuery({
    queryKey: ['company'],
    queryFn: () => api.get<{ currency: string }>('/company'),
    enabled: canManage,
  });

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
  const live = rows.filter((row) => ['PENDING', 'APPROVED', 'ACTIVE'].includes(row.status));
  const settled = rows.filter((row) => !live.includes(row));

  // Opening a live loan by default saves a click in the case that matters: an
  // employee with one running loan wants the schedule, not a list of one.
  const selected = openLoanId ?? live[0]?.id ?? null;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <HandCoins className="size-4" aria-hidden /> Loans
          </CardTitle>
          {canManage ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> Record a loan
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <EmptyState
              icon={HandCoins}
              title="No loans on record"
              description={
                canManage
                  ? `Record one for ${employeeName} to set up a repayment schedule payroll collects automatically.`
                  : 'Loans and salary advances appear here.'
              }
            />
          ) : (
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
                      <p className="text-[13.5px] font-medium tabular">
                        {money(row.principalAmount, row.currency)}
                        <span className="ml-2 font-normal text-muted-foreground">
                          over {row.installmentCount} month{row.installmentCount === 1 ? '' : 's'}
                        </span>
                      </p>
                      <p className="mt-0.5 text-[12.5px] text-muted-foreground">
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
          )}
        </CardContent>
      </Card>

      {selected ? <LoanDetailPanel loanId={selected} /> : null}

      <LoanCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        employees={[]}
        fixedEmployeeId={employeeId}
        currency={company.data?.currency ?? 'USD'}
      />
    </div>
  );
}
