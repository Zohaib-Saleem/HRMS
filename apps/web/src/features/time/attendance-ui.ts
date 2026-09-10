import type { AttendanceFlag, DerivedAttendanceStatus } from '@hrms/shared';

/**
 * The shared visual vocabulary for attendance.
 *
 * One definition, so the calendar cell, the history row and the team grid can
 * never show the same day in two different colours. Adding a status to the
 * domain breaks compilation here until it is given a colour, which is the
 * point.
 *
 * Colours come from the `--att-*` tokens in index.css, which carry the same
 * five hues as the dashboard charts. Each status owns a background, a border
 * and a text colour rather than borrowing the generic `*-soft` pastels: tiled
 * across a desktop month grid those read as disabled, and a status the reader
 * has to squint at is not a status.
 */

export const STATUS_TONE: Record<
  DerivedAttendanceStatus,
  'success' | 'destructive' | 'warning' | 'neutral'
> = {
  PRESENT: 'success',
  HALF_DAY: 'warning',
  ABSENT: 'destructive',
  ON_LEAVE: 'warning',
  WEEKEND: 'neutral',
  HOLIDAY: 'neutral',
  // A day that has not happened yet carries no judgement, so it gets the
  // quietest treatment available - never the red used for absence.
  UPCOMING: 'neutral',
  // Rostered off. Not a weekend, not an absence: the shift simply does not
  // work that day, and nobody failed to attend it.
  OFF_DAY: 'neutral',
};

/** Background / text / border triples, one per status. */
export const STATUS_COLOR: Record<DerivedAttendanceStatus, string> = {
  PRESENT: 'bg-att-present text-att-present-foreground border-att-present-border',
  HALF_DAY: 'bg-att-half-day text-att-half-day-foreground border-att-half-day-border',
  ABSENT: 'bg-att-absent text-att-absent-foreground border-att-absent-border',
  ON_LEAVE: 'bg-att-leave text-att-leave-foreground border-att-leave-border',
  HOLIDAY: 'bg-att-holiday text-att-holiday-foreground border-att-holiday-border',
  WEEKEND: 'bg-att-weekend text-att-weekend-foreground border-att-weekend-border',
  // Deliberately the plainest cell in the set: an empty future day should read
  // as "nothing here yet", not as a mark against the employee.
  UPCOMING: 'bg-att-upcoming text-att-upcoming-foreground border-att-upcoming-border border-dashed',
  // The weekend hue, because it is the same kind of day - not worked - with a
  // dashed edge so a company weekend and a shift's own off day stay tellable
  // apart at a glance in a month grid.
  OFF_DAY: 'bg-att-weekend text-att-weekend-foreground border-att-weekend-border border-dashed',
};

/** The same triples plus a hover step, for the interactive calendar grid. */
export const STATUS_CELL: Record<DerivedAttendanceStatus, string> = {
  PRESENT: `${STATUS_COLOR.PRESENT} hover:bg-att-present-hover`,
  HALF_DAY: `${STATUS_COLOR.HALF_DAY} hover:bg-att-half-day-hover`,
  ABSENT: `${STATUS_COLOR.ABSENT} hover:bg-att-absent-hover`,
  ON_LEAVE: `${STATUS_COLOR.ON_LEAVE} hover:bg-att-leave-hover`,
  HOLIDAY: `${STATUS_COLOR.HOLIDAY} hover:bg-att-holiday-hover`,
  WEEKEND: `${STATUS_COLOR.WEEKEND} hover:bg-att-weekend-hover`,
  UPCOMING: `${STATUS_COLOR.UPCOMING} hover:bg-att-upcoming-hover`,
  OFF_DAY: `${STATUS_COLOR.OFF_DAY} hover:bg-att-weekend-hover`,
};

/**
 * Badge shape, kept in step with `components/ui/badge` by hand.
 *
 * Attendance needs seven colours where the shared Badge offers four tones, and
 * a tone-plus-override would leave two backgrounds fighting in the class list.
 * So the status badge borrows the geometry and brings its own palette.
 */
const BADGE_SHAPE =
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap';

export const STATUS_BADGE: Record<DerivedAttendanceStatus, string> = {
  PRESENT: `${BADGE_SHAPE} ${STATUS_COLOR.PRESENT}`,
  HALF_DAY: `${BADGE_SHAPE} ${STATUS_COLOR.HALF_DAY}`,
  ABSENT: `${BADGE_SHAPE} ${STATUS_COLOR.ABSENT}`,
  ON_LEAVE: `${BADGE_SHAPE} ${STATUS_COLOR.ON_LEAVE}`,
  HOLIDAY: `${BADGE_SHAPE} ${STATUS_COLOR.HOLIDAY}`,
  WEEKEND: `${BADGE_SHAPE} ${STATUS_COLOR.WEEKEND}`,
  UPCOMING: `${BADGE_SHAPE} ${STATUS_COLOR.UPCOMING}`,
  OFF_DAY: `${BADGE_SHAPE} ${STATUS_COLOR.OFF_DAY}`,
};

/** Text-only status colours, for counts in a summary strip. */
export const STATUS_TEXT: Record<DerivedAttendanceStatus, string> = {
  PRESENT: 'text-att-present-foreground',
  HALF_DAY: 'text-att-half-day-foreground',
  ABSENT: 'text-att-absent-foreground',
  ON_LEAVE: 'text-att-leave-foreground',
  HOLIDAY: 'text-att-holiday-foreground',
  WEEKEND: 'text-att-weekend-foreground',
  UPCOMING: 'text-att-upcoming-foreground',
  OFF_DAY: 'text-att-weekend-foreground',
};

/**
 * Lateness and early-leave minutes.
 *
 * Amber, but not `warning-foreground`: that token is ink meant to sit ON the
 * amber fill, and against a dark card it lands around 1.1:1 - the late/early
 * column was legible in light mode and effectively blank in dark. This one
 * reads on both grounds.
 */
export const LATE_TEXT = 'text-att-half-day-foreground';

/** "7h 45m", or an em dash when there is nothing to show. */
export const minutesLabel = (minutes: number | null | undefined): string =>
  minutes === null || minutes === undefined
    ? '--'
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;

export const timeLabel = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '--';


/**
 * Flag badges.
 *
 * A flag is not a status. A late day is a PRESENT day that was late, and the
 * two are shown side by side: the status says whether the day was worked, the
 * flag says what else needs looking at. Giving flags their own quieter shape
 * keeps that distinction visible in a dense grid.
 */
export const FLAG_BADGE: Record<AttendanceFlag, string> = {
  LATE: `${BADGE_SHAPE} bg-att-half-day text-att-half-day-foreground border-att-half-day-border`,
  EARLY_LEAVE: `${BADGE_SHAPE} bg-att-half-day text-att-half-day-foreground border-att-half-day-border`,
  OVERTIME: `${BADGE_SHAPE} bg-att-present text-att-present-foreground border-att-present-border`,
  MISSING_PUNCH: `${BADGE_SHAPE} bg-att-absent text-att-absent-foreground border-att-absent-border`,
  IRREGULAR: `${BADGE_SHAPE} bg-att-absent text-att-absent-foreground border-att-absent-border`,
  // A manual adjustment is information, not a problem: it should read as a
  // note on the day rather than as another thing that went wrong.
  MANUAL: `${BADGE_SHAPE} bg-att-weekend text-att-weekend-foreground border-att-weekend-border`,
};
