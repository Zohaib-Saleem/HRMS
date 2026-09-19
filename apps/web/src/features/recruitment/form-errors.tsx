import type { UseFormReturn, FieldValues } from 'react-hook-form';
import { ApiError, errorMessage } from '@/lib/api';

/**
 * The server's field errors, placed on the form that produced them.
 *
 * Every write endpoint in recruitment answers a bad body with a 422 whose
 * `details` is keyed by field - `salaryMax`, `endTime`, `leadInterviewerId`.
 * Dropping that into a toast would hand somebody "The end time must be after
 * the start time" floating above a form with eleven fields, so each message is
 * put where it belongs and only what has nowhere to go is returned for the
 * banner.
 *
 * A message whose field is not on THIS form is returned rather than discarded.
 * The scheduling form is the case that matters: it can be refused for a
 * `candidateId` it never showed, and swallowing that would leave a form that
 * silently refuses to submit.
 */
export function placeFieldErrors<T extends FieldValues>(
  error: unknown,
  form: UseFormReturn<T>,
): string | null {
  if (error instanceof ApiError && error.isValidation && error.details) {
    const unplaced: string[] = [];
    const values = form.getValues();
    for (const [field, messages] of Object.entries(error.details)) {
      const message = messages[0] ?? 'Invalid value.';
      if (field in values) form.setError(field as never, { message });
      else unplaced.push(message);
    }
    return unplaced.length > 0 ? unplaced.join(' ') : null;
  }
  return errorMessage(error);
}

const ERROR_BOX =
  'rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive';

/** The banner for a refusal that is about the whole form rather than a field. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className={ERROR_BOX} role="alert">
      {message}
    </p>
  );
}
