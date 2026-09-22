import type { Prisma } from '@prisma/client';
import { EMPLOYEE_EXIT_STATUSES, isExitStatus } from '@hrms/shared';
import { dateColumnToDayKey } from '../../core/zoned-time.js';

/**
 * Who was employed on a given day - the single source of truth.
 *
 * Attendance is scored against a population, and the population is not "every
 * row in the employee table". A day only means something for somebody who was
 * actually employed on it: nobody is absent from a job they had already left,
 * and nobody is absent from one they had not yet started. Derive a month for a
 * person terminated on the 10th and days 11 to 30 used to come back ABSENT,
 * because the deriver classified every calendar day it was handed and nothing
 * upstream had told it when the employment ended.
 *
 * Three questions live on an employee record and only the FIRST of them belongs
 * here:
 *
 *   - `status`           - is this person employed at all (Active, Resigned...)
 *   - `employmentType`   - on what terms (Full time, Part time, Contract...)
 *   - `employmentStatus` - how far through the arrangement they are
 *                          (Probation, Permanent, Internee)
 *
 * `employmentStatus` is deliberately NOT read by anything in this file. A
 * probationer is employed; an internee is employed. That field answers a
 * question about the stage of an arrangement, not about whether the arrangement
 * existed on a Tuesday, and using it here would quietly drop every probationer
 * out of attendance.
 *
 * Equally deliberately, this is not `status === 'ACTIVE'`. Somebody serving out
 * their notice still comes to work: in this data model that person carries a
 * FUTURE last working day, and an exit status is written the moment notice is
 * recorded. Filtering on the status alone would delete a leaver's final fortnight
 * from every attendance screen. The DATE decides; the status only chooses which
 * date to believe.
 */

/**
 * The columns this rule reads, and the only ones it may read.
 *
 * Spread into the `select` of every query that feeds an attendance population,
 * so a caller cannot half-remember which four fields the rule needs.
 */
export const EMPLOYMENT_WINDOW_SELECT = {
  status: true,
  hireDate: true,
  terminationDate: true,
  resignationDate: true,
  excludedFromAttendance: true,
} satisfies Prisma.EmployeeSelect;

/**
 * The employment lifecycle of one person, as the attendance rule sees it.
 *
 * Structural rather than `Prisma.EmployeeGetPayload`, so the same rule applies
 * to a full record, to a narrow `select`, and to a test fixture without any of
 * the three having to agree on anything but these four fields.
 */
export interface EmploymentWindowFields {
  status: string;
  hireDate: Date | null;
  terminationDate: Date | null;
  resignationDate: Date | null;
  /**
   * Set for somebody who never punches - a partner, a director. Not an
   * employment fact, which is why it sits beside the lifecycle dates rather
   * than among them, but it is read by the same two predicates: being outside
   * attendance and having left both end in the same place, "no row here".
   */
  excludedFromAttendance: boolean;
}

/**
 * The last day somebody was employed, or null when they have not left.
 *
 * `terminationDate` is the canonical column and holds the last day WORKED for
 * both kinds of exit - `/terminate` writes it, and `/resign` writes the last
 * working day into it, falling back to the resignation date when the person
 * left the same day. That is why this reads it first regardless of status: a
 * notice period is modelled as an exit status carrying a future date in that
 * very column, and honouring it is what keeps a leaver in attendance until
 * their final day.
 *
 * `resignationDate` is the fallback and ONLY for a record that has already
 * left, because it answers a different question - the day notice was handed in,
 * not the day work stopped. Reading it for anyone else would evict a person
 * serving out their notice on the day they announced it.
 *
 * An exit status with neither date recorded returns null: nothing here invents
 * a leaving date. See `isEmployeeInAttendancePopulation`.
 */
export function effectiveLastWorkingDate(employee: EmploymentWindowFields): Date | null {
  if (employee.terminationDate) return employee.terminationDate;
  if (isExitStatus(employee.status)) return employee.resignationDate;
  return null;
}

/**
 * Was this person employed on this date?
 *
 * The one predicate. Every attendance figure in the product - the team page,
 * the dashboard counts and their drill-downs, present, absent, half day, late,
 * overtime, leave, the holiday and weekend population, an individual's
 * calendar, every report and export - resolves its population through this
 * function or through the SQL clause below, which is written to mean exactly
 * the same thing.
 *
 * The rule, in full:
 *
 *   1. Before the hire date            -> not employed, not expected.
 *   2. On or before the last working   -> employed. This is what keeps notice
 *      day (see above)                    periods, and every historical day a
 *                                         leaver actually worked, intact.
 *   3. After the last working day      -> not employed. The fix.
 *   4. No leaving date at all          -> employed. Nothing to exclude by.
 *
 * Case 4 covers a record with an exit status and no date on it, which the
 * product's own endpoints cannot produce - both write a date - but imported
 * data can. Guessing a date would silently delete real history from every
 * screen; leaving the person in changes nothing about how they were treated
 * before, and the missing date is a data-quality problem to fix on the record
 * rather than in the attendance engine.
 *
 * `attendanceDate` is a `@db.Date`-shaped day (UTC midnight). Comparison is on
 * the day key, never on milliseconds, so a value that picked up a time
 * component somewhere upstream cannot turn "the 10th" into "after the 10th".
 */
export function isEmployeeInAttendancePopulation(
  employee: EmploymentWindowFields,
  attendanceDate: Date,
): boolean {
  if (employee.excludedFromAttendance) return false;

  const day = dateColumnToDayKey(attendanceDate);

  if (employee.hireDate && dateColumnToDayKey(employee.hireDate) > day) return false;

  const last = effectiveLastWorkingDate(employee);
  if (last === null) return true;

  return dateColumnToDayKey(last) >= day;
}

/**
 * Does the employment overlap the range at all?
 *
 * The row-level question, as against the day-level one. A team page for a
 * single date asks it to decide whether somebody appears; a page for a month
 * asks it to decide whether somebody is worth a row at all. Somebody employed
 * for one day of the range is in the range - their other days are excluded
 * individually by `isEmployeeInAttendancePopulation`, which is what keeps a
 * leaver's first ten days of September visible in a September report while the
 * rest of the month scores nothing.
 */
export function isEmployedDuringRange(
  employee: EmploymentWindowFields,
  from: Date,
  to: Date,
): boolean {
  if (employee.excludedFromAttendance) return false;

  const fromKey = dateColumnToDayKey(from);
  const toKey = dateColumnToDayKey(to);

  if (employee.hireDate && dateColumnToDayKey(employee.hireDate) > toKey) return false;

  const last = effectiveLastWorkingDate(employee);
  if (last === null) return true;

  return dateColumnToDayKey(last) >= fromKey;
}

/**
 * The same overlap test, expressed in SQL.
 *
 * Needed because a page's `total` has to be the count of the filtered
 * population, not of the unfiltered one. Filtering rows in JavaScript after the
 * database has already cut the page is the mismatch that puts eight rows under
 * a footer reading "Showing 1 to 20 of 80" - the same failure `/team`'s status
 * filter was fixed for. So the population narrows in the database, where `count`
 * and `findMany` see the identical clause.
 *
 * Every branch here mirrors a branch of `isEmployedDuringRange`, in the same
 * order, and both are covered by the same tests. Read together:
 *
 *   excludedFromAttendance = false
 *   AND hireDate  IS NULL OR hireDate <= to
 *   AND ( terminationDate >= from
 *         OR ( terminationDate IS NULL
 *              AND ( status NOT IN (exit statuses)   -- notice served, no last day
 *                    OR resignationDate IS NULL      -- left, no date recorded
 *                    OR resignationDate >= from ) ) )
 *
 * The first clause is not a lifecycle test and has no mirror in
 * `isEmployedDuringRange`: somebody who never punches is outside the attendance
 * question entirely, rather than employed-but-absent. It lives here because
 * here is the one place every attendance screen already agrees on.
 *
 * This can only ever remove rows, so it composes with the scope filter exactly
 * as the department and team clauses do.
 */
export function attendancePopulationWhere(from: Date, to: Date): Prisma.EmployeeWhereInput {
  return {
    AND: [
      { excludedFromAttendance: false },
      { OR: [{ hireDate: null }, { hireDate: { lte: to } }] },
      {
        OR: [
          { terminationDate: { gte: from } },
          {
            AND: [
              { terminationDate: null },
              {
                OR: [
                  { status: { notIn: [...EMPLOYEE_EXIT_STATUSES] } },
                  { resignationDate: null },
                  { resignationDate: { gte: from } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
