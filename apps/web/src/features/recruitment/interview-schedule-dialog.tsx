import * as React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  INTERVIEW_ROUNDS,
  INTERVIEW_ROUND_LABELS,
  INTERVIEW_TYPES,
  INTERVIEW_TYPE_LABELS,
  type CandidateApplicationRecord,
  type InterviewConflict,
  type InterviewScheduleResult,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
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
import { InterviewerPicker } from './interviewer-picker';
import { TimezoneSelect } from './timezone-select';
import { ConflictWarning } from './conflict-warning';
import { addMinutes, todayIn } from './recruitment-shared';
import { useInterviewers, useRecruitmentAccess } from './use-recruitment-data';

/**
 * Booking an interview.
 *
 * The time is a DAY, two wall-clock times and a ZONE - never an instant this
 * browser computed. An instant computed here is computed in the laptop's zone,
 * so a coordinator working from home in another country would book "10:00" and
 * produce an interview at a time nobody agreed to. The server does the
 * arithmetic from the three parts, which is also why the reschedule form takes
 * the same three.
 *
 * CLASHES ARE NEVER SILENT. The conflict check runs as the form is filled in,
 * against the same `findConflicts` the create endpoint uses, and reports who
 * is already busy with whom. Booking over one is then a deliberate act: the
 * button changes its words, the request carries `allowConflicts`, and the
 * audit entry records `bookedOverConflicts`. What cannot happen is a
 * double-booking that nobody was told about - the endpoint refuses by default
 * and this form has no way to send the flag without the person seeing the
 * clash first.
 */

interface FormValues {
  jobOpeningId: string;
  applicationId: string;
  type: string;
  round: string;
  day: string;
  startTime: string;
  endTime: string;
  timezone: string;
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

export function InterviewScheduleDialog({
  open,
  candidateId,
  candidateName,
  applications,
  onClose,
}: {
  open: boolean;
  candidateId: string;
  candidateName: string;
  /** Their live applications, so the vacancy can be preselected. */
  applications: CandidateApplicationRecord[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { companyTimezone } = useRecruitmentAccess();
  const { interviewers, isLoading: loadingPeople } = useInterviewers(open);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [override, setOverride] = React.useState(false);

  const form = useForm<FormValues>({
    defaultValues: {
      jobOpeningId: '',
      applicationId: '',
      type: 'TECHNICAL',
      round: 'ROUND_1',
      day: '',
      startTime: '10:00',
      endTime: '11:00',
      timezone: companyTimezone,
      interviewerIds: [],
      leadInterviewerId: '',
      location: '',
      meetingLink: '',
      notes: '',
    },
  });

  React.useEffect(() => {
    if (!open) return;
    const first = applications[0];
    form.reset({
      jobOpeningId: first?.jobOpeningId ?? '',
      applicationId: first?.id ?? '',
      type: 'TECHNICAL',
      round: 'ROUND_1',
      day: todayIn(companyTimezone),
      startTime: '10:00',
      endTime: '11:00',
      timezone: companyTimezone,
      interviewerIds: [],
      leadInterviewerId: '',
      location: '',
      meetingLink: '',
      notes: '',
    });
    setFormError(null);
    setOverride(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, candidateId]);

  const values = form.watch();

  /*
   * An end time that follows the start time when the start time moves, but
   * only while the two are still an hour apart - so somebody who deliberately
   * booked a ninety-minute slot does not have it silently shortened when they
   * correct the start by five minutes.
   */
  const previousStart = React.useRef(values.startTime);
  React.useEffect(() => {
    const before = previousStart.current;
    previousStart.current = values.startTime;
    if (before === values.startTime) return;
    if (values.endTime === addMinutes(before, 60)) {
      form.setValue('endTime', addMinutes(values.startTime, 60));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.startTime]);

  /** A lead who is no longer on the panel is not a lead. */
  React.useEffect(() => {
    if (values.leadInterviewerId && !values.interviewerIds.includes(values.leadInterviewerId)) {
      form.setValue('leadInterviewerId', '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.interviewerIds]);

  /*
   * Consent to double-book one slot is not consent to double-book the next
   * one somebody types, so the override is dropped whenever the window or the
   * panel changes.
   */
  React.useEffect(() => {
    setOverride(false);
  }, [values.day, values.startTime, values.endTime, values.timezone, values.interviewerIds.length]);

  const conflicts = useConflicts({
    enabled: open,
    day: values.day,
    startTime: values.startTime,
    endTime: values.endTime,
    timezone: values.timezone,
    interviewerIds: values.interviewerIds,
  });

  const mutation = useMutation({
    mutationFn: (input: FormValues) =>
      api.post<InterviewScheduleResult>('/recruitment/interviews', {
        candidateId,
        jobOpeningId: textOrNull(input.jobOpeningId),
        applicationId: textOrNull(input.applicationId),
        type: input.type,
        round: input.round,
        day: input.day,
        startTime: input.startTime,
        endTime: input.endTime,
        timezone: input.timezone,
        interviewerIds: input.interviewerIds,
        leadInterviewerId: textOrNull(input.leadInterviewerId),
        location: textOrNull(input.location),
        meetingLink: textOrNull(input.meetingLink),
        notes: textOrNull(input.notes),
        allowConflicts: override,
      }),
    onSuccess: async (result) => {
      toast.success(scheduleMessage(result));
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
      navigate(`/recruitment/interviews/${result.interview.id}`);
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form)),
  });

  const submit = form.handleSubmit((input) => {
    setFormError(null);
    mutation.mutate(input);
  });

  const blocked = conflicts.data.length > 0 && !override;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="lg">
        <DialogHeader>
          <DialogTitle>Schedule an interview</DialogTitle>
          <DialogDescription>
            With {candidateName}. The panel is notified in the app; whether they also get an email
            depends on how mail is configured.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form id="schedule-form" className="space-y-4" onSubmit={submit}>
            <FormError message={formError} />

            <FormField
              label="Job opening"
              htmlFor="sch-opening"
              hint={
                applications.length === 0
                  ? 'This candidate has no application yet. The interview can still be booked as an exploratory conversation.'
                  : undefined
              }
            >
              <NativeSelect
                value={values.applicationId}
                onChange={(event) => {
                  const application = applications.find((entry) => entry.id === event.target.value);
                  form.setValue('applicationId', application?.id ?? '');
                  form.setValue('jobOpeningId', application?.jobOpeningId ?? '');
                }}
              >
                <option value="">No specific opening</option>
                {applications.map((application) => (
                  <option key={application.id} value={application.id}>
                    {application.jobTitle} ({application.jobReference})
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Interview type" htmlFor="sch-type" required>
                <NativeSelect {...form.register('type')}>
                  {INTERVIEW_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {INTERVIEW_TYPE_LABELS[type]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField label="Round" htmlFor="sch-round" required>
                <NativeSelect {...form.register('round')}>
                  {INTERVIEW_ROUNDS.map((round) => (
                    <option key={round} value={round}>
                      {INTERVIEW_ROUND_LABELS[round]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Date"
                htmlFor="sch-day"
                required
                error={form.formState.errors.day?.message}
              >
                <Input type="date" {...form.register('day', { required: 'Choose a date.' })} />
              </FormField>

              <FormField
                label="Time zone"
                htmlFor="sch-timezone"
                required
                hint="The times below are in this zone."
              >
                <Controller
                  control={form.control}
                  name="timezone"
                  render={({ field }) => (
                    <TimezoneSelect
                      id="sch-timezone"
                      value={field.value}
                      onChange={field.onChange}
                      companyTimezone={companyTimezone}
                    />
                  )}
                />
              </FormField>

              <FormField
                label="Start time"
                htmlFor="sch-start"
                required
                error={form.formState.errors.startTime?.message}
              >
                <Input type="time" {...form.register('startTime', { required: true })} />
              </FormField>

              <FormField
                label="End time"
                htmlFor="sch-end"
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

            <FormField
              label="Interviewers"
              htmlFor="sch-interviewers"
              required
              error={form.formState.errors.interviewerIds?.message as string | undefined}
            >
              <Controller
                control={form.control}
                name="interviewerIds"
                rules={{
                  validate: (value) =>
                    value.length > 0 || 'Add at least one interviewer.',
                }}
                render={({ field }) => (
                  <InterviewerPicker
                    interviewers={interviewers}
                    selected={field.value}
                    onChange={field.onChange}
                    loading={loadingPeople}
                  />
                )}
              />
            </FormField>

            {values.interviewerIds.length > 1 ? (
              <FormField
                label="Lead interviewer"
                htmlFor="sch-lead"
                hint="Optional. Who runs the room."
              >
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
              timezone={values.timezone}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Location" htmlFor="sch-location">
                <Input {...form.register('location')} placeholder="Meeting room 2" />
              </FormField>
              <FormField label="Meeting link" htmlFor="sch-link">
                <Input {...form.register('meetingLink')} placeholder="https://" />
              </FormField>
            </div>

            <FormField
              label="Notes"
              htmlFor="sch-notes"
              hint="Seen by the panel. Not by the candidate."
            >
              <Textarea rows={3} {...form.register('notes')} />
            </FormField>
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="schedule-form"
            loading={mutation.isPending}
            variant={blocked ? 'outline' : 'primary'}
            disabled={blocked}
          >
            {blocked ? 'Resolve the clash first' : override ? 'Book anyway' : 'Schedule interview'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Who is already busy in the proposed window.
 *
 * Debounced, because the inputs it watches change on every keystroke of a time
 * field, and skipped entirely until there is a whole question to ask - a day,
 * two times and at least one person. `retry: false`: a refused check is not a
 * transient fault, and the create endpoint runs the same check anyway, so the
 * worst case of this query failing is a warning that does not appear in
 * advance rather than a double-booking that goes through.
 */
export function useConflicts({
  enabled,
  day,
  startTime,
  endTime,
  timezone,
  interviewerIds,
  excludeInterviewId,
}: {
  enabled: boolean;
  day: string;
  startTime: string;
  endTime: string;
  timezone: string;
  interviewerIds: string[];
  excludeInterviewId?: string;
}): { data: InterviewConflict[]; isChecking: boolean } {
  const key = useDebounced(
    `${day}|${startTime}|${endTime}|${timezone}|${[...interviewerIds].sort().join(',')}`,
    400,
  );

  const complete =
    enabled &&
    day !== '' &&
    startTime !== '' &&
    endTime !== '' &&
    endTime > startTime &&
    interviewerIds.length > 0;

  const query = useQuery({
    queryKey: ['recruitment', 'interviews', 'conflicts', key, excludeInterviewId ?? null],
    queryFn: () =>
      api.get<InterviewConflict[]>('/recruitment/interviews/conflicts', {
        query: {
          day,
          startTime,
          endTime,
          timezone,
          interviewerIds: interviewerIds.join(','),
          excludeInterviewId,
        },
      }),
    enabled: complete,
    retry: false,
    staleTime: 15_000,
  });

  return {
    data: query.data ?? [],
    isChecking: complete && query.isFetching,
  };
}

/**
 * What actually happened, reported honestly.
 *
 * `emailStatus` is the notification service's own answer and is deliberately
 * not flattened into "sent": when mail is configured to the console provider
 * nothing left the building, and telling somebody an email went out when it
 * did not is how a candidate is left waiting. In-app notifications are durable
 * and always written, so those can be stated plainly.
 */
function scheduleMessage(result: InterviewScheduleResult): string {
  const notified =
    result.notified === 0
      ? 'Nobody could be notified in the app'
      : `${result.notified} ${result.notified === 1 ? 'person' : 'people'} notified in the app`;

  const email =
    result.emailStatus === 'delivered'
      ? 'email sent'
      : result.emailStatus === 'unconfirmed'
        ? 'email handed to the mail server'
        : result.emailStatus === 'failed'
          ? 'email failed'
          : 'no email sent';

  return `Interview scheduled. ${notified}, ${email}.`;
}
