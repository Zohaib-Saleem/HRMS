import * as React from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  EVALUATION_CRITERIA,
  EVALUATION_SCORE_MAX,
  INTERVIEW_RECOMMENDATIONS,
  INTERVIEW_RECOMMENDATION_LABELS,
  type EvaluationRecord,
  type InterviewRecord,
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
 * Filing your own feedback.
 *
 * "Your own" is the whole design, and it is enforced on the server rather than
 * here: the endpoint resolves the caller's seat on the panel from the session
 * and upserts against THAT, so there is no request shape that files an opinion
 * in somebody else's name or overwrites theirs. Three interviewers produce
 * three separate evaluations. Submitting twice revises your own.
 *
 * Every score is OPTIONAL, and that is load-bearing. An HR interviewer has no
 * business scoring technical skill, and leaving it blank says "not assessed"
 * where a zero would say "assessed, and terrible" - which is the difference
 * between an honest panel summary and a libel. So the control offers "Not
 * assessed" as its first option rather than defaulting to a number.
 *
 * The recommendation is required and the scores are not, because the
 * recommendation is the thing a reader actually acts on. Nothing here averages
 * the numbers, ranks anybody by them, or moves a stage - a person reads the
 * panel's opinions and decides.
 */

interface FormValues {
  technicalScore: string;
  problemSolvingScore: string;
  communicationScore: string;
  experienceScore: string;
  cultureFitScore: string;
  recommendation: string;
  comments: string;
}

const SCORES = Array.from({ length: EVALUATION_SCORE_MAX + 1 }, (_, index) => index);

function scoreOrNull(value: string): number | null {
  return value === '' ? null : Number(value);
}

export function EvaluationDialog({
  open,
  interview,
  existing,
  onClose,
}: {
  open: boolean;
  interview: InterviewRecord;
  /** The caller's own evaluation, when they have already filed one. */
  existing: EvaluationRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<FormValues>({
    defaultValues: {
      technicalScore: '',
      problemSolvingScore: '',
      communicationScore: '',
      experienceScore: '',
      cultureFitScore: '',
      recommendation: 'YES',
      comments: '',
    },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({
      technicalScore: existing?.technicalScore?.toString() ?? '',
      problemSolvingScore: existing?.problemSolvingScore?.toString() ?? '',
      communicationScore: existing?.communicationScore?.toString() ?? '',
      experienceScore: existing?.experienceScore?.toString() ?? '',
      cultureFitScore: existing?.cultureFitScore?.toString() ?? '',
      recommendation: existing?.recommendation ?? 'YES',
      comments: existing?.comments ?? '',
    });
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      api.post<EvaluationRecord>(`/recruitment/interviews/${interview.id}/evaluations`, {
        technicalScore: scoreOrNull(values.technicalScore),
        problemSolvingScore: scoreOrNull(values.problemSolvingScore),
        communicationScore: scoreOrNull(values.communicationScore),
        experienceScore: scoreOrNull(values.experienceScore),
        cultureFitScore: scoreOrNull(values.cultureFitScore),
        recommendation: values.recommendation,
        comments: values.comments.trim() || null,
      }),
    onSuccess: async () => {
      toast.success(existing ? 'Your feedback was updated.' : 'Feedback submitted.');
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form)),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="md">
        <DialogHeader>
          <DialogTitle>{existing ? 'Revise your feedback' : 'Submit feedback'}</DialogTitle>
          <DialogDescription>
            Your own assessment of {interview.candidateName}. It sits alongside the rest of the
            panel's and cannot replace anybody else's.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form
            id="evaluation-form"
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => {
              setFormError(null);
              mutation.mutate(values);
            })}
          >
            <FormError message={formError} />

            <div className="space-y-3">
              {EVALUATION_CRITERIA.map((criterion) => (
                <FormField
                  key={criterion.key}
                  label={`${criterion.label} (out of ${EVALUATION_SCORE_MAX})`}
                  htmlFor={`eval-${criterion.key}`}
                >
                  <NativeSelect {...form.register(criterion.key as keyof FormValues)}>
                    <option value="">Not assessed</option>
                    {SCORES.map((score) => (
                      <option key={score} value={score}>
                        {score}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
              ))}
            </div>

            <FormField
              label="Recommendation"
              htmlFor="eval-recommendation"
              required
              hint="Advice for whoever decides. Nothing is decided by it automatically."
            >
              <NativeSelect {...form.register('recommendation', { required: true })}>
                {INTERVIEW_RECOMMENDATIONS.map((value) => (
                  <option key={value} value={value}>
                    {INTERVIEW_RECOMMENDATION_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField
              label="Comments"
              htmlFor="eval-comments"
              hint="Read by HR and the hiring manager. Never by the candidate."
            >
              <Textarea rows={6} {...form.register('comments')} />
            </FormField>
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="evaluation-form" loading={mutation.isPending}>
            {existing ? 'Update feedback' : 'Submit feedback'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
