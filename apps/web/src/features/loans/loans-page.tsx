import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { HandCoins, Plus } from 'lucide-react';
import {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_LABELS,
  LOAN_KINDS,
  LOAN_KIND_LABELS,
  LOAN_STATUSES,
  LOAN_STATUS_LABELS,
  PERMISSIONS,
  type LoanKind,
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

const INITIAL = {
  q: '',
  status: '',
  kind: '',
  employmentStatus: '',
  view: 'all' as 'all' | 'mine',
  page: 1,
  limit: 20,
};

export function LoansPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.LOAN_MANAGE);
  const canRequest = has(PERMISSIONS.LOAN_REQUEST);
  const canSeeOthers = has(PERMISSIONS.LOAN_MANAGE) || has(PERMISSIONS.LOAN_APPROVE);

  const [filters, setFilters] = React.useState(INITIAL);
  // Which kind the open dialog is for; null while none is open.
  const [creating, setCreating] = React.useState<LoanKind | null>(null);
  const [applying, setApplying] = React.useState<LoanKind | null>(null);
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
          kind: filters.kind || undefined,
          employmentStatus: filters.employmentStatus || undefined,
          view: filters.view,
          page: filters.page,
          limit: filters.limit,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;
  const hasActiveFilters =
    filters.q !== '' ||
    filters.status !== '' ||
    filters.kind !== '' ||
    filters.employmentStatus !== '' ||
    filters.view !== 'all';

  return (
    <>
      <PageHeader
        title="Loans"
        description="Employee loans and salary advances. Only a released loan is ever deducted from pay."
        actions={
          <div className="flex flex-wrap gap-2">
            {canRequest ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setApplying('SALARY_ADVANCE')}>
                  Request an advance
                </Button>
                <Button variant="outline" size="sm" onClick={() => setApplying('LOAN')}>
                  Apply for a loan
                </Button>
              </>
            ) : null}
            {canManage ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setCreating('SALARY_ADVANCE')}>
                  <Plus className="size-4" aria-hidden />
                  Record an advance
                </Button>
                <Button size="sm" onClick={() => setCreating('LOAN')}>
                  <Plus className="size-4" aria-hidden />
                  Record a loan
                </Button>
              </>
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
              <NativeSelect
                aria-label="Kind"
                value={filters.kind}
                onChange={(event) => update({ kind: event.target.value })}
                className="xl:w-44"
              >
                <option value="">Loans and advances</option>
                {LOAN_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {LOAN_KIND_LABELS[kind]}
                  </option>
                ))}
              </NativeSelect>
              {/*
                The borrower's employment status - the employee's own field,
                not a copy kept on the loan. Offered only to somebody who can
                see other people's loans: filtering your own list by your own
                status answers nothing.
              */}
              {canSeeOthers ? (
                <NativeSelect
                  aria-label="Employment status"
                  value={filters.employmentStatus}
                  onChange={(event) => update({ employmentStatus: event.target.value })}
                  className="xl:w-48"
                >
                  <option value="">All employment statuses</option>
                  {EMPLOYMENT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {EMPLOYMENT_STATUS_LABELS[s]}
                    </option>
                  ))}
                </NativeSelect>
              ) : null}
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
                    <TH>Kind</TH>
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
                    <TableSkeleton rows={5} columns={8} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={8} className="p-0">
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
                        <TD className="whitespace-nowrap text-[13px] text-muted-foreground">
                          {LOAN_KIND_LABELS[row.kind]}
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
                            {row.statusLabel}
                          </Badge>
                          {row.deductionDecisionMonth ? (
                            <Badge variant="warning" className="ml-1.5">
                              Month needs decision
                            </Badge>
                          ) : null}
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
        open={creating !== null}
        kind={creating ?? 'LOAN'}
        onClose={() => setCreating(null)}
        employees={lookups.managers}
        currency={currency}
      />
      <LoanApplyDialog
        open={applying !== null}
        kind={applying ?? 'LOAN'}
        onClose={() => setApplying(null)}
        currency={currency}
      />

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
