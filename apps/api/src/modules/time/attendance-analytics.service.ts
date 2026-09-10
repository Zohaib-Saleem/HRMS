import type {
  AttendanceAnalyticsSummary,
  AttendanceDailyTotal,
  DerivedAttendanceStatus,
} from '@hrms/shared';
import type { DerivedDay } from './attendance.service.js';

/**
 * Daily aggregation for the attendance bar chart.
 *
 * Pure arithmetic over days the engine has already derived. Nothing here
 * classifies a day, scores one, or decides what counts as late: it receives
 * `DerivedDay` values - the same ones the table, the calendar and every report
 * are built from - and adds them up.
 *
 * That is the whole point of the file. The chart cannot show a different month
 * from the table, because it is not a second calculation; it is a sum of the
 * first one.
 */

const emptySplit = () => ({ onTimeMinutes: 0, lateWorkedMinutes: 0, overtimeMinutes: 0 });

function emptyDay(date: string): AttendanceDailyTotal {
  return {
    date,
    ...emptySplit(),
    employeeCount: 0,
    present: 0,
    halfDay: 0,
    absent: 0,
    onLeave: 0,
    holiday: 0,
    weekend: 0,
    offDay: 0,
    upcoming: 0,
    workedMinutes: 0,
    expectedMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    lateCount: 0,
    overtimeCount: 0,
    firstCheckInAt: null,
    lastCheckOutAt: null,
    dayState: 'WORKING',
    holidayName: null,
  };
}

export function emptySummary(): AttendanceAnalyticsSummary {
  return {
    totalEmployees: 0,
    present: 0,
    absent: 0,
    halfDay: 0,
    onLeave: 0,
    holiday: 0,
    weekend: 0,
    offDay: 0,
    upcoming: 0,
    workedMinutes: 0,
    overtimeMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    averageWorkedMinutes: null,
    attendancePercentage: null,
  };
}

/** Which counter on the row a status increments. One place, so nothing drifts. */
const COUNTER: Record<DerivedAttendanceStatus, keyof AttendanceDailyTotal> = {
  PRESENT: 'present',
  HALF_DAY: 'halfDay',
  ABSENT: 'absent',
  ON_LEAVE: 'onLeave',
  HOLIDAY: 'holiday',
  WEEKEND: 'weekend',
  OFF_DAY: 'offDay',
  UPCOMING: 'upcoming',
};

/**
 * The character of the whole day, for the ribbon under the column.
 *
 * A day is a holiday, a weekend, an off day or still ahead only when that is
 * true of EVERY employee-day counted for it. Anyone working means the day is a
 * working day that some people did not work - which is an absence, shown in the
 * counts, and not a property of the date.
 *
 * Read from statuses the deriver assigned, so a company whose weekend is
 * Friday-Saturday gets the right answer without this file knowing that.
 */
function dayStateFor(row: AttendanceDailyTotal): AttendanceDailyTotal['dayState'] {
  if (row.employeeCount === 0) return 'WORKING';
  if (row.holiday === row.employeeCount) return 'HOLIDAY';
  if (row.weekend === row.employeeCount) return 'WEEKEND';
  if (row.offDay === row.employeeCount) return 'OFF_DAY';
  if (row.weekend + row.offDay === row.employeeCount) return 'WEEKEND';
  /**
   * Upcoming as soon as nobody has been scored yet.
   *
   * Not `upcoming === employeeCount`: one person with approved leave booked
   * three weeks out is enough to break that equality, and the day would then
   * be drawn as an ordinary working day nobody attended. Nothing has been
   * scored on it, so it has not happened - the leave still shows in the counts
   * and in the ribbon, which is where a future booking belongs.
   */
  if (row.upcoming > 0 && row.present + row.halfDay + row.absent === 0) return 'UPCOMING';
  return 'WORKING';
}

export interface AggregateInput {
  /** Every calendar date in the range, in order. Days with no data still appear. */
  dates: readonly string[];
  /** Derived days per employee, exactly as `deriveRangeForEmployees` returns them. */
  byEmployee: ReadonlyMap<string, DerivedDay[]>;
  /** Applied to employee-days before anything is counted. */
  status?: DerivedAttendanceStatus | undefined;
}

export interface AggregateResult {
  days: AttendanceDailyTotal[];
  summary: AttendanceAnalyticsSummary;
}

/**
 * Sums derived days into one row per calendar date, plus the headline summary.
 *
 * Every date in the range is returned whether or not anything happened on it: a
 * month with no records is a chart of empty columns, which is a true and
 * readable answer, and not an empty chart that looks like a failed request.
 */
export function aggregateDailyTotals(input: AggregateInput): AggregateResult {
  const { dates, byEmployee, status } = input;

  const rows = new Map<string, AttendanceDailyTotal>();
  for (const date of dates) rows.set(date, emptyDay(date));

  const summary = emptySummary();
  /** Employees who contributed at least one counted day - people, not days. */
  const contributors = new Set<string>();
  /** Denominators, kept out of the summary until they are known to be non-zero. */
  let workedDays = 0;
  let scored = 0;
  let attended = 0;
  /** A holiday name is only the day's name while every employee agrees on it. */
  const holidayNames = new Map<string, Set<string>>();

  for (const [employeeId, days] of byEmployee) {
    for (const day of days) {
      if (status && day.status !== status) continue;
      const row = rows.get(day.date);
      // A derived day outside the requested range would be a caller error; drop
      // it rather than inventing a column the axis does not have.
      if (!row) continue;

      contributors.add(employeeId);
      row.employeeCount += 1;
      (row[COUNTER[day.status]] as number) += 1;

      const worked = day.workedMinutes ?? 0;
      const overtime = day.overtimeMinutes ?? 0;
      const late = day.lateMinutes ?? 0;
      const early = day.earlyLeaveMinutes ?? 0;

      /**
       * Worked time, split three ways and never double counted.
       *
       * Overtime comes out of worked time because that is what it is - a label
       * on part of it. `regular` is clamped at zero so a column can never be
       * drawn shorter than the truth.
       *
       * The overtime figure itself is NOT clamped, and that is the point: it
       * used to be `Math.min(overtime, worked)` here while the summary beside
       * it, and every report and CSV, added the raw value. The chart and its
       * own export could therefore disagree about the same day. One figure,
       * added the same way everywhere, is worth more than a tidier bar.
       */
      const regular = Math.max(0, worked - overtime);
      const isLate = day.flags.includes('LATE');
      if (isLate) row.lateWorkedMinutes += regular;
      else row.onTimeMinutes += regular;
      row.overtimeMinutes += overtime;

      row.workedMinutes += worked;
      row.expectedMinutes += day.expectedMinutes ?? 0;
      row.lateMinutes += late;
      row.earlyLeaveMinutes += early;
      if (isLate) row.lateCount += 1;
      if (day.flags.includes('OVERTIME')) row.overtimeCount += 1;

      if (day.checkInAt && (row.firstCheckInAt === null || day.checkInAt < row.firstCheckInAt)) {
        row.firstCheckInAt = day.checkInAt;
      }
      if (day.checkOutAt && (row.lastCheckOutAt === null || day.checkOutAt > row.lastCheckOutAt)) {
        row.lastCheckOutAt = day.checkOutAt;
      }

      if (day.status === 'HOLIDAY' && day.holidayName) {
        let names = holidayNames.get(day.date);
        if (!names) holidayNames.set(day.date, (names = new Set()));
        names.add(day.holidayName);
      }

      // --- summary ---------------------------------------------------------
      (summary[COUNTER[day.status] as keyof AttendanceAnalyticsSummary] as number) += 1;
      summary.workedMinutes += worked;
      summary.overtimeMinutes += overtime;
      summary.lateMinutes += late;
      summary.earlyLeaveMinutes += early;
      if (day.workedMinutes !== null) workedDays += 1;

      /**
       * Only days somebody was expected to attend are scored. A weekend, a
       * holiday, a rostered off day and a date that has not arrived are not
       * attendance anyone failed to produce - counting them would report a
       * company as absent every Sunday.
       */
      if (
        day.status === 'PRESENT' ||
        day.status === 'HALF_DAY' ||
        day.status === 'ABSENT' ||
        day.status === 'ON_LEAVE'
      ) {
        scored += 1;
        if (day.status === 'PRESENT') attended += 1;
        else if (day.status === 'HALF_DAY') attended += 0.5;
      }
    }
  }

  for (const row of rows.values()) {
    row.dayState = dayStateFor(row);
    /**
     * The name belongs to the date only when the date is the holiday.
     *
     * Two ways it is withheld: the day is not a holiday for everyone - someone
     * came in, so the chart calls it a working day and naming it would
     * contradict the ribbon - or two locations kept different holidays that
     * day, in which case there is no single name to print.
     */
    const names = holidayNames.get(row.date);
    row.holidayName =
      row.dayState === 'HOLIDAY' && names && names.size === 1 ? [...names][0]! : null;
  }

  summary.totalEmployees = contributors.size;
  summary.averageWorkedMinutes =
    workedDays > 0 ? Math.round(summary.workedMinutes / workedDays) : null;
  summary.attendancePercentage =
    scored > 0 ? Math.round((attended / scored) * 1000) / 10 : null;

  return { days: [...rows.values()], summary };
}

/** Every calendar date from `from` to `to` inclusive, as YYYY-MM-DD. */
export function datesInRange(from: Date, to: Date): string[] {
  const dates: string[] = [];
  for (const d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}
