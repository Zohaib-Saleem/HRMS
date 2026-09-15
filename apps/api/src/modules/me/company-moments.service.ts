import type { WeekDay } from '@hrms/shared';
import type {
  AnniversaryMoment,
  BirthdayMoment,
  CompanyMomentsView,
  NewJoinerMoment,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { dateColumnToDayKey } from '../../core/zoned-time.js';
import { isShiftWorkingDay } from '../time/attendance-policy.js';
import { attendancePopulationWhere } from '../time/employment-window.js';
import { resolvePhotoUrl } from '../employees/employees.service.js';

/**
 * Birthdays, work anniversaries and new joiners, for one person's dashboard.
 *
 * Three questions that look unrelated and are in fact the same question asked
 * three ways: which of my colleagues does today mean something for? So they
 * share one query, one lifecycle rule and one definition of "colleague", rather
 * than three endpoints that could each drift into disagreeing about who works
 * here.
 *
 * Nothing in this file decides who is employed. That is
 * `attendancePopulationWhere`, the same clause Team Attendance was fixed to
 * use, and it is spread into the query below rather than restated: a person
 * terminated last week is not on the team page and must not be on the birthday
 * card either. The rule reads the lifecycle status and the leaving DATE - never
 * `employmentStatus`, which answers a different question (Probation, Permanent,
 * Internee) and would quietly drop every probationer out of the company's
 * social life.
 */

/** The columns a celebration card needs, and nothing else. See the DTO note. */
const MOMENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  displayName: true,
  dateOfBirth: true,
  hireDate: true,
  photoUrl: true,
  photoObjectKey: true,
  photoUpdatedAt: true,
  department: { select: { name: true } },
  team: { select: { name: true } },
  designation: { select: { name: true } },
} satisfies import('@prisma/client').Prisma.EmployeeSelect;

type MomentRow = import('@prisma/client').Prisma.EmployeeGetPayload<{
  select: typeof MOMENT_SELECT;
}>;

/**
 * The widest a five-WORKING-day window can be in calendar days.
 *
 * Five working days plus a generous run of weekends and public holidays. Used
 * only to keep the new-joiner query off the whole employee table - the precise
 * answer is counted day by day below, against the real calendar. Deliberately
 * loose: being too generous here costs a handful of extra rows, while being too
 * tight would silently drop a joiner whose first fortnight was full of
 * holidays.
 */
const JOINER_LOOKBACK_DAYS = 21;

/** Month and day, ignoring the year. The only part of a birthday we compare. */
const monthDay = (value: Date): string => dateColumnToDayKey(value).slice(5);

const personOf = (row: MomentRow) => ({
  employeeId: row.id,
  fullName: row.displayName ?? `${row.firstName} ${row.lastName}`,
  photoUrl: resolvePhotoUrl(row),
  departmentName: row.department?.name ?? null,
  teamName: row.team?.name ?? null,
  designationName: row.designation?.name ?? null,
});

/**
 * How many working days have passed since somebody started, today included.
 *
 * Counted forwards over the real calendar rather than subtracted, because the
 * whole point is that a weekend or a holiday does not consume a welcome day.
 * Joining on a Friday means Friday is day 1 and the following Monday is day 2,
 * however long the weekend between them ran.
 *
 * Working days come from `isShiftWorkingDay`, which is the attendance engine's
 * own function, with a null shift so it falls back to the company's configured
 * weekend. Holidays are subtracted from that using the company's holiday
 * calendar, location-aware in the same way attendance is. No second definition
 * of "a working day" is introduced here, and none may be: a company that moves
 * its weekend changes its settings and this follows.
 *
 * Returns 0 when the start date is in the future - a joiner who has not started
 * is not yet somebody to welcome.
 */
export function workingDaysElapsed(input: {
  from: Date;
  to: Date;
  weekendDays: readonly WeekDay[];
  /** Day keys (`YYYY-MM-DD`) that are company holidays for this person. */
  holidays: ReadonlySet<string>;
}): number {
  const { from, to, weekendDays, holidays } = input;
  if (dateColumnToDayKey(from) > dateColumnToDayKey(to)) return 0;

  let count = 0;
  for (const d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!isShiftWorkingDay(d, null, weekendDays)) continue;
    if (holidays.has(dateColumnToDayKey(d))) continue;
    count += 1;
  }
  return count;
}

/** How many whole years between two dates, by calendar - never by division. */
function completedYears(from: Date, to: Date): number {
  const fromKey = dateColumnToDayKey(from);
  const toKey = dateColumnToDayKey(to);
  let years = Number(toKey.slice(0, 4)) - Number(fromKey.slice(0, 4));
  if (toKey.slice(5) < fromKey.slice(5)) years -= 1;
  return years;
}

/**
 * The number of working days a new joiner stays on the dashboard.
 *
 * Working days, not calendar days - see `workingDaysElapsed`.
 */
export const WELCOME_WORKING_DAYS = 5;

export async function companyMomentsFor(input: {
  companyId: string;
  /** The viewer, excluded from every list. Null for a login with no record. */
  viewerEmployeeId: string | null;
  /** Today, as a `@db.Date`-shaped day in the company's zone. */
  today: Date;
  weekendDays: readonly WeekDay[];
  /** The viewer's location, for the holiday calendar. */
  locationId: string | null;
}): Promise<CompanyMomentsView> {
  const { companyId, viewerEmployeeId, today, weekendDays, locationId } = input;

  const earliestJoin = new Date(today);
  earliestJoin.setUTCDate(earliestJoin.getUTCDate() - JOINER_LOOKBACK_DAYS);

  /**
   * One pass over the people who work here, plus the holidays in the joiner
   * window.
   *
   * The employee query is narrow in both directions: `MOMENT_SELECT` columns
   * only - no national id, no bank details, no salary, no personal contact -
   * and only people the lifecycle rule says were employed today. Birthdays and
   * anniversaries are then matched in memory, because month/day equality is not
   * expressible in a Prisma `where` without raw SQL, and raw SQL here would
   * mean restating the lifecycle clause that this deliberately shares.
   */
  const [people, holidayRows] = await Promise.all([
    prisma.employee.findMany({
      where: {
        AND: [
          { companyId },
          attendancePopulationWhere(today, today),
          // A person is not their own colleague. Done in the query so the
          // viewer's row never travels, rather than filtered out afterwards.
          viewerEmployeeId ? { id: { not: viewerEmployeeId } } : {},
        ],
      },
      select: MOMENT_SELECT,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    }),
    prisma.holiday.findMany({
      where: {
        companyId,
        isActive: true,
        date: { gte: earliestJoin, lte: today },
        OR: [{ locationId: null }, { locationId }],
      },
      select: { date: true },
    }),
  ]);

  const holidays = new Set(holidayRows.map((h) => dateColumnToDayKey(h.date)));
  const todayMonthDay = monthDay(today);
  const earliestJoinKey = dateColumnToDayKey(earliestJoin);
  const todayKey = dateColumnToDayKey(today);

  const birthdays: BirthdayMoment[] = [];
  const anniversaries: AnniversaryMoment[] = [];
  const newJoiners: NewJoinerMoment[] = [];

  for (const row of people) {
    if (row.dateOfBirth && monthDay(row.dateOfBirth) === todayMonthDay) {
      birthdays.push(personOf(row));
    }

    if (!row.hireDate) continue;
    const hireKey = dateColumnToDayKey(row.hireDate);

    /**
     * An anniversary is the hire date's month and day coming round again, and
     * only from the first year onwards. Somebody's first day is a welcome, not
     * a "celebrating 0 years", so the year count has to clear 1 - which also
     * keeps a person hired today out of both lists at once.
     */
    if (monthDay(row.hireDate) === todayMonthDay) {
      const years = completedYears(row.hireDate, today);
      if (years >= 1) anniversaries.push({ ...personOf(row), years });
    }

    // Future joiners are not yet colleagues, and somebody who started before
    // the window cannot still be inside it however the calendar fell.
    if (hireKey > todayKey || hireKey < earliestJoinKey) continue;

    const workingDay = workingDaysElapsed({
      from: row.hireDate,
      to: today,
      weekendDays,
      holidays,
    });

    if (workingDay >= 1 && workingDay <= WELCOME_WORKING_DAYS) {
      newJoiners.push({ ...personOf(row), hireDate: hireKey, workingDay });
    }
  }

  // Newest first: the person who started today leads the welcome list.
  newJoiners.sort((a, b) => a.workingDay - b.workingDay);
  // Longest service first, which is the one people actually remark on.
  anniversaries.sort((a, b) => b.years - a.years);

  return { birthdays, anniversaries, newJoiners };
}
