import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarCheck, ChevronDown, ChevronRight, Users } from 'lucide-react';
import {
  ATTENDANCE_STATUSES,
  ATTENDANCE_STATUS_LABELS,
  PERMISSIONS,
  type AttendanceTotals,
  type MarkAbsencesResult,
  type Paginated,
  type TeamAttendanceRow,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { formatDate } from '@/lib/utils';
import { usePermissions } from '@/features/auth/session-context';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { STATUS_TONE, minutesLabel, timeLabel } from './attendance-ui';

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

const todayIso = () => new Date().toISOString().slice(0, 10);

export function TeamAttendancePage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.ATTENDANCE_MANAGE);
  const queryClient = useQueryClient();

  const [filters, setFilters] = React.useState(() => ({
    q: '',
    status: '',
    from: todayIso(),
    to: todayIso(),
    page: 1,
    limit: 20,
  }));
  const [expanded, setExpanded] = React.useState<string | null>(null);
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

  const rows = query.data?.data ?? [];
  const totals = query.data?.totals;
  const singleDay = filters.from === filters.to;
  const hasFilters = filters.q !== '' || filters.status !== '' || !singleDay;

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

      {totals ? (
        <Card className="mb-6">
          <div className="tabular flex flex-wrap gap-x-6 gap-y-2 p-4 text-[13px] text-muted-foreground">
            <span><span className="font-semibold text-foreground">{totals.present}</span> present</span>
            <span><span className="font-semibold text-foreground">{totals.halfDay}</span> half day</span>
            <span><span className="font-semibold text-foreground">{totals.absent}</span> absent</span>
            <span><span className="font-semibold text-foreground">{totals.onLeave}</span> on leave</span>
            <span><span className="font-semibold text-foreground">{totals.holiday}</span> holiday</span>
            <span><span className="font-semibold text-foreground">{totals.weekend}</span> weekend</span>
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

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search name or employee number"
          hasActiveFilters={hasFilters}
          onReset={() =>
            setFilters({ q: '', status: '', from: todayIso(), to: todayIso(), page: 1, limit: 20 })
          }
          filters={
            <>
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
                    <TH>Employee</TH>
                    <TH className="w-40">Department</TH>
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
                    <TableSkeleton rows={6} columns={singleDay ? 9 : 9} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={9} className="p-0">
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
  );
}

function EmployeeCell({ row }: { row: TeamAttendanceRow }) {
  return (
    <TD className="text-[13px]">
      <span className="font-medium">{row.employeeName}</span>
      <span className="tabular ml-1.5 text-[11.5px] text-muted-foreground">
        {row.employeeNumber}
      </span>
    </TD>
  );
}

function SingleDayRow({ row }: { row: TeamAttendanceRow }) {
  const day = row.days[0];

  return (
    <TR>
      <EmployeeCell row={row} />
      <TD className="text-[13px] text-muted-foreground">{row.departmentName ?? '--'}</TD>
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
          <span className="text-warning-foreground">
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
          <Badge variant={STATUS_TONE[day.status]}>
            {day.holidayName ?? day.leaveTypeName ?? ATTENDANCE_STATUS_LABELS[day.status]}
          </Badge>
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
        <TD className="text-[12.5px] text-muted-foreground">{row.shiftName ?? 'Unassigned'}</TD>
        <TD className="tabular text-right text-[13px]">
          {row.totals.present}
          {row.totals.halfDay > 0 ? (
            <span className="text-warning-foreground"> +{row.totals.halfDay}½</span>
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
          <TD colSpan={9} className="bg-muted/40 p-0">
            <div className="divide-y divide-border">
              {row.days.map((day) => (
                <div
                  key={day.date}
                  className="tabular flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 text-[12.5px]"
                >
                  <span className="w-28 font-medium">{formatDate(day.date)}</span>
                  <Badge variant={STATUS_TONE[day.status]}>
                    {day.holidayName ?? day.leaveTypeName ?? ATTENDANCE_STATUS_LABELS[day.status]}
                  </Badge>
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
                    <span className="text-warning-foreground">{day.lateMinutes}m late</span>
                  ) : null}
                  {day.earlyLeaveMinutes ? (
                    <span className="text-warning-foreground">{day.earlyLeaveMinutes}m early</span>
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
