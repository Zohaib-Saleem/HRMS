import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Banknote,
  CalendarDays,
  Columns3,
  Download,
  HandCoins,
  Timer,
  Users,
} from 'lucide-react';
import {
  COLUMN_GROUPS,
  EMPLOYEE_MASTER_COLUMNS,
  EMPLOYEE_STATUSES,
  EMPLOYEE_STATUS_LABELS,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_LABELS,
  LOAN_FILTER_STATUSES,
  type EmploymentStatus,
  REPORT_PERIOD_LABELS,
  REPORT_PERIOD_PRESETS,
  resolveReportPeriod,
  type EmployeeMasterReport,
  type EmployeeMasterRow,
  type MasterColumn,
  type ReportPeriodPreset,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useLookups } from '@/lib/lookups';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Label, NativeSelect } from '@/components/ui/field';
import { Pagination } from '@/components/ui/pagination';
import { StatCard } from '@/components/ui/stat-card';
import { TableSkeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMasterColumns } from './use-master-columns';

/**
 * Employee Master Report - one row per employee, every module's figure in one
 * place.
 *
 * The screen renders; it does not calculate. Every number in a cell arrives
 * from the API already decided by the module that owns it, which is why a
 * salary here and a salary on the Employee 360 profile cannot drift apart.
 *
 * Two deliberate shapes. Filters are held in a draft and applied on demand
 * rather than on every keystroke, because each request re-runs the attendance
 * engine over the whole cohort and firing that on a half-typed department name
 * is rude to the database. And a row is a link to the existing profile rather
 * than a drawer of its own: there is one employee-detail screen in this product
 * and this is not a second one.
 */

/** Everything the filter bar can hold. Kept flat so reset is one assignment. */
interface Filters {
  q: string;
  period: ReportPeriodPreset;
  from: string;
  to: string;
  status: string;
  employmentStatus: string;
  departmentId: string;
  teamId: string;
  designationId: string;
  locationId: string;
  hiredFrom: string;
  hiredTo: string;
  incrementDueFrom: string;
  incrementDueTo: string;
  salaryMin: string;
  salaryMax: string;
  leaveTypeId: string;
  leaveRemainingMin: string;
  leaveRemainingMax: string;
  loanStatus: string;
  hasActiveLoan: string;
  loanOutstandingMin: string;
  loanOutstandingMax: string;
  attendanceMin: string;
  attendanceMax: string;
  overtimeMinHours: string;
}

const EMPTY: Filters = {
  q: '', period: 'this-month', from: '', to: '',
  status: '', employmentStatus: '', departmentId: '', teamId: '', designationId: '', locationId: '',
  hiredFrom: '', hiredTo: '', incrementDueFrom: '', incrementDueTo: '',
  salaryMin: '', salaryMax: '', leaveTypeId: '', leaveRemainingMin: '', leaveRemainingMax: '',
  loanStatus: 'any', hasActiveLoan: '', loanOutstandingMin: '', loanOutstandingMax: '',
  attendanceMin: '', attendanceMax: '', overtimeMinHours: '',
};

/** Only what is set, so the URL says what the operator actually asked for. */
function toQuery(filters: Filters, page: number, sort: string, order: 'asc' | 'desc', limit: number) {
  const out: Record<string, string | number> = { page, limit, sort, order, period: filters.period };
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'period') continue;
    if (value !== '' && !(key === 'loanStatus' && value === 'any')) out[key] = value;
  }
  return out;
}

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);

export function EmployeeMasterReportPage() {
  const navigate = useNavigate();
  const { lookups } = useLookups();

  const [draft, setDraft] = React.useState<Filters>(EMPTY);
  const [applied, setApplied] = React.useState<Filters>(EMPTY);
  const [page, setPage] = React.useState(1);
  const [limit, setLimit] = React.useState(25);
  const [sort, setSort] = React.useState('fullName');
  const [order, setOrder] = React.useState<'asc' | 'desc'>('asc');
  const [picker, setPicker] = React.useState(false);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const query = useQuery({
    queryKey: ['reports', 'employee-master', { applied, page, limit, sort, order }],
    queryFn: () =>
      api.get<EmployeeMasterReport>('/reports/employee-master', {
        query: toQuery(applied, page, sort, order, limit),
      }),
    placeholderData: keepPreviousData,
  });

  const report = query.data;
  const available = React.useMemo(() => report?.availableColumns ?? [], [report]);
  const { selected, visible, toggle, setGroup, reset } = useMasterColumns(available);

  const leaveTypes = useQuery({
    queryKey: ['leave-types'],
    queryFn: () => api.getPage<{ id: string; name: string }>('/leave/types', { query: { limit: 50 } }),
  });

  const apply = () => {
    setPage(1);
    setApplied(draft);
  };
  const clear = () => {
    setDraft(EMPTY);
    setApplied(EMPTY);
    setPage(1);
  };

  const sortBy = (key: string) => {
    if (sort === key) {
      setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(key);
      setOrder('asc');
    }
    setPage(1);
  };

  /** Exports carry the filters, the period AND the visible columns. */
  const exportHref = (extension: 'csv' | 'xlsx') => {
    const params = new URLSearchParams(
      Object.entries(toQuery(applied, 1, sort, order, limit)).map(([k, v]) => [k, String(v)]),
    );
    params.set('columns', visible.map((c) => c.key).join(','));
    return `/api/v1/reports/employee-master/export.${extension}?${params.toString()}`;
  };

  const period = resolveReportPeriod(applied.period, new Date(), {
    from: applied.from,
    to: applied.to,
  });
  const totals = report?.totals;
  const currency = totals?.currency ?? 'PKR';
  const isFiltered = JSON.stringify(applied) !== JSON.stringify(EMPTY);

  return (
    <>
      <PageHeader
        title="Employee Master Report"
        description={`One row per employee. Attendance and overtime cover ${report?.from ?? period.from} to ${report?.to ?? period.to}; salary, leave and loans are as they stand today.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setPicker(true)}>
              <Columns3 className="size-4" aria-hidden />
              Columns
              <Badge variant="neutral" className="ml-1">{visible.length}</Badge>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={exportHref('xlsx')}>
                <Download className="size-4" aria-hidden /> Export Excel
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={exportHref('csv')}>
                <Download className="size-4" aria-hidden /> Export CSV
              </a>
            </Button>
          </div>
        }
      />

      {/* Totals for the CURRENT filters, from the same response as the table. */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard label="Employees" value={totals?.employees} icon={Users} loading={query.isLoading} />
        <StatCard label="Active" value={totals?.active} icon={Users} tone="success" loading={query.isLoading} />
        {totals?.totalSalary !== undefined ? (
          <StatCard label="Total Salary" value={money(totals.totalSalary, currency)} icon={Banknote} tone="primary" loading={query.isLoading} />
        ) : null}
        {totals?.totalLeaveRemaining !== undefined ? (
          <StatCard label="Leave Remaining" value={`${totals.totalLeaveRemaining} days`} icon={CalendarDays} loading={query.isLoading} />
        ) : null}
        {totals?.outstandingLoans !== undefined ? (
          <StatCard label="Outstanding Loans" value={money(totals.outstandingLoans, currency)} icon={HandCoins} tone="warning" hint={`${totals.activeLoans ?? 0} active`} loading={query.isLoading} />
        ) : null}
        {totals?.totalOvertimeHours !== undefined ? (
          <StatCard label="Overtime" value={`${totals.totalOvertimeHours} h`} icon={Timer} loading={query.isLoading} />
        ) : null}
      </div>

      <Card className="mb-5 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <Field label="Search employee">
            <Input
              value={draft.q}
              placeholder="Name, code, email, job title"
              onChange={(e) => set('q', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
            />
          </Field>
          <Field label="Period">
            <NativeSelect value={draft.period} onChange={(e) => set('period', e.target.value as ReportPeriodPreset)}>
              {REPORT_PERIOD_PRESETS.map((p) => (
                <option key={p} value={p}>{REPORT_PERIOD_LABELS[p]}</option>
              ))}
            </NativeSelect>
          </Field>
          {draft.period === 'custom' ? (
            <>
              <Field label="From"><Input type="date" value={draft.from} onChange={(e) => set('from', e.target.value)} /></Field>
              <Field label="To"><Input type="date" value={draft.to} onChange={(e) => set('to', e.target.value)} /></Field>
            </>
          ) : null}

          <Field label="Department">
            <Lookup value={draft.departmentId} onChange={(v) => set('departmentId', v)} options={lookups.departments} all="All departments" />
          </Field>
          <Field label="Team">
            <Lookup value={draft.teamId} onChange={(v) => set('teamId', v)} options={lookups.teams} all="All teams" />
          </Field>
          <Field label="Designation">
            <Lookup value={draft.designationId} onChange={(v) => set('designationId', v)} options={lookups.designations} all="All designations" />
          </Field>
          <Field label="Location">
            <Lookup value={draft.locationId} onChange={(v) => set('locationId', v)} options={lookups.locations} all="All locations" />
          </Field>
          {/*
            The employment status - is this person employed - from the shared
            list rather than a hand-typed one. The old literal offered
            PROBATION, NOTICE_PERIOD and RETIRED, none of which are values of
            EmployeeStatus, so picking any of the three filtered the report down
            to nothing. Probation was the one people actually reached for, and
            it now has a filter of its own below, which is the field that
            genuinely holds it.
          */}
          <Field label="Status">
            <NativeSelect value={draft.status} onChange={(e) => set('status', e.target.value)}>
              <option value="">Any status</option>
              {EMPLOYEE_STATUSES.map((s) => (
                <option key={s} value={s}>{EMPLOYEE_STATUS_LABELS[s]}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Employment status">
            <NativeSelect
              value={draft.employmentStatus}
              onChange={(e) => set('employmentStatus', e.target.value)}
            >
              <option value="">All employment statuses</option>
              {EMPLOYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>{EMPLOYMENT_STATUS_LABELS[s]}</option>
              ))}
            </NativeSelect>
          </Field>

          <Field label="Joined between"><Range a={draft.hiredFrom} b={draft.hiredTo} onA={(v) => set('hiredFrom', v)} onB={(v) => set('hiredTo', v)} type="date" /></Field>
          <Field label="Increment due between"><Range a={draft.incrementDueFrom} b={draft.incrementDueTo} onA={(v) => set('incrementDueFrom', v)} onB={(v) => set('incrementDueTo', v)} type="date" /></Field>
          <Field label="Salary range"><Range a={draft.salaryMin} b={draft.salaryMax} onA={(v) => set('salaryMin', v)} onB={(v) => set('salaryMax', v)} type="number" placeholderA="min" placeholderB="max" /></Field>

          <Field label="Leave type">
            <NativeSelect value={draft.leaveTypeId} onChange={(e) => set('leaveTypeId', e.target.value)}>
              <option value="">All types (total)</option>
              {(leaveTypes.data?.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Leave remaining"><Range a={draft.leaveRemainingMin} b={draft.leaveRemainingMax} onA={(v) => set('leaveRemainingMin', v)} onB={(v) => set('leaveRemainingMax', v)} type="number" placeholderA="min" placeholderB="max" /></Field>
          <Field label="Loan status">
            <NativeSelect value={draft.loanStatus} onChange={(e) => set('loanStatus', e.target.value)}>
              {LOAN_FILTER_STATUSES.map((s) => (
                <option key={s} value={s}>{s === 'any' ? 'Any' : s === 'none' ? 'No loans' : `${s.charAt(0).toUpperCase()}${s.slice(1)}`}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Has active loan">
            <NativeSelect value={draft.hasActiveLoan} onChange={(e) => set('hasActiveLoan', e.target.value)}>
              <option value="">Either</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </NativeSelect>
          </Field>
          <Field label="Loan outstanding"><Range a={draft.loanOutstandingMin} b={draft.loanOutstandingMax} onA={(v) => set('loanOutstandingMin', v)} onB={(v) => set('loanOutstandingMax', v)} type="number" placeholderA="min" placeholderB="max" /></Field>
          <Field label="Attendance %"><Range a={draft.attendanceMin} b={draft.attendanceMax} onA={(v) => set('attendanceMin', v)} onB={(v) => set('attendanceMax', v)} type="number" placeholderA="min" placeholderB="max" /></Field>
          <Field label="Overtime at least (h)">
            <Input type="number" value={draft.overtimeMinHours} placeholder="hours" onChange={(e) => set('overtimeMinHours', e.target.value)} />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button size="sm" onClick={apply}>Apply Filters</Button>
          <Button size="sm" variant="outline" onClick={clear} disabled={!isFiltered && JSON.stringify(draft) === JSON.stringify(EMPTY)}>
            Clear Filters
          </Button>
          {query.isFetching ? <span className="text-[12.5px] text-muted-foreground">Updating…</span> : null}
        </div>
      </Card>

      <Card className="p-0">
        {query.isError ? (
          <div className="p-5"><ErrorState error={query.error} onRetry={() => void query.refetch()} /></div>
        ) : (
          <>
            {/* The one place the page is allowed to scroll sideways. */}
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full min-w-max border-collapse text-[13px]">
                <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_0_hsl(var(--border))]">
                  <tr>
                    {visible.map((column) => (
                      <th
                        key={column.key}
                        scope="col"
                        className={cn(
                          'whitespace-nowrap px-3 py-2.5 text-left text-[12px] font-semibold uppercase tracking-wide text-muted-foreground',
                          column.align === 'right' && 'text-right',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => sortBy(column.key)}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          {column.label}
                          {sort === column.key ? (
                            order === 'asc' ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />
                          ) : null}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {query.isLoading ? (
                    <TableSkeleton rows={8} columns={Math.max(1, visible.length)} />
                  ) : visible.length === 0 ? (
                    <tr>
                      <td className="p-0">
                        <EmptyState
                          icon={Columns3}
                          title="No columns selected"
                          description="Choose at least one column to see the report."
                          action={<Button size="sm" variant="outline" onClick={reset}>Restore defaults</Button>}
                        />
                      </td>
                    </tr>
                  ) : (report?.rows.length ?? 0) === 0 ? (
                    <tr>
                      <td colSpan={visible.length} className="p-0">
                        <EmptyState
                          icon={Users}
                          title={isFiltered ? 'No employees match those filters' : 'No employees'}
                          description={isFiltered ? 'Clear the filters to see everyone.' : 'Employees appear here once they are on the roster.'}
                        />
                      </td>
                    </tr>
                  ) : (
                    report?.rows.map((row) => (
                      <tr
                        key={row.employeeId}
                        onClick={() => navigate(`/people/${row.employeeId}`)}
                        className="cursor-pointer border-t border-border transition-colors hover:bg-accent/45"
                      >
                        {visible.map((column) => (
                          <td
                            key={column.key}
                            className={cn(
                              'whitespace-nowrap px-3 py-2.5',
                              column.align === 'right' && 'tabular text-right',
                            )}
                          >
                            <Cell row={row} column={column} currency={currency} />
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {report ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
                <NativeSelect
                  aria-label="Rows per page"
                  className="w-32"
                  value={String(limit)}
                  onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}
                >
                  {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} rows</option>)}
                </NativeSelect>
                <Pagination
                  meta={{ page: report.meta.page, limit: report.meta.limit, total: report.meta.total, totalPages: report.meta.totalPages }}
                  onPageChange={setPage}
                />
              </div>
            ) : null}
          </>
        )}
      </Card>

      <Dialog open={picker} onOpenChange={setPicker}>
        <DialogContent size="lg">
          <DialogHeader><DialogTitle>Columns</DialogTitle></DialogHeader>
          <DialogBody>
            <div className="mb-4 flex items-center justify-between">
              <p className="text-[12.5px] text-muted-foreground">
                {visible.length} of {available.length} available. Remembered on this device.
              </p>
              <Button size="sm" variant="outline" onClick={reset}>Restore defaults</Button>
            </div>
            <div className="space-y-5">
              {COLUMN_GROUPS.map((group) => {
                const columns = EMPLOYEE_MASTER_COLUMNS.filter(
                  (c) => c.group === group && available.includes(c.key),
                );
                if (columns.length === 0) return null;
                const allOn = columns.every((c) => selected.includes(c.key));
                return (
                  <div key={group}>
                    <div className="mb-2 flex items-center justify-between border-b border-border pb-1.5">
                      <h3 className="text-[13px] font-semibold">{group}</h3>
                      <Button size="sm" variant="ghost" onClick={() => setGroup(group, !allOn, available)}>
                        {allOn ? 'None' : 'All'}
                      </Button>
                    </div>
                    <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                      {columns.map((c) => (
                        <label key={c.key} className="flex cursor-pointer items-center gap-2 text-[13px]">
                          <input
                            type="checkbox"
                            className="size-4 rounded border-border"
                            checked={selected.includes(c.key)}
                            onChange={() => toggle(c.key)}
                          />
                          {c.label}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[12px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Lookup({
  value, onChange, options, all,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ id: string; label: string }>;
  all: string;
}) {
  return (
    <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{all}</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </NativeSelect>
  );
}

function Range({
  a, b, onA, onB, type, placeholderA, placeholderB,
}: {
  a: string; b: string;
  onA: (v: string) => void; onB: (v: string) => void;
  type: 'date' | 'number';
  placeholderA?: string; placeholderB?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Input type={type} value={a} placeholder={placeholderA} onChange={(e) => onA(e.target.value)} />
      <span className="text-muted-foreground">–</span>
      <Input type={type} value={b} placeholder={placeholderB} onChange={(e) => onB(e.target.value)} />
    </div>
  );
}

/** One cell. Reads the row; computes nothing. */
function Cell({ row, column, currency }: { row: EmployeeMasterRow; column: MasterColumn; currency: string }) {
  const dash = <span className="text-muted-foreground">—</span>;
  const text = (v: string | number | null | undefined) =>
    v === null || v === undefined || v === '' ? dash : <>{v}</>;

  switch (column.key) {
    case 'fullName':
      return (
        <div className="min-w-[12rem]">
          <p className="font-medium">{row.fullName}</p>
          <p className="text-[11.5px] text-muted-foreground">{row.designationName ?? row.jobTitle ?? '—'}</p>
        </div>
      );
    case 'employeeNumber':
      return <span className="font-mono text-[12px]">{row.employeeNumber}</span>;
    case 'punchCodes':
      return row.punchCodes?.length ? <span className="font-mono text-[12px]">{row.punchCodes.join(' / ')}</span> : dash;
    case 'status':
      return <Badge variant={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.status.replace(/_/g, ' ')}</Badge>;
    case 'employmentStatus':
      // The label, not the enum: the export and the screen both read "Probation".
      return row.employmentStatus
        ? text(EMPLOYMENT_STATUS_LABELS[row.employmentStatus as EmploymentStatus])
        : dash;
    case 'contract':
      return row.contract ? text([row.contract.type, row.contract.startDate].filter(Boolean).join(' · ')) : dash;
    case 'salaryAmount':
      return row.salary ? <>{money(row.salary.amount, row.salary.currency || currency)}</> : dash;
    case 'salaryEffectiveFrom': return text(row.salary?.effectiveFrom);
    case 'salaryRevisionCount': return text(row.salary?.revisionCount);
    case 'lastRevisionDate': return text(row.salary?.lastRevisionDate);
    case 'lastRevisionAmount':
      return row.salary?.lastRevisionAmount != null ? <>{money(row.salary.lastRevisionAmount, currency)}</> : dash;
    case 'nextIncrementDueDate': return text(row.salary?.nextIncrementDueDate);
    case 'leaveEntitlement': return text(row.leave?.entitlementDays);
    case 'leaveUsed': return text(row.leave?.usedDays);
    case 'leaveConsumed': return text(row.leave?.consumedDays);
    case 'leaveAdjusted': return text(row.leave?.adjustedDays);
    case 'leaveRemaining':
      return row.leave ? (
        <span className={row.leave.availableDays < 0 ? 'text-destructive' : undefined}>{row.leave.availableDays}</span>
      ) : dash;
    case 'leavePending': return text(row.leave?.pendingDays);
    case 'leaveByType':
      return row.leave?.byType.length ? (
        <span className="text-[12px] text-muted-foreground">
          {row.leave.byType.map((t) => `${t.code ?? t.name}: ${t.availableDays}`).join(' · ')}
        </span>
      ) : dash;
    case 'leaveRequestCount': return text(row.leave?.requestCount);
    case 'leavePendingCount': return text(row.leave?.pendingCount);
    case 'leaveApprovedCount': return text(row.leave?.approvedCount);
    case 'leaveRejectedCount': return text(row.leave?.rejectedCount);
    case 'hasActiveLoan':
      return row.loans ? (
        row.loans.hasActiveLoan ? <Badge variant="warning">Yes</Badge> : <span className="text-muted-foreground">No</span>
      ) : dash;
    case 'loanStatuses':
      return row.loans?.statuses.length ? text(row.loans.statuses.join(', ')) : dash;
    case 'loanCount': return text(row.loans?.count);
    case 'loanPrincipal': return row.loans ? <>{money(row.loans.principalTotal, row.loans.currency)}</> : dash;
    case 'loanPaid': return row.loans ? <>{money(row.loans.paidTotal, row.loans.currency)}</> : dash;
    case 'loanOutstanding': return row.loans ? <>{money(row.loans.outstandingTotal, row.loans.currency)}</> : dash;
    case 'loanMonthly': return row.loans ? <>{money(row.loans.monthlyDeduction, row.loans.currency)}</> : dash;
    case 'loanRemainingInstallments': return text(row.loans?.remainingInstallments);
    case 'loanNextDueMonth': return text(row.loans?.nextDueMonth);
    case 'attPresent': return text(row.attendance?.present);
    case 'attAbsent': return text(row.attendance?.absent);
    case 'attLate': return text(row.attendance?.late);
    case 'attHalfDay': return text(row.attendance?.halfDay);
    case 'attOnLeave': return text(row.attendance?.onLeave);
    case 'attHoliday': return text(row.attendance?.holiday);
    case 'attWeekend': return text(row.attendance?.weekend);
    case 'attWorkedHours': return text(row.attendance?.workedHours);
    case 'attOvertimeHours': return text(row.attendance?.overtimeHours);
    case 'attPercentage':
      return row.attendance?.attendancePercentage != null ? <>{row.attendance.attendancePercentage}%</> : dash;
    case 'priorExperienceMonths':
      return row.priorExperienceMonths != null
        ? <>{Math.round((row.priorExperienceMonths / 12) * 10) / 10} yrs</>
        : dash;
    case 'education':
      return row.education ? <span className="block max-w-[20rem] truncate" title={row.education}>{row.education}</span> : dash;
    default:
      return text((row as unknown as Record<string, string | number | null>)[column.key]);
  }
}
