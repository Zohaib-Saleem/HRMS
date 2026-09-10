import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  CalendarClock,
  CalendarDays,
  Clock,
  Download,
  TimerOff,
  TrendingUp,
  UserCheck,
  UserMinus,
  Users,
} from 'lucide-react';
import {
  DERIVED_ATTENDANCE_STATUSES,
  DERIVED_ATTENDANCE_STATUS_LABELS,
  type AttendanceAnalyticsResponse,
  type AttendanceDailyTotal,
  type AttendanceMonthlyRow,
  type AttendanceReport,
  type DerivedAttendanceStatus,
  type Paginated,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/field';
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { AttendanceBarChart, AttendanceChartLegend } from './attendance-bar-chart';
import { CalendarGrid, MonthNav, type CalendarCell } from './attendance-calendar';
import { LATE_TEXT, STATUS_BADGE, minutesLabel, timeLabel } from './attendance-ui';

/**
 * The attendance bar chart view.
 *
 * Everything on this screen is one request to `/attendance/analytics/daily`,
 * which returns the month already aggregated - a row per calendar day. The
 * chart, the summary cards and the calendar all read that one response, so
 * there is exactly one source of truth on the page and the three cannot
 * disagree with each other or with the table view beside them.
 *
 * The server does the arithmetic for two reasons. It is the only place that
 * knows the attendance rules, and it is the only place that can apply the data
 * scope: what a manager may see is decided before a single day is derived, and
 * the filters below narrow inside that answer rather than widening it.
 */

const monthKey = (d: Date) => d.toISOString().slice(0, 7);

const monthLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

const currentMonth = () => startOfMonth(new Date());

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

interface Filters {
  departmentId: string;
  teamId: string;
  employeeId: string;
  status: string;
}

const NO_FILTERS: Filters = { departmentId: '', teamId: '', employeeId: '', status: '' };

export function AttendanceAnalytics() {
  const { lookups } = useLookups();
  const [month, setMonth] = React.useState(currentMonth);
  const [filters, setFilters] = React.useState<Filters>(NO_FILTERS);
  const [selectedDate, setSelectedDate] = React.useState<string | null>(null);

  const monthValue = monthKey(month);

  /**
   * Changing the month closes the open day.
   *
   * Otherwise the detail panel would keep showing the 9th of September while
   * the chart above it moved to October, which is the kind of mismatch nobody
   * notices until they have acted on it.
   */
  const goToMonth = React.useCallback((next: Date) => {
    setMonth(next);
    setSelectedDate(null);
  }, []);

  const shiftMonth = React.useCallback(
    (delta: number) =>
      goToMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + delta, 1))),
    [goToMonth, month],
  );

  const update = React.useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      // A team belongs to a department. Changing the department strands the
      // team filter on a team that is no longer offered, which silently
      // narrows the chart to nothing.
      if (patch.departmentId !== undefined && patch.departmentId !== prev.departmentId) {
        next.teamId = '';
      }
      return next;
    });
  }, []);

  /** The query every panel on this screen shares. */
  const params = React.useMemo(
    () => ({
      month: monthValue,
      departmentId: filters.departmentId || undefined,
      teamId: filters.teamId || undefined,
      employeeId: filters.employeeId || undefined,
      status: filters.status || undefined,
    }),
    [monthValue, filters],
  );

  const query = useQuery({
    queryKey: ['attendance', 'analytics', params],
    queryFn: () => api.get<AttendanceAnalyticsResponse>('/attendance/analytics/daily', { query: params }),
    placeholderData: keepPreviousData,
  });

  const days = query.data?.days ?? [];
  const summary = query.data?.summary;

  const teamOptions = filters.departmentId
    ? lookups.teams.filter((t) => t.departmentId === filters.departmentId)
    : lookups.teams;

  const hasFilters = Object.values(filters).some((v) => v !== '');
  const isCurrentMonth = monthValue === monthKey(currentMonth());

  /**
   * The CSV comes from the existing report endpoint, not a new one.
   *
   * `daily` is one row per employee per day over the same range with the same
   * filters, which is precisely the data behind these columns - so the export
   * is the chart's own numbers, unrolled, rather than a second query that might
   * answer differently.
   */
  const exportHref = React.useMemo(() => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, String(value));
    }
    return `/api/v1/attendance/reports/daily/export?${search.toString()}`;
  }, [params]);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader bordered className="gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <MonthNav onShift={shiftMonth} />
            <CardTitle className="min-w-[9rem]">{monthLabel(month)}</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => goToMonth(currentMonth())}
              disabled={isCurrentMonth}
            >
              Today
            </Button>
            <label className="sr-only" htmlFor="analytics-month">
              Month
            </label>
            <input
              id="analytics-month"
              type="month"
              value={monthValue}
              onChange={(e) => {
                // An empty value means the picker was cleared; keep the month
                // that is on screen rather than jumping to an invalid date.
                if (!e.target.value) return;
                goToMonth(new Date(`${e.target.value}-01T00:00:00Z`));
              }}
              className="h-8 rounded-md border border-border bg-surface px-2 text-[13px] text-foreground"
            />
          </div>

          <div className="flex items-center gap-2">
            {hasFilters ? (
              <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
                Clear filters
              </Button>
            ) : null}
            <Button variant="outline" size="sm" asChild>
              <a href={exportHref} download>
                <Download />
                Export CSV
              </a>
            </Button>
          </div>
        </CardHeader>

        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Filter label="Department">
            <NativeSelect
              value={filters.departmentId}
              onChange={(e) => update({ departmentId: e.target.value })}
              aria-label="Filter by department"
            >
              <option value="">All departments</option>
              {lookups.departments.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </NativeSelect>
          </Filter>

          <Filter label="Team">
            <NativeSelect
              value={filters.teamId}
              onChange={(e) => update({ teamId: e.target.value })}
              aria-label="Filter by team"
            >
              <option value="">All teams</option>
              {teamOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </NativeSelect>
          </Filter>

          <Filter label="Employee">
            <NativeSelect
              value={filters.employeeId}
              onChange={(e) => update({ employeeId: e.target.value })}
              aria-label="Filter by employee"
            >
              <option value="">All employees</option>
              {lookups.managers.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </NativeSelect>
          </Filter>

          <Filter label="Status">
            <NativeSelect
              value={filters.status}
              onChange={(e) => update({ status: e.target.value })}
              aria-label="Filter by attendance status"
            >
              <option value="">All statuses</option>
              {DERIVED_ATTENDANCE_STATUSES.map((s) => (
                <option key={s} value={s}>{DERIVED_ATTENDANCE_STATUS_LABELS[s]}</option>
              ))}
            </NativeSelect>
          </Filter>
        </CardContent>
      </Card>

      <SummaryCards summary={summary} loading={query.isLoading} />

      <Card>
        <CardHeader bordered className="gap-1">
          <CardTitle>Worked hours by day</CardTitle>
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
                onSelectDate={(date) => setSelectedDate((prev) => (prev === date ? null : date))}
                singleEmployee={filters.employeeId !== ''}
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

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader bordered>
            <CardTitle>{monthLabel(month)}</CardTitle>
            <p className="text-[12.5px] text-muted-foreground">
              The same days as the chart. Choose one to see who was in and who was not.
            </p>
          </CardHeader>
          <CardContent>
            <CalendarGrid
              cells={days.map((day) => calendarCell(day, filters.employeeId !== ''))}
              loading={query.isLoading}
              selectedDate={selectedDate}
              onSelectDate={(date) => setSelectedDate((prev) => (prev === date ? null : date))}
            />
          </CardContent>
        </Card>

        <EmployeeBreakdown
          params={params}
          selectedEmployeeId={filters.employeeId}
          onSelectEmployee={(employeeId) => update({ employeeId })}
        />
      </div>

      {selectedDate ? (
        <DayDetail
          date={selectedDate}
          params={params}
          onClose={() => setSelectedDate(null)}
        />
      ) : null}
    </div>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
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
 * already filtered on the same four parameters. Choosing a row filters the
 * chart above to that person, which is how their daily bars are reached.
 */
function EmployeeBreakdown({
  params,
  selectedEmployeeId,
  onSelectEmployee,
}: {
  params: Record<string, string | undefined>;
  selectedEmployeeId: string;
  onSelectEmployee: (employeeId: string) => void;
}) {
  // The employee filter is deliberately dropped: the list is how somebody is
  // chosen, so filtering it to the current choice would leave one row and no
  // way back to the others.
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
          Choose someone to see their daily bars for this month.
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
                  const id = String(row.employeeNumber ?? '');
                  const selected = selectedEmployeeId !== '' && row.employeeId === selectedEmployeeId;
                  return (
                    <TR
                      key={id || String(row.employeeName)}
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
 * rules and the same figures as everything above it.
 */
function DayDetail({
  date,
  params,
  onClose,
}: {
  date: string;
  params: Record<string, string | undefined>;
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
