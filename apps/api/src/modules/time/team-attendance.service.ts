import type { Prisma } from '@prisma/client';
import {
  UNASSIGNED_TEAM_ID,
  UNASSIGNED_TEAM_LABEL,
  type AttendanceDay,
  type TeamAttendanceSummaryRow,
} from '@hrms/shared';

/**
 * Team attendance is a join, not a copy.
 *
 * An attendance record already carries `employeeId` - the device PIN was
 * resolved to a person once, at ingest, through the device-user mapping. So the
 * team of a day's attendance is whatever team that employee is on now:
 *
 *     AttendanceRecord.employeeId -> Employee.teamId -> Team.name
 *
 * Nothing here stores a team against a punch or a day. Moving someone between
 * teams re-groups their history, which is the behaviour a team report wants -
 * and the alternative, stamping a team onto every record, would need a backfill
 * and would then disagree with the org chart the moment anyone transferred.
 */

/**
 * Narrows an employee query to one team, or to the people on no team.
 *
 * Returns an empty clause for "no preference", so it composes with the scope
 * filter the same way the department filter does: these can only ever remove
 * rows from what the caller is already allowed to see.
 */
export function teamFilterClause(teamId: string | undefined): Prisma.EmployeeWhereInput {
  if (!teamId) return {};
  if (teamId === UNASSIGNED_TEAM_ID) return { teamId: null };
  return { teamId };
}

/** A day someone arrived late, however many minutes it ran. */
export function isLateDay(day: AttendanceDay): boolean {
  return (day.lateMinutes ?? 0) > 0;
}

/**
 * Working days actually scored in the range.
 *
 * Weekends, holidays and days that have not happened yet are excluded: counting
 * them would make a short week look like poor attendance.
 */
export function isScoredDay(day: AttendanceDay): boolean {
  return (
    day.status === 'PRESENT' ||
    day.status === 'HALF_DAY' ||
    day.status === 'ABSENT' ||
    day.status === 'ON_LEAVE'
  );
}

export interface TeamGroupable {
  teamId: string | null;
  teamName: string | null;
  departmentName: string | null;
  days: readonly AttendanceDay[];
}

/**
 * Groups per-employee days into one row per team.
 *
 * Employees with no team are kept in an "Unassigned" bucket rather than
 * dropped - a person missing from the team report is indistinguishable from a
 * person with perfect attendance, which is the worst way to lose someone.
 *
 * Every employee handed in is counted, including one with no days at all, so
 * the employee count matches the roster rather than the subset who happened to
 * clock in during the range.
 */
export function summariseByTeam(entries: readonly TeamGroupable[]): TeamAttendanceSummaryRow[] {
  const buckets = new Map<string, TeamAttendanceSummaryRow>();

  for (const entry of entries) {
    // The null team is one bucket, keyed by a sentinel that cannot collide with
    // a cuid.
    const key = entry.teamId ?? UNASSIGNED_TEAM_ID;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        teamId: entry.teamId,
        teamName: entry.teamId ? (entry.teamName ?? UNASSIGNED_TEAM_LABEL) : UNASSIGNED_TEAM_LABEL,
        departmentName: entry.teamId ? entry.departmentName : null,
        employees: 0,
        present: 0,
        late: 0,
        absent: 0,
        total: 0,
      };
      buckets.set(key, bucket);
    }

    bucket.employees += 1;
    for (const day of entry.days) {
      if (day.status === 'PRESENT') bucket.present += 1;
      if (day.status === 'ABSENT') bucket.absent += 1;
      if (isLateDay(day)) bucket.late += 1;
      if (isScoredDay(day)) bucket.total += 1;
    }
  }

  // Named teams alphabetically, Unassigned always last: it is a residue, not a
  // team, and sorting it among the names implies it is one.
  return [...buckets.values()].sort((a, b) => {
    if (a.teamId === null) return 1;
    if (b.teamId === null) return -1;
    return a.teamName.localeCompare(b.teamName);
  });
}
