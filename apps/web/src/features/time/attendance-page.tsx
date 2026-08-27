import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { CalendarClock, Plus } from 'lucide-react';
import {
  ATTENDANCE_STATUSES,
  ATTENDANCE_STATUS_LABELS,
  type AttendanceRecordItem,
  type AttendanceStatus,
  type RegularizationCreateInput,
  regularizationCreateSchema,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useDebounced } from '@/lib/use-debounced';
import { formatDate } from '@/lib/utils';
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
import { AttendanceToday } from './attendance-today';
import { AttendanceCalendar } from './attendance-calendar';


const STATUS_TONE: Record<AttendanceStatus, 'success' | 'destructive' | 'warning' | 'neutral'> = {
  PRESENT: 'success',
  ABSENT: 'destructive',
  ON_LEAVE: 'warning',
  WEEKEND: 'neutral',
  HOLIDAY: 'neutral',
};

const INITIAL = { q: '', employeeId: '', status: '', page: 1, limit: 20 };

const minutesLabel = (minutes: number | null) =>
  minutes === null ? '--' : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;

export function AttendancePage() {
  const { lookups } = useLookups();
  const [filters, setFilters] = React.useState(INITIAL);
  const [requesting, setRequesting] = React.useState(false);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['attendance', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<AttendanceRecordItem>('/attendance', {
        query: {
          page: filters.page,
          limit: filters.limit,
          q: debouncedQuery || undefined,
          employeeId: filters.employeeId || undefined,
          status: filters.status || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const hasFilters = filters.q !== '' || filters.employeeId !== '' || filters.status !== '';
  const rows = query.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Attendance"
        description="Check in and out, review your month, and request corrections through approval."
        actions={
          <Button size="sm" variant="outline" onClick={() => setRequesting(true)}>
            <Plus />
            Request correction
          </Button>
        }
      />

      <AttendanceToday />
      <AttendanceCalendar />

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search employee or notes"
          hasActiveFilters={hasFilters}
          onReset={() => setFilters(INITIAL)}
          filters={
            <>
              <NativeSelect
                value={filters.employeeId}
                onChange={(e) => update({ employeeId: e.target.value })}
                aria-label="Filter by employee"
                className="w-48"
              >
                <option value="">All employees</option>
                {lookups.managers.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </NativeSelect>
              <NativeSelect
                value={filters.status}
                onChange={(e) => update({ status: e.target.value })}
                aria-label="Filter by status"
                className="w-36"
              >
                <option value="">All statuses</option>
                {ATTENDANCE_STATUSES.map((s) => (
                  <option key={s} value={s}>{ATTENDANCE_STATUS_LABELS[s]}</option>
                ))}
              </NativeSelect>
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
                  <TR className="hover:bg-transparent">
                    <TH className="w-36">Date</TH>
                    <TH>Employee</TH>
                    <TH className="w-32">Check in</TH>
                    <TH className="w-32">Check out</TH>
                    <TH className="w-28 text-right">Worked</TH>
                    <TH className="w-28">Status</TH>
                    <TH className="w-24">Source</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={6} columns={7} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={7} className="p-0">
                        <EmptyState
                          icon={CalendarClock}
                          title={hasFilters ? 'No records match your filters' : 'No attendance recorded yet'}
                          description="Records appear here once attendance is captured. Check-in capture arrives with the full attendance module."
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR key={row.id}>
                        <TD className="tabular text-[13px]">{formatDate(row.date)}</TD>
                        <TD className="text-[13px]">{row.employeeName}</TD>
                        <TD className="tabular text-[13px] text-muted-foreground">
                          {row.checkInAt ? new Date(row.checkInAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '--'}
                        </TD>
                        <TD className="tabular text-[13px] text-muted-foreground">
                          {row.checkOutAt ? new Date(row.checkOutAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '--'}
                        </TD>
                        <TD className="tabular text-right text-[13px]">{minutesLabel(row.workedMinutes)}</TD>
                        <TD>
                          <Badge variant={STATUS_TONE[row.status]}>
                            {ATTENDANCE_STATUS_LABELS[row.status]}
                          </Badge>
                        </TD>
                        <TD className="text-[12px] text-muted-foreground">{row.source}</TD>
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

      <RegularizationDrawer open={requesting} onClose={() => setRequesting(false)} />
    </>
  );
}

function RegularizationDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();

  const { register, handleSubmit, formState, reset, setError } = useForm<RegularizationCreateInput>({
    resolver: zodResolver(regularizationCreateSchema),
    values: {
      attendanceDate: new Date().toISOString().slice(0, 10),
      requestedCheckInAt: '',
      requestedCheckOutAt: '',
      requestedStatus: null,
      reason: '',
    },
  });

  const mutation = useMutation({
    mutationFn: (values: RegularizationCreateInput) =>
      api.post('/attendance/regularizations', values),
    onSuccess: async () => {
      toast.success('Correction requested. Your manager has been notified.');
      await queryClient.invalidateQueries({ queryKey: ['approvals'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      reset();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof RegularizationCreateInput, { message: messages[0] });
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
            <DialogTitle>Request an attendance correction</DialogTitle>
            <DialogDescription>
              This is routed to your reporting manager for approval. Attendance history is never
              edited directly.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <FormField label="Date" htmlFor="reg-date" error={formState.errors.attendanceDate?.message} required>
              <Input type="date" {...register('attendanceDate')} autoFocus />
            </FormField>
            <FormField label="Correct status to" htmlFor="reg-status" error={formState.errors.requestedStatus?.message}>
              <NativeSelect {...register('requestedStatus')}>
                <option value="">No change</option>
                {ATTENDANCE_STATUSES.map((s) => (
                  <option key={s} value={s}>{ATTENDANCE_STATUS_LABELS[s]}</option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Reason" htmlFor="reg-reason" error={formState.errors.reason?.message} required>
              <Textarea rows={4} {...register('reason')} placeholder="Explain what should be corrected and why." />
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

