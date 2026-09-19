import * as React from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  INTERVIEW_STATUS_DESCRIPTIONS,
  INTERVIEW_STATUS_LABELS,
  INTERVIEW_STATUS_TRANSITIONS,
  type InterviewRecord,
  type InterviewStatus,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField, NativeSelect, Textarea } from '@/components/ui/field';
import { FormError, placeFieldErrors } from './form-errors';

/**
 * Marking an interview confirmed, complete, cancelled or a no-show.
 *
 * The destinations come from `INTERVIEW_STATUS_TRANSITIONS`, the same map the
 * server checks - so this dialog cannot offer a move the endpoint refuses.
 * RESCHEDULED is absent from every list in that map by design: it is a status
 * a reschedule PRODUCES, never one somebody picks, and the reschedule endpoint
 * is the only thing that writes it.
 *
 * Cancelling requires a reason. A cancelled interview is never deleted - the
 * row stays, which is how "we cancelled on this candidate twice" remains a
 * fact about us rather than a gap in a calendar.
 *
 * `target` lets a screen open this straight onto one outcome, which is what
 * the "Mark completed" and "Cancel" buttons do: the same dialog, one choice
 * already made.
 */

interface FormValues {
  status: InterviewStatus;
  reason: string;
}

export function InterviewStatusDialog({
  open,
  interview,
  target,
  onClose,
}: {
  open: boolean;
  interview: InterviewRecord;
  /** Preselected outcome, when the screen already knows which one. */
  target?: InterviewStatus;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const options = INTERVIEW_STATUS_TRANSITIONS[interview.status];
  const form = useForm<FormValues>({ defaultValues: { status: 'COMPLETED', reason: '' } });

  React.useEffect(() => {
    if (!open) return;
    const initial = target && options.includes(target) ? target : (options[0] ?? 'COMPLETED');
    form.reset({ status: initial, reason: '' });
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, interview.id, target]);

  const status = form.watch('status');
  const needsReason = status === 'CANCELLED';

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      api.post<InterviewRecord>(`/recruitment/interviews/${interview.id}/status`, {
        status: values.status,
        reason: values.reason.trim() || null,
      }),
    onSuccess: async (saved) => {
      toast.success(`Interview marked ${INTERVIEW_STATUS_LABELS[saved.status].toLowerCase()}.`);
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form)),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Update interview</DialogTitle>
          <DialogDescription>
            {interview.candidateName}, currently{' '}
            {INTERVIEW_STATUS_LABELS[interview.status].toLowerCase()}.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {options.length === 0 ? (
            <p className="text-[13.5px] text-muted-foreground">
              A cancelled interview is finished. If it is happening after all, book a new one -
              that keeps the cancellation visible instead of erasing it.
            </p>
          ) : (
            <form
              id="interview-status-form"
              className="space-y-4"
              onSubmit={form.handleSubmit((values) => {
                setFormError(null);
                mutation.mutate(values);
              })}
            >
              <FormError message={formError} />

              <FormField
                label="Mark as"
                htmlFor="ist-status"
                hint={INTERVIEW_STATUS_DESCRIPTIONS[status]}
              >
                <NativeSelect {...form.register('status')}>
                  {options.map((value) => (
                    <option key={value} value={value}>
                      {INTERVIEW_STATUS_LABELS[value]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Reason"
                htmlFor="ist-reason"
                required={needsReason}
                error={form.formState.errors.reason?.message}
                hint={
                  needsReason
                    ? 'Sent to the panel, and kept with the interview.'
                    : 'Optional.'
                }
              >
                <Textarea
                  rows={3}
                  {...form.register('reason', {
                    validate: (value) =>
                      !needsReason || value.trim().length > 0
                        ? true
                        : 'Say why the interview is being cancelled.',
                  })}
                />
              </FormField>

              {status === 'COMPLETED' ? (
                <p className="rounded-md border border-border bg-surface-muted px-3 py-2.5 text-[13px] text-muted-foreground">
                  Everyone on the panel is asked for their feedback once this is marked complete.
                  Each of them files their own.
                </p>
              ) : null}
            </form>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            {options.length === 0 ? 'Close' : 'Cancel'}
          </Button>
          {options.length === 0 ? null : (
            <Button
              type="submit"
              form="interview-status-form"
              loading={mutation.isPending}
              variant={status === 'CANCELLED' ? 'destructive' : 'primary'}
            >
              {status === 'CANCELLED' ? 'Cancel interview' : 'Update'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
