import * as React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { InterviewRecord, InterviewScheduleResult } from '@hrms/shared';
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
import { FormField, Input, Textarea } from '@/components/ui/field';
import { FormError, placeFieldErrors } from './form-errors';
import { ConflictWarning } from './conflict-warning';
import { TimezoneSelect } from './timezone-select';
import { useConflicts } from './interview-schedule-dialog';
import { splitInZone } from './recruitment-shared';
import { useRecruitmentAccess } from './use-recruitment-data';

/**
 * Moving an interview.
 *
 * The REASON is compulsory, and that is the whole reason this is its own
 * endpoint rather than an edit: a reschedule without a reason is a silent
 * overwrite with a fresh timestamp. What is kept is a row per move - the old
 * window, the new one, who moved it and why - so "we moved this candidate
 * three times" stays a fact about us rather than something only the candidate
 * remembers.
 *
 * The form is prefilled by reading the existing instant back in the
 * INTERVIEW'S OWN ZONE. Prefilling it from the raw ISO string would put UTC in
 * a field labelled "start time", which is the exact bug the day/time/zone
 * split exists to prevent.
 *
 * The clash check excludes this interview, because an interview always clashes
 * with itself.
 */

interface FormValues {
  day: string;
  startTime: string;
  endTime: string;
  timezone: string;
  reason: string;
}

export function InterviewRescheduleDialog({
  open,
  interview,
  onClose,
}: {
  open: boolean;
  interview: InterviewRecord;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { companyTimezone } = useRecruitmentAccess();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [override, setOverride] = React.useState(false);

  const form = useForm<FormValues>({
    defaultValues: { day: '', startTime: '', endTime: '', timezone: companyTimezone, reason: '' },
  });

  React.useEffect(() => {
    if (!open) return;
    const start = splitInZone(interview.startsAt, interview.timezone);
    const end = splitInZone(interview.endsAt, interview.timezone);
    form.reset({
      day: start.day,
      startTime: start.time,
      endTime: end.time,
      timezone: interview.timezone,
      reason: '',
    });
    setFormError(null);
    setOverride(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, interview.id]);

  const values = form.watch();

  React.useEffect(() => {
    setOverride(false);
  }, [values.day, values.startTime, values.endTime, values.timezone]);

  const conflicts = useConflicts({
    enabled: open,
    day: values.day,
    startTime: values.startTime,
    endTime: values.endTime,
    timezone: values.timezone,
    interviewerIds: interview.interviewers.map((person) => person.employeeId),
    excludeInterviewId: interview.id,
  });

  const mutation = useMutation({
    mutationFn: (input: FormValues) =>
      api.post<InterviewScheduleResult>(`/recruitment/interviews/${interview.id}/reschedule`, {
        day: input.day,
        startTime: input.startTime,
        endTime: input.endTime,
        timezone: input.timezone,
        reason: input.reason,
        allowConflicts: override,
      }),
    onSuccess: async () => {
      toast.success('Interview moved. The panel has been told.');
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form)),
  });

  const blocked = conflicts.data.length > 0 && !override;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Reschedule</DialogTitle>
          <DialogDescription>
            The {interview.candidateName} interview. The old time is kept with the record.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form
            id="reschedule-form"
            className="space-y-4"
            onSubmit={form.handleSubmit((input) => {
              setFormError(null);
              mutation.mutate(input);
            })}
          >
            <FormError message={formError} />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Date"
                htmlFor="res-day"
                required
                error={form.formState.errors.day?.message}
              >
                <Input type="date" {...form.register('day', { required: 'Choose a date.' })} />
              </FormField>

              <FormField label="Time zone" htmlFor="res-timezone" required>
                <Controller
                  control={form.control}
                  name="timezone"
                  render={({ field }) => (
                    <TimezoneSelect
                      id="res-timezone"
                      value={field.value}
                      onChange={field.onChange}
                      companyTimezone={companyTimezone}
                    />
                  )}
                />
              </FormField>

              <FormField
                label="Start time"
                htmlFor="res-start"
                required
                error={form.formState.errors.startTime?.message}
              >
                <Input type="time" {...form.register('startTime', { required: true })} />
              </FormField>

              <FormField
                label="End time"
                htmlFor="res-end"
                required
                error={form.formState.errors.endTime?.message}
              >
                <Input
                  type="time"
                  {...form.register('endTime', {
                    required: true,
                    validate: (value) =>
                      value > form.getValues('startTime') ||
                      'The end time must be after the start time.',
                  })}
                />
              </FormField>
            </div>

            <ConflictWarning
              conflicts={conflicts.data}
              checking={conflicts.isChecking}
              override={override}
              onOverrideChange={setOverride}
              timezone={values.timezone}
            />

            <FormField
              label="Why it is moving"
              htmlFor="res-reason"
              required
              error={form.formState.errors.reason?.message}
              hint="Kept on the record, and sent to the panel."
            >
              <Textarea
                rows={3}
                {...form.register('reason', {
                  validate: (value) => value.trim().length > 0 || 'Say why it is moving.',
                })}
              />
            </FormField>
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="reschedule-form"
            loading={mutation.isPending}
            disabled={blocked}
            variant={blocked ? 'outline' : 'primary'}
          >
            {blocked ? 'Resolve the clash first' : override ? 'Move it anyway' : 'Move interview'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
