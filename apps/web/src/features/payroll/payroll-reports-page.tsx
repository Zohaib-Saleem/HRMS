import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BarChart3, Download } from 'lucide-react';
import {
  PAYROLL_REPORT_DESCRIPTIONS,
  PAYROLL_REPORT_KEYS,
  PAYROLL_REPORT_LABELS,
  type PayrollPeriodRecord,
  type PayrollReportKey,
  type PayrollReportTable,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/field';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { ScopeFilters, money } from './payroll-shared';

/**
 * Payroll reports.
 *
 * Eight reports, one table component. The server decides the columns, which is
 * what keeps a report from drifting away from the figures it claims to
 * summarise: adding a column is a change in one place, not two.
 *
 * Only approved and finalized runs are included by default. A draft calculation
 * is working material, and reporting on it as though it were payroll would be
 * misleading.
 */

const INITIAL = {
  key: 'summary' as PayrollReportKey,
  periodId: '',
  departmentId: '',
  locationId: '',
  includeDraft: false,
};

export function PayrollReportsPage() {
  const [filters, setFilters] = React.useState(INITIAL);
  const [downloading, setDownloading] = React.useState(false);

  const periods = useQuery({
    queryKey: ['payroll-periods', { limit: 50 }],
    queryFn: () => api.getPage<PayrollPeriodRecord>('/payroll/periods', { query: { limit: 50 } }),
  });

  const queryParams = {
    periodId: filters.periodId || undefined,
    departmentId: filters.departmentId || undefined,
    locationId: filters.locationId || undefined,
    includeDraft: filters.includeDraft ? 'true' : undefined,
  };

  const report = useQuery({
    queryKey: ['payroll-report', filters],
    queryFn: () =>
      api.get<PayrollReportTable>(`/payroll/reports/${filters.key}`, { query: queryParams }),
  });

  /**
   * Downloads the CSV the server builds, rather than re-serialising the rows in
   * the browser: the export and the screen then cannot disagree.
   */
  const download = async () => {
    setDownloading(true);
    try {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(queryParams)) {
        if (value) search.set(key, String(value));
      }
      const response = await fetch(
        `/api/v1/payroll/reports/${filters.key}/export?${search.toString()}`,
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error('The export could not be generated.');

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `payroll-${filters.key}.csv`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setDownloading(false);
    }
  };

  const table = report.data;
  const totals = React.useMemo(() => {
    if (!table) return null;
    const moneyColumns = table.columns.filter((c) => c.money);
    if (moneyColumns.length === 0 || table.rows.length === 0) return null;
    const result: Record<string, number> = {};
    for (const column of moneyColumns) {
      result[column.key] = table.rows.reduce((sum, row) => {
        const value = row[column.key];
        return sum + (typeof value === 'number' ? value : 0);
      }, 0);
    }
    return result;
  }, [table]);

  return (
    <>
      <PageHeader
        title="Payroll reports"
        description="Built from the figures each run produced, not from a recalculation."
        actions={
          <Button
            variant="outline"
            size="sm"
            loading={downloading}
            disabled={!table || table.rows.length === 0}
            onClick={() => void download()}
          >
            <Download />
            Export CSV
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        <Card className="h-fit overflow-hidden p-1.5">
          <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {PAYROLL_REPORT_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilters((f) => ({ ...f, key }))}
                className={cn(
                  'shrink-0 rounded-md px-3 py-2 text-left text-[13px] transition-colors lg:w-full',
                  filters.key === key
                    ? 'bg-primary-soft font-medium text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {PAYROLL_REPORT_LABELS[key]}
              </button>
            ))}
          </nav>
        </Card>

        <div className="min-w-0">
          <Card className="mb-4 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect
                value={filters.periodId}
                onChange={(e) => setFilters((f) => ({ ...f, periodId: e.target.value }))}
                aria-label="Filter by pay period"
                className="w-52"
              >
                <option value="">All pay periods</option>
                {periods.data?.data.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
              <ScopeFilters
                departmentId={filters.departmentId}
                locationId={filters.locationId}
                onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
              />
              <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={filters.includeDraft}
                  onChange={(e) => setFilters((f) => ({ ...f, includeDraft: e.target.checked }))}
                  className="size-4 shrink-0 rounded border-input accent-[var(--primary)]"
                />
                Include draft runs
              </label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFilters((f) => ({ ...INITIAL, key: f.key }))}
              >
                Reset
              </Button>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-[13.5px] font-semibold">
                {PAYROLL_REPORT_LABELS[filters.key]}
              </h2>
              <p className="text-[12.5px] text-muted-foreground">
                {PAYROLL_REPORT_DESCRIPTIONS[filters.key]}
              </p>
            </div>

            {report.isError ? (
              <ErrorState error={report.error} onRetry={() => void report.refetch()} />
            ) : (
              <TableWrapper>
                <Table>
                  <THead>
                    <TR className="hover:bg-transparent">
                      {(table?.columns ?? []).map((column) => (
                        <TH
                          key={column.key}
                          className={column.align === 'right' ? 'text-right' : undefined}
                        >
                          {column.label}
                        </TH>
                      ))}
                    </TR>
                  </THead>
                  <TBody>
                    {report.isLoading ? (
                      <TableSkeleton rows={6} columns={table?.columns.length ?? 6} />
                    ) : !table || table.rows.length === 0 ? (
                      <TR className="hover:bg-transparent">
                        <TD colSpan={table?.columns.length || 1} className="p-0">
                          <EmptyState
                            icon={BarChart3}
                            title="Nothing to report yet"
                            description="Approve or finalize a payroll run, or include draft runs above."
                          />
                        </TD>
                      </TR>
                    ) : (
                      <>
                        {table.rows.map((row, index) => (
                          <TR key={index}>
                            {table.columns.map((column) => {
                              const value = row[column.key];
                              return (
                                <TD
                                  key={column.key}
                                  className={cn(
                                    'text-[13px]',
                                    column.align === 'right' && 'tabular text-right',
                                  )}
                                >
                                  {column.money && typeof value === 'number'
                                    ? money(value)
                                    : (value ?? '--')}
                                </TD>
                              );
                            })}
                          </TR>
                        ))}
                        {totals ? (
                          <TR className="bg-surface-muted/60 hover:bg-surface-muted/60">
                            {table.columns.map((column, index) => (
                              <TD
                                key={column.key}
                                className={cn(
                                  'text-[13px] font-semibold',
                                  column.align === 'right' && 'tabular text-right',
                                )}
                              >
                                {index === 0
                                  ? `${table.rows.length} row(s)`
                                  : column.key in totals
                                    ? money(totals[column.key])
                                    : ''}
                              </TD>
                            ))}
                          </TR>
                        ) : null}
                      </>
                    )}
                  </TBody>
                </Table>
              </TableWrapper>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
