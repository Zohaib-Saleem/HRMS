import type { WeekDay } from '@hrms/shared';
import type {
  AnniversaryMoment,
  BirthdayMoment,
  CompanyMomentPerson,
  CompanyMomentsView,
  MomentOccasion,
  NewJoinerMoment,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { dateColumnToDayKey, dayKeyToDateColumn } from '../../core/zoned-time.js';
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

const personOf = (row: MomentRow): CompanyMomentPerson => ({
  employeeId: row.id,
  fullName: row.displayName ?? `${row.firstName} ${row.lastName}`,
  photoUrl: resolvePhotoUrl(row),
  departmentName: row.department?.name ?? null,
  teamName: row.team?.name ?? null,
  designationName: row.designation?.name ?? null,
  // Filled in by `attachGreetings` once the three lists are known. Zero and
  // false are the honest answer for a company with no greetings at all, which
  // is every company until somebody sends the first one.
  greetedByMe: false,
  greetingCount: 0,
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

  const view: CompanyMomentsView = { birthdays, anniversaries, newJoiners };
  await attachGreetings(view, { companyId, viewerEmployeeId, today });
  return view;
}

// ------------------------------------------------------------------ greetings

/**
 * The day an occasion falls on, which is what a greeting is filed under.
 *
 * A birthday and an anniversary are dated to today - they happen on one day and
 * the card is only shown on it. A new joiner is dated to their HIRE DATE, since
 * their welcome window runs five working days: dating a welcome to the day it
 * was written would let one colleague send five of them, one per day, and each
 * would look to the database like a different occasion.
 *
 * Exported because both halves of the feature must agree. The dashboard counts
 * greetings against these keys and the endpoint writes them against these keys;
 * two implementations of the same rule would drift into a card that says you
 * have not greeted somebody you have.
 */
export function occasionDateFor(input: {
  occasion: MomentOccasion;
  today: Date;
  /** The recipient's hire date. Required for a new joiner, ignored otherwise. */
  hireDate: Date | null;
}): Date {
  const { occasion, today, hireDate } = input;
  if (occasion === 'NEW_JOINER' && hireDate) return hireDate;
  return today;
}

/** One greeting's identity: who it is for, what for, and on which day. */
const greetingKey = (recipientEmployeeId: string, occasion: MomentOccasion, day: string): string =>
  `${recipientEmployeeId}|${occasion}|${day}`;

/**
 * Fill in `greetingCount` and `greetedByMe` across all three lists.
 *
 * One query, not one per person: the keys of every celebration on the page are
 * known by the time this runs, so the greetings for all of them are fetched
 * together and matched in memory. A company where nobody has sent anything
 * costs a single empty result.
 *
 * Sender ids are read and discarded - only whether one of them is the viewer
 * ever leaves this function. WHO wished a colleague happy birthday is the
 * recipient's business, and it reaches them through their notifications; it is
 * not published to the rest of the company via a dashboard card.
 */
async function attachGreetings(
  view: CompanyMomentsView,
  context: { companyId: string; viewerEmployeeId: string | null; today: Date },
): Promise<void> {
  const { companyId, viewerEmployeeId, today } = context;

  const entries: { person: CompanyMomentPerson; occasion: MomentOccasion; day: string }[] = [
    ...view.birthdays.map((person) => ({
      person,
      occasion: 'BIRTHDAY' as const,
      day: dateColumnToDayKey(today),
    })),
    ...view.anniversaries.map((person) => ({
      person,
      occasion: 'ANNIVERSARY' as const,
      day: dateColumnToDayKey(today),
    })),
    // A joiner's welcome is filed under their hire date - see `occasionDateFor`.
    ...view.newJoiners.map((person) => ({
      person,
      occasion: 'NEW_JOINER' as const,
      day: person.hireDate,
    })),
  ];

  if (entries.length === 0) return;

  const greetings = await prisma.momentGreeting.findMany({
    where: {
      companyId,
      recipientEmployeeId: { in: [...new Set(entries.map((e) => e.person.employeeId))] },
      occasionDate: { in: [...new Set(entries.map((e) => e.day))].map(dayKeyToDateColumn) },
    },
    select: {
      recipientEmployeeId: true,
      senderEmployeeId: true,
      occasion: true,
      occasionDate: true,
    },
  });

  const counts = new Map<string, number>();
  const mine = new Set<string>();

  for (const row of greetings) {
    const key = greetingKey(
      row.recipientEmployeeId,
      row.occasion,
      dateColumnToDayKey(row.occasionDate),
    );
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (viewerEmployeeId && row.senderEmployeeId === viewerEmployeeId) mine.add(key);
  }

  for (const entry of entries) {
    const key = greetingKey(entry.person.employeeId, entry.occasion, entry.day);
    entry.person.greetingCount = counts.get(key) ?? 0;
    entry.person.greetedByMe = mine.has(key);
  }
}

/**
 * Whether this viewer may greet this person for this occasion, today.
 *
 * The check is deliberately not a permission or a company-membership test. It
 * re-derives the caller's OWN celebration lists and asks whether the recipient
 * is on the one they named - so the endpoint can only reach a person the server
 * itself has already decided to show that caller, on the day it decided to show
 * them. Every rule the dashboard obeys is therefore inherited for free: the
 * employment lifecycle, the company boundary, the exclusion of the caller
 * themselves, and the five-working-day welcome window.
 *
 * Returns the occasion's date when the greeting is allowed, and null when it is
 * not, because the caller needs that date to write the row and there is exactly
 * one place it should be computed.
 */
export async function resolveGreetableOccasion(input: {
  moments: CompanyMomentsView;
  recipientEmployeeId: string;
  occasion: MomentOccasion;
  today: Date;
}): Promise<Date | null> {
  const { moments, recipientEmployeeId, occasion, today } = input;

  if (occasion === 'BIRTHDAY') {
    const found = moments.birthdays.some((p) => p.employeeId === recipientEmployeeId);
    return found ? occasionDateFor({ occasion, today, hireDate: null }) : null;
  }

  if (occasion === 'ANNIVERSARY') {
    const found = moments.anniversaries.some((p) => p.employeeId === recipientEmployeeId);
    return found ? occasionDateFor({ occasion, today, hireDate: null }) : null;
  }

  const joiner = moments.newJoiners.find((p) => p.employeeId === recipientEmployeeId);
  if (!joiner) return null;
  return occasionDateFor({ occasion, today, hireDate: dayKeyToDateColumn(joiner.hireDate) });
}

/** How many greetings a person has for one occasion, after a write. */
export function countGreetings(input: {
  recipientEmployeeId: string;
  occasion: MomentOccasion;
  occasionDate: Date;
}): Promise<number> {
  return prisma.momentGreeting.count({
    where: {
      recipientEmployeeId: input.recipientEmployeeId,
      occasion: input.occasion,
      occasionDate: input.occasionDate,
    },
  });
}
