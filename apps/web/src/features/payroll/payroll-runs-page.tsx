import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Calculator, CalendarPlus, Plus, Receipt } from 'lucide-react';
import {
  PERMISSIONS,
  payrollPeriodSchema,
  payrollRunSchema,
  type PayrollCalculationResult,
  type PayrollPeriodInput,
  type PayrollPeriodRecord,
  type PayrollRunInput,
  type PayrollRunRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { Pagination } from '@/components/ui/pagination';
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
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { Can } from '@/features/auth/session-context';
import { RunStatusBadge, money } from './payroll-shared';

/**
 * Pay runs.
 *
 * The action buttons are driven by the run's status rather than shown and
 * disabled, because a workflow with six states and every button always visible
 * is harder to read than one that offers the two things that are actually
 * possible. The server enforces the same transitions regardless - hiding a
 * button is a courtesy, not a control.
 */

const INITIAL = { page: 1, limit: 20 };

export function PayrollRunsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [filters, setFilters] = React.useState(INITIAL);
  const [creatingRun, setCreatingRun] = React.useState(false);
  const [creatingPeriod, setCreatingPeriod] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const runs = useQuery({
    queryKey: ['payroll-runs', filters],
    queryFn: () =>
      api.getPage<PayrollRunRecord>('/payroll/runs', {
        query: { page: filters.page, limit: filters.limit },
      }),
    placeholderData: keepPreviousData,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['payroll-runs'] });
    await queryClient.invalidateQueries({ queryKey: ['payroll-dashboard'] });
    await queryClient.invalidateQueries({ queryKey: ['payroll-periods'] });
  };

  const calculate = useMutation({
    mutationFn: (id: string) =>
      api.post<PayrollCalculationResult>(`/payroll/runs/${id}/calculate`),
    onSuccess: async (result) => {
      toast.success(
        result.blocking > 0
          ? `Calculated ${result.lines} line(s), but ${result.blocking} exception(s) must be resolved before this can be approved.`
          : `Calculated ${result.lines} line(s)${result.exceptions > 0 ? ` with ${result.exceptions} warning(s)` : ''}.`,
      );
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
    onSettled: () => setBusyId(null),
  });

  const transition = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) =>
      api.post(`/payroll/runs/${id}/${action}`, body),
    onSuccess: async (_result, variables) => {
      const said: Record<string, string> = {
        approve: 'Payroll approved.',
        review: 'Sent back for review.',
        finalize: 'Payroll finalized. Payslips have been issued.',
        cancel: 'Payroll run cancelled.',
      };
      toast.success(said[variables.action] ?? 'Done.');
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
    onSettled: () => setBusyId(null),
  });

  const act = (id: string, action: string, body?: unknown) => {
    setBusyId(id);
    transition.mutate({ id, action, body });
  };

  const handleFinalize = async (run: PayrollRunRecord) => {
    const ok = await confirm({
      title: `Finalize ${run.periodName}?`,
      description:
        'This issues payslips and closes the period. The figures can no longer be changed - a correction after this has to be a payroll adjustment.',
      confirmLabel: 'Finalize',
    });
    if (ok) act(run.id, 'finalize');
  };

  const handleCancel = async (run: PayrollRunRecord) => {
    const ok = await confirm({
      title: `Cancel ${run.periodName}?`,
      description: 'The run is closed without paying anything. A new run can be created after.',
      confirmLabel: 'Cancel run',
      tone: 'destructive',
    });
    if (ok) act(run.id, 'cancel', { reason: 'Cancelled from the pay runs screen' });
  };

  const rows = runs.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Pay runs"
        description="Create, calculate, review and finalize payroll for a period."
        actions={
          <Can permission={PERMISSIONS.PAYROLL_MANAGE}>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setCreatingPeriod(true)}>
                <CalendarPlus />
                New period
              </Button>
              <Button size="sm" onClick={() => setCreatingRun(true)}>
                <Plus />
                New pay run
              </Button>
            </div>
          </Can>
        }
      />

      <Card className="overflow-hidden">
        {runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Pay period</TH>
                    <TH className="w-24 text-right">Employees</TH>
                    <TH className="w-36 text-right">Gross</TH>
                    <TH className="w-36 text-right">Deductions</TH>
                    <TH className="w-36 text-right">Net</TH>
                    <TH className="w-32">Created</TH>
                    <TH className="w-32">Status</TH>
                    <TH className="w-64 text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {runs.isLoading ? (
                    <TableSkeleton rows={5} columns={8} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={8} className="p-0">
                        <EmptyState
                          icon={Receipt}
                          title="No pay runs yet"
                          description="Create a pay period, then a run against it."
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((run) => (
                      <TR key={run.id}>
                        <TD className="text-[13px]">
                          <Link className="font-medium hover:underline" to={`/payroll/runs/${run.id}`}>
                            {run.periodName}
                          </Link>
                          <span className="tabular block text-[12px] text-muted-foreground">
                            {formatDate(run.periodStart)} – {formatDate(run.periodEnd)}
                          </span>
                        </TD>
                        <TD className="tabular text-right text-[13px]">{run.employeeCount}</TD>
                        <TD className="tabular text-right text-[13px]">
                          {money(run.grossTotal, run.currency)}
                        </TD>
                        <TD className="tabular text-right text-[13px]">
                          {money(run.deductionTotal, run.currency)}
                        </TD>
                        <TD className="tabular text-right text-[13px] font-medium">
                          {money(run.netTotal, run.currency)}
                        </TD>
                        <TD className="tabular text-[12.5px] text-muted-foreground">
                          {formatDate(run.createdAt)}
                        </TD>
                        <TD>
                          <RunStatusBadge status={run.status} />
                          {run.blockingCount > 0 ? (
                            <span className="mt-1 block text-[11px] text-destructive">
                              {run.blockingCount} blocking
                            </span>
                          ) : null}
                        </TD>
                        <TD>
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button variant="ghost" size="sm" asChild>
                              <Link to={`/payroll/runs/${run.id}`}>Review</Link>
                            </Button>

                            <Can permission={PERMISSIONS.PAYROLL_MANAGE}>
                              {run.status === 'DRAFT' ||
                              run.status === 'REVIEW' ||
                              run.status === 'CALCULATING' ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  loading={calculate.isPending && busyId === run.id}
                                  onClick={() => {
                                    setBusyId(run.id);
                                    calculate.mutate(run.id);
                                  }}
                                >
                                  <Calculator />
                                  Calculate
                                </Button>
                              ) : null}
                              {run.status === 'APPROVED' ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  loading={transition.isPending && busyId === run.id}
                                  onClick={() => act(run.id, 'review')}
                                >
                                  Send back
                                </Button>
                              ) : null}
                              {run.status !== 'FINALIZED' && run.status !== 'CANCELLED' ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => void handleCancel(run)}
                                >
                                  Cancel
                                </Button>
                              ) : null}
                            </Can>

                            <Can permission={PERMISSIONS.PAYROLL_APPROVE}>
                              {run.status === 'REVIEW' ? (
                                <Button
                                  size="sm"
                                  disabled={run.blockingCount > 0}
                                  title={
                                    run.blockingCount > 0
                                      ? 'Resolve the blocking exceptions first'
                                      : 'Approve this payroll'
                                  }
                                  loading={transition.isPending && busyId === run.id}
                                  onClick={() => act(run.id, 'approve')}
                                >
                                  Approve
                                </Button>
                              ) : null}
                              {run.status === 'APPROVED' ? (
                                <Button
                                  size="sm"
                                  loading={transition.isPending && busyId === run.id}
                                  onClick={() => void handleFinalize(run)}
                                >
                                  Finalize
                                </Button>
                              ) : null}
                            </Can>
                          </div>
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>

            {runs.data ? (
              <Pagination
                meta={runs.data.meta}
                disabled={runs.isFetching}
                onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
              />
            ) : null}
          </>
        )}
      </Card>

      {creatingPeriod ? (
        <PeriodDialog
          open
          onClose={() => setCreatingPeriod(false)}
          onSaved={async () => {
            await refresh();
          }}
        />
      ) : null}

      {creatingRun ? (
        <RunDialog
          open
          onClose={() => setCreatingRun(false)}
          onSaved={async (id) => {
            await refresh();
            navigate(`/payroll/runs/${id}`);
          }}
        />
      ) : null}
    </>
  );
}

/** Creates a pay period. Dates are the ones the calculation actually reads. */
function PeriodDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const today = new Date();
  const firstOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const lastOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const { register, handleSubmit, formState, setError } = useForm<PayrollPeriodInput>({
    resolver: zodResolver(payrollPeriodSchema),
    defaultValues: {
      name: firstOfMonth.toLocaleString(undefined, { month: 'long', year: 'numeric' }),
      startDate: iso(firstOfMonth),
      endDate: iso(lastOfMonth),
      payDate: '',
    },
  });

  const mutation = useMutation({
    mutationFn: (values: PayrollPeriodInput) =>
      api.post<{ id: string }>('/payroll/periods', {
        ...values,
        payDate: values.payDate || null,
      }),
    onSuccess: async () => {
      toast.success('Pay period created.');
      await onSaved();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof PayrollPeriodInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="sm">
        <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="contents">
          <DialogHeader>
            <DialogTitle>New pay period</DialogTitle>
            <DialogDescription>
              The dates the calculation reads. Attendance is counted between them, inclusive.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Name"
              htmlFor="period-name"
              error={formState.errors.name?.message}
              required
              className="sm:col-span-2"
            >
              <Input {...register('name')} autoFocus placeholder="September 2025" />
            </FormField>
            <FormField
              label="Starts"
              htmlFor="period-start"
              error={formState.errors.startDate?.message}
              required
            >
              <Input type="date" {...register('startDate')} className="tabular" />
            </FormField>
            <FormField
              label="Ends"
              htmlFor="period-end"
              error={formState.errors.endDate?.message}
              required
            >
              <Input type="date" {...register('endDate')} className="tabular" />
            </FormField>
            <FormField
              label="Payment date"
              htmlFor="period-pay"
              error={formState.errors.payDate?.message}
              hint="Shown on the payslip. Nothing calculates from it."
              className="sm:col-span-2"
            >
              <Input type="date" {...register('payDate')} className="tabular" />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Create period
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Creates a run against an open period. */
function RunDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const periods = useQuery({
    queryKey: ['payroll-periods', { limit: 50 }],
    queryFn: () => api.getPage<PayrollPeriodRecord>('/payroll/periods', { query: { limit: 50 } }),
  });

  const { register, handleSubmit, formState, setError } = useForm<PayrollRunInput>({
    resolver: zodResolver(payrollRunSchema),
    defaultValues: { periodId: '', notes: '' },
  });

  const mutation = useMutation({
    mutationFn: (values: PayrollRunInput) =>
      api.post<{ id: string }>('/payroll/runs', { ...values, notes: values.notes || null }),
    onSuccess: async (result) => {
      toast.success('Pay run created. Calculate it when you are ready.');
      await onSaved(result.id);
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof PayrollRunInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  const open_ = periods.data?.data.filter((p) => p.status === 'OPEN') ?? [];

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="sm">
        <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="contents">
          <DialogHeader>
            <DialogTitle>New pay run</DialogTitle>
            <DialogDescription>
              A period that has already been paid is closed and will not appear here.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <FormField
              label="Pay period"
              htmlFor="run-period"
              error={formState.errors.periodId?.message}
              required
            >
              <NativeSelect {...register('periodId')} autoFocus>
                <option value="">Choose a period</option>
                {open_.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            {open_.length === 0 && !periods.isLoading ? (
              <p className="text-[13px] text-muted-foreground">
                No open periods. Create one first.
              </p>
            ) : null}
            <FormField label="Notes" htmlFor="run-notes" error={formState.errors.notes?.message}>
              <Textarea {...register('notes')} rows={3} placeholder="Optional" />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending} disabled={open_.length === 0}>
              Create run
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
