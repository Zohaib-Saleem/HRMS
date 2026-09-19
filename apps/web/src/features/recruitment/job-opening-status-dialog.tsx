import * as React from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  JOB_OPENING_STATUSES,
  JOB_OPENING_STATUS_DESCRIPTIONS,
  JOB_OPENING_STATUS_LABELS,
  jobOpeningNeedsReason,
  type JobOpeningRecord,
  type JobOpeningStatus,
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
 * Moving an opening between statuses.
 *
 * Separate from the edit drawer because closing and cancelling need a reason,
 * and a reason asked for on a form with twenty other fields is a reason
 * somebody types "n/a" into. `jobOpeningNeedsReason` is the SAME predicate the
 * server uses, imported rather than reimplemented, so the field this form marks
 * required and the field the endpoint refuses without cannot drift apart.
 *
 * The current status is absent from the list. Re-submitting it is a 409 -
 * "that opening is already open" - and offering a choice whose only outcome is
 * an error is not a choice.
 */
interface FormValues {
  status: JobOpeningStatus;
  reason: string;
}

export function JobOpeningStatusDialog({
  open,
  opening,
  onClose,
}: {
  open: boolean;
  opening: JobOpeningRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<FormValues>({ defaultValues: { status: 'OPEN', reason: '' } });

  React.useEffect(() => {
    if (!open || !opening) return;
    const first = JOB_OPENING_STATUSES.find((value) => value !== opening.status) ?? 'OPEN';
    form.reset({ status: first, reason: '' });
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, opening?.id]);

  const status = form.watch('status');
  const needsReason = jobOpeningNeedsReason(status);

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      api.post<JobOpeningRecord>(`/recruitment/job-openings/${opening?.id}/status`, {
        status: values.status,
        reason: values.reason.trim() || null,
      }),
    onSuccess: async (saved) => {
      toast.success(`${saved.reference} is now ${JOB_OPENING_STATUS_LABELS[saved.status].toLowerCase()}.`);
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form)),
  });

  if (!opening) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Change status</DialogTitle>
          <DialogDescription>
            {opening.reference} - {opening.title}, currently{' '}
            {JOB_OPENING_STATUS_LABELS[opening.status].toLowerCase()}.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form
            id="job-opening-status-form"
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => {
              setFormError(null);
              mutation.mutate(values);
            })}
          >
            <FormError message={formError} />

            <FormField
              label="New status"
              htmlFor="jos-status"
              hint={JOB_OPENING_STATUS_DESCRIPTIONS[status]}
            >
              <NativeSelect {...form.register('status')}>
                {JOB_OPENING_STATUSES.filter((value) => value !== opening.status).map((value) => (
                  <option key={value} value={value}>
                    {JOB_OPENING_STATUS_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField
              label="Reason"
              htmlFor="jos-reason"
              required={needsReason}
              error={form.formState.errors.reason?.message}
              hint={
                needsReason
                  ? 'Kept with the opening, so why it ended survives the people who were here.'
                  : 'Optional.'
              }
            >
              <Textarea
                rows={3}
                {...form.register('reason', {
                  validate: (value) =>
                    !needsReason || value.trim().length > 0
                      ? true
                      : 'Say why the opening is being closed or cancelled.',
                })}
              />
            </FormField>
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="job-opening-status-form" loading={mutation.isPending}>
            Update status
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
