import { Link } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import type { AttendanceDay } from '@hrms/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmployeeAttendanceBars } from '@/features/time/employee-attendance-bars';

/**
 * The caller's own month, as bars, on their dashboard.
 *
 * Deliberately thin. The chart is `EmployeeAttendanceBars` - the same component
 * the individual attendance page draws, with the same colours, the same
 * tooltip, the same axis and the same rule that bar height is `workedMinutes`
 * and nothing else. This file adds a card around it, a shorter plot, and a way
 * through to the full page; it does not draw a bar, pick a colour or decide
 * what a status means, and it must never start to. A second chart would be a
 * second answer to "how did my month go", and the two would drift.
 *
 * The days come from the dashboard's existing `/attendance/summary` request -
 * the one whose totals the cards above already count - so adding this chart
 * costs no extra query and cannot disagree with the numbers beside it.
 */
export function MyAttendanceBarsCard({
  days,
  employeeName,
  month,
  loading = false,
}: {
  days: AttendanceDay[];
  employeeName: string;
  /** `YYYY-MM`, for the heading. */
  month: string;
  loading?: boolean;
}) {
  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="size-4" aria-hidden /> My attendance
          </CardTitle>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{monthLabel}</p>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/attendance">View attendance</Link>
        </Button>
      </CardHeader>

      <CardContent>
        {/*
          Shorter than the full page's 224px, and the legend left to the page
          that has room for it. A dashboard card is a glance; the detail, the
          key and the table are one click away behind the header link.

          Everything else about the chart is untouched, including the sideways
          scroll that keeps a 31-day month legible on a phone.
        */}
        <EmployeeAttendanceBars
          days={days}
          employeeName={employeeName}
          loading={loading}
          plotHeight={132}
          showLegend={false}
          hint={false}
        />
      </CardContent>
    </Card>
  );
}
