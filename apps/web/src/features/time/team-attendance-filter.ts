import type { AttendanceFlag, AttendanceStatus } from '@hrms/shared';

/**
 * The one vocabulary for "which days am I looking at" on team attendance.
 *
 * The screen asks a single question - Present, Absent, Late - but the domain
 * answers it two different ways. Present, Half day, Absent, On leave, Holiday
 * and Weekend are STATUSES: what the day was. Late and Overtime are FLAGS: what
 * else was true about it. A late day is a present day that was late, and the
 * status never becomes LATE (see ATTENDANCE_FLAGS in the shared DTOs).
 *
 * So one URL parameter - `?status=` - carries either kind, and this table is
 * where it is turned back into the `status` or `flag` the API expects. Nothing
 * here derives or counts anything; it only names what the server already
 * classified, which is what keeps the dashboard's figures and this list's rows
 * two views of the same data rather than two calculations of it.
 */
export interface TeamAttendanceFilterOption {
  /** The value that travels in `?status=`. */
  value: string;
  label: string;
  /** Sent to `/attendance/team` as `status` - exactly one of these two is set. */
  status?: AttendanceStatus;
  /** Sent to `/attendance/team` as `flag`. */
  flag?: AttendanceFlag;
}

export const TEAM_ATTENDANCE_FILTERS: readonly TeamAttendanceFilterOption[] = [
  { value: 'PRESENT', label: 'Present', status: 'PRESENT' },
  { value: 'HALF_DAY', label: 'Half day', status: 'HALF_DAY' },
  { value: 'ABSENT', label: 'Absent', status: 'ABSENT' },
  { value: 'ON_LEAVE', label: 'On leave', status: 'ON_LEAVE' },
  { value: 'HOLIDAY', label: 'Holiday', status: 'HOLIDAY' },
  { value: 'WEEKEND', label: 'Weekend', status: 'WEEKEND' },
  { value: 'LATE', label: 'Late', flag: 'LATE' },
  { value: 'OVERTIME', label: 'Overtime', flag: 'OVERTIME' },
];

/** The option a `?status=` value names, or undefined for "all statuses". */
export function teamAttendanceFilter(value: string): TeamAttendanceFilterOption | undefined {
  return TEAM_ATTENDANCE_FILTERS.find((option) => option.value === value);
}

/** What `/attendance/team` should be asked for, given a `?status=` value. */
export function teamAttendanceQuery(value: string): {
  status?: AttendanceStatus;
  flag?: AttendanceFlag;
} {
  const option = teamAttendanceFilter(value);
  return { status: option?.status, flag: option?.flag };
}

export interface TeamAttendanceLinkInit {
  /** A value from TEAM_ATTENDANCE_FILTERS. Omitted means "all statuses". */
  status?: string;
  /** A single day, written to both ends of the range. */
  date?: string;
  from?: string;
  to?: string;
  departmentId?: string;
  teamId?: string;
}

/**
 * The link a dashboard figure drills down through.
 *
 * Every filter the destination needs is in the query string rather than in
 * router state, so a refresh keeps it, back and forward move between it, and
 * the address can be pasted to somebody else. Only what was asked for is
 * written: search stays empty unless the caller sets it, and department and
 * team survive when the figure came from a scoped card.
 */
export function teamAttendancePath(init: TeamAttendanceLinkInit = {}): string {
  const params = new URLSearchParams();
  const from = init.from ?? init.date;
  const to = init.to ?? init.date;

  if (init.status) params.set('status', init.status);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (init.departmentId) params.set('departmentId', init.departmentId);
  if (init.teamId) params.set('teamId', init.teamId);

  const query = params.toString();
  return query ? `/attendance/team?${query}` : '/attendance/team';
}
