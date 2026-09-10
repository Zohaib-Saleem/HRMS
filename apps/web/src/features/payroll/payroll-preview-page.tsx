import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Calculator, Download } from 'lucide-react';
import type {
  PayrollPeriodRecord,
  PayrollPreview,
  PayrollPreviewRow,
  PayrollRunRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { cn, formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/field';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/feedback/states';

/**
 * The payroll preview.
 *
 * What a period would pay, before anybody commits to it. It runs the same
 * calculation a run runs and writes none of it - no lines, no exceptions, no
 * adjustment claimed, no run moved - so it can be opened as often as somebody
 * likes without changing the answer.
 *
 * The columns are the ones the finance conversation actually needs: basic,
 * paid days, absence, unpaid leave, allowances, overtime, deductions, gross,
 * net. A row opens to show the arithmetic line by line, because "why is this
 * number what it is" is the whole reason a preview exists.
 */

const money = (value: number, currency: string): string =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value);

export function PayrollPreviewPage() {
  const [params, setParams] = useSearchParams();
  const { lookups } = useLookups();

  const runId = params.get('runId') ?? '';
  const periodId = params.get('periodId') ?? '';
  const departmentId = params.get('departmentId') ?? '';
  const [inspecting, setInspecting] = React.useState<PayrollPreviewRow | null>(null);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // Choosing a run supersedes a period and vice versa: two answers to "which
    // period?" is how a preview quietly describes the wrong month.
    if (key === 'runId' && value) next.delete('periodId');
    if (key === 'periodId' && value) next.delete('runId');
    setParams(next, { replace: true });
  };

  const runs = useQuery({
    queryKey: ['payroll', 'runs', 'preview-picker'],
    queryFn: () => api.getPage<PayrollRunRecord>('/payroll/runs', { query: { limit: 50 } }),
  });

  const periods = useQuery({
    queryKey: ['payroll', 'periods', 'preview-picker'],
    queryFn: () => api.getPage<PayrollPeriodRecord>('/payroll/periods', { query: { limit: 50 } }),
  });

  const enabled = runId !== '' || periodId !== '';

  const query = useQuery({
    queryKey: ['payroll', 'preview', { runId, periodId, departmentId }],
    queryFn: () =>
      api.get<PayrollPreview>('/payroll/runs/preview', {
        query: {
          runId: runId || undefined,
          periodId: periodId || undefined,
          departmentId: departmentId || undefined,
        },
      }),
    enabled,
    placeholderData: keepPreviousData,
  });

  const preview = query.data;
  const currency = preview?.currency ?? 'PKR';

  const exportHref = () => {
    const search = new URLSearchParams({ format: 'csv' });
    if (runId) search.set('runId', runId);
    if (periodId) search.set('periodId', periodId);
    if (departmentId) search.set('departmentId', departmentId);
    return `/api/v1/payroll/runs/preview?${search.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Payroll preview"
        description="What this period would pay, calculated and thrown away. Nothing is written."
      />

      <Card className="mb-5 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <label>
            <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
              Run
            </span>
            <NativeSelect value={runId} onChange={(e) => setParam('runId', e.target.value)}>
              <option value="">Choose a run</option>
              {(runs.data?.data ?? []).map((run) => (
                <option key={run.id} value={run.id}>
                  {run.periodName} - {run.status}
                </option>
              ))}
            </NativeSelect>
          </label>

          <label>
            <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
              Or a period
            </span>
            <NativeSelect value={periodId} onChange={(e) => setParam('periodId', e.target.value)}>
              <option value="">Choose a period</option>
              {(periods.data?.data ?? []).map((period) => (
                <option key={period.id} value={period.id}>
                  {period.name}
                </option>
              ))}
            </NativeSelect>
          </label>

          <label>
            <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
              Department
            </span>
            <NativeSelect
              value={departmentId}
              onChange={(e) => setParam('departmentId', e.target.value)}
            >
              <option value="">All</option>
              {lookups.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
      </Card>

      {!enabled ? (
        <Card>
          <EmptyState
            icon={Calculator}
            title="Choose a run or a period"
            description="The preview shows what would be paid, without writing anything. A period with no run yet works too."
          />
        </Card>
      ) : (
        <>
          {preview ? (
            <div className="mb-5 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
              <Total label="Employees" value={String(preview.totals.employees)} />
              <Total label="Basic" value={money(preview.totals.basicAmount, currency)} />
              <Total label="Allowances" value={money(preview.totals.allowances, currency)} />
              <Total label="Overtime" value={money(preview.totals.overtimeAmount, currency)} />
              <Total label="Gross" value={money(preview.totals.grossAmount, currency)} />
              <Total label="Net" value={money(preview.totals.netAmount, currency)} emphasis />
            </div>
          ) : null}

          {preview && preview.totals.blocked > 0 ? (
            <div className="mb-5 flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <p>
                {preview.totals.blocked} employee(s) cannot be calculated yet and would produce no
                payslip. They are listed below with the reason - finalizing before they are fixed
                would pay everybody else and quietly skip them.
              </p>
            </div>
          ) : null}

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
              <div>
                <h2 className="text-sm font-semibold">Calculation preview</h2>
                {preview ? (
                  <p className="text-xs text-muted-foreground">
                    {formatDate(preview.from)} to {formatDate(preview.to)}
                    {preview.runStatus ? ` - run is ${preview.runStatus}` : ''}
                  </p>
                ) : null}
              </div>
              <Button asChild variant="outline" size="sm">
                <a href={exportHref()}>
                  <Download className="size-4" aria-hidden />
                  Export CSV
                </a>
              </Button>
            </div>

            {query.isError ? (
              <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : query.isLoading || !preview ? (
              <TableSkeleton rows={8} />
            ) : preview.rows.length === 0 ? (
              <EmptyState
                icon={Calculator}
                title="Nothing to preview"
                description="No employee is payable over that period."
              />
            ) : (
              <TableWrapper>
                <Table>
                  <THead>
                    <TR>
                      <TH>Employee</TH>
                      <TH className="text-right">Basic salary</TH>
                      <TH className="text-right">Paid days</TH>
                      <TH className="text-right">Absent</TH>
                      <TH className="text-right">Unpaid leave</TH>
                      <TH className="text-right">Allowances</TH>
                      <TH className="text-right">OT hours</TH>
                      <TH className="text-right">OT amount</TH>
                      <TH className="text-right">Deductions</TH>
                      <TH className="text-right">Gross</TH>
                      <TH className="text-right">Net</TH>
                      <TH />
                    </TR>
                  </THead>
                  <TBody>
                    {preview.rows.map((row) => (
                      <TR key={row.employeeId} className={row.blocked ? 'opacity-70' : ''}>
                        <TD>
                          <div className="font-medium">{row.employeeName}</div>
                          <div className="text-xs text-muted-foreground">
                            {row.employeeNumber}
                            {row.departmentName ? ` - ${row.departmentName}` : ''}
                          </div>
                          {row.blocked ? (
                            <div className="mt-1 text-xs text-destructive">
                              {row.notes[0] ?? 'Blocked'}
                            </div>
                          ) : null}
                        </TD>
                        <TD className="text-right tabular-nums">
                          {money(row.basicSalary, row.currency)}
                          {row.salarySegments > 1 ? (
                            <div className="text-xs text-muted-foreground">
                              {row.salarySegments} salaries this period
                            </div>
                          ) : null}
                        </TD>
                        <TD className="text-right tabular-nums">{row.paidDays}</TD>
                        <TD className="text-right tabular-nums">{row.absentDays}</TD>
                        <TD className="text-right tabular-nums">{row.unpaidLeaveDays}</TD>
                        <TD className="text-right tabular-nums">{money(row.allowances, row.currency)}</TD>
                        <TD className="text-right tabular-nums">{row.overtimeHours}</TD>
                        <TD className="text-right tabular-nums">
                          {money(row.overtimeAmount, row.currency)}
                        </TD>
                        <TD className="text-right tabular-nums">
                          {money(row.deductionsTotal, row.currency)}
                        </TD>
                        <TD className="text-right tabular-nums">
                          {money(row.grossAmount, row.currency)}
                        </TD>
                        <TD className="text-right font-semibold tabular-nums">
                          {money(row.netAmount, row.currency)}
                        </TD>
                        <TD className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => setInspecting(row)}>
                            Inspect
                          </Button>
                        </TD>
                      </TR>
                    ))}
                    <TR className="border-t-2 border-border bg-surface-muted/40 font-semibold">
                      <TD>Total</TD>
                      <TD />
                      <TD />
                      <TD />
                      <TD />
                      <TD className="text-right tabular-nums">
                        {money(preview.totals.allowances, currency)}
                      </TD>
                      <TD />
                      <TD className="text-right tabular-nums">
                        {money(preview.totals.overtimeAmount, currency)}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {money(preview.totals.deductionsTotal, currency)}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {money(preview.totals.grossAmount, currency)}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {money(preview.totals.netAmount, currency)}
                      </TD>
                      <TD />
                    </TR>
                  </TBody>
                </Table>
              </TableWrapper>
            )}
          </Card>
        </>
      )}

      <InspectDrawer row={inspecting} onClose={() => setInspecting(null)} />
    </>
  );
}

function Total({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums', emphasis && 'text-primary')}>{value}</p>
    </div>
  );
}

/** One employee's arithmetic, line by line. */
function InspectDrawer({
  row,
  onClose,
}: {
  row: PayrollPreviewRow | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={row !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="md">
        <DialogHeader>
          <DialogTitle>{row?.employeeName ?? 'Calculation'}</DialogTitle>
          <DialogDescription>
            {row ? `${row.employeeNumber} - every line that makes up the net` : ''}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          {!row ? null : (
            <>
              <section className="rounded-lg border border-border p-4 text-[13px]">
                <h3 className="mb-2 text-sm font-semibold">How the rates were reached</h3>
                <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  <Row label="Salary" value={money(row.basicSalary, row.currency)} />
                  <Row label="Basis" value={`${row.basis} (${row.basisDays} days)`} />
                  <Row label="Daily rate" value={money(row.dailyRate, row.currency)} />
                  <Row label="Hourly rate" value={money(row.hourlyRate, row.currency)} />
                  <Row label="Working days" value={String(row.scheduledDays)} />
                  <Row label="Paid days" value={String(row.paidDays)} />
                  <Row label="Present" value={String(row.presentDays)} />
                  <Row label="Paid leave" value={String(row.paidLeaveDays)} />
                  <Row label="Unpaid leave" value={String(row.unpaidLeaveDays)} />
                  <Row label="Absent" value={String(row.absentDays)} />
                  <Row label="Holidays" value={String(row.holidayDays)} />
                  <Row label="Weekends" value={String(row.weekendDays)} />
                </dl>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Earnings</h3>
                <LineTable lines={row.earnings} currency={row.currency} />
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Deductions</h3>
                {row.deductions.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border p-3 text-[13px] text-muted-foreground">
                    Nothing deducted.
                  </p>
                ) : (
                  <LineTable lines={row.deductions} currency={row.currency} />
                )}
              </section>

              <section className="rounded-lg border border-border p-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Gross</span>
                  <span className="tabular-nums">{money(row.grossAmount, row.currency)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Deductions</span>
                  <span className="tabular-nums">-{money(row.deductionsTotal, row.currency)}</span>
                </div>
                <div className="mt-2 flex justify-between border-t border-border pt-2 font-semibold">
                  <span>Net</span>
                  <span className="tabular-nums">{money(row.netAmount, row.currency)}</span>
                </div>
              </section>

              {row.notes.length > 0 ? (
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Exceptions</h3>
                  <ul className="space-y-1.5 text-[13px]">
                    {row.notes.map((note, index) => (
                      <li
                        key={index}
                        className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2"
                      >
                        {note}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function LineTable({
  lines,
  currency,
}: {
  lines: PayrollPreviewRow['earnings'];
  currency: string;
}) {
  return (
    <TableWrapper>
      <Table>
        <THead>
          <TR>
            <TH>Line</TH>
            <TH className="text-right">Rate</TH>
            <TH className="text-right">Units</TH>
            <TH className="text-right">Amount</TH>
          </TR>
        </THead>
        <TBody>
          {lines.map((line, index) => (
            <TR key={`${line.code}-${index}`}>
              <TD>{line.label}</TD>
              <TD className="text-right tabular-nums">
                {line.rate === null ? '--' : line.rate}
              </TD>
              <TD className="text-right tabular-nums">
                {line.units === null || line.units === undefined ? '--' : line.units}
              </TD>
              <TD className="text-right tabular-nums">{money(Number(line.amount), currency)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableWrapper>
  );
}
