import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { BarChart3, CalendarClock, Plus, CircleAlert, TableIcon } from 'lucide-react';
import {
  ATTENDANCE_STATUSES,
  ATTENDANCE_STATUS_LABELS,
  type AttendanceRecordItem,
  type RegularizationCreateInput,
  regularizationCreateSchema,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useDebounced } from '@/lib/use-debounced';
import { formatDate } from '@/lib/utils';
import { useAuthenticatedSession } from '@/features/auth/session-context';
import { PageHeader } from '@/components/layout/page-header';
import { HelpLink } from '@/features/help/help-link';
import { Card } from '@/components/ui/card';
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
import { AttendanceAnalytics } from './attendance-analytics';
import { LATE_TEXT, STATUS_BADGE, minutesLabel, timeLabel } from './attendance-ui';

const INITIAL = { q: '', employeeId: '', status: '', page: 1, limit: 20 };

/**
 * Which view the page is showing.
 *
 * The table is the default and is untouched by the chart beside it: same query,
 * same columns, same pagination it has always had. The toggle only decides
 * which of the two is mounted, so nothing about the existing view depends on
 * the new one working.
 */
type View = 'chart' | 'table';

const VIEWS: Array<{ key: View; label: string; icon: typeof BarChart3 }> = [
  { key: 'chart', label: 'Bar chart', icon: BarChart3 },
  { key: 'table', label: 'Table', icon: TableIcon },
];

function ViewToggle({ view, onChange }: { view: View; onChange: (next: View) => void }) {
  return (
    <div
      className="inline-flex rounded-lg border border-border bg-surface p-0.5"
      role="group"
      aria-label="Attendance view"
    >
      {VIEWS.map((option) => (
        <button
          key={option.key}
          type="button"
          aria-pressed={view === option.key}
          onClick={() => onChange(option.key)}
          className={
            view === option.key
              ? 'inline-flex items-center gap-1.5 rounded-[6px] bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-foreground'
              : 'inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground'
          }
        >
          <option.icon className="size-4" aria-hidden />
          {option.label}
        </button>
      ))}
    </div>
  );
}

function AttendancePageInner() {
  const { lookups } = useLookups();
  const [view, setView] = React.useState<View>('chart');
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
          <>
            <ViewToggle view={view} onChange={setView} />
            <HelpLink slug="attendance" />
            <Button size="sm" variant="outline" onClick={() => setRequesting(true)}>
              <Plus />
              Request correction
            </Button>
          </>
        }
      />

      <AttendanceToday />

      {view === 'chart' ? (
        <AttendanceAnalytics />
      ) : (
        <>
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
                      <TH className="w-28 text-right">Overtime</TH>
                      <TH className="w-32">Late / early</TH>
                      <TH className="w-28">Status</TH>
                      <TH className="w-24">Source</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {query.isLoading ? (
                      <TableSkeleton rows={6} columns={9} />
                    ) : rows.length === 0 ? (
                      <TR className="hover:bg-transparent">
                        <TD colSpan={9} className="p-0">
                          <EmptyState
                            icon={CalendarClock}
                            title={hasFilters ? 'No records match your filters' : 'No attendance recorded yet'}
                            description="Check in above to record today. Days with no record are still shown in the calendar, classified as weekend, holiday, leave or absent."
                          />
                        </TD>
                      </TR>
                    ) : (
                      rows.map((row) => (
                        <TR key={row.id}>
                          <TD className="tabular text-[13px]">{formatDate(row.date)}</TD>
                          <TD className="text-[13px]">
                            {row.employeeName}
                            {row.shiftName ? (
                              <span className="ml-1.5 text-[11.5px] text-muted-foreground">
                                {row.shiftName}
                              </span>
                            ) : null}
                          </TD>
                          <TD className="tabular text-[13px] text-muted-foreground">
                            {timeLabel(row.checkInAt)}
                          </TD>
                          <TD className="tabular text-[13px] text-muted-foreground">
                            {timeLabel(row.checkOutAt)}
                          </TD>
                          <TD className="tabular text-right text-[13px]">{minutesLabel(row.workedMinutes)}</TD>
                          <TD className="tabular text-right text-[13px]">
                            {row.overtimeMinutes ? (
                              <span className="text-success">{minutesLabel(row.overtimeMinutes)}</span>
                            ) : (
                              <span className="text-muted-foreground">--</span>
                            )}
                          </TD>
                          <TD className="tabular text-[12.5px]">
                            {row.lateMinutes || row.earlyLeaveMinutes ? (
                              <span className={LATE_TEXT}>
                                {row.lateMinutes ? `${row.lateMinutes}m late` : ''}
                                {row.lateMinutes && row.earlyLeaveMinutes ? ' · ' : ''}
                                {row.earlyLeaveMinutes ? `${row.earlyLeaveMinutes}m early` : ''}
                              </span>
                            ) : (
                              // Nobody arrived, so there is nothing to be on time
                              // for. Saying "On time" about an absence is worse
                              // than saying nothing.
                              <span className="text-muted-foreground">
                                {row.checkInAt ? 'On time' : '--'}
                              </span>
                            )}
                          </TD>
                          <TD>
                            <span className={STATUS_BADGE[row.status]}>
                              {ATTENDANCE_STATUS_LABELS[row.status]}
                            </span>
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
        </>
      )}

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

/**
 * Gate in front of the page.
 *
 * A login with no employee record has no personal your attendance to show, and every
 * query on the page would 403. Checked out here rather than inside the page so
 * the page's own hooks are never conditionally skipped - an early return in the
 * middle of a component changes hook order between renders.
 */
export function AttendancePage() {
  const session = useAuthenticatedSession();

  if (!session.employeeLinked) {
    return (
      <>
        <PageHeader title="Attendance" />
        <Card>
          <EmptyState
            icon={CircleAlert}
            title="Employee profile not configured"
            description="Your login is not linked to an employee record, so your attendance is unavailable. Ask an administrator to link your account."
          />
        </Card>
      </>
    );
  }

  return <AttendancePageInner />;
}
