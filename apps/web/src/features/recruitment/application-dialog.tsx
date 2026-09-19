import * as React from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { JOB_OPENING_ACCEPTING_STATUSES, type CandidateRecord } from '@hrms/shared';
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
import { FormField, NativeSelect } from '@/components/ui/field';
import { FormError, placeFieldErrors } from './form-errors';
import { useJobOpeningOptions } from './use-recruitment-data';

/**
 * Putting an existing candidate against a vacancy.
 *
 * Its own action rather than a field on the candidate form, because an
 * application is a record with its own stage and its own history - somebody
 * shortlisted for one role and rejected for another is one person and two
 * applications, and editing a candidate must never silently move one process
 * onto a different opening.
 *
 * Only openings that are actually taking applications are offered. A closed or
 * draft vacancy is not somewhere a person can be put, and the server refuses
 * it regardless - this list is just the form agreeing with that in advance.
 */
export function ApplicationDialog({
  open,
  candidate,
  onClose,
}: {
  open: boolean;
  candidate: CandidateRecord;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { openings } = useJobOpeningOptions(open);
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<{ jobOpeningId: string }>({ defaultValues: { jobOpeningId: '' } });

  React.useEffect(() => {
    if (!open) return;
    form.reset({ jobOpeningId: '' });
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const alreadyApplied = new Set(candidate.applications.map((entry) => entry.jobOpeningId));
  const available = openings.filter(
    (opening) =>
      JOB_OPENING_ACCEPTING_STATUSES.includes(opening.status) && !alreadyApplied.has(opening.id),
  );

  const mutation = useMutation({
    mutationFn: (values: { jobOpeningId: string }) =>
      api.post<CandidateRecord>(`/recruitment/candidates/${candidate.id}/applications`, {
        jobOpeningId: values.jobOpeningId,
      }),
    onSuccess: async () => {
      toast.success(`${candidate.fullName} added to the opening.`);
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form)),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Apply {candidate.fullName} to an opening</DialogTitle>
          <DialogDescription>
            They keep one record. This adds a second process, not a second person.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form
            id="application-form"
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => {
              setFormError(null);
              mutation.mutate(values);
            })}
          >
            <FormError message={formError} />

            {available.length === 0 ? (
              <p className="text-[13.5px] text-muted-foreground">
                There is no open vacancy left to put them against - either none is taking
                applications, or they are already on all of them.
              </p>
            ) : (
              <FormField
                label="Job opening"
                htmlFor="app-opening"
                required
                error={form.formState.errors.jobOpeningId?.message}
              >
                <NativeSelect
                  {...form.register('jobOpeningId', { required: 'Choose a job opening.' })}
                >
                  <option value="">Choose an opening</option>
                  {available.map((opening) => (
                    <option key={opening.id} value={opening.id}>
                      {opening.title} ({opening.reference})
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            )}
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          {available.length === 0 ? null : (
            <Button type="submit" form="application-form" loading={mutation.isPending}>
              Add application
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
