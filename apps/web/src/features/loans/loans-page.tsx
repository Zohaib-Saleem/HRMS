import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { HandCoins, Plus } from 'lucide-react';
import {
  LOAN_STATUSES,
  LOAN_STATUS_LABELS,
  PERMISSIONS,
  type LoanRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { useLookups } from '@/lib/lookups';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LOAN_STATUS_TONE, isoMonth, money } from '@/features/employment/employment-shared';
import { LoanApplyDialog, LoanCreateDialog } from './loan-dialogs';
import { LoanDetailPanel } from './loan-detail-panel';

/**
 * Loans, from both sides of the desk.
 *
 * One screen rather than two, because the data scope already decides what
 * somebody sees: an employee with an OWN scope opens this and finds their own
 * loans, an HR administrator finds the company's. The `mine` toggle exists for
 * the people who can see both and want their own.
 */

const INITIAL = { q: '', status: '', view: 'all' as 'all' | 'mine', page: 1, limit: 20 };

export function LoansPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.LOAN_MANAGE);
  const canRequest = has(PERMISSIONS.LOAN_REQUEST);
  const canSeeOthers = has(PERMISSIONS.LOAN_MANAGE) || has(PERMISSIONS.LOAN_APPROVE);

  const [filters, setFilters] = React.useState(INITIAL);
  const [creating, setCreating] = React.useState(false);
  const [applying, setApplying] = React.useState(false);
  const [openLoanId, setOpenLoanId] = React.useState<string | null>(null);
  const debouncedQuery = useDebounced(filters.q, 350);

  const { lookups } = useLookups();

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const company = useQuery({
    queryKey: ['company'],
    queryFn: () => api.get<{ currency: string }>('/company'),
  });
  const currency = company.data?.currency ?? 'USD';

  const query = useQuery({
    queryKey: ['loans', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<LoanRecord>('/loans', {
        query: {
          q: debouncedQuery || undefined,
          status: filters.status || undefined,
          view: filters.view,
          page: filters.page,
          limit: filters.limit,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;
  const hasActiveFilters = filters.q !== '' || filters.status !== '' || filters.view !== 'all';

  return (
    <>
      <PageHeader
        title="Loans"
        description="Employee loans and salary advances. Only a released loan is ever deducted from pay."
        actions={
          <div className="flex flex-wrap gap-2">
            {canRequest ? (
              <Button variant="outline" size="sm" onClick={() => setApplying(true)}>
                Apply for a loan
              </Button>
            ) : null}
            {canManage ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-4" aria-hidden />
                Record a loan
              </Button>
            ) : null}
          </div>
        }
      />

      <Card>
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search by employee, reference or purpose"
          hasActiveFilters={hasActiveFilters}
          onReset={() => setFilters(INITIAL)}
          filters={
            <>
              <NativeSelect
                aria-label="Status"
                value={filters.status}
                onChange={(event) => update({ status: event.target.value })}
                className="xl:w-48"
              >
                <option value="">All statuses</option>
                {LOAN_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {LOAN_STATUS_LABELS[status]}
                  </option>
                ))}
              </NativeSelect>
              {canSeeOthers ? (
                <NativeSelect
                  aria-label="Whose loans"
                  value={filters.view}
                  onChange={(event) => update({ view: event.target.value as 'all' | 'mine' })}
                  className="xl:w-40"
                >
                  <option value="all">Everyone</option>
                  <option value="mine">Mine</option>
                </NativeSelect>
              ) : null}
            </>
          }
        />

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Employee</TH>
                    <TH>Amount</TH>
                    <TH>Monthly</TH>
                    <TH>Remaining</TH>
                    <TH>Progress</TH>
                    <TH>Next due</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={5} columns={7} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={7} className="p-0">
                        <EmptyState
                          icon={HandCoins}
                          title={hasActiveFilters ? 'No loans match those filters' : 'No loans yet'}
                          description={
                            hasActiveFilters
                              ? 'Clear the filters to see everything.'
                              : canRequest
                                ? 'Apply for one, or wait for HR to record an agreement.'
                                : 'Loans appear here once one is recorded.'
                          }
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR
                        key={row.id}
                        className="cursor-pointer"
                        onClick={() => setOpenLoanId(row.id)}
                      >
                        <TD>
                          <p className="text-[13.5px] font-medium">{row.employeeName}</p>
                          <p className="font-mono text-[11.5px] text-muted-foreground">
                            {row.employeeNumber}
                          </p>
                        </TD>
                        <TD className="tabular text-[13px]">
                          {money(row.principalAmount, row.currency)}
                        </TD>
                        <TD className="tabular text-[13px]">
                          {money(row.monthlyDeduction, row.currency)}
                        </TD>
                        <TD className="tabular text-[13px]">
                          {money(row.remainingAmount, row.currency)}
                        </TD>
                        <TD className="tabular whitespace-nowrap text-[13px] text-muted-foreground">
                          {row.paidInstallments}/{row.installmentCount}
                        </TD>
                        <TD className="whitespace-nowrap text-[13px] text-muted-foreground">
                          {row.nextDueMonth ? isoMonth(row.nextDueMonth) : '—'}
                        </TD>
                        <TD>
                          <Badge variant={LOAN_STATUS_TONE[row.status]}>
                            {LOAN_STATUS_LABELS[row.status]}
                          </Badge>
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>
            {meta ? <Pagination meta={meta} onPageChange={(page) => update({ page })} /> : null}
          </>
        )}
      </Card>

      <LoanCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        employees={lookups.managers}
        currency={currency}
      />
      <LoanApplyDialog open={applying} onClose={() => setApplying(false)} currency={currency} />

      <Dialog open={openLoanId !== null} onOpenChange={(next) => !next && setOpenLoanId(null)}>
        <DialogContent variant="drawer" size="lg">
          <DialogHeader>
            <DialogTitle>Loan</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {openLoanId ? <LoanDetailPanel loanId={openLoanId} /> : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
