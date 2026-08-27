import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  ATTENDANCE_STATUS_LABELS,
  type AttendanceDay,
  type AttendanceStatus,
  type AttendanceTotals,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { cn } from '@/lib/utils';
import { STATUS_CELL } from './attendance-ui';

const monthLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * Month grid of derived attendance.
 *
 * Every calendar day appears, including ones with no record - the API
 * classifies them as weekend, holiday, leave or absent, so a gap in the grid
 * always means something specific rather than missing data.
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

  // Blank cells so the first day lands under the right weekday column.
  const leadingBlanks = days.length > 0 ? new Date(`${days[0]!.date}T00:00:00Z`).getUTCDay() : 0;

  return (
    <Card className="mb-6">
      <CardHeader bordered className="flex-row items-center justify-between">
        <CardTitle>{monthLabel(month)}</CardTitle>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="Next month" onClick={() => shiftMonth(1)}>
            <ChevronRight />
          </Button>
        </div>
      </CardHeader>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <CardContent>
          {totals ? (
            <div className="tabular mb-4 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-muted-foreground">
              <span><span className="font-medium text-foreground">{totals.present}</span> present</span>
              {totals.halfDay > 0 ? (
                <span><span className="font-medium text-foreground">{totals.halfDay}</span> half day</span>
              ) : null}
              <span><span className="font-medium text-foreground">{totals.absent}</span> absent</span>
              <span><span className="font-medium text-foreground">{totals.onLeave}</span> on leave</span>
              <span><span className="font-medium text-foreground">{totals.holiday}</span> holiday</span>
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

          <div className="grid grid-cols-7 gap-1.5" role="grid" aria-label="Attendance calendar">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d} className="pb-1 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {d}
              </div>
            ))}

            {query.isLoading
              ? Array.from({ length: 35 }).map((_, i) => (
                  <Skeleton key={i} className="aspect-square rounded-lg" />
                ))
              : (
                <>
                  {Array.from({ length: leadingBlanks }).map((_, i) => (
                    <div key={`blank-${i}`} aria-hidden />
                  ))}
                  {days.map((day) => {
                    const dayNumber = Number(day.date.slice(8, 10));
                    const title = [
                      day.date,
                      ATTENDANCE_STATUS_LABELS[day.status],
                      day.holidayName ?? day.leaveTypeName ?? '',
                      day.workedMinutes !== null ? `${(day.workedMinutes / 60).toFixed(1)}h` : '',
                      day.lateMinutes ? `${day.lateMinutes}m late` : '',
                      day.overtimeMinutes ? `${day.overtimeMinutes}m overtime` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ');

                    return (
                      <div
                        key={day.date}
                        title={title}
                        className={cn(
                          'flex aspect-square flex-col items-center justify-center rounded-lg border p-1 text-center',
                          STATUS_CELL[day.status],
                        )}
                      >
                        <span className="tabular text-[13px] font-semibold leading-none">{dayNumber}</span>
                        <span className="mt-1 line-clamp-2 text-[9.5px] leading-tight opacity-80">
                          {day.holidayName ?? day.leaveTypeName ?? ATTENDANCE_STATUS_LABELS[day.status]}
                        </span>
                      </div>
                    );
                  })}
                </>
              )}
          </div>

          <div className="mt-4 flex flex-wrap gap-3 border-t border-border pt-3 text-[11.5px] text-muted-foreground">
            {(Object.keys(STATUS_CELL) as AttendanceStatus[]).map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span className={cn('size-3 rounded border', STATUS_CELL[s])} aria-hidden />
                {ATTENDANCE_STATUS_LABELS[s]}
              </span>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
