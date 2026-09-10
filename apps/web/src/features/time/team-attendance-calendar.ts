import {
  DERIVED_ATTENDANCE_STATUS_LABELS,
  type DerivedAttendanceStatus,
  type TeamAttendanceRow,
} from '@hrms/shared';
import type { CalendarCell } from './attendance-calendar';

/**
 * The team's range, tallied into one calendar cell per date.
 *
 * A tally, not a derivation. Every day counted here was already classified by
 * the attendance engine on the server; this only groups those classifications
 * by date and counts them, exactly as the totals strip above the table does.
 *
 * A date with several people on it has no single status - eleven were in and
 * one was not - so the cell takes the character of the DAY where the day has
 * one (a holiday, a weekend, a date that has not arrived) and prints a headcount
 * otherwise. With one employee in scope the tally has one entry and the cell is
 * simply that person's status, which is the reading the personal calendar has
 * always shown.
 */

interface Tally {
  date: string;
  total: number;
  present: number;
  halfDay: number;
  absent: number;
  onLeave: number;
  holiday: number;
  weekend: number;
  offDay: number;
  upcoming: number;
  workedMinutes: number;
  lateMinutes: number;
  overtimeMinutes: number;
  holidayName: string | null;
}

const empty = (date: string): Tally => ({
  date,
  total: 0,
  present: 0,
  halfDay: 0,
  absent: 0,
  onLeave: 0,
  holiday: 0,
  weekend: 0,
  offDay: 0,
  upcoming: 0,
  workedMinutes: 0,
  lateMinutes: 0,
  overtimeMinutes: 0,
  holidayName: null,
});

/** Which bucket a derived status lands in. Unknown statuses are simply not counted. */
const BUCKET: Partial<Record<DerivedAttendanceStatus, keyof Tally>> = {
  PRESENT: 'present',
  HALF_DAY: 'halfDay',
  ABSENT: 'absent',
  ON_LEAVE: 'onLeave',
  HOLIDAY: 'holiday',
  WEEKEND: 'weekend',
  OFF_DAY: 'offDay',
  UPCOMING: 'upcoming',
};

export function teamCalendarCells(rows: readonly TeamAttendanceRow[]): CalendarCell[] {
  const byDate = new Map<string, Tally>();

  for (const row of rows) {
    // `days` is optional in practice: a row for somebody with nothing in the
    // range can arrive without it, and a missing array is not a crash.
    for (const day of row?.days ?? []) {
      if (!day?.date) continue;
      const tally = byDate.get(day.date) ?? empty(day.date);
      tally.total += 1;

      const bucket = BUCKET[day.status];
      if (bucket) (tally[bucket] as number) += 1;

      tally.workedMinutes += day.workedMinutes ?? 0;
      tally.lateMinutes += day.lateMinutes ?? 0;
      tally.overtimeMinutes += day.overtimeMinutes ?? 0;
      if (day.holidayName && !tally.holidayName) tally.holidayName = day.holidayName;

      byDate.set(day.date, tally);
    }
  }

  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((tally) => {
      const attended = tally.present + tally.halfDay;

      // The day's own character wins, but only when it is true of EVERYONE on
      // it. One person's rostered off day does not make the date a weekend for
      // the team.
      const status: DerivedAttendanceStatus =
        tally.total > 0 && tally.holiday === tally.total
          ? 'HOLIDAY'
          : tally.total > 0 && tally.weekend === tally.total
            ? 'WEEKEND'
            : tally.total > 0 && tally.offDay === tally.total
              ? 'OFF_DAY'
              : tally.total > 0 && tally.upcoming === tally.total
                ? 'UPCOMING'
                : tally.absent > 0
                  ? 'ABSENT'
                  : attended > 0
                    ? 'PRESENT'
                    : tally.onLeave > 0
                      ? 'ON_LEAVE'
                      : 'WEEKEND';

      const working =
        status !== 'HOLIDAY' &&
        status !== 'WEEKEND' &&
        status !== 'OFF_DAY' &&
        status !== 'UPCOMING';

      const label =
        tally.holidayName ??
        (working
          ? `${attended}/${tally.total} in`
          : (DERIVED_ATTENDANCE_STATUS_LABELS[status] ?? status));

      const detail = [
        tally.date,
        !working ? (DERIVED_ATTENDANCE_STATUS_LABELS[status] ?? status) : null,
        tally.holidayName,
        working ? `${attended} of ${tally.total} present` : null,
        tally.absent > 0 ? `${tally.absent} absent` : null,
        tally.onLeave > 0 ? `${tally.onLeave} on leave` : null,
        tally.workedMinutes > 0 ? `${(tally.workedMinutes / 60).toFixed(1)}h worked` : null,
        tally.lateMinutes > 0 ? `${tally.lateMinutes}m late` : null,
        tally.overtimeMinutes > 0 ? `${tally.overtimeMinutes}m overtime` : null,
      ]
        .filter(Boolean)
        .join(' · ');

      return { date: tally.date, status, label, detail };
    });
}
