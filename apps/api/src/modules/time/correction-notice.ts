import { ATTENDANCE_CORRECTION_ISSUE_LABELS, type AttendanceCorrectionIssue } from '@hrms/shared';
import { formatDayKey } from '../leave/leave-reconciliation.service.js';

/**
 * What an approver is told about an attendance correction.
 *
 * The approver decides from the notification, so it carries the request
 * itself: who, which day, what kind of correction, what is on record now, what
 * is being asked for, and why. Stored as the approval's title and summary, so
 * the in-app notification, the email, the approvals list and the approval page
 * all read the same text, and a later stage's approver is told the same.
 */

export const CORRECTION_NOTICE_TITLE = 'Attendance Correction Request';

/** `06:02 PM`, on the company's wall clock. */
export function clockInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(instant);
}

/**
 * The kind of correction, as the approver would say it.
 *
 * A missing punch names the end that is missing: "Missing check-out" tells the
 * approver what to look for, "Missing punch" does not.
 */
export function correctionTypeLabel(input: {
  issueType: AttendanceCorrectionIssue | null;
  requestedCheckInAt: Date | null;
  requestedCheckOutAt: Date | null;
}): string {
  const { issueType, requestedCheckInAt: inAt, requestedCheckOutAt: outAt } = input;
  if (issueType === 'MISSING_PUNCH' || issueType === null) {
    if (inAt && outAt) return issueType ? 'Missing check-in and check-out' : 'Check-in and check-out';
    if (outAt) return issueType ? 'Missing check-out' : 'Check-out';
    if (inAt) return issueType ? 'Missing check-in' : 'Check-in';
  }
  return issueType ? ATTENDANCE_CORRECTION_ISSUE_LABELS[issueType] : 'Attendance status';
}

export interface CorrectionNoticeInput {
  employeeName: string;
  dayKey: string;
  timeZone: string;
  issueType: AttendanceCorrectionIssue | null;
  /** What the stored record says now. Null when there is no record at all. */
  current: { checkInAt: Date | null; checkOutAt: Date | null } | null;
  requestedCheckInAt: Date | null;
  requestedCheckOutAt: Date | null;
  /** A status asked for in place of times, already labelled. */
  requestedStatusLabel: string | null;
  reason: string;
}

export function correctionNotice(input: CorrectionNoticeInput): { title: string; summary: string } {
  const clock = (d: Date | null) => (d ? clockInZone(d, input.timeZone) : 'Missing');
  const date = formatDayKey(input.dayKey);

  const asksIn = input.requestedCheckInAt !== null;
  const asksOut = input.requestedCheckOutAt !== null;

  /*
   * Current and requested name the same ends, so the two lines can be read
   * against each other. With no time asked for (a status or OTHER request),
   * both ends of the current record are shown.
   */
  const ends: Array<'in' | 'out'> =
    asksIn || asksOut ? [...(asksIn ? ['in' as const] : []), ...(asksOut ? ['out' as const] : [])] : ['in', 'out'];
  const label = (end: 'in' | 'out') => (end === 'in' ? 'Check-in' : 'Check-out');
  const both = ends.length > 1;

  const currentText = ends
    .map((end) => {
      const value = clock(end === 'in' ? input.current?.checkInAt ?? null : input.current?.checkOutAt ?? null);
      return both ? `${label(end)} ${value}` : value;
    })
    .join(' · ');

  const requested: string[] = [];
  if (input.requestedCheckInAt) requested.push(`${both ? 'Check-in ' : ''}${clock(input.requestedCheckInAt)}`);
  if (input.requestedCheckOutAt) requested.push(`${both ? 'Check-out ' : ''}${clock(input.requestedCheckOutAt)}`);
  if (input.requestedStatusLabel) requested.push(`Status ${input.requestedStatusLabel}`);

  const lines = [
    `Employee: ${input.employeeName}`,
    `Date: ${date}`,
    `Correction: ${correctionTypeLabel(input)}`,
    `Current: ${currentText}`,
    `Requested: ${requested.length > 0 ? requested.join(' · ') : 'See reason'}`,
    `Reason: ${input.reason}`,
  ];

  return {
    title: `${CORRECTION_NOTICE_TITLE}: ${input.employeeName}, ${date}`,
    summary: lines.join('\n'),
  };
}
