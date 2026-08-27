import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { FileClock, Plus, Send } from 'lucide-react';
import {
  PERMISSIONS,
  TIMESHEET_STATUSES,
  TIMESHEET_STATUS_LABELS,
  type TimesheetCreateInput,
  type TimesheetRecord,
  type TimesheetStatus,
  timesheetCreateSchema,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
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

const STATUS_TONE: Record<TimesheetStatus, 'neutral' | 'warning' | 'success' | 'destructive'> = {
  DRAFT: 'neutral',
  SUBMITTED: 'warning',
  APPROVED: 'success',
  REJECTED: 'destructive',
};

const INITIAL = { q: '', status: '', page: 1, limit: 20 };

const hours = (minutes: number) => `${(minutes / 60).toFixed(1)}h`;

export function TimesheetsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [filters, setFilters] = React.useState(INITIAL);
  const [creating, setCreating] = React.useState(false);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['timesheets', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<TimesheetRecord>('/timesheets', {
        query: {
          page: filters.page,
          limit: filters.limit,
          q: debouncedQuery || undefined,
          status: filters.status || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const submit = useMutation({
    mutationFn: (id: string) => api.post(`/timesheets/${id}/submit`),
    onSuccess: async () => {
      toast.success('Timesheet submitted for approval.');
      await queryClient.invalidateQueries({ queryKey: ['timesheets'] });
      await queryClient.invalidateQueries({ queryKey: ['approvals'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const handleSubmitSheet = async (row: TimesheetRecord) => {
    const ok = await confirm({
      title: 'Submit this timesheet?',
      description: 'It goes to your reporting manager for approval and can no longer be edited.',
      confirmLabel: 'Submit',
    });
    if (ok) submit.mutate(row.id);
  };

  const rows = query.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Timesheets"
        description="Recorded hours per period. Submitting sends the timesheet through approval."
        actions={
          <Can permission={PERMISSIONS.TIMESHEET_MANAGE}>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              New timesheet
            </Button>
          </Can>
        }
      />

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search employee or notes"
          hasActiveFilters={filters.q !== '' || filters.status !== ''}
          onReset={() => setFilters(INITIAL)}
          filters={
            <NativeSelect
              value={filters.status}
              onChange={(e) => update({ status: e.target.value })}
              aria-label="Filter by status"
              className="w-36"
            >
              <option value="">All statuses</option>
              {TIMESHEET_STATUSES.map((s) => (
                <option key={s} value={s}>{TIMESHEET_STATUS_LABELS[s]}</option>
              ))}
            </NativeSelect>
          }
        />

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Employee</TH>
                    <TH className="w-56">Period</TH>
                    <TH className="w-28 text-right">Entries</TH>
                    <TH className="w-28 text-right">Total</TH>
                    <TH className="w-32">Status</TH>
                    <TH className="w-40 text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={5} columns={6} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={6} className="p-0">
                        <EmptyState
                          icon={FileClock}
                          title="No timesheets yet"
                          description="Create a timesheet for a period, then submit it for approval."
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR key={row.id}>
                        <TD className="text-[13px]">{row.employeeName}</TD>
                        <TD className="tabular text-[13px]">
                          {formatDate(row.periodStart)} – {formatDate(row.periodEnd)}
                        </TD>
                        <TD className="tabular text-right text-[13px]">{row.entries.length}</TD>
                        <TD className="tabular text-right text-[13px] font-medium">
                          {hours(row.totalMinutes)}
                        </TD>
                        <TD>
                          <Badge variant={STATUS_TONE[row.status]}>
                            {TIMESHEET_STATUS_LABELS[row.status]}
                          </Badge>
                        </TD>
                        <TD>
                          <div className="flex justify-end gap-1">
                            {row.status === 'DRAFT' ? (
                              <Button
                                variant="outline"
                                size="sm"
                                loading={submit.isPending}
                                onClick={() => void handleSubmitSheet(row)}
                              >
                                <Send />
                                Submit
                              </Button>
                            ) : row.approvalRequestId ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => navigate(`/approvals/${row.approvalRequestId}`)}
                              >
                                View approval
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

            {query.data ? (
              <Pagination
                meta={query.data.meta}
                disabled={query.isFetching}
                onPageChange={(page) => update({ page })}
                onLimitChange={(limit) => update({ limit })}
              />
            ) : null}
          </>
        )}
      </Card>

      <TimesheetDrawer open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

/**
 * Turns a period total into one entry per day.
 *
 * A single entry carrying the whole total would break the per-entry limit of
 * 1440 minutes as soon as the week exceeds 24 hours, which is essentially
 * always. Spreading it also produces data the real timesheet module can refine
 * day by day rather than having to unpick one lump sum.
 */
function spreadOverPeriod(
  values: TimesheetCreateInput,
  totalHours: string,
): Array<{ date: string; minutes: number; description: string }> {
  const start = new Date(values.periodStart);
  const end = new Date(values.periodEnd);

  const days: string[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  if (days.length === 0) days.push(values.periodStart);

  const totalMinutes = Math.max(0, Math.round(Number(totalHours || '0') * 60));
  const perDay = Math.floor(totalMinutes / days.length);
  // Give the remainder to the first day so the entries sum to the total exactly.
  const remainder = totalMinutes - perDay * days.length;

  return days.map((date, index) => ({
    date,
    minutes: Math.min(1440, perDay + (index === 0 ? remainder : 0)),
    description: 'Recorded hours',
  }));
}

function TimesheetDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();

  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const { register, handleSubmit, formState, reset, setError } = useForm<TimesheetCreateInput>({
    resolver: zodResolver(timesheetCreateSchema),
    values: {
      periodStart: monday.toISOString().slice(0, 10),
      periodEnd: sunday.toISOString().slice(0, 10),
      notes: '',
      entries: [],
    },
  });

  // One total for the period keeps the foundation simple; day-by-day entry
  // arrives with the full timesheet module.
  const [totalHours, setTotalHours] = React.useState('40');

  const mutation = useMutation({
    mutationFn: (values: TimesheetCreateInput) =>
      api.post('/timesheets', { ...values, entries: spreadOverPeriod(values, totalHours) }),
    onSuccess: async () => {
      toast.success('Timesheet created as a draft.');
      await queryClient.invalidateQueries({ queryKey: ['timesheets'] });
      reset();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof TimesheetCreateInput, { message: messages[0] });
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
            <DialogTitle>New timesheet</DialogTitle>
            <DialogDescription>
              Created as a draft. Submit it separately when you are ready for approval.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <FormField label="Period start" htmlFor="ts-start" error={formState.errors.periodStart?.message} required>
              <Input type="date" {...register('periodStart')} autoFocus />
            </FormField>
            <FormField label="Period end" htmlFor="ts-end" error={formState.errors.periodEnd?.message} required>
              <Input type="date" {...register('periodEnd')} />
            </FormField>
            <FormField label="Total hours" htmlFor="ts-hours" hint="Day-by-day entry arrives with the full module.">
              <Input
                type="number"
                min={0}
                step="0.5"
                value={totalHours}
                onChange={(event) => setTotalHours(event.target.value)}
              />
            </FormField>
            <FormField label="Notes" htmlFor="ts-notes" error={formState.errors.notes?.message} className="sm:col-span-2">
              <Textarea rows={3} {...register('notes')} />
            </FormField>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Create draft
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
