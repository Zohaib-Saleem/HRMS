import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  CalendarClock,
  CalendarDays,
  Clock,
  TimerOff,
  TrendingUp,
  UserCheck,
  UserMinus,
  Users,
} from 'lucide-react';
import {
  DERIVED_ATTENDANCE_STATUS_LABELS,
  type AttendanceAnalyticsResponse,
  type AttendanceDailyTotal,
  type AttendanceMonthlyRow,
  type AttendanceReport,
  type DerivedAttendanceStatus,
  type Paginated,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { AttendanceBarChart, AttendanceChartLegend } from './attendance-bar-chart';
import { CalendarGrid, type CalendarCell } from './attendance-calendar';
import { monthLabel } from './attendance-view';
import { LATE_TEXT, STATUS_BADGE, minutesLabel, timeLabel } from './attendance-ui';

/**
 * The bar chart and calendar views of attendance.
 *
 * Both are one request to `/attendance/analytics/daily`, which returns the
 * month already aggregated - a row per calendar day. The chart, the summary
 * cards and the calendar all read that one response, so there is exactly one
 * source of truth behind them and they cannot disagree with each other or with
 * the table view beside them.
 *
 * The server does the arithmetic for two reasons. It is the only place that
 * knows the attendance rules, and it is the only place that can apply the data
 * scope: what a manager may see is decided before a single day is derived, and
 * the filters the page holds narrow inside that answer rather than widening it.
 *
 * Neither view owns its month or its filters. The page does, and hands them
 * down, so switching between them keeps the reader on the same question.
 */

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const hoursLabel = (minutes: number | null): string =>
  minutes === null ? '—' : `${(minutes / 60).toFixed(1)}h`;

/** Query parameters as the page assembles them. */
export type AnalyticsParams = Record<string, string | undefined>;

interface ViewProps {
  month: Date;
  params: AnalyticsParams;
  /** True when the employee filter has narrowed the page to one person. */
  singleEmployee: boolean;
  /** That person's name, when there is one. */
  employeeName?: string | null;
  selectedDate: string | null;
  /** Toggles the day detail open, or shut when the same day is chosen again. */
  onSelectDate: (date: string) => void;
  onClearDate: () => void;
  /** Narrows the page to one person, from the employee list under the chart. */
  onSelectEmployee: (employeeId: string) => void;
}

/** The one request behind both views. Shared cache key, so switching is free. */
function useDailyAnalytics(params: AnalyticsParams) {
  return useQuery({
    queryKey: ['attendance', 'analytics', params],
    queryFn: () =>
      api.get<AttendanceAnalyticsResponse>('/attendance/analytics/daily', { query: params }),
    placeholderData: keepPreviousData,
  });
}

/** The bar chart view: worked hours per day, with the month totalled above it. */
export function AttendanceChartView({
  month,
  params,
  singleEmployee,
  employeeName = null,
  selectedDate,
  onSelectDate,
  onClearDate,
  onSelectEmployee,
}: ViewProps) {
  const query = useDailyAnalytics(params);
  const days = query.data?.days ?? [];

  return (
    <div className="space-y-5">
      <SummaryCards summary={query.data?.summary} loading={query.isLoading} />

      <Card>
        <CardHeader bordered className="gap-1">
          <CardTitle>Worked hours by day — {monthLabel(month)}</CardTitle>
          <p className="text-[12.5px] text-muted-foreground">
            Bar height is time actually worked. Overtime is part of that time, not added to it, and
            late minutes are shown beside the bar rather than drawn as hours nobody worked.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : (
            <>
              <AttendanceBarChart
                days={days}
                loading={query.isLoading}
                selectedDate={selectedDate}
                onSelectDate={onSelectDate}
                singleEmployee={singleEmployee}
                employeeName={employeeName}
              />
              <AttendanceChartLegend />
              {query.data?.truncated ? (
                <p className="text-[12px] text-warning-foreground">
                  Showing the first 2,000 employees in scope. Filter by department or team for a
                  complete picture.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {/*
        Directly under the chart, not below the employee list. Choosing a bar
        has to put something where the reader is already looking; a panel two
        screens down reads as nothing having happened.
      */}
      {selectedDate ? (
        <DayDetail date={selectedDate} params={params} onClose={onClearDate} />
      ) : null}

      <EmployeeBreakdown
        params={params}
        selectedEmployeeId={params.employeeId ?? ''}
        onSelectEmployee={onSelectEmployee}
      />
    </div>
  );
}

/**
 * The calendar view: the same aggregated days, drawn as a month grid.
 *
 * It reads the analytics response rather than `/attendance/summary` so that the
 * department, team, employee and status filters mean the same thing here as
 * they do on the chart. `/attendance/summary` only knows about one employee,
 * which is why the personal calendar still uses it and this does not.
 */
export function AttendanceCalendarView({
  month,
  params,
  singleEmployee,
  selectedDate,
  onSelectDate,
  onClearDate,
}: ViewProps) {
  const query = useDailyAnalytics(params);
  const days = query.data?.days ?? [];

  return (
    <div className="space-y-5">
      <SummaryCards summary={query.data?.summary} loading={query.isLoading} />

      <Card>
        <CardHeader bordered className="gap-1">
          <CardTitle>{monthLabel(month)}</CardTitle>
          <p className="text-[12.5px] text-muted-foreground">
            {singleEmployee
              ? 'Each day is that employee’s status. Choose one to see the detail.'
              : 'Each day shows how many of the people in scope were in. Choose one to see who.'}
          </p>
        </CardHeader>
        <CardContent>
          {query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : (
            <CalendarGrid
              cells={days.map((day) => calendarCell(day, singleEmployee))}
              loading={query.isLoading}
              selectedDate={selectedDate}
              onSelectDate={onSelectDate}
            />
          )}
        </CardContent>
      </Card>

      {selectedDate ? (
        <DayDetail date={selectedDate} params={params} onClose={onClearDate} />
      ) : null}
    </div>
  );
}

/**
 * One aggregated day as a calendar cell.
 *
 * With a single employee in scope the cell is that person's status, exactly as
 * the personal calendar has always shown it. With more than one it cannot be a
 * status - twelve people were present and three were not - so it takes the
 * colour of the day's own character and prints the headcount instead. Claiming
 * a single status for a mixed day is the one thing this must not do.
 */
export function calendarCell(day: AttendanceDailyTotal, singleEmployee: boolean): CalendarCell {
  const status: DerivedAttendanceStatus =
    day.dayState === 'HOLIDAY'
      ? 'HOLIDAY'
      : day.dayState === 'WEEKEND'
        ? 'WEEKEND'
        : day.dayState === 'OFF_DAY'
          ? 'OFF_DAY'
          : day.dayState === 'UPCOMING'
            ? 'UPCOMING'
            : singleEmployee
              ? day.present > 0
                ? 'PRESENT'
                : day.halfDay > 0
                  ? 'HALF_DAY'
                  : day.onLeave > 0
                    ? 'ON_LEAVE'
                    : 'ABSENT'
              : day.absent > 0
                ? 'ABSENT'
                : 'PRESENT';

  const attended = day.present + day.halfDay;
  const label =
    day.holidayName ??
    (day.dayState !== 'WORKING'
      ? DERIVED_ATTENDANCE_STATUS_LABELS[status]
      : singleEmployee
        ? DERIVED_ATTENDANCE_STATUS_LABELS[status]
        : `${attended}/${day.employeeCount} in`);

  const detail = [
    longDate(day.date),
    day.dayState !== 'WORKING' ? DERIVED_ATTENDANCE_STATUS_LABELS[status] : null,
    day.holidayName,
    day.employeeCount > 0 && day.dayState === 'WORKING'
      ? `${attended} of ${day.employeeCount} present`
      : null,
    day.absent > 0 ? `${day.absent} absent` : null,
    day.onLeave > 0 ? `${day.onLeave} on leave` : null,
    day.workedMinutes > 0 ? `${(day.workedMinutes / 60).toFixed(1)}h worked` : null,
    day.lateMinutes > 0 ? `${day.lateMinutes}m late` : null,
    day.overtimeMinutes > 0 ? `${day.overtimeMinutes}m overtime` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return { date: day.date, status, label, detail };
}

/**
 * The headline cards.
 *
 * Day counts are employee-days, not people: nine absences in a month can be one
 * person nine times or nine people once, and the card says nine either way. The
 * labels say "days" so the figure cannot be misread as a headcount.
 */
function SummaryCards({
  summary,
  loading,
}: {
  summary: AttendanceAnalyticsResponse['summary'] | undefined;
  loading: boolean;
}) {
  const cards = [
    { label: 'Total employees', value: summary?.totalEmployees, icon: Users, hint: 'In scope this month' },
    { label: 'Present days', value: summary?.present, icon: UserCheck, hint: 'Full days worked' },
    { label: 'Absent days', value: summary?.absent, icon: UserMinus, hint: 'Working days with no attendance' },
    { label: 'Half days', value: summary?.halfDay, icon: TimerOff, hint: 'Scored as half a day' },
    { label: 'On leave', value: summary?.onLeave, icon: CalendarDays, hint: 'Days on approved leave' },
    { label: 'Holidays', value: summary?.holiday, icon: CalendarClock, hint: 'Employee-days on a holiday' },
    {
      label: 'Average hours',
      value: summary ? hoursLabel(summary.averageWorkedMinutes) : undefined,
      icon: Clock,
      hint: 'Per day worked',
    },
    {
      label: 'Total overtime',
      value: summary ? hoursLabel(summary.overtimeMinutes) : undefined,
      icon: TrendingUp,
      hint: 'Part of hours worked',
    },
    {
      label: 'Total late',
      value: summary ? `${summary.lateMinutes} min` : undefined,
      icon: Clock,
      hint: 'Minutes missed at shift start',
    },
  ];

  return (
    <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-5">
      {cards.map((card) => (
        <Card key={card.label} className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <p className="truncate text-[12px] font-medium text-muted-foreground">{card.label}</p>
              {loading ? (
                <Skeleton className="h-7 w-14" />
              ) : (
                <p className="tabular text-2xl font-semibold leading-none tracking-tight">
                  {card.value ?? '—'}
                </p>
              )}
              <p className="truncate text-[11px] text-muted-foreground">{card.hint}</p>
            </div>
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground" aria-hidden>
              <card.icon className="size-4" />
            </span>
          </div>
        </Card>
      ))}
    </div>
  );
}

/**
 * Everyone in scope, with their month totalled.
 *
 * Served by the existing monthly report rather than a new endpoint: it is
 * already one row per employee with exactly these figures, already scoped, and
 * already filtered on the same four parameters.
 */
function EmployeeBreakdown({
  params,
  selectedEmployeeId,
  onSelectEmployee,
}: {
  params: AnalyticsParams;
  selectedEmployeeId: string;
  onSelectEmployee: (employeeId: string) => void;
}) {
  // The employee filter is deliberately dropped: this is the list somebody is
  // chosen FROM, so narrowing it to the current choice would leave one row.
  const { employeeId: _ignored, ...listParams } = params;

  const query = useQuery({
    queryKey: ['attendance', 'analytics', 'employees', listParams],
    queryFn: () =>
      api.get<AttendanceReport>('/attendance/reports/monthly', { query: listParams }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.rows ?? [];

  return (
    <Card className="overflow-hidden">
      <CardHeader bordered className="gap-1">
        <CardTitle>Employees</CardTitle>
        <p className="text-[12.5px] text-muted-foreground">
          Choose someone to narrow every view above to their daily bars.
        </p>
      </CardHeader>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <TableWrapper className="max-h-[26rem] overflow-y-auto">
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Employee</TH>
                <TH className="w-20 text-right">Present</TH>
                <TH className="w-16 text-right">Late</TH>
                <TH className="w-20 text-right">OT</TH>
                <TH className="w-16 text-right">%</TH>
              </TR>
            </THead>
            <TBody>
              {query.isLoading ? (
                <TableSkeleton rows={6} columns={5} />
              ) : rows.length === 0 ? (
                <TR className="hover:bg-transparent">
                  <TD colSpan={5} className="p-0">
                    <EmptyState
                      icon={Users}
                      title="Nobody matches these filters"
                      description="Widen the department, team or status filter to see people here."
                    />
                  </TD>
                </TR>
              ) : (
                rows.map((row) => {
                  const selected = selectedEmployeeId !== '' && row.employeeId === selectedEmployeeId;
                  return (
                    <TR
                      key={String(row.employeeId ?? row.employeeNumber ?? row.employeeName)}
                      className={cn('cursor-pointer', selected && 'bg-accent/50')}
                      onClick={() =>
                        row.employeeId ? onSelectEmployee(String(row.employeeId)) : undefined
                      }
                    >
                      <TD className="text-[13px]">
                        <span className="block truncate font-medium">{row.employeeName}</span>
                        <span className="block truncate text-[11.5px] text-muted-foreground">
                          {row.departmentName ?? '—'}
                        </span>
                      </TD>
                      <TD className="tabular text-right text-[13px]">{row.presentDays ?? 0}</TD>
                      <TD className={cn('tabular text-right text-[13px]', row.lateCount ? LATE_TEXT : '')}>
                        {row.lateCount ?? 0}
                      </TD>
                      <TD className="tabular text-right text-[13px]">{row.overtimeHours ?? 0}</TD>
                      <TD className="tabular text-right text-[13px]">
                        {row.attendancePercentage === null || row.attendancePercentage === undefined
                          ? '—'
                          : `${row.attendancePercentage}%`}
                      </TD>
                    </TR>
                  );
                })
              )}
            </TBody>
          </Table>
        </TableWrapper>
      )}
    </Card>
  );
}

/**
 * One day, one row per employee.
 *
 * Opened by clicking a bar or a calendar cell. Served by the existing
 * `/attendance/monthly` endpoint with the range collapsed to a single date and
 * the screen's own filters carried over, so it is the same scope, the same
 * rules and the same figures as everything above it. This is also where the
 * per-employee facts the aggregate cannot carry live: the name, the shift, and
 * that person's own check-in and check-out.
 */
function DayDetail({
  date,
  params,
  onClose,
}: {
  date: string;
  params: AnalyticsParams;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ['attendance', 'analytics', 'day', date, params],
    queryFn: () =>
      api.getPage<AttendanceMonthlyRow>('/attendance/monthly', {
        query: {
          ...params,
          month: undefined,
          from: date,
          to: date,
          limit: 100,
        },
      }) as Promise<Paginated<AttendanceMonthlyRow>>,
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];

  return (
    <Card className="overflow-hidden">
      <CardHeader bordered className="flex-row items-center justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="truncate">{longDate(date)}</CardTitle>
          <p className="text-[12.5px] text-muted-foreground">
            {query.isLoading ? 'Loading…' : `${rows.length} employee(s)`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </CardHeader>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <TableWrapper>
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Employee</TH>
                <TH className="w-28">Check in</TH>
                <TH className="w-28">Check out</TH>
                <TH className="w-24 text-right">Worked</TH>
                <TH className="w-24 text-right">Overtime</TH>
                <TH className="w-28">Late / early</TH>
                <TH className="w-28">Status</TH>
              </TR>
            </THead>
            <TBody>
              {query.isLoading ? (
                <TableSkeleton rows={5} columns={7} />
              ) : rows.length === 0 ? (
                <TR className="hover:bg-transparent">
                  <TD colSpan={7} className="p-0">
                    <EmptyState
                      icon={CalendarClock}
                      title="Nothing recorded for this day"
                      description="No employee in scope has a day matching the current filters."
                    />
                  </TD>
                </TR>
              ) : (
                rows.map((row) => (
                  <TR key={`${row.employeeId}-${row.date}`}>
                    <TD className="text-[13px]">
                      <span className="block truncate font-medium">{row.employeeName}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {row.departmentName ?? '—'}
                        {row.shiftName ? ` · ${row.shiftName}` : ''}
                      </span>
                    </TD>
                    <TD className="tabular text-[13px] text-muted-foreground">
                      {timeLabel(row.checkInAt)}
                    </TD>
                    <TD className="tabular text-[13px] text-muted-foreground">
                      {timeLabel(row.checkOutAt)}
                    </TD>
                    <TD className="tabular text-right text-[13px]">
                      {minutesLabel(row.workedMinutes)}
                    </TD>
                    <TD className="tabular text-right text-[13px]">
                      {row.overtimeMinutes ? (
                        <span className="text-success">{minutesLabel(row.overtimeMinutes)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
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
                        <span className="text-muted-foreground">
                          {row.checkInAt ? 'On time' : '—'}
                        </span>
                      )}
                    </TD>
                    <TD>
                      <span className={STATUS_BADGE[row.status]}>
                        {DERIVED_ATTENDANCE_STATUS_LABELS[row.status]}
                      </span>
                    </TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </TableWrapper>
      )}
    </Card>
  );
}
