import type { BadgeProps } from '@/components/ui/badge';
import type { CasePriority, CaseStatus } from '@hrms/shared';

/**
 * Shared vocabulary for the cases screens.
 *
 * The tone of a badge is a judgement about the record, and the same case has to
 * look the same on the list, on the detail page and on the dashboard card.
 * Keeping the mapping here rather than repeating a ternary in three files is
 * what stops a case reading "pending" in amber on one screen and grey on
 * another - the same reason `employment-shared` exists for contracts and loans.
 */

type Tone = NonNullable<BadgeProps['variant']>;

/**
 * Status colours, chosen by whose move it is rather than by how far along the
 * case is.
 *
 * PENDING is amber because it is waiting on the person reading the screen and
 * is the one status they can do something about. ON_HOLD is grey because it is
 * waiting on somebody else and there is nothing for them to do - a distinction
 * that is invisible if both are painted "in progress".
 */
export const CASE_STATUS_TONE: Record<CaseStatus, Tone> = {
  OPEN: 'primary',
  IN_PROGRESS: 'primary',
  PENDING: 'warning',
  ON_HOLD: 'neutral',
  RESOLVED: 'success',
  CLOSED: 'neutral',
  REOPENED: 'warning',
};

/**
 * Priority colours.
 *
 * Only the two that mean "this is worse than normal" get a colour. Painting
 * Normal and Low as well would make a list of ordinary cases look like an
 * incident board, and the colours would stop carrying information.
 */
export const CASE_PRIORITY_TONE: Record<CasePriority, Tone> = {
  LOW: 'neutral',
  NORMAL: 'neutral',
  HIGH: 'warning',
  URGENT: 'destructive',
};

/** A `yyyy-MM-dd` or ISO instant as a short readable day, or an em dash. */
export function caseDay(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The same instant with its time, for a conversation where minutes matter. */
export function caseTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * A file size a person can read.
 *
 * Decimal units, because that is what the operating system's file dialog told
 * them the file was and disagreeing with it invites a support case of its own.
 */
export function fileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(0)} KB`;
  return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
}
