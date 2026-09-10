import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { CalendarClock, Plus, CircleAlert } from 'lucide-react';
import {
  ATTENDANCE_STATUSES,
  ATTENDANCE_STATUS_LABELS,
  DERIVED_ATTENDANCE_STATUS_LABELS,
  type AttendanceRecordItem,
  type AttendanceStatus,
  type DerivedAttendanceStatus,
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
import { AttendanceCalendarView, AttendanceChartView } from './attendance-analytics';
import {
  AttendanceControlBar,
  DEFAULT_ATTENDANCE_VIEW,
  NO_ATTENDANCE_FILTERS,
  analyticsParams,
  currentMonth,
  hasAnyFilter,
  isDerivedOnlyStatus,
  monthRange,
  type AttendanceFilters,
  type AttendanceView,
} from './attendance-view';
import { LATE_TEXT, STATUS_BADGE, minutesLabel, timeLabel } from './attendance-ui';

/**
 * The Attendance page.
 *
 * Three views over one question: a bar chart of the month, the same month as a
 * calendar, and the underlying records as a table. The view, the month and the
 * filters all live here rather than inside whichever view is mounted, which is
 * what makes switching a change of presentation and nothing else - the reader
 * keeps their September, their department and their status filter across all
 * three.
 *
 * The chart leads because it is the only one that answers "how did the month
 * go?" without being read row by row.
 */
function AttendancePageInner() {
  const { lookups } = useLookups();
  const [view, setView] = React.useState<AttendanceView>(DEFAULT_ATTENDANCE_VIEW);
  const [month, setMonth] = React.useState(currentMonth);
  const [filters, setFilters] = React.useState<AttendanceFilters>(NO_ATTENDANCE_FILTERS);
  const [selectedDate, setSelectedDate] = React.useState<string | null>(null);
  const [requesting, setRequesting] = React.useState(false);

  /**
   * Changing the month closes the open day.
   *
   * Otherwise the detail panel would keep showing the 9th of September while
   * the chart above it moved to October, which is the kind of mismatch nobody
   * notices until they have acted on it. The VIEW is deliberately left alone:
   * paging through months must not throw the reader back to a view they did
   * not choose.
   */
  const goToMonth = React.useCallback((next: Date) => {
    setMonth(next);
    setSelectedDate(null);
  }, []);

  const updateFilters = React.useCallback((patch: Partial<AttendanceFilters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      // A team belongs to a department. Changing the department strands the
      // team filter on a team that is no longer offered, which silently
      // narrows every view to nothing.
      if (patch.departmentId !== undefined && patch.departmentId !== prev.departmentId) {
        next.teamId = '';
      }
      return next;
    });
  }, []);

  const toggleDate = React.useCallback(
    (date: string) => setSelectedDate((prev) => (prev === date ? null : date)),
    [],
  );

  const params = React.useMemo(() => analyticsParams(month, filters), [month, filters]);

  /**
   * The CSV comes from the existing report endpoint, not a new one.
   *
   * `daily` is one row per employee per day over the same range with the same
   * filters, which is precisely the data behind these views - so the export is
   * the page's own numbers, unrolled, rather than a second query that might
   * answer differently.
   */
  const exportHref = React.useMemo(() => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, String(value));
    }
    return `/api/v1/attendance/reports/daily/export?${search.toString()}`;
  }, [params]);

  const singleEmployee = filters.employeeId !== '';
  const employeeName =
    lookups.managers.find((o) => o.id === filters.employeeId)?.label ?? null;

  const viewProps = {
    month,
    params,
    singleEmployee,
    employeeName,
    selectedDate,
    onSelectDate: toggleDate,
    onClearDate: () => setSelectedDate(null),
    onSelectEmployee: (employeeId: string) => updateFilters({ employeeId }),
  };

  return (
    <>
      <PageHeader
        title="Attendance"
        description="Check in and out, review your month, and request corrections through approval."
        actions={
          <>
            <HelpLink slug="attendance" />
            <Button size="sm" variant="outline" onClick={() => setRequesting(true)}>
              <Plus />
              Request correction
            </Button>
          </>
        }
      />

      <AttendanceControlBar
        view={view}
        onViewChange={setView}
        month={month}
        onMonthChange={goToMonth}
        filters={filters}
        onFiltersChange={updateFilters}
        onResetFilters={() => setFilters(NO_ATTENDANCE_FILTERS)}
        exportHref={exportHref}
      />

      <AttendanceToday />

      {view === 'chart' ? (
        <AttendanceChartView {...viewProps} />
      ) : view === 'calendar' ? (
        <AttendanceCalendarView {...viewProps} />
      ) : (
        <AttendanceTableView month={month} filters={filters} onFiltersChange={updateFilters} />
      )}

      <RegularizationDrawer open={requesting} onClose={() => setRequesting(false)} />
    </>
  );
}

/**
 * The records themselves, one row per stored attendance record.
 *
 * The same list it has always been, with two differences: it is scoped to the
 * month the page is showing, and it reads the page's filters instead of a
 * private set of its own. Its own state is only what the other views have no
 * use for - which page of results is showing, and how many rows fit on it.
 */
function AttendanceTableView({
  month,
  filters,
  onFiltersChange,
}: {
  month: Date;
  filters: AttendanceFilters;
  onFiltersChange: (patch: Partial<AttendanceFilters>) => void;
}) {
  const [page, setPage] = React.useState(1);
  const [limit, setLimit] = React.useState(20);
  const debouncedQuery = useDebounced(filters.q, 350);
  const { from, to } = monthRange(month);

  // Filters narrow the result set, so the page the reader was on may not exist
  // any more. Going back to the first one is the only answer that is never a
  // blank screen.
  const filterKey = `${from}|${filters.departmentId}|${filters.teamId}|${filters.employeeId}|${filters.status}|${debouncedQuery}`;
  React.useEffect(() => setPage(1), [filterKey]);

  /**
   * `UPCOMING` and `OFF_DAY` are derived at read time and never stored, so no
   * record can carry them. The table says that rather than dropping the filter
   * and listing everything, which would look like the filter had worked.
   */
  const unlistableStatus = isDerivedOnlyStatus(filters.status);

  const query = useQuery({
    queryKey: ['attendance', 'list', { ...filters, from, to, page, limit, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<AttendanceRecordItem>('/attendance', {
        query: {
          page,
          limit,
          from,
          to,
          q: debouncedQuery || undefined,
          departmentId: filters.departmentId || undefined,
          teamId: filters.teamId || undefined,
          employeeId: filters.employeeId || undefined,
          status: (filters.status || undefined) as AttendanceStatus | undefined,
        },
      }),
    placeholderData: keepPreviousData,
    enabled: !unlistableStatus,
  });

  const rows = query.data?.data ?? [];

  return (
    <Card className="overflow-hidden">
      <ListToolbar
        search={filters.q}
        onSearchChange={(q) => onFiltersChange({ q })}
        placeholder="Search employee or notes"
        hasActiveFilters={hasAnyFilter(filters)}
        onReset={() => onFiltersChange(NO_ATTENDANCE_FILTERS)}
      />

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : unlistableStatus ? (
        <EmptyState
          icon={CalendarClock}
          title={`${DERIVED_ATTENDANCE_STATUS_LABELS[filters.status as DerivedAttendanceStatus]} days have no record to list`}
          description="They are worked out when the month is read, not stored against a day. Switch to the bar chart or the calendar to see them, or choose another status."
        />
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
                        title={
                          hasAnyFilter(filters)
                            ? 'No records match your filters'
                            : 'No attendance recorded this month'
                        }
                        description="Days with no record are still shown in the calendar and the bar chart, classified as weekend, holiday, leave or absent."
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
              onPageChange={setPage}
              onLimitChange={(next) => {
                setLimit(next);
                setPage(1);
              }}
            />
          ) : null}
        </>
      )}
    </Card>
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
