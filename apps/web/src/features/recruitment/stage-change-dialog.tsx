import * as React from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CANDIDATE_STAGE_DESCRIPTIONS,
  CANDIDATE_STAGE_LABELS,
  CANDIDATE_STAGE_TRANSITIONS,
  stageNeedsReason,
  type CandidateApplicationRecord,
  type CandidateRecord,
  type CandidateStage,
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
 * Moving a candidate through the pipeline.
 *
 * The stage belongs to the APPLICATION, not to the person, which is what this
 * dialog is built around: somebody shortlisted for one role and rejected for
 * another on the same afternoon is an ordinary Tuesday, and a single stage on
 * the candidate could only record one of those. So the thing being moved here
 * is always an application, named in the title.
 *
 * The destinations come from `CANDIDATE_STAGE_TRANSITIONS`, which is the SAME
 * map the server checks against - imported, not copied. A move this dialog
 * offers is therefore a move the endpoint allows, and the two cannot drift into
 * disagreeing. The one case worth naming: HIRED is reachable only from OFFER,
 * and reaching it creates no employee. That is a separate, reviewed action
 * behind its own permission.
 */

interface FormValues {
  stage: CandidateStage;
  reason: string;
}

export function StageChangeDialog({
  open,
  candidateName,
  application,
  onClose,
}: {
  open: boolean;
  candidateName: string;
  application: CandidateApplicationRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const options = application ? CANDIDATE_STAGE_TRANSITIONS[application.stage] : [];

  const form = useForm<FormValues>({ defaultValues: { stage: 'SCREENING', reason: '' } });

  React.useEffect(() => {
    if (!open || !application) return;
    form.reset({ stage: options[0] ?? 'SCREENING', reason: '' });
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, application?.id]);

  const stage = form.watch('stage');
  const needsReason = stageNeedsReason(stage);

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      api.post<CandidateRecord>(
        `/recruitment/candidates/applications/${application?.id}/stage`,
        { stage: values.stage, reason: values.reason.trim() || null },
      ),
    onSuccess: async (saved) => {
      toast.success(`${saved.fullName} moved to ${CANDIDATE_STAGE_LABELS[stage]}.`);
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form)),
  });

  if (!application) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Move {candidateName}</DialogTitle>
          <DialogDescription>
            {application.jobTitle} ({application.jobReference}), currently at{' '}
            {CANDIDATE_STAGE_LABELS[application.stage].toLowerCase()}.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {options.length === 0 ? (
            /*
             * HIRED is the only stage with nowhere to go, and saying so plainly
             * is better than an empty select. Undoing a hire is an employee
             * record action, not a move on a board.
             */
            <p className="text-[13.5px] text-muted-foreground">
              {candidateName} is hired for this role. There is nowhere further to move them from
              here - reversing a hire is a change to the employee record, not to the pipeline.
            </p>
          ) : (
            <form
              id="stage-form"
              className="space-y-4"
              onSubmit={form.handleSubmit((values) => {
                setFormError(null);
                mutation.mutate(values);
              })}
            >
              <FormError message={formError} />

              <FormField
                label="Move to"
                htmlFor="stage-target"
                hint={CANDIDATE_STAGE_DESCRIPTIONS[stage]}
              >
                <NativeSelect {...form.register('stage')}>
                  {options.map((value) => (
                    <option key={value} value={value}>
                      {CANDIDATE_STAGE_LABELS[value]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Reason"
                htmlFor="stage-reason"
                required={needsReason}
                error={form.formState.errors.reason?.message}
                hint={
                  needsReason
                    ? 'Kept with the application. It is what answers "why" when this CV arrives again.'
                    : 'Optional.'
                }
              >
                <Textarea
                  rows={3}
                  {...form.register('reason', {
                    validate: (value) =>
                      !needsReason || value.trim().length > 0
                        ? true
                        : `Say why ${candidateName} is being marked ${CANDIDATE_STAGE_LABELS[stage].toLowerCase()}.`,
                  })}
                />
              </FormField>

              {stage === 'HIRED' ? (
                <p className="rounded-md border border-border bg-surface-muted px-3 py-2.5 text-[13px] text-muted-foreground">
                  Marking somebody hired does not create an employee record. Converting them is a
                  separate action, reviewed by a person, on their profile.
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
            <Button type="submit" form="stage-form" loading={mutation.isPending}>
              Move candidate
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
