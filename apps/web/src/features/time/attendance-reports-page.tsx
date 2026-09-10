import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BarChart3, Download } from 'lucide-react';
import {
  ATTENDANCE_FLAG_LABELS,
  ATTENDANCE_REPORT_LABELS,
  ATTENDANCE_REPORT_TYPES,
  DERIVED_ATTENDANCE_STATUS_LABELS,
  type AttendanceEmployeeFile,
  type AttendanceReport,
  type AttendanceReportCell,
  type AttendanceReportColumn,
  type AttendanceReportType,
  type EmployeeListItem,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { useLookups } from '@/lib/lookups';
import { cn, formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/field';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { FLAG_BADGE, STATUS_CELL, STATUS_TEXT, minutesLabel, timeLabel } from './attendance-ui';

/**
 * Attendance reports.
 *
 * Every report is the same shape - columns, rows, a totals line - because they
 * all come from the same derived days the attendance screens read. That is
 * what lets one table component render twelve reports, and more importantly it
 * is what stops a report from disagreeing with the attendance page about the
 * same person on the same day.
 *
 * The server decides the columns, so a report gains a column without this file
 * changing.
 */

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** Renders one cell according to what the server said the column is. */
function cell(value: AttendanceReportCell, column: AttendanceReportColumn): string {
  if (value === null || value === undefined || value === '') return '--';
  switch (column.kind) {
    case 'minutes': {
      const minutes = Number(value);
      if (!Number.isFinite(minutes)) return String(value);
      return `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, '0')}m`;
    }
    case 'percent':
      return `${value}%`;
    case 'date':
      return formatDate(String(value));
    case 'time':
      return new Date(String(value)).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      });
    default:
      return String(value);
  }
}

export function AttendanceReportsPage() {
  const { lookups } = useLookups();

  const [type, setType] = React.useState<AttendanceReportType>('monthly');
  const [filters, setFilters] = React.useState({
    month: thisMonth(),
    from: '',
    to: '',
    departmentId: '',
    teamId: '',
    employeeId: '',
  });

  const params = {
    month: filters.from || filters.to ? undefined : filters.month || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    departmentId: filters.departmentId || undefined,
    teamId: filters.teamId || undefined,
    employeeId: filters.employeeId || undefined,
  };

  const query = useQuery({
    queryKey: ['attendance', 'reports', type, filters],
    queryFn: () => api.get<AttendanceReport>(`/attendance/reports/${type}`, { query: params }),
    placeholderData: keepPreviousData,
    // The employee report is answered by the file below instead: a calendar,
    // the punches and the corrections say far more about one person than a
    // table of their days would.
    enabled: !(type === 'employee' && filters.employeeId !== ''),
  });

  const report = query.data;
  const showFile = type === 'employee' && filters.employeeId !== '';

  /**
   * The CSV is a plain link, not a fetch.
   *
   * The endpoint answers with a file and a Content-Disposition; letting the
   * browser handle that is both simpler and the only way the download lands
   * in the user's downloads folder rather than in memory.
   */
  const exportHref = () => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, String(value));
    }
    const qs = search.toString();
    return `/api/v1/attendance/reports/${type}/export${qs ? `?${qs}` : ''}`;
  };

  return (
    <>
      <PageHeader
        title="Attendance reports"
        description="Daily, monthly, per employee, per department and per team - plus the exception lists."
      />

      <Card className="mb-5 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
          <label className="xl:col-span-2">
            <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
              Report
            </span>
            <NativeSelect
              value={type}
              onChange={(e) => setType(e.target.value as AttendanceReportType)}
            >
              {ATTENDANCE_REPORT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {ATTENDANCE_REPORT_LABELS[value]}
                </option>
              ))}
            </NativeSelect>
          </label>

          <label>
            <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
              Month
            </span>
            <Input
              type="month"
              value={filters.month}
              onChange={(e) => setFilters({ ...filters, month: e.target.value, from: '', to: '' })}
            />
          </label>

          <label>
            <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
              From
            </span>
            <Input
              type="date"
              value={filters.from}
              onChange={(e) => setFilters({ ...filters, from: e.target.value })}
            />
          </label>

          <label>
            <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
              To
            </span>
            <Input
              type="date"
              value={filters.to}
              onChange={(e) => setFilters({ ...filters, to: e.target.value })}
            />
          </label>

          <label>
            <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
              Department
            </span>
            <NativeSelect
              value={filters.departmentId}
              onChange={(e) => setFilters({ ...filters, departmentId: e.target.value })}
            >
              <option value="">All</option>
              {lookups.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </NativeSelect>
          </label>

          <label>
            <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
              Team
            </span>
            <NativeSelect
              value={filters.teamId}
              onChange={(e) => setFilters({ ...filters, teamId: e.target.value })}
            >
              <option value="">All</option>
              {lookups.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>

        {type === 'employee' ? (
          <div className="mt-3">
            <EmployeePicker
              value={filters.employeeId}
              onChange={(employeeId) => setFilters({ ...filters, employeeId })}
            />
          </div>
        ) : null}

        <p className="mt-3 text-xs text-muted-foreground">
          Employees with no team are grouped as &ldquo;Unassigned&rdquo; rather than left out -
          nobody is forced into a team, and a report that quietly omitted them would understate the
          company.
        </p>
      </Card>

      {showFile ? (
        <EmployeeFile
          employeeId={filters.employeeId}
          month={params.month}
          from={params.from}
          to={params.to}
        />
      ) : null}

      <Card className={cn('overflow-hidden', showFile && 'hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold">{report?.title ?? 'Report'}</h2>
            {report ? (
              <p className="text-xs text-muted-foreground">
                {formatDate(report.from)} to {formatDate(report.to)} - {report.rows.length} row(s)
                {report.truncated ? ', cut at the server limit' : ''}
              </p>
            ) : null}
          </div>
          <Button asChild variant="outline" size="sm">
            <a href={exportHref()}>
              <Download className="size-4" aria-hidden />
              Export CSV
            </a>
          </Button>
        </div>

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isLoading || !report ? (
          <TableSkeleton rows={8} />
        ) : report.rows.length === 0 ? (
          <EmptyState
            icon={BarChart3}
            title="Nothing to report"
            description="No attendance matched this report over that range."
          />
        ) : (
          <TableWrapper>
            <Table>
              <THead>
                <TR>
                  {report.columns.map((column) => (
                    <TH key={column.key} className={column.align === 'right' ? 'text-right' : ''}>
                      {column.label}
                    </TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {report.rows.map((row, index) => (
                  <TR key={index}>
                    {report.columns.map((column) => (
                      <TD
                        key={column.key}
                        className={cn(
                          column.align === 'right' && 'text-right tabular-nums',
                          'whitespace-nowrap',
                        )}
                      >
                        {cell(row[column.key] ?? null, column)}
                      </TD>
                    ))}
                  </TR>
                ))}
                {report.totals ? (
                  <TR className="border-t-2 border-border bg-surface-muted/40 font-semibold">
                    {report.columns.map((column) => (
                      <TD
                        key={column.key}
                        className={cn(
                          column.align === 'right' && 'text-right tabular-nums',
                          'whitespace-nowrap',
                        )}
                      >
                        {report.totals![column.key] === undefined
                          ? ''
                          : cell(report.totals![column.key] ?? null, column)}
                      </TD>
                    ))}
                  </TR>
                ) : null}
              </TBody>
            </Table>
          </TableWrapper>
        )}
      </Card>
    </>
  );
}


/** Picks the employee an employee-level report is about. */
function EmployeePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (employeeId: string) => void;
}) {
  const [search, setSearch] = React.useState('');
  const debounced = useDebounced(search, 300);

  const query = useQuery({
    queryKey: ['employees', 'report-picker', debounced],
    queryFn: () =>
      api.get<{ data: EmployeeListItem[] }>('/employees', {
        query: { q: debounced || undefined, limit: 15 },
      }),
  });

  const rows = query.data?.data ?? [];

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,320px)_1fr] sm:items-start">
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search for an employee"
        aria-label="Search for an employee"
      />
      <div className="flex flex-wrap gap-1.5">
        {rows.map((employee) => (
          <button
            key={employee.id}
            type="button"
            onClick={() => onChange(employee.id)}
            className={cn(
              'rounded-md border border-input px-2.5 py-1 text-xs transition-colors hover:bg-accent/40',
              value === employee.id && 'border-primary bg-primary/10 font-medium text-primary',
            )}
          >
            {employee.fullName}
            <span className="ml-1.5 text-muted-foreground">{employee.employeeNumber}</span>
          </button>
        ))}
        {rows.length === 0 ? (
          <span className="text-xs text-muted-foreground">No matching employees.</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One employee's whole attendance file.
 *
 * The month as a calendar, the days behind it, the raw punches underneath
 * those, every correction anyone made, and the shifts they were on - one
 * request, so the five panels cannot describe five slightly different ranges.
 */
function EmployeeFile({
  employeeId,
  month,
  from,
  to,
}: {
  employeeId: string;
  month?: string;
  from?: string;
  to?: string;
}) {
  const query = useQuery({
    queryKey: ['attendance', 'employee-file', { employeeId, month, from, to }],
    queryFn: () =>
      api.get<AttendanceEmployeeFile>('/attendance/reports/employee-file', {
        query: { employeeId, month, from, to },
      }),
  });

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }
  if (query.isLoading || !query.data) {
    return (
      <Card>
        <TableSkeleton rows={8} />
      </Card>
    );
  }

  const file = query.data;
  const days = file.days;

  // Blank cells so the first day lands under the right weekday column.
  const leadingBlanks = days.length > 0 ? new Date(`${days[0]!.date}T00:00:00Z`).getUTCDay() : 0;

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h2 className="text-base font-semibold">{file.employee.name}</h2>
        <p className="text-[13px] text-muted-foreground">
          {file.employee.employeeNumber}
          {file.employee.departmentName ? ` - ${file.employee.departmentName}` : ''}
          {file.employee.teamName ? ` - ${file.employee.teamName}` : ''}
          {file.employee.designationName ? ` - ${file.employee.designationName}` : ''}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatDate(file.from)} to {formatDate(file.to)}
          {file.employee.punchCodes.length > 0
            ? ` - PunchCodes: ${file.employee.punchCodes
                .map((c) => `${c.deviceUserId} on ${c.deviceName}${c.isActive ? '' : ' (retired)'}`)
                .join(', ')}`
            : ' - no PunchCode mapped'}
        </p>

        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-muted-foreground">
          <span>
            <span className={cn('font-semibold', STATUS_TEXT.PRESENT)}>{file.totals.present}</span>{' '}
            present
          </span>
          <span>
            <span className={cn('font-semibold', STATUS_TEXT.HALF_DAY)}>{file.totals.halfDay}</span>{' '}
            half day
          </span>
          <span>
            <span className={cn('font-semibold', STATUS_TEXT.ABSENT)}>{file.totals.absent}</span>{' '}
            absent
          </span>
          <span>
            <span className={cn('font-semibold', STATUS_TEXT.ON_LEAVE)}>{file.totals.onLeave}</span>{' '}
            on leave
          </span>
          <span>
            <span className="font-semibold text-foreground">{file.totals.late}</span> late
          </span>
          <span>
            <span className="font-semibold text-foreground">{file.totals.earlyLeave}</span> early
          </span>
          <span>
            <span className="font-semibold text-foreground">
              {(file.totals.overtimeMinutes / 60).toFixed(1)}
            </span>{' '}
            OT hours
          </span>
          <span>
            <span className="font-semibold text-foreground">
              {file.totals.attendancePercentage === null
                ? '--'
                : `${file.totals.attendancePercentage}%`}
            </span>{' '}
            attendance
          </span>
        </div>
      </Card>

      {/* --- calendar -------------------------------------------------- */}
      <Card className="p-5">
        <h3 className="mb-3 text-sm font-semibold">Calendar</h3>
        <div className="grid grid-cols-7 gap-1.5">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label) => (
            <div key={label} className="pb-1 text-center text-xs text-muted-foreground">
              {label}
            </div>
          ))}
          {Array.from({ length: leadingBlanks }, (_, i) => (
            <div key={`blank-${i}`} />
          ))}
          {days.map((day) => (
            <div
              key={day.date}
              title={`${DERIVED_ATTENDANCE_STATUS_LABELS[day.status]}${day.flags.length ? ` - ${day.flags.map((f) => ATTENDANCE_FLAG_LABELS[f]).join(', ')}` : ''}`}
              className={cn(
                'rounded-md border p-1.5 text-center text-xs transition-colors',
                STATUS_CELL[day.status],
              )}
            >
              <div className="font-semibold">{Number(day.date.slice(8, 10))}</div>
              <div className="text-[10px] opacity-80">
                {day.workedMinutes === null ? '' : `${(day.workedMinutes / 60).toFixed(1)}h`}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* --- daily detail ---------------------------------------------- */}
      <Card className="overflow-hidden">
        <h3 className="border-b border-border px-5 py-3.5 text-sm font-semibold">Daily details</h3>
        <TableWrapper>
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                <TH>Status</TH>
                <TH>Shift</TH>
                <TH>In</TH>
                <TH>Out</TH>
                <TH className="text-right">Worked</TH>
                <TH className="text-right">Late</TH>
                <TH className="text-right">Early</TH>
                <TH className="text-right">OT</TH>
              </TR>
            </THead>
            <TBody>
              {days.map((day) => (
                <TR key={day.date}>
                  <TD className="whitespace-nowrap font-medium">{formatDate(day.date)}</TD>
                  <TD>
                    <div className="flex flex-wrap items-center gap-1">
                      <span>{DERIVED_ATTENDANCE_STATUS_LABELS[day.status]}</span>
                      {day.flags.map((flag) => (
                        <span key={flag} className={FLAG_BADGE[flag]}>
                          {ATTENDANCE_FLAG_LABELS[flag]}
                        </span>
                      ))}
                    </div>
                  </TD>
                  <TD className="text-muted-foreground">{day.shiftName ?? '--'}</TD>
                  <TD className="whitespace-nowrap">{timeLabel(day.checkInAt)}</TD>
                  <TD className="whitespace-nowrap">{timeLabel(day.checkOutAt)}</TD>
                  <TD className="text-right tabular-nums">{minutesLabel(day.workedMinutes)}</TD>
                  <TD className="text-right tabular-nums">{minutesLabel(day.lateMinutes)}</TD>
                  <TD className="text-right tabular-nums">
                    {minutesLabel(day.earlyLeaveMinutes)}
                  </TD>
                  <TD className="text-right tabular-nums">{minutesLabel(day.overtimeMinutes)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrapper>
      </Card>

      {/* --- raw punches ------------------------------------------------ */}
      <Card className="overflow-hidden">
        <h3 className="border-b border-border px-5 py-3.5 text-sm font-semibold">
          Raw punches ({file.rawPunches.length})
        </h3>
        {file.rawPunches.length === 0 ? (
          <EmptyState
            title="No device punches"
            description="Nothing in this range came from a terminal."
          />
        ) : (
          <TableWrapper>
            <Table>
              <THead>
                <TR>
                  <TH>Punched at</TH>
                  <TH>Device</TH>
                  <TH>PunchCode</TH>
                  <TH>Direction</TH>
                  <TH>Verify</TH>
                  <TH>Processed</TH>
                </TR>
              </THead>
              <TBody>
                {file.rawPunches.map((punch) => (
                  <TR key={punch.id}>
                    <TD className="whitespace-nowrap font-medium">
                      {new Date(punch.punchedAt).toLocaleString()}
                    </TD>
                    <TD className="text-muted-foreground">{punch.deviceName}</TD>
                    <TD className="font-mono text-[13px]">{punch.deviceUserId}</TD>
                    <TD className="text-muted-foreground">{punch.punchState ?? '--'}</TD>
                    <TD className="text-muted-foreground">{punch.verifyMode ?? '--'}</TD>
                    <TD className="text-muted-foreground">
                      {punch.processedAt ? formatDate(punch.processedAt) : 'Pending'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrapper>
        )}
      </Card>

      {/* --- corrections ------------------------------------------------ */}
      <Card className="overflow-hidden">
        <h3 className="border-b border-border px-5 py-3.5 text-sm font-semibold">
          Corrections ({file.adjustments.length})
        </h3>
        {file.adjustments.length === 0 ? (
          <EmptyState
            title="No corrections"
            description="Nothing in this range has been corrected by hand."
          />
        ) : (
          <ul className="divide-y divide-border">
            {file.adjustments.map((entry) => (
              <li key={entry.id} className="px-5 py-3 text-[13px]">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {formatDate(entry.date)} - {entry.actorName ?? 'System'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="mt-0.5 text-muted-foreground">{entry.reason}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Changed: {entry.changedFields.join(', ')}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* --- shift history ---------------------------------------------- */}
      <Card className="overflow-hidden">
        <h3 className="border-b border-border px-5 py-3.5 text-sm font-semibold">Shift history</h3>
        {file.shiftHistory.length === 0 ? (
          <EmptyState
            title="No shift assignment"
            description="This employee was scored against the company default window."
          />
        ) : (
          <TableWrapper>
            <Table>
              <THead>
                <TR>
                  <TH>Shift</TH>
                  <TH>Window</TH>
                  <TH>From</TH>
                  <TH>To</TH>
                </TR>
              </THead>
              <TBody>
                {file.shiftHistory.map((assignment) => (
                  <TR key={assignment.id}>
                    <TD className="font-medium">{assignment.shiftName}</TD>
                    <TD className="text-muted-foreground">
                      {assignment.startTime}-{assignment.endTime}
                    </TD>
                    <TD>{formatDate(assignment.effectiveFrom)}</TD>
                    <TD className="text-muted-foreground">
                      {assignment.effectiveTo ? formatDate(assignment.effectiveTo) : 'Still in force'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrapper>
        )}
      </Card>
    </div>
  );
}
