import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Banknote,
  CalendarRange,
  ClipboardCheck,
  Clock,
  MinusCircle,
  Receipt,
  Users,
  Wallet,
} from 'lucide-react';
import {
  PERMISSIONS,
  type PayrollDashboard,
  type PayrollPeriodRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { HelpLink } from '@/features/help/help-link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/field';
import { StatCard } from '@/components/ui/stat-card';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Can } from '@/features/auth/session-context';
import { FinalizedNotice, RunStatusBadge, ScopeFilters, money } from './payroll-shared';

/**
 * The payroll landing page.
 *
 * Answers one question before any other: where is this month's payroll, and is
 * anything wrong with it. The exception count is a card rather than something
 * buried on a tab, because a payroll with an unresolved exception is the one
 * case where nobody should be reading the totals yet.
 */

const INITIAL = { periodId: '', departmentId: '', locationId: '' };

export function PayrollDashboardPage() {
  const [filters, setFilters] = React.useState(INITIAL);

  const periods = useQuery({
    queryKey: ['payroll-periods', { limit: 50 }],
    queryFn: () => api.getPage<PayrollPeriodRecord>('/payroll/periods', { query: { limit: 50 } }),
  });

  const dashboard = useQuery({
    queryKey: ['payroll-dashboard', filters],
    queryFn: () =>
      api.get<PayrollDashboard>('/payroll/dashboard', {
        query: {
          periodId: filters.periodId || undefined,
          departmentId: filters.departmentId || undefined,
          locationId: filters.locationId || undefined,
        },
      }),
  });

  const data = dashboard.data;
  const currency = data?.currency ?? 'USD';
  const hasFilters = filters !== INITIAL && Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader
        title="Payroll"
        description="What this period costs, and whether anything is unresolved before it is paid."
        actions={
          <div className="flex flex-wrap gap-2">
            <HelpLink slug="payroll" />
            <Can permission={PERMISSIONS.PAYROLL_READ}>
              <Button variant="outline" size="sm" asChild>
                <Link to="/payroll/reports">Reports</Link>
              </Button>
            </Can>
            <Can permission={PERMISSIONS.PAYROLL_MANAGE}>
              <Button size="sm" asChild>
                <Link to="/payroll/runs">Pay runs</Link>
              </Button>
            </Can>
          </div>
        }
      />

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            value={filters.periodId}
            onChange={(e) => setFilters((f) => ({ ...f, periodId: e.target.value }))}
            aria-label="Filter by pay period"
            className="w-56"
          >
            <option value="">Latest pay period</option>
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
          {hasFilters ? (
            <Button variant="ghost" size="sm" onClick={() => setFilters(INITIAL)}>
              Reset
            </Button>
          ) : null}
        </div>
      </Card>

      {dashboard.isError ? (
        <Card>
          <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
        </Card>
      ) : !dashboard.isLoading && !data?.run ? (
        <Card>
          <EmptyState
            icon={Banknote}
            title="No payroll run yet"
            description="Create a pay period and a run to see what this month costs."
            action={
              <Can permission={PERMISSIONS.PAYROLL_MANAGE}>
                <Button size="sm" asChild>
                  <Link to="/payroll/runs">Go to pay runs</Link>
                </Button>
              </Can>
            }
          />
        </Card>
      ) : (
        <>
          <Card className="mb-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-muted-foreground">Current pay period</p>
                <p className="truncate text-lg font-semibold">{data?.period?.name ?? '--'}</p>
                {data?.period ? (
                  <p className="tabular text-[13px] text-muted-foreground">
                    {formatDate(data.period.startDate)} – {formatDate(data.period.endDate)}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {data?.run ? <RunStatusBadge status={data.run.status} /> : null}
                {data?.run ? (
                  <Button variant="outline" size="sm" asChild>
                    <Link to={`/payroll/runs/${data.run.id}`}>Open run</Link>
                  </Button>
                ) : null}
              </div>
            </div>
            {data?.run?.status === 'FINALIZED' ? (
              <div className="mt-3">
                <FinalizedNotice />
              </div>
            ) : null}
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Total employees"
              value={data?.totalEmployees}
              icon={Users}
              loading={dashboard.isLoading}
              hint="In scope for this period"
            />
            <StatCard
              label="Employees processed"
              value={data?.employeesProcessed}
              icon={ClipboardCheck}
              tone={
                data && data.employeesProcessed < data.totalEmployees ? 'warning' : 'success'
              }
              loading={dashboard.isLoading}
              hint={
                data && data.employeesProcessed < data.totalEmployees
                  ? `${data.totalEmployees - data.employeesProcessed} not on this run`
                  : 'Everyone in scope'
              }
            />
            <StatCard
              label="Gross payroll"
              value={money(data?.grossTotal, currency)}
              icon={Wallet}
              tone="primary"
              loading={dashboard.isLoading}
            />
            <StatCard
              label="Total deductions"
              value={money(data?.deductionTotal, currency)}
              icon={MinusCircle}
              loading={dashboard.isLoading}
            />
            <StatCard
              label="Net payroll"
              value={money(data?.netTotal, currency)}
              icon={Banknote}
              tone="success"
              loading={dashboard.isLoading}
              hint="What actually leaves the account"
            />
            <StatCard
              label="Overtime cost"
              value={money(data?.overtimeCost, currency)}
              icon={Clock}
              loading={dashboard.isLoading}
              hint={data ? `${data.overtimeHours.toFixed(1)} approved hours` : undefined}
            />
            <StatCard
              label="Pending approvals"
              value={data?.pendingApprovals}
              icon={CalendarRange}
              tone={data && data.pendingApprovals > 0 ? 'warning' : 'default'}
              loading={dashboard.isLoading}
              hint="Runs waiting on a decision"
            />
            <StatCard
              label="Payroll exceptions"
              value={data?.exceptionCount}
              icon={AlertTriangle}
              tone={
                data && data.blockingCount > 0
                  ? 'warning'
                  : data && data.exceptionCount > 0
                    ? 'warning'
                    : 'default'
              }
              loading={dashboard.isLoading}
              hint={
                data && data.blockingCount > 0
                  ? `${data.blockingCount} blocking finalization`
                  : 'None blocking'
              }
            />
          </div>

          <Card className="mt-6 overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <h2 className="text-[13.5px] font-semibold">Recent pay runs</h2>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/payroll/runs">See all</Link>
              </Button>
            </div>
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Pay period</TH>
                    <TH className="w-32">Status</TH>
                    <TH className="w-28 text-right">Employees</TH>
                    <TH className="w-40 text-right">Net</TH>
                    <TH className="w-36">Created</TH>
                  </TR>
                </THead>
                <TBody>
                  {(data?.recentRuns ?? []).length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={5} className="p-0">
                        <EmptyState
                          icon={Receipt}
                          title="No runs yet"
                          description="A pay run appears here once one is created."
                        />
                      </TD>
                    </TR>
                  ) : (
                    data?.recentRuns.map((run) => (
                      <TR key={run.id}>
                        <TD className="text-[13px]">
                          <Link className="hover:underline" to={`/payroll/runs/${run.id}`}>
                            {run.periodName}
                          </Link>
                        </TD>
                        <TD>
                          <RunStatusBadge status={run.status} />
                        </TD>
                        <TD className="tabular text-right text-[13px]">{run.employeeCount}</TD>
                        <TD className="tabular text-right text-[13px] font-medium">
                          {money(run.netTotal, currency)}
                        </TD>
                        <TD className="tabular text-[12.5px] text-muted-foreground">
                          {formatDate(run.createdAt)}
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>
          </Card>
        </>
      )}
    </>
  );
}
