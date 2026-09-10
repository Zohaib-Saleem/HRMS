import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  DERIVED_ATTENDANCE_STATUS_LABELS,
  type DerivedAttendanceStatus,
  type AttendanceDay,
  type AttendanceTotals,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { cn } from '@/lib/utils';
import { STATUS_CELL, STATUS_COLOR, STATUS_TEXT } from './attendance-ui';

const monthLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * One cell of the month grid.
 *
 * Deliberately not `AttendanceDay`. The same grid draws one person's month -
 * where a cell is a status - and the whole workforce's month, where a cell is a
 * tally and no single status is true of it. Reducing both to a colour and two
 * short lines is what lets one grid serve both without either lying.
 */
export interface CalendarCell {
  date: string;
  /** Which `--att-*` colour the cell takes. */
  status: DerivedAttendanceStatus;
  /** The line under the day number. Kept to a couple of words. */
  label: string;
  /** The full text for the title attribute and the accessible name. */
  detail: string;
}

/** One person's derived day, as a cell. The reading the calendar always had. */
export function cellFromDay(day: AttendanceDay): CalendarCell {
  return {
    date: day.date,
    status: day.status,
    label: day.holidayName ?? day.leaveTypeName ?? DERIVED_ATTENDANCE_STATUS_LABELS[day.status],
    detail: [
      day.date,
      DERIVED_ATTENDANCE_STATUS_LABELS[day.status],
      day.holidayName ?? day.leaveTypeName ?? '',
      day.workedMinutes !== null ? `${(day.workedMinutes / 60).toFixed(1)}h` : '',
      day.lateMinutes ? `${day.lateMinutes}m late` : '',
      day.overtimeMinutes ? `${day.overtimeMinutes}m overtime` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

interface GridProps {
  cells: CalendarCell[];
  loading?: boolean;
  selectedDate?: string | null;
  onSelectDate?: ((date: string) => void) | undefined;
}

/**
 * The month grid itself.
 *
 * Every calendar day appears, including ones with no record - the API
 * classifies them as weekend, holiday, leave or absent, so a gap in the grid
 * always means something specific rather than missing data.
 *
 * A cell is a button only when there is somewhere to go. A static grid of
 * buttons that do nothing is worse for a screen reader than a static grid.
 */
export function CalendarGrid({ cells, loading = false, selectedDate, onSelectDate }: GridProps) {
  // Blank cells so the first day lands under the right weekday column.
  const leadingBlanks = cells.length > 0 ? new Date(`${cells[0]!.date}T00:00:00Z`).getUTCDay() : 0;

  return (
    <>
      <div className="grid grid-cols-7 gap-1 sm:gap-1.5" role="grid" aria-label="Attendance calendar">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div
            key={d}
            className="pb-1 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:text-[11px]"
          >
            {d}
          </div>
        ))}

        {loading ? (
          Array.from({ length: 35 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-lg" />
          ))
        ) : (
          <>
            {Array.from({ length: leadingBlanks }).map((_, i) => (
              <div key={`blank-${i}`} aria-hidden />
            ))}
            {cells.map((cell) => {
              const dayNumber = Number(cell.date.slice(8, 10));
              const selected = cell.date === selectedDate;
              const className = cn(
                'flex aspect-square flex-col items-center justify-center rounded-lg border p-1 text-center transition-colors',
                STATUS_CELL[cell.status],
                selected && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
              );
              const body = (
                <>
                  <span className="tabular text-[12px] font-semibold leading-none sm:text-[13px]">
                    {dayNumber}
                  </span>
                  <span className="mt-1 line-clamp-2 text-[9px] font-medium leading-tight sm:text-[9.5px]">
                    {cell.label}
                  </span>
                </>
              );

              return onSelectDate ? (
                <button
                  key={cell.date}
                  type="button"
                  title={cell.detail}
                  aria-label={cell.detail}
                  aria-pressed={selected}
                  onClick={() => onSelectDate(cell.date)}
                  className={cn(className, 'cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring')}
                >
                  {body}
                </button>
              ) : (
                <div key={cell.date} title={cell.detail} className={className}>
                  {body}
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2.5 border-t border-border pt-3 text-[11px] text-muted-foreground sm:gap-3 sm:text-[11.5px]">
        {(Object.keys(STATUS_COLOR) as DerivedAttendanceStatus[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className={cn('size-3 rounded border', STATUS_COLOR[s])} aria-hidden />
            {DERIVED_ATTENDANCE_STATUS_LABELS[s]}
          </span>
        ))}
      </div>
    </>
  );
}

/** Previous / next month, shared by every caller that navigates months. */
export function MonthNav({
  onShift,
  className,
}: {
  onShift: (delta: number) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Button variant="outline" size="icon-sm" aria-label="Previous month" onClick={() => onShift(-1)}>
        <ChevronLeft />
      </Button>
      <Button variant="outline" size="icon-sm" aria-label="Next month" onClick={() => onShift(1)}>
        <ChevronRight />
      </Button>
    </div>
  );
}

/**
 * One person's month of derived attendance, fetching its own data.
 *
 * The personal calendar as it has always been: its own month state, its own
 * request to `/attendance/summary`, its own totals strip. The grid underneath
 * is now shared with the analytics view so the two can never disagree about
 * what a status looks like.
 */
export function AttendanceCalendar({ employeeId }: { employeeId?: string }) {
  const [month, setMonth] = React.useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });

  const from = month.toISOString().slice(0, 10);
  const to = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);

  const query = useQuery({
    queryKey: ['attendance', 'summary', { from, to, employeeId }],
    queryFn: () =>
      api.get<{ days: AttendanceDay[]; totals: AttendanceTotals }>('/attendance/summary', {
        query: { from, to, employeeId },
      }),
  });

  const shiftMonth = (delta: number) =>
    setMonth((prev) => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + delta, 1)));

  const days = query.data?.days ?? [];
  const totals = query.data?.totals;

  return (
    <Card className="mb-6">
      <CardHeader bordered className="flex-row items-center justify-between">
        <CardTitle>{monthLabel(month)}</CardTitle>
        <MonthNav onShift={shiftMonth} />
      </CardHeader>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <CardContent>
          {totals ? (
            <div className="tabular mb-4 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-muted-foreground">
              <span><span className={cn('font-semibold', STATUS_TEXT.PRESENT)}>{totals.present}</span> present</span>
              {totals.halfDay > 0 ? (
                <span><span className={cn('font-semibold', STATUS_TEXT.HALF_DAY)}>{totals.halfDay}</span> half day</span>
              ) : null}
              <span><span className={cn('font-semibold', STATUS_TEXT.ABSENT)}>{totals.absent}</span> absent</span>
              <span><span className={cn('font-semibold', STATUS_TEXT.ON_LEAVE)}>{totals.onLeave}</span> on leave</span>
              <span><span className={cn('font-semibold', STATUS_TEXT.HOLIDAY)}>{totals.holiday}</span> holiday</span>
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
                <span><span className="font-medium text-foreground">{totals.lateMinutes}</span> minutes late</span>
              ) : null}
            </div>
          ) : null}

          <CalendarGrid cells={days.map(cellFromDay)} loading={query.isLoading} />
        </CardContent>
      )}
    </Card>
  );
}
