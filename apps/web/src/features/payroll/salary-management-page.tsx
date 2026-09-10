import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { keepPreviousData } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import {
  PAYROLL_SALARY_TYPE_LABELS,
  PERMISSIONS,
  type SalaryOverviewRow,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/features/auth/session-context';
import { SalaryDialog } from '@/features/people/salary-dialog';

/**
 * Salary management: everyone, and what they are on.
 *
 * One row per employee, folded from the same tables the profile's Compensation
 * tab reads. This is the view across people; that tab is the view into one
 * person, and the Edit and History actions here hand off to it rather than
 * repeating it.
 *
 * Fixed allowances and deductions are summed because their money is known
 * now. A percentage or per-unit component is priced by a run, so it is
 * counted rather than added and the column heading says so.
 */

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);

const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

const STATUS: Record<SalaryOverviewRow['status'], { label: string; variant: 'success' | 'neutral' | 'warning' }> = {
  ACTIVE: { label: 'Active', variant: 'success' },
  ENDED: { label: 'Ended', variant: 'warning' },
  NONE: { label: 'No salary', variant: 'neutral' },
};

export function SalaryManagementPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.PAYROLL_MANAGE);

  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(1);
  const debounced = useDebounced(search, 250);

  const [adding, setAdding] = React.useState<SalaryOverviewRow | null>(null);

  const query = useQuery({
    queryKey: ['salary-overview', { q: debounced, page }],
    queryFn: () =>
      api.getPage<SalaryOverviewRow>('/payroll/salaries/overview', {
        query: { q: debounced, page, limit: 25 },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;

  return (
    <>
      <PageHeader
        title="Salary management"
        description="Each employee's current basic salary, what recurs on top of it, and when it last changed."
      />

      <Card>
        <ListToolbar
          search={search}
          onSearchChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder="Search by name or employee number"
        />

        {query.isLoading ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={debounced ? 'No matching employees' : 'No employees to show'}
            description={debounced ? 'Try a different name or number.' : 'Employees appear here once they exist.'}
          />
        ) : (
          <TableWrapper>
            <Table>
              <THead>
                <TR>
                  <TH>Employee</TH>
                  <TH className="text-right">Current salary</TH>
                  <TH className="text-right">Basic</TH>
                  <TH className="text-right">Allowances (fixed)</TH>
                  <TH className="text-right">Deductions (fixed)</TH>
                  <TH>Effective from</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => {
                  const s = STATUS[row.status];
                  const cur = row.currentSalary;
                  return (
                    <TR key={row.employeeId}>
                      <TD>
                        <div className="font-medium">{row.employeeName}</div>
                        <div className="text-[12px] text-muted-foreground">
                          {row.employeeNumber}
                          {row.departmentName ? ` · ${row.departmentName}` : ''}
                        </div>
                      </TD>
                      <TD className="text-right tabular-nums">
                        {cur ? (
                          <>
                            <div className="font-semibold">{money(cur.amount, cur.currency)}</div>
                            <div className="text-[12px] text-muted-foreground">
                              {PAYROLL_SALARY_TYPE_LABELS[cur.salaryType]}
                            </div>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {cur ? money(cur.amount, cur.currency) : '—'}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {row.allowanceCount === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <>
                            <div>{cur ? money(row.fixedAllowanceTotal, cur.currency) : row.fixedAllowanceTotal}</div>
                            <div className="text-[12px] text-muted-foreground">{row.allowanceCount} active</div>
                          </>
                        )}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {row.deductionCount === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <>
                            <div>{cur ? money(row.fixedDeductionTotal, cur.currency) : row.fixedDeductionTotal}</div>
                            <div className="text-[12px] text-muted-foreground">{row.deductionCount} active</div>
                          </>
                        )}
                      </TD>
                      <TD className="whitespace-nowrap">{cur ? day(cur.effectiveFrom) : '—'}</TD>
                      <TD>
                        <Badge variant={s.variant}>{s.label}</Badge>
                      </TD>
                      <TD className="text-right">
                        <div className="flex justify-end gap-1">
                          {canManage ? (
                            <Button size="sm" variant="ghost" onClick={() => setAdding(row)}>
                              <Plus className="size-4" aria-hidden /> Add
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" asChild>
                            <Link to={`/people/${row.employeeId}`}>
                              {canManage ? 'Edit' : 'View'}
                            </Link>
                          </Button>
                          <Button size="sm" variant="ghost" asChild>
                            <Link to={`/people/${row.employeeId}`}>History</Link>
                          </Button>
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableWrapper>
        )}

        {meta && meta.totalPages > 1 ? (
          <Pagination meta={meta} disabled={query.isFetching} onPageChange={setPage} />
        ) : null}
      </Card>

      {canManage && adding ? (
        <SalaryDialog
          employeeId={adding.employeeId}
          employeeName={adding.employeeName}
          currency={adding.currentSalary?.currency ?? 'USD'}
          open
          onClose={() => setAdding(null)}
        />
      ) : null}
    </>
  );
}
