import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  UNASSIGNED_TEAM_LABEL,
  type AttendanceDay,
  type EmployeeListItem,
  type TeamAttendanceRow,
} from '@hrms/shared';
import { api } from '@/lib/api';

/**
 * Everything the company dashboard shows, derived from endpoints that already
 * exist.
 *
 * There is no dashboard endpoint and this file does not ask for one. It reads
 * `/attendance/team`, which returns one row per employee the caller may see
 * with a classified day for every date in the range, and folds those rows into
 * the shapes the screen needs: today's headline counts, a per-day trend, and
 * the same counts grouped by department and by team. Every figure below is a
 * count of days the API classified - nothing here estimates, projects or
 * back-fills a number the server did not return.
 *
 * The grouping is done here rather than server-side because the server already
 * publishes the per-employee facts; a second aggregation endpoint would be a
 * second place for the two to disagree.
 */

// ------------------------------------------------------------------- ranges

export type TrendRangeKey = '7d' | '30d' | 'month';

export const TREND_RANGES: Array<{ key: TrendRangeKey; label: string; short: string }> = [
  { key: '7d', label: 'Last 7 days', short: '7 days' },
  { key: '30d', label: 'Last 30 days', short: '30 days' },
  { key: 'month', label: 'This month', short: 'This month' },
];

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Today, in the same UTC-day convention the attendance screens already use. */
export const todayIso = (): string => isoDay(new Date());

/**
 * The from/to a trend range covers.
 *
 * Capped below the API's own 62-day ceiling by construction: the widest option
 * is a calendar month, so no range here can be rejected as a report.
 */
export function trendRange(key: TrendRangeKey): { from: string; to: string } {
  const to = new Date();
  if (key === 'month') {
    const first = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    return { from: isoDay(first), to: isoDay(to) };
  }
  const days = key === '7d' ? 7 : 30;
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return { from: isoDay(from), to: isoDay(to) };
}

// -------------------------------------------------------------------- fetch

/**
 * `/attendance/team` is paginated, and a dashboard built from page one would
 * describe 100 people while appearing to describe the company. So the pages are
 * walked - with the same 2,000-person ceiling the server puts on its own
 * unpaginated team summary, and a flag when that ceiling is hit, so a very
 * large company is told its dashboard is partial instead of being quietly
 * given the wrong denominator.
 */
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

export interface TeamRangeResult {
  rows: TeamAttendanceRow[];
  /** Employees in scope, from the API's own count rather than the rows walked. */
  total: number;
  truncated: boolean;
}

async function fetchTeamRange(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<TeamRangeResult> {
  const rows: TeamAttendanceRow[] = [];
  let page = 1;
  let totalPages = 1;
  let total = 0;

  while (page <= totalPages && page <= MAX_PAGES) {
    const response = await api.getPage<TeamAttendanceRow>('/attendance/team', {
      query: { page, limit: PAGE_LIMIT, from, to },
      signal,
    });
    rows.push(...response.data);
    totalPages = response.meta.totalPages;
    total = response.meta.total;
    page += 1;
  }

  return { rows, total, truncated: totalPages > MAX_PAGES };
}

/**
 * The employee roster, used only to fill in the team of an attendance row.
 *
 * `/attendance/team` carries the team on API builds that publish it, and the
 * grouping below prefers that. But an older build returns the same rows without
 * any team field at all, and grouping those would file every employee under
 * "Unassigned" - a report that quietly claims nobody is on a team is worse than
 * no report. `/employees` has carried `team: { id, name }` on every build, so it
 * is the fallback: one extra list request, joined by employee id.
 *
 * It is a read of the employee list and nothing else. No attendance record,
 * device mapping or punch is touched, and the join happens in the browser.
 */
export interface RosterEntry {
  teamId: string | null;
  teamName: string | null;
  departmentName: string | null;
}

export type Roster = Map<string, RosterEntry>;

async function fetchRoster(signal?: AbortSignal): Promise<Roster> {
  const roster: Roster = new Map();
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= MAX_PAGES) {
    const response = await api.getPage<EmployeeListItem>('/employees', {
      query: { page, limit: PAGE_LIMIT },
      signal,
    });
    for (const employee of response.data) {
      roster.set(employee.id, {
        teamId: employee.team?.id ?? null,
        teamName: employee.team?.name ?? null,
        departmentName: employee.department?.name ?? null,
      });
    }
    totalPages = response.meta.totalPages;
    page += 1;
  }

  return roster;
}

export function useEmployeeRoster(enabled: boolean) {
  return useQuery({
    queryKey: ['dashboard', 'roster'],
    queryFn: ({ signal }) => fetchRoster(signal),
    enabled,
    // Team membership changes far more slowly than attendance does.
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

type JoinField = 'teamId' | 'teamName' | 'departmentName';

/**
 * The row as an older API build may actually put it on the wire: the three join
 * fields absent rather than null. The DTO declares them required because every
 * current build sends them, so the widening is kept local to the one function
 * that has to cope with their absence.
 */
type MaybeJoined = Omit<TeamAttendanceRow, JoinField> &
  Partial<Pick<TeamAttendanceRow, JoinField>>;

/**
 * Fills in team and department on attendance rows that arrived without them.
 *
 * The row always wins when it carries the field, so this is inert against an
 * API build that already sends it. Only a missing field - `undefined`, never a
 * deliberate `null` - is filled from the roster, so "on no team" stays "on no
 * team" and keeps its place in the Unassigned bucket.
 */
export function applyRoster(
  rows: readonly TeamAttendanceRow[],
  roster: Roster | undefined,
): TeamAttendanceRow[] {
  if (!roster || roster.size === 0) return [...rows];

  return rows.map((row) => {
    const entry = roster.get(row.employeeId);
    if (!entry) return row;
    // `??` coalesced a deliberate null as readily as a missing field, so a
    // roster read up to five minutes earlier could hand a team to somebody the
    // attendance API had just reported as being on none - moving them out of
    // Unassigned on the strength of stale data. Only `undefined`, which is what
    // an older build's silence actually looks like, is filled in.
    const sent = row as MaybeJoined;
    return {
      ...row,
      teamId: sent.teamId === undefined ? entry.teamId : sent.teamId,
      teamName: sent.teamName === undefined ? entry.teamName : sent.teamName,
      departmentName:
        sent.departmentName === undefined ? entry.departmentName : sent.departmentName,
    };
  });
}

export function useAttendanceToday(enabled: boolean) {
  const date = todayIso();
  return useQuery({
    queryKey: ['dashboard', 'attendance', 'day', date],
    queryFn: ({ signal }) => fetchTeamRange(date, date, signal),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useAttendanceRange(range: TrendRangeKey, enabled: boolean) {
  const { from, to } = trendRange(range);
  return useQuery({
    queryKey: ['dashboard', 'attendance', 'range', from, to],
    queryFn: ({ signal }) => fetchTeamRange(from, to, signal),
    enabled,
    staleTime: 60_000,
    // Holds the previous chart while a wider range loads, so switching the
    // range does not flash a skeleton and shift the page under the pointer.
    placeholderData: keepPreviousData,
  });
}

// --------------------------------------------------------------- aggregation

export interface StatusCounts {
  present: number;
  halfDay: number;
  absent: number;
  onLeave: number;
  holiday: number;
  weekend: number;
  upcoming: number;
  /**
   * Days somebody arrived late.
   *
   * Lateness is an arrival fact, so it is only counted on a day the person
   * actually arrived - a PRESENT or HALF_DAY day. `late` is the sum of the two
   * splits below, which exist because every chart on the dashboard partitions
   * the scored population exactly once: a late day belongs to the late slice
   * and is therefore removed from the present and half-day slices rather than
   * being drawn in both.
   */
  late: number;
  latePresent: number;
  lateHalfDay: number;
  /** Working days actually scored: present + halfDay + absent + onLeave. */
  scored: number;
}

export const emptyCounts = (): StatusCounts => ({
  present: 0,
  halfDay: 0,
  absent: 0,
  onLeave: 0,
  holiday: 0,
  weekend: 0,
  upcoming: 0,
  late: 0,
  latePresent: 0,
  lateHalfDay: 0,
  scored: 0,
});

/**
 * A day that counts as a late arrival.
 *
 * Lateness is an arrival fact, so it is only a late day when the person
 * actually arrived. `lateMinutes` is read off the stored record whatever the
 * day turned out to be, so it survives on a day the derivation then classified
 * ON_LEAVE, HOLIDAY or WEEKEND - an approved leave day with a punch behind it
 * keeps its minutes. Without one rule for both, the alert list named people the
 * "Late today" figure had not counted.
 */
export function isLateArrival(day: AttendanceDay): boolean {
  return (
    (day.lateMinutes ?? 0) > 0 && (day.status === 'PRESENT' || day.status === 'HALF_DAY')
  );
}

export function addDay(counts: StatusCounts, day: AttendanceDay): StatusCounts {
  if (day.status === 'PRESENT') counts.present += 1;
  else if (day.status === 'HALF_DAY') counts.halfDay += 1;
  else if (day.status === 'ABSENT') counts.absent += 1;
  else if (day.status === 'ON_LEAVE') counts.onLeave += 1;
  else if (day.status === 'HOLIDAY') counts.holiday += 1;
  else if (day.status === 'WEEKEND') counts.weekend += 1;
  else if (day.status === 'UPCOMING') counts.upcoming += 1;

  if (isLateArrival(day)) {
    if (day.status === 'PRESENT') counts.latePresent += 1;
    else counts.lateHalfDay += 1;
    counts.late += 1;
  }
  if (
    day.status === 'PRESENT' ||
    day.status === 'HALF_DAY' ||
    day.status === 'ABSENT' ||
    day.status === 'ON_LEAVE'
  ) {
    counts.scored += 1;
  }
  return counts;
}

export function tallyDays(days: Iterable<AttendanceDay>): StatusCounts {
  const counts = emptyCounts();
  for (const day of days) addDay(counts, day);
  return counts;
}

/**
 * Attendance as a percentage of the days that could be scored.
 *
 * Null - not zero - when nothing was scored. A company-wide weekend has no
 * attendance rate, and printing 0% for one would read as everybody missing.
 */
export function attendanceRate(counts: StatusCounts): number | null {
  if (counts.scored === 0) return null;
  return Math.round(((counts.present + counts.halfDay) / counts.scored) * 100);
}

// ------------------------------------------------------------------ groups

export interface GroupCounts extends StatusCounts {
  key: string;
  label: string;
  employees: number;
  /** True for the residue bucket, which sorts last and is styled as unassigned. */
  unassigned: boolean;
}

function groupBy(
  rows: readonly TeamAttendanceRow[],
  pick: (row: TeamAttendanceRow) => { key: string | null; label: string | null },
): GroupCounts[] {
  const buckets = new Map<string, GroupCounts>();

  for (const row of rows) {
    const { key, label } = pick(row);
    // The null bucket is keyed by a sentinel rather than by an empty string, so
    // it cannot collide with a real id.
    const bucketKey = key ?? '__unassigned__';
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        ...emptyCounts(),
        key: bucketKey,
        label: key ? (label ?? UNASSIGNED_TEAM_LABEL) : UNASSIGNED_TEAM_LABEL,
        employees: 0,
        unassigned: key === null,
      };
      buckets.set(bucketKey, bucket);
    }
    // Counted whether or not the person has a single day in the range: an
    // employee missing from the roll-up is indistinguishable from one with
    // perfect attendance.
    bucket.employees += 1;
    for (const day of row.days) addDay(bucket, day);
  }

  return [...buckets.values()].sort((a, b) => {
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
}

export const groupByDepartment = (rows: readonly TeamAttendanceRow[]): GroupCounts[] =>
  groupBy(rows, (row) => ({
    key: row.departmentName,
    label: row.departmentName,
  }));

export const groupByTeam = (rows: readonly TeamAttendanceRow[]): GroupCounts[] =>
  groupBy(rows, (row) => ({ key: row.teamId, label: row.teamName }));

// ------------------------------------------------------------------- trend

export interface TrendPoint {
  date: string;
  /** Present and on time. Kept apart from `late` so the two never double-count. */
  onTime: number;
  late: number;
  absent: number;
  /**
   * Approved leave - the rest of the scored population once the attended and
   * absent days are taken out. Half days are not here: an attended half day is
   * already in `onTime`, or in `late` when it arrived late.
   */
  other: number;
  scored: number;
  rate: number | null;
}

/**
 * One column per calendar day in the range.
 *
 * Built from the days the API returned rather than from a generated date list,
 * so a day nobody has a record for simply does not appear instead of being
 * drawn as a zero.
 */
export function buildTrend(rows: readonly TeamAttendanceRow[]): TrendPoint[] {
  const byDate = new Map<string, StatusCounts>();

  for (const row of rows) {
    for (const day of row.days) {
      let counts = byDate.get(day.date);
      if (!counts) {
        counts = emptyCounts();
        byDate.set(day.date, counts);
      }
      addDay(counts, day);
    }
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => {
      // A late day is drawn once, in the late segment - so on-time is what is
      // left of the attended days after the late ones are taken out. The four
      // segments then add up to exactly `scored`.
      const onTime =
        counts.present - counts.latePresent + (counts.halfDay - counts.lateHalfDay);
      return {
        date,
        onTime,
        late: counts.late,
        absent: counts.absent,
        other: counts.onLeave,
        scored: counts.scored,
        rate: attendanceRate(counts),
      };
    });
}

// ------------------------------------------------------------------ alerts

export interface PersonDay {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  departmentName: string | null;
  teamName: string | null;
  day: AttendanceDay;
}

const toPersonDay = (row: TeamAttendanceRow, day: AttendanceDay): PersonDay => ({
  employeeId: row.employeeId,
  employeeName: row.employeeName,
  employeeNumber: row.employeeNumber,
  departmentName: row.departmentName,
  teamName: row.teamName,
  day,
});

export interface TodayExceptions {
  late: PersonDay[];
  absent: PersonDay[];
  /** Checked in and never checked out - a day that cannot be scored for hours. */
  incomplete: PersonDay[];
}

export function todayExceptions(rows: readonly TeamAttendanceRow[]): TodayExceptions {
  const late: PersonDay[] = [];
  const absent: PersonDay[] = [];
  const incomplete: PersonDay[] = [];

  for (const row of rows) {
    for (const day of row.days) {
      if (isLateArrival(day)) late.push(toPersonDay(row, day));
      if (day.status === 'ABSENT') absent.push(toPersonDay(row, day));
      if (day.checkInAt && !day.checkOutAt) incomplete.push(toPersonDay(row, day));
    }
  }

  late.sort((a, b) => (b.day.lateMinutes ?? 0) - (a.day.lateMinutes ?? 0));
  absent.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
  incomplete.sort((a, b) => (a.day.checkInAt ?? '').localeCompare(b.day.checkInAt ?? ''));

  return { late, absent, incomplete };
}

/**
 * The latest captured punches across the range, newest first.
 *
 * These are the check-ins attendance was actually scored from, so the list
 * agrees with every other figure on the page. It is not a second read of the
 * raw device feed - that lives on the punches screen, which the card links to.
 */
export function recentPunches(rows: readonly TeamAttendanceRow[], limit = 8): PersonDay[] {
  const punches: PersonDay[] = [];
  for (const row of rows) {
    for (const day of row.days) {
      if (day.checkInAt) punches.push(toPersonDay(row, day));
    }
  }
  punches.sort((a, b) => (b.day.checkInAt ?? '').localeCompare(a.day.checkInAt ?? ''));
  return punches.slice(0, limit);
}
