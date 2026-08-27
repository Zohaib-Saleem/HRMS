import type { AttendanceStatus } from '@hrms/shared';

/**
 * The shared visual vocabulary for attendance.
 *
 * One definition, so the calendar cell, the history row and the team grid can
 * never show the same day in two different colours. Adding a status to the
 * domain breaks compilation here until it is given a colour, which is the
 * point.
 */

export const STATUS_TONE: Record<
  AttendanceStatus,
  'success' | 'destructive' | 'warning' | 'neutral'
> = {
  PRESENT: 'success',
  HALF_DAY: 'warning',
  ABSENT: 'destructive',
  ON_LEAVE: 'warning',
  WEEKEND: 'neutral',
  HOLIDAY: 'neutral',
};

export const STATUS_CELL: Record<AttendanceStatus, string> = {
  PRESENT: 'bg-success-soft text-success border-success/25',
  HALF_DAY: 'bg-warning-soft text-warning-foreground border-warning/40',
  ABSENT: 'bg-destructive-soft text-destructive border-destructive/25',
  ON_LEAVE: 'bg-warning-soft text-warning-foreground border-warning/25',
  HOLIDAY: 'bg-primary-soft text-primary border-primary/25',
  WEEKEND: 'bg-muted text-muted-foreground border-border',
};

/** "7h 45m", or an em dash when there is nothing to show. */
export const minutesLabel = (minutes: number | null | undefined): string =>
  minutes === null || minutes === undefined
    ? '--'
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;

export const timeLabel = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '--';
