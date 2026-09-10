import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BarChart3, CalendarCheck, CalendarDays, ChevronDown, ChevronRight, TableIcon, Users } from 'lucide-react';
import {
  ATTENDANCE_STATUSES,
  ATTENDANCE_STATUS_LABELS,
  DERIVED_ATTENDANCE_STATUS_LABELS,
  PERMISSIONS,
  type AttendanceTotals,
  type MarkAbsencesResult,
  type Paginated,
  type TeamAttendanceRow,
  type TeamAttendanceSummaryRow,
  UNASSIGNED_TEAM_ID,
  UNASSIGNED_TEAM_LABEL,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { cn, formatDate } from '@/lib/utils';
import { Link } from 'react-router-dom';
import { useLookups } from '@/lib/lookups';
import { usePermissions } from '@/features/auth/session-context';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { ListSkeleton, TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { ViewSwitcher, type ViewOption } from '@/components/ui/view-switcher';
import { useStickyState } from '@/lib/use-sticky-state';
import { CalendarGrid } from './attendance-calendar';
import { TeamAttendanceBars } from './team-attendance-bars';
import { teamCalendarCells } from './team-attendance-calendar';
import { LATE_TEXT, STATUS_BADGE, STATUS_TEXT, minutesLabel, timeLabel } from './attendance-ui';

/**
 * Team attendance.
 *
 * Two shapes, one endpoint. A single date shows what each person did that day;
 * a range shows totals per person with the days expandable underneath. Both
 * come from `/attendance/team`, which applies the same data scope as every
 * other employee query - a manager sees their reports and nobody else, and the
 * filters below cannot widen that.
 */

interface TeamResponse extends Paginated<TeamAttendanceRow> {
  totals: AttendanceTotals;
  range: { from: string; to: string };
}

interface TeamSummaryResponse {
  data: TeamAttendanceSummaryRow[];
  range: { from: string; to: string };
  truncated: boolean;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/** First and last day of the month containing `iso`. */
function monthAround(iso: string): { from: string; to: string } {
  const date = new Date(`${iso}T00:00:00Z`);
  const base = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10),
  };
}

/**
 * Which shape the team's attendance is drawn in.
 *
 * `table` is what this page has always been and stays the default, so nothing
 * an administrator does daily moves under them. The other two are new readings
 * of the SAME request - no extra endpoint, no second derivation.
 */
type TeamView = 'table' | 'calendar' | 'bars';

const TEAM_VIEWS: ReadonlyArray<ViewOption<TeamView>> = [
  { key: 'table', label: 'Table', icon: TableIcon },
  { key: 'calendar', label: 'Calendar', icon: CalendarDays },
  { key: 'bars', label: 'Bars', icon: BarChart3 },
];

const TEAM_VIEW_KEYS = TEAM_VIEWS.map((v) => v.key);

/** Remembered across visits, so the reader is not re-choosing every time. */
const TEAM_VIEW_STORAGE_KEY = 'hrms.team-attendance.view';

export function TeamAttendancePage() {
  const { has } = usePermissions();
  const { lookups } = useLookups();
  const canManage = has(PERMISSIONS.ATTENDANCE_MANAGE);
  const queryClient = useQueryClient();

  const [filters, setFilters] = React.useState(() => ({
    q: '',
    status: '',
    departmentId: '',
    teamId: '',
    from: todayIso(),
    to: todayIso(),
    page: 1,
    limit: 20,
  }));
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [view, setView] = useStickyState<TeamView>(
    TEAM_VIEW_STORAGE_KEY,
    'table',
    TEAM_VIEW_KEYS,
  );
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof filters>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['attendance', 'team', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<TeamAttendanceRow>('/attendance/team', {
        query: {
          page: filters.page,
          limit: filters.limit,
          q: debouncedQuery || undefined,
          status: filters.status || undefined,
          departmentId: filters.departmentId || undefined,
          teamId: filters.teamId || undefined,
          from: filters.from,
          to: filters.to,
        },
        // The endpoint returns company-wide totals alongside the page.
      }) as Promise<TeamResponse>,
    placeholderData: keepPreviousData,
  });

  const markAbsences = useMutation({
    mutationFn: () => api.post<MarkAbsencesResult>('/attendance/mark-absences', { date: filters.to }),
    onSuccess: async (result) => {
      toast.success(
        result.marked > 0
          ? `Marked ${result.marked} employee(s) absent for ${result.date}.`
          : `Nothing to mark for ${result.date} - every working day already has a record.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  // Separate from the paginated list on purpose: a summary built from one page
  // would describe 25 people while appearing to describe everyone.
  const summaryQuery = useQuery({
    queryKey: ['attendance', 'team-summary', { ...filters, q: debouncedQuery, page: 0, limit: 0 }],
    queryFn: () =>
      // Same envelope hazard as the corrections page: `range` and `truncated`
      // sit beside `data`, so `get` would return the rows and drop the rest -
      // which is why the "By team" card silently never appeared.
      api.getEnvelope<TeamSummaryResponse>('/attendance/team-summary', {
        query: {
          departmentId: filters.departmentId || undefined,
          teamId: filters.teamId || undefined,
          from: filters.from,
          to: filters.to,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const totals = query.data?.totals;
  const singleDay = filters.from === filters.to;
  const hasFilters =
    filters.q !== '' ||
    filters.status !== '' ||
    filters.departmentId !== '' ||
    filters.teamId !== '' ||
    !singleDay;

  // Teams belong to departments, so choosing a department narrows the list.
  const teamOptions = filters.departmentId
    ? lookups.teams.filter((t) => t.departmentId === filters.departmentId)
    : lookups.teams;

  return (
    <>
      <PageHeader
        title="Team attendance"
        description="Everyone you are responsible for, on one day or across a range. Days with no record are classified, not blank."
        actions={
          canManage ? (
            <Button
              size="sm"
              variant="outline"
              loading={markAbsences.isPending}
              onClick={() => markAbsences.mutate()}
            >
              <CalendarCheck />
              Finalise {formatDate(filters.to)}
            </Button>
          ) : null
        }
      />

      {/*
        The switcher leads the page. It used to not exist here at all, and the
        lesson from the personal attendance page is that a view control tucked
        in among header buttons is a control nobody finds - so this one gets its
        own row, at the top, at full width on a phone.
      */}
      <Card className="mb-5">
        <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
          <ViewSwitcher
            value={view}
            onChange={setView}
            options={TEAM_VIEWS}
            label="Team attendance view"
          />
          <p className="text-[12.5px] text-muted-foreground">
            {view === 'table'
              ? 'One row per person, with the days expandable across a range.'
              : view === 'calendar'
                ? 'The selected range as a month grid, one cell per date.'
                : 'One bar per employee per day. Height is time actually worked.'}
          </p>
        </div>
      </Card>

      {totals ? (
        <Card className="mb-6">
          <div className="tabular flex flex-wrap gap-x-6 gap-y-2 p-4 text-[13px] text-muted-foreground">
            <span><span className={cn('font-semibold', STATUS_TEXT.PRESENT)}>{totals.present}</span> present</span>
            <span><span className={cn('font-semibold', STATUS_TEXT.HALF_DAY)}>{totals.halfDay}</span> half day</span>
            <span><span className={cn('font-semibold', STATUS_TEXT.ABSENT)}>{totals.absent}</span> absent</span>
            <span><span className={cn('font-semibold', STATUS_TEXT.ON_LEAVE)}>{totals.onLeave}</span> on leave</span>
            <span><span className={cn('font-semibold', STATUS_TEXT.HOLIDAY)}>{totals.holiday}</span> holiday</span>
            <span><span className={cn('font-semibold', STATUS_TEXT.WEEKEND)}>{totals.weekend}</span> weekend</span>
            <span>
              <span className="font-semibold text-foreground">
                {(totals.workedMinutes / 60).toFixed(1)}
              </span>{' '}
              hours worked
            </span>
            <span>
              <span className="font-semibold text-foreground">
                {(totals.overtimeMinutes / 60).toFixed(1)}
              </span>{' '}
              hours overtime
            </span>
            <span><span className="font-semibold text-foreground">{totals.lateMinutes}</span> minutes late</span>
          </div>
        </Card>
      ) : null}

      <TeamSummaryCard
        rows={summaryQuery.data?.data ?? []}
        loading={summaryQuery.isLoading}
        truncated={summaryQuery.data?.truncated ?? false}
      />

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search name or employee number"
          hasActiveFilters={hasFilters}
          onReset={() =>
            setFilters({
              q: '',
              status: '',
              departmentId: '',
              teamId: '',
              from: todayIso(),
              to: todayIso(),
              page: 1,
              limit: 20,
            })
          }
          filters={
            <>
              <NativeSelect
                value={filters.departmentId}
                // Changing department clears a team that no longer belongs to it.
                onChange={(e) => update({ departmentId: e.target.value, teamId: '' })}
                aria-label="Filter by department"
                className="w-44"
              >
                <option value="">All departments</option>
                {lookups.departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </NativeSelect>
              <NativeSelect
                value={filters.teamId}
                onChange={(e) => update({ teamId: e.target.value })}
                aria-label="Filter by team"
                className="w-40"
              >
                <option value="">All teams</option>
                <option value={UNASSIGNED_TEAM_ID}>{UNASSIGNED_TEAM_LABEL}</option>
                {teamOptions.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </NativeSelect>
              <Input
                type="date"
                value={filters.from}
                onChange={(e) => update({ from: e.target.value })}
                aria-label="From date"
                className="w-40"
              />
              <Input
                type="date"
                value={filters.to}
                onChange={(e) => update({ to: e.target.value })}
                aria-label="To date"
                className="w-40"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => update(monthAround(filters.from))}
              >
                This month
              </Button>
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
        ) : view === 'calendar' ? (
          <div className="px-4 py-4 sm:px-5">
            {singleDay ? (
              <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2">
                <p className="text-[12.5px] text-muted-foreground">
                  A calendar of one day is one square. Widen the range to see a month.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => update(monthAround(filters.from))}
                >
                  Show the whole month
                </Button>
              </div>
            ) : null}

            {!query.isLoading && rows.length === 0 ? (
              <EmptyState
                icon={Users}
                title={hasFilters ? 'Nobody matches those filters' : 'No one in your team yet'}
                description="You see the people your role gives you access to. Ask an administrator if someone is missing."
              />
            ) : (
              <CalendarGrid cells={teamCalendarCells(rows)} loading={query.isLoading} />
            )}
          </div>
        ) : view === 'bars' ? (
          <>
            <div className="px-4 py-4 sm:px-5">
              <TeamAttendanceBars
                rows={rows}
                loading={query.isLoading}
                singleDay={singleDay}
              />
            </div>
            {query.data?.meta ? (
              <Pagination
                meta={query.data.meta}
                disabled={query.isFetching}
                onPageChange={(page) => update({ page })}
                onLimitChange={(limit) => update({ limit })}
              />
            ) : null}
          </>
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Employee</TH>
                    <TH className="w-40">Department</TH>
                    <TH className="w-32">Team</TH>
                    <TH className="w-28">Shift</TH>
                    {singleDay ? (
                      <>
                        <TH className="w-28">Check in</TH>
                        <TH className="w-28">Check out</TH>
                        <TH className="w-28 text-right">Worked</TH>
                        <TH className="w-28 text-right">Overtime</TH>
                        <TH className="w-32">Late / early</TH>
                        <TH className="w-28">Status</TH>
                      </>
                    ) : (
                      <>
                        <TH className="w-24 text-right">Present</TH>
                        <TH className="w-24 text-right">Absent</TH>
                        <TH className="w-24 text-right">Leave</TH>
                        <TH className="w-28 text-right">Worked</TH>
                        <TH className="w-28 text-right">Overtime</TH>
                        <TH className="w-24 text-right">Late</TH>
                      </>
                    )}
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={6} columns={10} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={10} className="p-0">
                        <EmptyState
                          icon={Users}
                          title={hasFilters ? 'Nobody matches those filters' : 'No one in your team yet'}
                          description="You see the people your role gives you access to. Ask an administrator if someone is missing."
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) =>
                      singleDay ? (
                        <SingleDayRow key={row.employeeId} row={row} />
                      ) : (
                        <RangeRow
                          key={row.employeeId}
                          row={row}
                          open={expanded === row.employeeId}
                          onToggle={() =>
                            setExpanded((prev) => (prev === row.employeeId ? null : row.employeeId))
                          }
                        />
                      ),
                    )
                  )}
                </TBody>
              </Table>
            </TableWrapper>

            {query.data?.meta ? (
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
  );
}

function EmployeeCell({ row }: { row: TeamAttendanceRow }) {
  return (
    <TD className="text-[13px]">
      <Link
        to={`/attendance/team/${row.employeeId}`}
        className="font-medium underline-offset-2 hover:underline"
      >
        {row.employeeName}
      </Link>
      <span className="tabular ml-1.5 text-[11.5px] text-muted-foreground">
        {row.employeeNumber}
      </span>
    </TD>
  );
}

/**
 * Attendance rolled up per team.
 *
 * Counts days, not minutes: "how did each team do" is a different question from
 * "how long was everyone at their desk", and the per-person rows below already
 * answer the second one. Unassigned is a row like any other, so people with no
 * team are visible in the summary rather than quietly missing from the totals.
 */
function TeamSummaryCard({
  rows,
  loading,
  truncated,
}: {
  rows: TeamAttendanceSummaryRow[];
  loading: boolean;
  truncated: boolean;
}) {
  if (loading) {
    return (
      <Card className="mb-6">
        <ListSkeleton rows={3} />
      </Card>
    );
  }
  if (rows.length === 0) return null;

  return (
    <Card className="mb-6 overflow-hidden">
      <div className="border-b border-border px-4 py-2.5 text-[13px] font-semibold">
        By team
        {truncated ? (
          <span className="ml-2 text-[11.5px] font-normal text-muted-foreground">
            showing the first 2,000 people
          </span>
        ) : null}
      </div>
      <TableWrapper>
        <Table>
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Team</TH>
              <TH className="w-40">Department</TH>
              <TH className="w-24 text-right">People</TH>
              <TH className="w-24 text-right">Present</TH>
              <TH className="w-24 text-right">Late</TH>
              <TH className="w-24 text-right">Absent</TH>
              <TH className="w-24 text-right">Total</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.teamId ?? UNASSIGNED_TEAM_ID} className="hover:bg-transparent">
                <TD className="text-[13px] font-medium">
                  {row.teamId === null ? (
                    <span className="italic text-muted-foreground">{row.teamName}</span>
                  ) : (
                    row.teamName
                  )}
                </TD>
                <TD className="text-[13px] text-muted-foreground">{row.departmentName ?? '--'}</TD>
                <TD className="tabular text-right text-[13px] text-muted-foreground">
                  {row.employees}
                </TD>
                <TD className="tabular text-right text-[13px]">
                  {row.present > 0 ? (
                    <span className={cn('font-medium', STATUS_TEXT.PRESENT)}>{row.present}</span>
                  ) : (
                    <span className="text-muted-foreground">--</span>
                  )}
                </TD>
                <TD className="tabular text-right text-[13px]">
                  {row.late > 0 ? (
                    <span className={cn('font-medium', STATUS_TEXT.HALF_DAY)}>{row.late}</span>
                  ) : (
                    <span className="text-muted-foreground">--</span>
                  )}
                </TD>
                <TD className="tabular text-right text-[13px]">
                  {row.absent > 0 ? (
                    <span className={cn('font-medium', STATUS_TEXT.ABSENT)}>{row.absent}</span>
                  ) : (
                    <span className="text-muted-foreground">--</span>
                  )}
                </TD>
                <TD className="tabular text-right text-[13px] font-medium">{row.total}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrapper>
    </Card>
  );
}

/**
 * The team column.
 *
 * An employee on no team reads "Unassigned" rather than a dash: they are a real
 * person the report is accountable for, and a blank cell invites the reader to
 * assume the row is incomplete rather than that the assignment is missing.
 */
function TeamCell({ row }: { row: TeamAttendanceRow }) {
  return (
    <TD className="text-[13px] text-muted-foreground">
      {row.teamName ?? (
        <span className="italic text-muted-foreground/80">{UNASSIGNED_TEAM_LABEL}</span>
      )}
    </TD>
  );
}

function SingleDayRow({ row }: { row: TeamAttendanceRow }) {
  // Optional on purpose. A row can arrive with no days - nothing in range, a
  // joiner who starts next week - and indexing straight into a missing array
  // took the whole page down rather than showing one row of dashes.
  const day = row.days?.[0];

  return (
    <TR>
      <EmployeeCell row={row} />
      <TD className="text-[13px] text-muted-foreground">{row.departmentName ?? '--'}</TD>
      <TeamCell row={row} />
      <TD className="text-[12.5px] text-muted-foreground">{row.shiftName ?? 'Unassigned'}</TD>
      <TD className="tabular text-[13px] text-muted-foreground">{timeLabel(day?.checkInAt)}</TD>
      <TD className="tabular text-[13px] text-muted-foreground">{timeLabel(day?.checkOutAt)}</TD>
      <TD className="tabular text-right text-[13px]">{minutesLabel(day?.workedMinutes)}</TD>
      <TD className="tabular text-right text-[13px]">
        {day?.overtimeMinutes ? (
          <span className="text-success">{minutesLabel(day.overtimeMinutes)}</span>
        ) : (
          <span className="text-muted-foreground">--</span>
        )}
      </TD>
      <TD className="tabular text-[12.5px]">
        {day?.lateMinutes || day?.earlyLeaveMinutes ? (
          <span className={LATE_TEXT}>
            {day.lateMinutes ? `${day.lateMinutes}m late` : ''}
            {day.lateMinutes && day.earlyLeaveMinutes ? ' · ' : ''}
            {day.earlyLeaveMinutes ? `${day.earlyLeaveMinutes}m early` : ''}
          </span>
        ) : (
          <span className="text-muted-foreground">--</span>
        )}
      </TD>
      <TD>
        {day ? (
          <span className={STATUS_BADGE[day.status]}>
            {day.holidayName ?? day.leaveTypeName ?? DERIVED_ATTENDANCE_STATUS_LABELS[day.status]}
          </span>
        ) : (
          <span className="text-[12px] text-muted-foreground">--</span>
        )}
      </TD>
    </TR>
  );
}

function RangeRow({
  row,
  open,
  onToggle,
}: {
  row: TeamAttendanceRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TR className="cursor-pointer" onClick={onToggle}>
        <TD className="text-[13px]">
          <button
            type="button"
            className="flex items-center gap-1.5 text-left"
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {open ? (
              <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
            )}
            <span className="font-medium">{row.employeeName}</span>
            <span className="tabular text-[11.5px] text-muted-foreground">{row.employeeNumber}</span>
          </button>
        </TD>
        <TD className="text-[13px] text-muted-foreground">{row.departmentName ?? '--'}</TD>
        <TeamCell row={row} />
        <TD className="text-[12.5px] text-muted-foreground">{row.shiftName ?? 'Unassigned'}</TD>
        <TD className="tabular text-right text-[13px]">
          {row.totals.present}
          {row.totals.halfDay > 0 ? (
            <span className={LATE_TEXT}> +{row.totals.halfDay}½</span>
          ) : null}
        </TD>
        <TD className="tabular text-right text-[13px]">{row.totals.absent}</TD>
        <TD className="tabular text-right text-[13px]">{row.totals.onLeave}</TD>
        <TD className="tabular text-right text-[13px]">{minutesLabel(row.totals.workedMinutes)}</TD>
        <TD className="tabular text-right text-[13px]">
          {row.totals.overtimeMinutes > 0 ? (
            <span className="text-success">{minutesLabel(row.totals.overtimeMinutes)}</span>
          ) : (
            <span className="text-muted-foreground">--</span>
          )}
        </TD>
        <TD className="tabular text-right text-[13px]">
          {row.totals.lateMinutes > 0 ? `${row.totals.lateMinutes}m` : '--'}
        </TD>
      </TR>

      {open ? (
        <TR className="hover:bg-transparent">
          <TD colSpan={10} className="bg-muted/40 p-0">
            <div className="divide-y divide-border">
              {(row.days ?? []).map((day) => (
                <div
                  key={day.date}
                  className="tabular flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 text-[12.5px]"
                >
                  <span className="w-28 font-medium">{formatDate(day.date)}</span>
                  <span className={STATUS_BADGE[day.status]}>
                    {day.holidayName ?? day.leaveTypeName ?? DERIVED_ATTENDANCE_STATUS_LABELS[day.status]}
                  </span>
                  <span className="text-muted-foreground">
                    In {timeLabel(day.checkInAt)} · Out {timeLabel(day.checkOutAt)}
                  </span>
                  <span className="text-muted-foreground">
                    Worked {minutesLabel(day.workedMinutes)}
                  </span>
                  {day.overtimeMinutes ? (
                    <span className="text-success">+{minutesLabel(day.overtimeMinutes)} overtime</span>
                  ) : null}
                  {day.lateMinutes ? (
                    <span className={LATE_TEXT}>{day.lateMinutes}m late</span>
                  ) : null}
                  {day.earlyLeaveMinutes ? (
                    <span className={LATE_TEXT}>{day.earlyLeaveMinutes}m early</span>
                  ) : null}
                </div>
              ))}
            </div>
          </TD>
        </TR>
      ) : null}
    </>
  );
}
