import { AlertTriangle, Loader2 } from 'lucide-react';
import type { InterviewConflict } from '@hrms/shared';
import { INTERVIEW_STATUS_LABELS } from '@hrms/shared';
import { interviewDay, interviewRange } from './recruitment-shared';

/**
 * Who is already busy, and what it would take to book anyway.
 *
 * The wording matters more than the box. "There is a conflict" is not
 * something a coordinator can act on; "Ahmed Khan is already with Usman Ahmed
 * from 10:00 to 11:00" is - they can move one, move the other, or decide the
 * clash is fine. So every clash names the person, the candidate they are
 * seeing and the window.
 *
 * The override is a checkbox rather than a second button, and it is
 * unchecked every time the window changes, because consent to double-book
 * ONE slot is not consent to double-book the next one somebody types.
 */
export function ConflictWarning({
  conflicts,
  checking,
  override,
  onOverrideChange,
  timezone,
}: {
  conflicts: InterviewConflict[];
  checking: boolean;
  override: boolean;
  onOverrideChange: (next: boolean) => void;
  /**
   * The zone being booked in, which is the zone these clashes are shown in.
   *
   * A clashing interview carries no zone of its own on this record, and that
   * is fine: the question here is "is this person free at the time I am
   * typing", so every time on screen belongs in the same zone as the form
   * above it. Rendering a clash in its own zone would put two different clocks
   * in one warning.
   */
  timezone: string | null;
}) {
  if (checking && conflicts.length === 0) {
    return (
      <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Checking who is free...
      </p>
    );
  }

  if (conflicts.length === 0) return null;

  return (
    <div
      className="rounded-md border border-warning/40 bg-warning-soft px-3.5 py-3 text-warning-foreground"
      role="alert"
    >
      <p className="flex items-center gap-2 text-[13px] font-medium">
        <AlertTriangle className="size-4 shrink-0" aria-hidden />
        {conflicts.length === 1
          ? 'One interviewer is already booked at that time'
          : `${conflicts.length} clashes at that time`}
      </p>

      <ul className="mt-2 space-y-1.5">
        {conflicts.map((conflict) => (
          <li key={`${conflict.employeeId}-${conflict.interviewId}`} className="text-[12.5px]">
            <span className="font-medium">{conflict.fullName}</span> is with{' '}
            {conflict.candidateName},{' '}
            {interviewDay(conflict.startsAt, timezone)}{' '}
            {interviewRange(conflict.startsAt, conflict.endsAt, timezone)}
            {' · '}
            {INTERVIEW_STATUS_LABELS[conflict.status]}
          </li>
        ))}
      </ul>

      <label className="mt-3 flex items-start gap-2 text-[12.5px]">
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0"
          checked={override}
          onChange={(event) => onOverrideChange(event.target.checked)}
        />
        <span>
          Book it anyway. Sometimes a panellist really does step out of one thing for another -
          this is recorded against the interview either way.
        </span>
      </label>
    </div>
  );
}
