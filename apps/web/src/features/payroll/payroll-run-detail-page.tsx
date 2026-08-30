import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, Calculator, Users } from 'lucide-react';
import {
  PAYROLL_EXCEPTION_LABELS,
  PERMISSIONS,
  type PayrollCalculationResult,
  type PayrollExceptionRecord,
  type PayrollLineRecord,
  type PayrollRunRecord,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState, FullPageLoader } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { Can } from '@/features/auth/session-context';
import { FinalizedNotice, RunStatusBadge, days, hoursFromMinutes, money } from './payroll-shared';
import { PayrollLineDrawer } from './payroll-line-drawer';

/**
 * One pay run, employee by employee.
 *
 * The exceptions sit above the table rather than behind a tab. A run with a
 * blocking exception is not ready to be read as payroll, and putting that fact
 * one click away invites somebody to approve a total they have not questioned.
 */

export function PayrollRunDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState('');
  const [openLineId, setOpenLineId] = React.useState<string | null>(null);

  const run = useQuery({
    queryKey: ['payroll-run', id],
    queryFn: () => api.get<PayrollRunRecord>(`/payroll/runs/${id}`),
    enabled: id !== '',
  });

  const lines = useQuery({
    queryKey: ['payroll-run-lines', id, page],
    queryFn: () =>
      api.getPage<PayrollLineRecord>(`/payroll/runs/${id}/lines`, {
        query: { page, limit: 50 },
      }),
    enabled: id !== '',
    placeholderData: keepPreviousData,
  });

  const exceptions = useQuery({
    queryKey: ['payroll-run-exceptions', id],
    queryFn: () => api.get<PayrollExceptionRecord[]>(`/payroll/runs/${id}/exceptions`),
    enabled: id !== '',
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['payroll-run', id] });
    await queryClient.invalidateQueries({ queryKey: ['payroll-run-lines', id] });
    await queryClient.invalidateQueries({ queryKey: ['payroll-run-exceptions', id] });
    await queryClient.invalidateQueries({ queryKey: ['payroll-runs'] });
    await queryClient.invalidateQueries({ queryKey: ['payroll-dashboard'] });
  };

  const calculate = useMutation({
    mutationFn: () => api.post<PayrollCalculationResult>(`/payroll/runs/${id}/calculate`),
    onSuccess: async (result) => {
      toast.success(
        result.blocking > 0
          ? `Calculated. ${result.blocking} exception(s) must be resolved before approval.`
          : `Calculated ${result.lines} line(s).`,
      );
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const transition = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: unknown }) =>
      api.post(`/payroll/runs/${id}/${action}`, body),
    onSuccess: async () => {
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const handleFinalize = async () => {
    const ok = await confirm({
      title: 'Finalize this payroll?',
      description:
        'Payslips are issued and the period closes. Nothing here can be changed afterwards - a correction has to be a payroll adjustment.',
      confirmLabel: 'Finalize',
    });
    if (!ok) return;
    await transition.mutateAsync({ action: 'finalize' });
    toast.success('Payroll finalized. Payslips issued.');
  };

  if (run.isLoading) return <FullPageLoader />;
  if (run.isError) {
    return (
      <Card>
        <ErrorState error={run.error} onRetry={() => void run.refetch()} />
      </Card>
    );
  }

  const data = run.data!;
  const finalized = data.status === 'FINALIZED';
  const cancelled = data.status === 'CANCELLED';
  const blocking = (exceptions.data ?? []).filter((e) => e.severity === 'BLOCKING');
  const warnings = (exceptions.data ?? []).filter((e) => e.severity === 'WARNING');

  const term = search.trim().toLowerCase();
  const rows = (lines.data?.data ?? []).filter(
    (line) =>
      term === '' ||
      line.employeeName.toLowerCase().includes(term) ||
      line.employeeNumber.toLowerCase().includes(term) ||
      (line.departmentName ?? '').toLowerCase().includes(term),
  );

  return (
    <>
      <PageHeader
        title={data.periodName}
        description={`${formatDate(data.periodStart)} – ${formatDate(data.periodEnd)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={data.status} />
            <Button variant="ghost" size="sm" asChild>
              <Link to="/payroll/runs">
                <ArrowLeft />
                All runs
              </Link>
            </Button>

            {!finalized && !cancelled ? (
              <Can permission={PERMISSIONS.PAYROLL_MANAGE}>
                {data.status === 'APPROVED' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={transition.isPending}
                    onClick={() => transition.mutate({ action: 'review' })}
                  >
                    Send back
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={calculate.isPending}
                    onClick={() => calculate.mutate()}
                  >
                    <Calculator />
                    Calculate
                  </Button>
                )}
              </Can>
            ) : null}

            {!finalized && !cancelled ? (
              <Can permission={PERMISSIONS.PAYROLL_APPROVE}>
                {data.status === 'REVIEW' ? (
                  <Button
                    size="sm"
                    disabled={blocking.length > 0}
                    title={
                      blocking.length > 0
                        ? 'Resolve the blocking exceptions first'
                        : 'Approve this payroll'
                    }
                    loading={transition.isPending}
                    onClick={async () => {
                      await transition.mutateAsync({ action: 'approve' });
                      toast.success('Payroll approved.');
                    }}
                  >
                    Approve
                  </Button>
                ) : null}
                {data.status === 'APPROVED' ? (
                  <Button size="sm" loading={transition.isPending} onClick={() => void handleFinalize()}>
                    Finalize
                  </Button>
                ) : null}
              </Can>
            ) : null}
          </div>
        }
      />

      {finalized ? (
        <div className="mb-4">
          <FinalizedNotice>
            Finalized on {formatDate(data.finalizedAt)}. Payslips have been issued; corrections are
            made with a payroll adjustment.
          </FinalizedNotice>
        </div>
      ) : null}

      {cancelled ? (
        <Card className="mb-4 border-destructive/30 bg-destructive-soft/40 p-3 text-[13px]">
          <span className="font-medium text-destructive">Cancelled</span>{' '}
          <span className="text-muted-foreground">{data.cancelReason ?? 'No reason recorded.'}</span>
        </Card>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile label="Employees" value={String(data.employeeCount)} />
        <SummaryTile label="Gross" value={money(data.grossTotal, data.currency)} />
        <SummaryTile label="Deductions" value={money(data.deductionTotal, data.currency)} />
        <SummaryTile label="Net" value={money(data.netTotal, data.currency)} emphasis />
      </div>

      {exceptions.data && exceptions.data.length > 0 ? (
        <Card className="mb-4 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <AlertTriangle
              className={blocking.length > 0 ? 'size-4 text-destructive' : 'size-4 text-warning-foreground'}
            />
            <h2 className="text-[13.5px] font-semibold">Payroll exceptions</h2>
            {blocking.length > 0 ? (
              <Badge variant="destructive">{blocking.length} blocking</Badge>
            ) : null}
            {warnings.length > 0 ? <Badge variant="warning">{warnings.length} warning</Badge> : null}
          </div>
          <ul className="divide-y divide-border">
            {[...blocking, ...warnings].map((exception) => (
              <li key={exception.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <Badge variant={exception.severity === 'BLOCKING' ? 'destructive' : 'warning'}>
                  {PAYROLL_EXCEPTION_LABELS[exception.code]}
                </Badge>
                <p className="min-w-0 flex-1 text-[13px]">{exception.message}</p>
                {exception.employeeId ? (
                  <Button variant="ghost" size="sm" asChild>
                    <Link to={`/people/${exception.employeeId}`}>Open employee</Link>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-[13.5px] font-semibold">Employee payroll</h2>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employee or department"
            className="w-full sm:w-64"
            aria-label="Search this run"
          />
        </div>

        {lines.isError ? (
          <ErrorState error={lines.error} onRetry={() => void lines.refetch()} />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH className="min-w-44">Employee</TH>
                    <TH className="w-36">Department</TH>
                    <TH className="w-32 text-right">Basic</TH>
                    <TH className="w-32 text-right">Allowances</TH>
                    <TH className="w-28 text-right">Overtime</TH>
                    <TH className="w-32 text-right">Gross</TH>
                    <TH className="w-32 text-right">Deductions</TH>
                    <TH className="w-32 text-right">Net</TH>
                    <TH className="w-20 text-right">Present</TH>
                    <TH className="w-20 text-right">Absent</TH>
                    <TH className="w-24 text-right">Unpaid</TH>
                    <TH className="w-24 text-right">OT hours</TH>
                  </TR>
                </THead>
                <TBody>
                  {lines.isLoading ? (
                    <TableSkeleton rows={6} columns={12} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={12} className="p-0">
                        <EmptyState
                          icon={Users}
                          title={
                            data.status === 'DRAFT'
                              ? 'Not calculated yet'
                              : term
                                ? 'No employee matches that search'
                                : 'No lines in this run'
                          }
                          description={
                            data.status === 'DRAFT'
                              ? 'Calculate the run to see what each employee is owed.'
                              : 'Employees with a blocking exception do not produce a line until it is resolved.'
                          }
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((line) => {
                      const allowances =
                        line.earnings
                          .filter((e) => e.kind !== 'BASIC' && e.kind !== 'OVERTIME')
                          .reduce((sum, e) => sum + e.amount, 0) ?? 0;
                      return (
                        <TR
                          key={line.id}
                          className="cursor-pointer"
                          onClick={() => setOpenLineId(line.id)}
                        >
                          <TD className="text-[13px]">
                            <span className="font-medium">{line.employeeName}</span>
                            <span className="tabular block text-[12px] text-muted-foreground">
                              {line.employeeNumber}
                            </span>
                          </TD>
                          <TD className="text-[12.5px] text-muted-foreground">
                            {line.departmentName ?? '--'}
                          </TD>
                          <TD className="tabular text-right text-[13px]">
                            {money(line.basicAmount, line.currency)}
                          </TD>
                          <TD className="tabular text-right text-[13px]">
                            {money(allowances, line.currency)}
                          </TD>
                          <TD className="tabular text-right text-[13px]">
                            {money(line.overtimeAmount, line.currency)}
                          </TD>
                          <TD className="tabular text-right text-[13px]">
                            {money(line.grossAmount, line.currency)}
                          </TD>
                          <TD className="tabular text-right text-[13px]">
                            {money(line.deductionsTotal, line.currency)}
                          </TD>
                          <TD className="tabular text-right text-[13px] font-semibold">
                            {money(line.netAmount, line.currency)}
                          </TD>
                          <TD className="tabular text-right text-[13px]">
                            {days(line.presentDays)}
                          </TD>
                          <TD className="tabular text-right text-[13px]">
                            {days(line.absentDays)}
                          </TD>
                          <TD className="tabular text-right text-[13px]">
                            {days(line.unpaidLeaveDays)}
                          </TD>
                          <TD className="tabular text-right text-[13px]">
                            {hoursFromMinutes(line.approvedOvertimeMinutes)}
                          </TD>
                        </TR>
                      );
                    })
                  )}
                </TBody>
              </Table>
            </TableWrapper>

            {lines.data ? (
              <Pagination
                meta={lines.data.meta}
                disabled={lines.isFetching}
                onPageChange={setPage}
              />
            ) : null}
          </>
        )}
      </Card>

      {openLineId ? (
        <PayrollLineDrawer lineId={openLineId} onClose={() => setOpenLineId(null)} />
      ) : null}
    </>
  );
}

function SummaryTile({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <Card className="p-4">
      <p className="text-[12.5px] font-medium text-muted-foreground">{label}</p>
      <p
        className={
          emphasis
            ? 'tabular mt-1 text-xl font-semibold tracking-tight'
            : 'tabular mt-1 text-lg font-semibold tracking-tight'
        }
      >
        {value}
      </p>
    </Card>
  );
}
