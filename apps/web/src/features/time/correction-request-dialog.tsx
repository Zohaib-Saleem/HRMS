import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ATTENDANCE_CORRECTION_ISSUES,
  ATTENDANCE_CORRECTION_ISSUE_FIELDS,
  ATTENDANCE_CORRECTION_ISSUE_HINTS,
  ATTENDANCE_CORRECTION_ISSUE_LABELS,
  type AttendanceCorrectionIssue,
  type RegularizationCreateInput,
  regularizationCreateSchema,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * The one form an employee uses to ask for a day to be corrected.
 *
 * One form rather than one per screen: it is opened from the Attendance page,
 * from a row of the employee's own month, and from the corrections screen, and
 * all three post to the same endpoint with the same shape. A second copy of
 * this form is how two screens come to disagree about which fields a
 * correction needs.
 *
 * What it deliberately does NOT carry is an employee id. The endpoint files the
 * request against whoever the session resolves to, so there is no field here -
 * hidden, disabled or otherwise - that could name somebody else.
 *
 * The times are sent as `HH:mm` and resolved by the server against the
 * attendance date in the COMPANY's timezone. Sending a browser-built instant
 * instead would mean an employee filing from another country asking for a
 * different minute than the one they typed.
 */

const today = () => new Date().toISOString().slice(0, 10);

const blank = (date?: string): RegularizationCreateInput => ({
  attendanceDate: date ?? today(),
  issueType: 'MISSING_PUNCH',
  requestedCheckInAt: null,
  requestedCheckOutAt: null,
  requestedStatus: null,
  reason: '',
});

export function CorrectionRequestDialog({
  open,
  onClose,
  /** Prefills the date, so a row's own button opens the form on that day. */
  date,
}: {
  open: boolean;
  onClose: () => void;
  date?: string;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<RegularizationCreateInput>({
    resolver: zodResolver(regularizationCreateSchema),
    defaultValues: blank(date),
  });

  React.useEffect(() => {
    if (open) {
      form.reset(blank(date));
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, date]);

  const mutation = useMutation({
    mutationFn: (values: RegularizationCreateInput) =>
      api.post('/attendance/regularizations', values),
    onSuccess: async () => {
      toast.success('Correction requested', {
        description:
          'It is with your manager for approval. Your attendance is unchanged until they decide.',
      });
      await queryClient.invalidateQueries({ queryKey: ['attendance', 'regularizations'] });
      await queryClient.invalidateQueries({ queryKey: ['approvals'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        const unplaced: string[] = [];
        for (const [field, messages] of Object.entries(error.details)) {
          const message = messages[0] ?? 'Invalid value.';
          if (field in form.getValues()) {
            form.setError(field as keyof RegularizationCreateInput, { message });
          } else {
            unplaced.push(message);
          }
        }
        if (unplaced.length > 0) setFormError(unplaced.join(' '));
        return;
      }
      setFormError(errorMessage(error));
    },
  });

  const errors = form.formState.errors;
  const issue = (form.watch('issueType') ?? 'OTHER') as AttendanceCorrectionIssue;
  const fields = ATTENDANCE_CORRECTION_ISSUE_FIELDS[issue];

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="md">
        <form
          onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
          className="contents"
          noValidate
        >
          <DialogHeader>
            <DialogTitle>Request an attendance correction</DialogTitle>
            <DialogDescription>
              This goes to your reporting manager for approval. Your attendance record is never
              edited directly - it is updated only once the request is approved.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {formError ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive"
              >
                {formError}
              </p>
            ) : null}

            <FormField
              label="Date"
              htmlFor="correction-date"
              required
              error={errors.attendanceDate?.message}
            >
              <Input
                id="correction-date"
                type="date"
                max={today()}
                autoFocus
                {...form.register('attendanceDate')}
              />
            </FormField>

            <FormField
              label="What went wrong?"
              htmlFor="correction-issue"
              required
              hint={ATTENDANCE_CORRECTION_ISSUE_HINTS[issue]}
              error={errors.issueType?.message}
            >
              <NativeSelect id="correction-issue" {...form.register('issueType')}>
                {ATTENDANCE_CORRECTION_ISSUES.map((value) => (
                  <option key={value} value={value}>
                    {ATTENDANCE_CORRECTION_ISSUE_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            {/* Only the times the chosen issue is about. Offering both for an
                "incorrect check-in" invites a correction that also silently
                rewrites a departure nobody complained about. */}
            <div className="grid gap-4 sm:grid-cols-2">
              {fields.checkIn ? (
                <FormField
                  label="Check-in time"
                  htmlFor="correction-check-in"
                  hint="Leave blank if it is already right."
                  error={errors.requestedCheckInAt?.message}
                >
                  <Input
                    id="correction-check-in"
                    type="time"
                    {...form.register('requestedCheckInAt')}
                  />
                </FormField>
              ) : null}
              {fields.checkOut ? (
                <FormField
                  label="Check-out time"
                  htmlFor="correction-check-out"
                  hint="Leave blank if it is already right."
                  error={errors.requestedCheckOutAt?.message}
                >
                  <Input
                    id="correction-check-out"
                    type="time"
                    {...form.register('requestedCheckOutAt')}
                  />
                </FormField>
              ) : null}
            </div>

            <FormField
              label="Reason"
              htmlFor="correction-reason"
              required
              hint="What happened, and anything your manager would need to confirm it."
              error={errors.reason?.message}
            >
              <Textarea
                id="correction-reason"
                rows={4}
                placeholder="Explain what should be corrected and why."
                {...form.register('reason')}
              />
            </FormField>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Submit request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
