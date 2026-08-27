import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { CalendarDays, CalendarPlus, Plane } from 'lucide-react';
import {
  APPROVAL_STATUS_LABELS,
  LEAVE_DAY_PARTS,
  LEAVE_DAY_PART_LABELS,
  PERMISSIONS,
  type ApprovalStatus,
  type LeaveBalanceRecord,
  type LeaveRequestCreateInput,
  type LeaveRequestRecord,
  type LeaveTypeRecord,
  leaveRequestCreateSchema,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
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
import { cn } from '@/lib/utils';

export const LEAVE_STATUS_TONE: Record<
  ApprovalStatus,
  'warning' | 'success' | 'destructive' | 'neutral'
> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'destructive',
  CANCELLED: 'neutral',
};

const days = (n: number) => `${n % 1 === 0 ? n : n.toFixed(1)}`;

export function MyLeavePage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [requesting, setRequesting] = React.useState(false);

  const balances = useQuery({
    queryKey: ['leave', 'balances', 'me'],
    queryFn: () => api.get<LeaveBalanceRecord[]>('/leave/balances/me'),
  });

  const requests = useQuery({
    queryKey: ['leave', 'requests', 'mine'],
    queryFn: () =>
      api.getPage<LeaveRequestRecord>('/leave/requests', { query: { view: 'mine', limit: 50 } }),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/leave/requests/${id}/cancel`, {}),
    onSuccess: async () => {
      toast.success('Leave request cancelled.');
      await queryClient.invalidateQueries({ queryKey: ['leave'] });
      await queryClient.invalidateQueries({ queryKey: ['approvals'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const handleCancel = async (row: LeaveRequestRecord) => {
    const ok = await confirm({
      title: 'Cancel this leave request?',
      description: 'It is withdrawn from approval and the days return to your balance.',
      confirmLabel: 'Cancel request',
      tone: 'destructive',
    });
    if (ok) cancel.mutate(row.id);
  };

  const rows = requests.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="My leave"
        description="Your balances and every request you have raised."
        actions={
          <Can permission={PERMISSIONS.LEAVE_REQUEST}>
            <Button size="sm" onClick={() => setRequesting(true)}>
              <CalendarPlus />
              Request leave
            </Button>
          </Can>
        }
      />

      {/* Balances */}
      {balances.isLoading ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-8 w-16" />
            </Card>
          ))}
        </div>
      ) : balances.isError ? (
        <Card className="mb-6">
          <ErrorState error={balances.error} onRetry={() => void balances.refetch()} />
        </Card>
      ) : (balances.data ?? []).length === 0 ? (
        <Card className="mb-6">
          <EmptyState
            icon={Plane}
            title="No leave types configured"
            description="An administrator needs to set up leave types before leave can be requested."
          />
        </Card>
      ) : (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {(balances.data ?? []).map((b) => (
            <Card key={b.leaveTypeId} className="p-5">
              <div className="flex items-start justify-between gap-2">
                <p className="truncate text-[13px] font-medium text-muted-foreground">
                  {b.leaveTypeName}
                </p>
                {!b.isPaid ? <Badge variant="neutral">Unpaid</Badge> : null}
              </div>
              <p className="tabular mt-1 text-3xl font-semibold leading-none tracking-tight">
                {days(b.availableDays)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">days available</p>

              <dl className="tabular mt-3 space-y-1 border-t border-border pt-3 text-[12px]">
                <Row label="Opening (carried)" value={days(b.openingDays)} />
                <Row label="Accrued" value={days(b.accruedDays)} />
                {b.adjustmentDays !== 0 ? (
                  <Row label="Adjustment" value={days(b.adjustmentDays)} />
                ) : null}
                <Row label="Used" value={days(b.usedDays)} />
                <Row label="Pending" value={days(b.pendingDays)} />
                <Row label="Entitlement" value={`${days(b.annualEntitlementDays)}/yr`} muted />
              </dl>
            </Card>
          ))}
        </div>
      )}

      {/* Requests */}
      <Card className="overflow-hidden">
        <CardHeader bordered>
          <CardTitle>My requests</CardTitle>
        </CardHeader>

        {requests.isError ? (
          <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />
        ) : (
          <TableWrapper>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Type</TH>
                  <TH className="w-56">Dates</TH>
                  <TH className="w-24 text-right">Days</TH>
                  <TH>Reason</TH>
                  <TH className="w-28">Status</TH>
                  <TH className="w-28 text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {requests.isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <TR key={i} className="hover:bg-transparent">
                      {Array.from({ length: 6 }).map((__, j) => (
                        <TD key={j}>
                          <Skeleton className="h-4 w-3/4" />
                        </TD>
                      ))}
                    </TR>
                  ))
                ) : rows.length === 0 ? (
                  <TR className="hover:bg-transparent">
                    <TD colSpan={6} className="p-0">
                      <EmptyState
                        icon={CalendarDays}
                        title="No leave requested yet"
                        description="Requests you raise appear here with their approval status."
                      />
                    </TD>
                  </TR>
                ) : (
                  rows.map((row) => (
                    <TR key={row.id}>
                      <TD className="text-[13px]">
                        {row.leaveTypeName}
                        {row.dayPart !== 'FULL_DAY' ? (
                          <span className="block text-[12px] text-muted-foreground">
                            {LEAVE_DAY_PART_LABELS[row.dayPart]}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="tabular text-[13px]">
                        {formatDate(row.startDate)}
                        {row.startDate !== row.endDate ? ` – ${formatDate(row.endDate)}` : ''}
                      </TD>
                      <TD className="tabular text-right text-[13px] font-medium">
                        {days(row.totalDays)}
                      </TD>
                      <TD className="max-w-xs truncate text-[13px] text-muted-foreground">
                        {row.reason}
                      </TD>
                      <TD>
                        <Badge variant={LEAVE_STATUS_TONE[row.status]}>
                          {APPROVAL_STATUS_LABELS[row.status]}
                        </Badge>
                      </TD>
                      <TD>
                        <div className="flex justify-end">
                          {row.canCancel ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={cancel.isPending}
                              onClick={() => void handleCancel(row)}
                            >
                              Cancel
                            </Button>
                          ) : null}
                        </div>
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </TableWrapper>
        )}
      </Card>

      <LeaveRequestDrawer open={requesting} onClose={() => setRequesting(false)} />
    </>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-2', muted && 'text-muted-foreground')}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function LeaveRequestDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();

  const types = useQuery({
    queryKey: ['leave-types', 'active'],
    queryFn: () =>
      api.getPage<LeaveTypeRecord>('/leave-types', { query: { isActive: 'true', limit: 100 } }),
    enabled: open,
  });

  const balances = useQuery({
    queryKey: ['leave', 'balances', 'me'],
    queryFn: () => api.get<LeaveBalanceRecord[]>('/leave/balances/me'),
    enabled: open,
  });

  const today = new Date().toISOString().slice(0, 10);

  const { register, handleSubmit, formState, reset, setError, watch } =
    useForm<LeaveRequestCreateInput>({
      resolver: zodResolver(leaveRequestCreateSchema),
      values: {
        leaveTypeId: '',
        startDate: today,
        endDate: today,
        dayPart: 'FULL_DAY',
        reason: '',
      },
    });

  const selectedType = watch('leaveTypeId');
  const start = watch('startDate');
  const end = watch('endDate');
  const balance = (balances.data ?? []).find((b) => b.leaveTypeId === selectedType);

  const mutation = useMutation({
    mutationFn: (values: LeaveRequestCreateInput) =>
      api.post<{ id: string; totalDays: number }>('/leave/requests', values),
    onSuccess: async (result) => {
      toast.success(
        `Leave requested: ${result.totalDays} day(s). Your manager has been notified.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['leave'] });
      await queryClient.invalidateQueries({ queryKey: ['approvals'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      reset();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof LeaveRequestCreateInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="md">
        <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="contents">
          <DialogHeader>
            <DialogTitle>Request leave</DialogTitle>
            <DialogDescription>
              Weekends and holidays for your location are excluded automatically.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <FormField
              label="Leave type"
              htmlFor="lr-type"
              error={formState.errors.leaveTypeId?.message}
              required
              hint={
                balance
                  ? `${days(balance.availableDays)} day(s) available, counting leave awaiting approval.`
                  : undefined
              }
            >
              <NativeSelect {...register('leaveTypeId')} autoFocus>
                <option value="">Choose a leave type</option>
                {(types.data?.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.isPaid ? '' : ' (unpaid)'}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="From" htmlFor="lr-start" error={formState.errors.startDate?.message} required>
                <Input type="date" {...register('startDate')} />
              </FormField>
              <FormField label="To" htmlFor="lr-end" error={formState.errors.endDate?.message} required>
                <Input type="date" {...register('endDate')} />
              </FormField>
            </div>

            <FormField
              label="Duration"
              htmlFor="lr-daypart"
              error={formState.errors.dayPart?.message}
              hint={start !== end ? 'Half days apply to a single date only.' : undefined}
            >
              <NativeSelect {...register('dayPart')} disabled={start !== end}>
                {LEAVE_DAY_PARTS.map((p) => (
                  <option key={p} value={p}>
                    {LEAVE_DAY_PART_LABELS[p]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField label="Reason" htmlFor="lr-reason" error={formState.errors.reason?.message} required>
              <Textarea rows={4} {...register('reason')} />
            </FormField>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Submit request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
