import * as React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  INTERVIEW_ROUNDS,
  INTERVIEW_ROUND_LABELS,
  INTERVIEW_TYPES,
  INTERVIEW_TYPE_LABELS,
  type InterviewRecord,
  type InterviewScheduleResult,
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
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { FormError, placeFieldErrors } from './form-errors';
import { ConflictWarning } from './conflict-warning';
import { InterviewerPicker } from './interviewer-picker';
import { useConflicts } from './interview-schedule-dialog';
import { splitInZone } from './recruitment-shared';
import { useInterviewers } from './use-recruitment-data';

/**
 * Editing everything about an interview except when it is.
 *
 * The panel is edited HERE rather than on the reschedule form, because
 * changing who is in the room is not a reschedule - nobody's time moves. It
 * still needs the clash check, though: adding a fourth interviewer to an
 * existing slot double-books them exactly as scheduling does, and the endpoint
 * refuses it by default for the same reason.
 *
 * The window is read back out of the existing interview in its own zone and
 * sent to the check unchanged - this form cannot move an interview, so the
 * times here are a question ("is this new person free then?"), never an edit.
 */

interface FormValues {
  type: string;
  round: string;
  interviewerIds: string[];
  leadInterviewerId: string;
  location: string;
  meetingLink: string;
  notes: string;
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function InterviewPanelDialog({
  open,
  interview,
  onClose,
}: {
  open: boolean;
  interview: InterviewRecord;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { interviewers, isLoading } = useInterviewers(open);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [override, setOverride] = React.useState(false);

  const form = useForm<FormValues>({
    defaultValues: {
      type: interview.type,
      round: interview.round,
      interviewerIds: [],
      leadInterviewerId: '',
      location: '',
      meetingLink: '',
      notes: '',
    },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({
      type: interview.type,
      round: interview.round,
      interviewerIds: interview.interviewers.map((person) => person.employeeId),
      leadInterviewerId:
        interview.interviewers.find((person) => person.isLead)?.employeeId ?? '',
      location: interview.location ?? '',
      meetingLink: interview.meetingLink ?? '',
      notes: interview.notes ?? '',
    });
    setFormError(null);
    setOverride(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, interview.id]);

  const values = form.watch();

  React.useEffect(() => {
    setOverride(false);
  }, [values.interviewerIds.length]);

  React.useEffect(() => {
    if (values.leadInterviewerId && !values.interviewerIds.includes(values.leadInterviewerId)) {
      form.setValue('leadInterviewerId', '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.interviewerIds]);

  const start = splitInZone(interview.startsAt, interview.timezone);
  const end = splitInZone(interview.endsAt, interview.timezone);

  /*
   * Only the people being ADDED are worth checking. Everybody already on this
   * interview clashes with it by definition, and `excludeInterviewId` handles
   * that - but asking about the new names only keeps the warning about the
   * change being made.
   */
  const conflicts = useConflicts({
    enabled: open,
    day: start.day,
    startTime: start.time,
    endTime: end.time,
    timezone: interview.timezone,
    interviewerIds: values.interviewerIds,
    excludeInterviewId: interview.id,
  });

  const mutation = useMutation({
    mutationFn: (input: FormValues) =>
      api.patch<InterviewScheduleResult>(`/recruitment/interviews/${interview.id}`, {
        type: input.type,
        round: input.round,
        interviewerIds: input.interviewerIds,
        leadInterviewerId: textOrNull(input.leadInterviewerId),
        location: textOrNull(input.location),
        meetingLink: textOrNull(input.meetingLink),
        notes: textOrNull(input.notes),
        allowConflicts: override,
      }),
    onSuccess: async () => {
      toast.success('Interview updated.');
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form)),
  });

  const blocked = conflicts.data.length > 0 && !override;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="md">
        <DialogHeader>
          <DialogTitle>Edit interview</DialogTitle>
          <DialogDescription>
            Everything but the time. Moving it is a reschedule, which needs a reason.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form
            id="panel-form"
            className="space-y-4"
            onSubmit={form.handleSubmit((input) => {
              setFormError(null);
              mutation.mutate(input);
            })}
          >
            <FormError message={formError} />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Interview type" htmlFor="panel-type">
                <NativeSelect {...form.register('type')}>
                  {INTERVIEW_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {INTERVIEW_TYPE_LABELS[type]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField label="Round" htmlFor="panel-round">
                <NativeSelect {...form.register('round')}>
                  {INTERVIEW_ROUNDS.map((round) => (
                    <option key={round} value={round}>
                      {INTERVIEW_ROUND_LABELS[round]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>

            <FormField
              label="Interviewers"
              htmlFor="panel-interviewers"
              required
              error={form.formState.errors.interviewerIds?.message as string | undefined}
            >
              <Controller
                control={form.control}
                name="interviewerIds"
                rules={{ validate: (value) => value.length > 0 || 'Add at least one interviewer.' }}
                render={({ field }) => (
                  <InterviewerPicker
                    interviewers={interviewers}
                    selected={field.value}
                    onChange={field.onChange}
                    loading={isLoading}
                  />
                )}
              />
            </FormField>

            {values.interviewerIds.length > 1 ? (
              <FormField label="Lead interviewer" htmlFor="panel-lead">
                <NativeSelect {...form.register('leadInterviewerId')}>
                  <option value="">Nobody in particular</option>
                  {interviewers
                    .filter((person) => values.interviewerIds.includes(person.employeeId))
                    .map((person) => (
                      <option key={person.employeeId} value={person.employeeId}>
                        {person.fullName}
                      </option>
                    ))}
                </NativeSelect>
              </FormField>
            ) : null}

            <ConflictWarning
              conflicts={conflicts.data}
              checking={conflicts.isChecking}
              override={override}
              onOverrideChange={setOverride}
              timezone={interview.timezone}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Location" htmlFor="panel-location">
                <Input {...form.register('location')} />
              </FormField>
              <FormField label="Meeting link" htmlFor="panel-link">
                <Input {...form.register('meetingLink')} placeholder="https://" />
              </FormField>
            </div>

            <FormField label="Notes" htmlFor="panel-notes">
              <Textarea rows={4} {...form.register('notes')} />
            </FormField>
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="panel-form"
            loading={mutation.isPending}
            disabled={blocked}
            variant={blocked ? 'outline' : 'primary'}
          >
            {blocked ? 'Resolve the clash first' : override ? 'Save anyway' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
