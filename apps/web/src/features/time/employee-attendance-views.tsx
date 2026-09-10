import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, CalendarClock, CalendarDays, Table as TableIcon } from 'lucide-react';
import {
  ATTENDANCE_FLAG_LABELS,
  DERIVED_ATTENDANCE_STATUS_LABELS,
  type AttendanceDay,
  type AttendanceTotals,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ViewSwitcher, type ViewOption } from '@/components/ui/view-switcher';
import { useStickyState } from '@/lib/use-sticky-state';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { TableSkeleton } from '@/components/ui/skeleton';
import { CalendarGrid, MonthNav, cellFromDay } from './attendance-calendar';
import { EmployeeAttendanceBars } from './employee-attendance-bars';
import { LATE_TEXT, STATUS_BADGE, STATUS_TEXT, minutesLabel, timeLabel } from './attendance-ui';

/**
 * One employee's month, in whichever of three shapes the reader asks for.
 *
 * The month and the request live HERE, above the switcher, and all three views
 * are handed the same `days` array. That is the whole point of the arrangement:
 * switching view changes the presentation and nothing else, and stepping to the
 * previous month moves all three at once. When each view owned its own month
 * and its own query - which is how this started out on the other attendance
 * screens - a switch silently answered a different question than the one the
 * reader had asked.
 *
 * There is exactly one request: `/attendance/summary` for this employee and
 * this month, the same endpoint the calendar has always used. No view fetches
 * anything of its own, so the three cannot disagree.
 *
 * NOTHING here knows what a working day is worth. No hour count, no grace
 * period, no late, half-day, full-day or overtime threshold appears in this
 * file or in the views below it. Those all live in the company's attendance
 * policy, are applied by the engine on the server, and reach this file already
 * decided - as `status`, `flags`, `workedMinutes`, `lateMinutes`,
 * `earlyLeaveMinutes` and `overtimeMinutes`. Change the policy from an
 * eight-hour day to a nine-hour one and every view below re-reads without being
 * edited.
 */

const monthLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The weekday for the table's "Day" column. */
const weekdayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short',
    timeZone: 'UTC',
  });

type EmployeeView = 'table' | 'calendar' | 'bars';

const VIEWS: ReadonlyArray<ViewOption<EmployeeView>> = [
  { key: 'table', label: 'Table', icon: TableIcon },
  { key: 'calendar', label: 'Calendar', icon: CalendarDays },
  { key: 'bars', label: 'Bars', icon: BarChart3 },
];

const VIEW_KEYS = VIEWS.map((v) => v.key);

/**
 * Remembered across visits - but Calendar is the fallback, deliberately.
 *
 * Calendar is what this page has always opened on, so somebody who has never
 * touched the switcher sees exactly what they saw yesterday.
 */
const VIEW_STORAGE_KEY = 'hrms.employee-attendance.view';

interface SummaryResponse {
  days: AttendanceDay[];
  totals: AttendanceTotals;
}

export function EmployeeAttendanceViews({
  employeeId,
  employeeName,
}: {
  employeeId: string;
  employeeName: string;
}) {
  const [month, setMonth] = React.useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });
  const [view, setView] = useStickyState<EmployeeView>(VIEW_STORAGE_KEY, 'calendar', VIEW_KEYS);

  const from = month.toISOString().slice(0, 10);
  const to = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);

  const query = useQuery({
    queryKey: ['attendance', 'summary', { from, to, employeeId }],
    queryFn: () =>
      api.get<SummaryResponse>('/attendance/summary', { query: { from, to, employeeId } }),
    enabled: Boolean(employeeId),
  });

  const shiftMonth = (delta: number) =>
    setMonth((prev) => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + delta, 1)));

  // Defensive on purpose: an employee with nothing recorded, a month that has
  // not started, or a response missing `days` all reach here, and none of them
  // is a crash.
  const days = query.data?.days ?? [];
  const totals = query.data?.totals;

  return (
    <Card className="mb-6">
      <CardHeader bordered className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{monthLabel(month)}</CardTitle>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <ViewSwitcher
            value={view}
            onChange={setView}
            options={VIEWS}
            label="Attendance view"
          />
          <MonthNav onShift={shiftMonth} className="self-start sm:self-auto" />
        </div>
      </CardHeader>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <CardContent>
          {totals ? <MonthTotals totals={totals} /> : null}

          {view === 'calendar' ? (
            <CalendarGrid cells={days.map(cellFromDay)} loading={query.isLoading} />
          ) : view === 'bars' ? (
            <EmployeeAttendanceBars
              days={days}
              employeeName={employeeName}
              loading={query.isLoading}
            />
          ) : (
            <DayTable days={days} loading={query.isLoading} />
          )}
        </CardContent>
      )}
    </Card>
  );
}

/**
 * The month's figures, as the calendar has always shown them.
 *
 * Shared by all three views so the headline does not change shape when the
 * presentation does. Every number is the engine's own total.
 */
function MonthTotals({ totals }: { totals: AttendanceTotals }) {
  return (
    <div className="tabular mb-4 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-muted-foreground">
      <span>
        <span className={cn('font-semibold', STATUS_TEXT.PRESENT)}>{totals.present}</span> present
      </span>
      {totals.halfDay > 0 ? (
        <span>
          <span className={cn('font-semibold', STATUS_TEXT.HALF_DAY)}>{totals.halfDay}</span> half
          day
        </span>
      ) : null}
      <span>
        <span className={cn('font-semibold', STATUS_TEXT.ABSENT)}>{totals.absent}</span> absent
      </span>
      <span>
        <span className={cn('font-semibold', STATUS_TEXT.ON_LEAVE)}>{totals.onLeave}</span> on leave
      </span>
      <span>
        <span className={cn('font-semibold', STATUS_TEXT.HOLIDAY)}>{totals.holiday}</span> holiday
      </span>
      <span>
        <span className="font-medium text-foreground">
          {(totals.workedMinutes / 60).toFixed(1)}
        </span>{' '}
        hours worked
      </span>
      {totals.overtimeMinutes > 0 ? (
        <span>
          <span className="font-medium text-foreground">
            {(totals.overtimeMinutes / 60).toFixed(1)}
          </span>{' '}
          hours overtime
        </span>
      ) : null}
      {totals.lateMinutes > 0 ? (
        <span>
          <span className="font-medium text-foreground">{totals.lateMinutes}</span> minutes late
        </span>
      ) : null}
    </div>
  );
}

/**
 * The month day by day.
 *
 * Every calendar day appears, including the ones with no record: the engine
 * classifies those as weekend, holiday, leave or absent, so a gap always means
 * something specific rather than missing data. A figure that does not apply to
 * a day is a dash rather than a zero, because a zero is a claim.
 */
function DayTable({ days, loading }: { days: AttendanceDay[]; loading: boolean }) {
  return (
    <TableWrapper>
      <Table>
        <THead>
          <TR className="hover:bg-transparent">
            <TH className="w-28">Date</TH>
            <TH className="w-16">Day</TH>
            <TH className="w-24">Check in</TH>
            <TH className="w-24">Check out</TH>
            <TH className="w-24 text-right">Worked</TH>
            <TH className="w-20 text-right">Late</TH>
            <TH className="w-20 text-right">Early</TH>
            <TH className="w-24 text-right">Overtime</TH>
            <TH className="w-32">Shift</TH>
            <TH className="w-28">Status</TH>
            <TH className="w-36">Notes</TH>
          </TR>
        </THead>
        <TBody>
          {loading ? (
            <TableSkeleton rows={8} columns={11} />
          ) : days.length === 0 ? (
            <TR className="hover:bg-transparent">
              <TD colSpan={11} className="p-0">
                <EmptyState
                  icon={CalendarClock}
                  title="Nothing in this month"
                  description="Step to another month with the arrows above."
                />
              </TD>
            </TR>
          ) : (
            days.map((day) => <DayRow key={day.date} day={day} />)
          )}
        </TBody>
      </Table>
    </TableWrapper>
  );
}

function DayRow({ day }: { day: AttendanceDay }) {
  const flags = day.flags ?? [];
  const missingPunch = flags.includes('MISSING_PUNCH');

  return (
    <TR>
      <TD className="tabular text-[13px]">{day.date}</TD>
      <TD className="text-[12.5px] text-muted-foreground">{weekdayLabel(day.date)}</TD>
      <TD className="tabular text-[13px] text-muted-foreground">
        {day.checkInAt ? timeLabel(day.checkInAt) : '--'}
      </TD>
      <TD className="tabular text-[13px] text-muted-foreground">
        {day.checkOutAt ? (
          timeLabel(day.checkOutAt)
        ) : missingPunch ? (
          <span className={LATE_TEXT}>Missing</span>
        ) : (
          '--'
        )}
      </TD>
      <TD className="tabular text-right text-[13px]">{minutesLabel(day.workedMinutes)}</TD>
      <TD className="tabular text-right text-[13px]">
        {day.lateMinutes ? (
          <span className={LATE_TEXT}>{day.lateMinutes}m</span>
        ) : (
          <span className="text-muted-foreground">--</span>
        )}
      </TD>
      <TD className="tabular text-right text-[13px]">
        {day.earlyLeaveMinutes ? (
          <span className={LATE_TEXT}>{day.earlyLeaveMinutes}m</span>
        ) : (
          <span className="text-muted-foreground">--</span>
        )}
      </TD>
      <TD className="tabular text-right text-[13px]">
        {day.overtimeMinutes ? (
          <span className="text-success">{minutesLabel(day.overtimeMinutes)}</span>
        ) : (
          <span className="text-muted-foreground">--</span>
        )}
      </TD>
      <TD className="text-[12.5px] text-muted-foreground">
        {day.shiftName ?? <span className="italic text-muted-foreground/80">Unassigned</span>}
      </TD>
      <TD>
        <span className={STATUS_BADGE[day.status]}>
          {DERIVED_ATTENDANCE_STATUS_LABELS[day.status] ?? day.status}
        </span>
      </TD>
      {/*
        The correction indicator. MANUAL is the engine's own flag for a day an
        administrator adjusted through the correction centre - it is not
        recomputed here, and a corrected day is never silently identical to one
        the terminal produced.
      */}
      <TD className="text-[11.5px] text-muted-foreground">
        <div className="flex flex-wrap gap-1">
          {day.holidayName ?? day.leaveTypeName ? (
            <span className="text-foreground">{day.holidayName ?? day.leaveTypeName}</span>
          ) : null}
          {flags.map((flag) => (
            <span
              key={flag}
              className={cn(
                'rounded border px-1 py-px',
                flag === 'MANUAL'
                  ? 'border-att-holiday-border text-att-holiday-foreground'
                  : 'border-border',
              )}
            >
              {ATTENDANCE_FLAG_LABELS[flag] ?? flag}
            </span>
          ))}
        </div>
      </TD>
    </TR>
  );
}
