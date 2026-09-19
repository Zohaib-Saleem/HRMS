import * as React from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_LABELS,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  JOB_OPENING_STATUSES,
  JOB_OPENING_STATUS_DESCRIPTIONS,
  JOB_OPENING_STATUS_LABELS,
  type JobOpeningRecord,
  type JobOpeningStatus,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
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
import { useInterviewers } from './use-recruitment-data';
import { useRecruitmentAccess } from './use-recruitment-data';
import { placeFieldErrors, FormError } from './form-errors';

/**
 * Creating and editing a vacancy.
 *
 * One drawer for both, because the fields are the same and a second component
 * that drifted from this one is how "edit" ends up missing the field "create"
 * gained last month. The only difference is the STATUS control, which appears
 * on create and not on edit - moving an opening to CLOSED or CANCELLED needs a
 * reason, so it has its own endpoint and its own dialog rather than riding
 * along on a form save where the reason could be forgotten. The API's update
 * schema does not accept a status at all, which is what makes that a design
 * rather than a convention.
 *
 * Every id on this form comes from a lookup the company already owns -
 * departments, teams, locations, employees. There is no free-text department
 * anywhere here, so an opening cannot be filed against a department that does
 * not exist, and the server re-reads each id regardless.
 */

interface FormValues {
  title: string;
  departmentId: string;
  teamId: string;
  locationId: string;
  employmentType: string;
  expectedEmploymentStatus: string;
  vacancies: string;
  hiringManagerId: string;
  recruiterId: string;
  minExperienceYears: string;
  salaryMin: string;
  salaryMax: string;
  salaryCurrency: string;
  openingDate: string;
  closingDate: string;
  skills: string;
  description: string;
  requirements: string;
  status: JobOpeningStatus;
}

const BLANK: FormValues = {
  title: '',
  departmentId: '',
  teamId: '',
  locationId: '',
  employmentType: 'FULL_TIME',
  expectedEmploymentStatus: '',
  vacancies: '1',
  hiringManagerId: '',
  recruiterId: '',
  minExperienceYears: '',
  salaryMin: '',
  salaryMax: '',
  salaryCurrency: '',
  openingDate: '',
  closingDate: '',
  skills: '',
  description: '',
  requirements: '',
  status: 'DRAFT',
};

/** A number field's value, where empty means "not stated" rather than zero. */
function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toForm(opening: JobOpeningRecord, fallbackCurrency: string): FormValues {
  return {
    title: opening.title,
    departmentId: opening.department?.id ?? '',
    teamId: opening.team?.id ?? '',
    locationId: opening.location?.id ?? '',
    employmentType: opening.employmentType,
    expectedEmploymentStatus: opening.expectedEmploymentStatus ?? '',
    vacancies: String(opening.vacancies),
    hiringManagerId: opening.hiringManager?.id ?? '',
    recruiterId: opening.recruiter?.id ?? '',
    minExperienceYears: opening.minExperienceYears === null ? '' : String(opening.minExperienceYears),
    salaryMin: opening.salaryMin === null ? '' : String(opening.salaryMin),
    salaryMax: opening.salaryMax === null ? '' : String(opening.salaryMax),
    salaryCurrency: opening.salaryCurrency ?? fallbackCurrency,
    // The API hands back an instant; a date input wants the day out of it.
    openingDate: opening.openingDate ? opening.openingDate.slice(0, 10) : '',
    closingDate: opening.closingDate ? opening.closingDate.slice(0, 10) : '',
    skills: opening.skills ?? '',
    description: opening.description ?? '',
    requirements: opening.requirements ?? '',
    status: opening.status,
  };
}

export function JobOpeningFormDrawer({
  open,
  opening,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Null for a new vacancy; a record to edit one. */
  opening: JobOpeningRecord | null;
  onClose: () => void;
  onSaved?: (saved: JobOpeningRecord) => void;
}) {
  const queryClient = useQueryClient();
  const { currency } = useRecruitmentAccess();
  const { lookups } = useLookups();
  const { interviewers } = useInterviewers(open);
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<FormValues>({ defaultValues: BLANK });

  React.useEffect(() => {
    if (!open) return;
    form.reset(opening ? toForm(opening, currency) : { ...BLANK, salaryCurrency: currency });
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, opening?.id]);

  const departmentId = form.watch('departmentId');
  const status = form.watch('status');

  /*
   * A team belongs to a department, so a team left selected after the
   * department changed is a combination the server will refuse and the reader
   * can already see is wrong.
   */
  const teams = lookups.teams.filter((team) => !departmentId || team.departmentId === departmentId);
  React.useEffect(() => {
    const teamId = form.getValues('teamId');
    if (teamId && !teams.some((team) => team.id === teamId)) form.setValue('teamId', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentId]);

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const body = {
        title: values.title,
        departmentId: textOrNull(values.departmentId),
        teamId: textOrNull(values.teamId),
        locationId: textOrNull(values.locationId),
        employmentType: values.employmentType,
        expectedEmploymentStatus: textOrNull(values.expectedEmploymentStatus),
        vacancies: numberOrNull(values.vacancies) ?? 1,
        hiringManagerId: textOrNull(values.hiringManagerId),
        recruiterId: textOrNull(values.recruiterId),
        minExperienceYears: numberOrNull(values.minExperienceYears),
        salaryMin: numberOrNull(values.salaryMin),
        salaryMax: numberOrNull(values.salaryMax),
        salaryCurrency: textOrNull(values.salaryCurrency),
        openingDate: textOrNull(values.openingDate),
        closingDate: textOrNull(values.closingDate),
        skills: textOrNull(values.skills),
        description: textOrNull(values.description),
        requirements: textOrNull(values.requirements),
      };

      return opening
        ? api.patch<JobOpeningRecord>(`/recruitment/job-openings/${opening.id}`, body)
        : api.post<JobOpeningRecord>('/recruitment/job-openings', {
            ...body,
            status: values.status,
          });
    },
    onSuccess: async (saved) => {
      toast.success(opening ? 'Opening updated.' : `${saved.reference} created.`);
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
      onSaved?.(saved);
      onClose();
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form)),
  });

  const submit = form.handleSubmit((values) => {
    setFormError(null);
    mutation.mutate(values);
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="lg">
        <DialogHeader>
          <DialogTitle>{opening ? `Edit ${opening.reference}` : 'New job opening'}</DialogTitle>
          <DialogDescription>
            {opening
              ? 'Changing the status needs a reason, so it has its own action on the opening.'
              : 'A draft is not advertised and takes no applications until you open it.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form id="job-opening-form" onSubmit={submit} className="space-y-4">
            <FormError message={formError} />

            <FormField
              label="Job title"
              htmlFor="jo-title"
              required
              error={form.formState.errors.title?.message}
            >
              <Input
                {...form.register('title', { required: 'A job title is required.' })}
                placeholder="Senior Unity Developer"
              />
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Department" htmlFor="jo-department">
                <NativeSelect {...form.register('departmentId')}>
                  <option value="">Not stated</option>
                  {lookups.departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.label}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Team"
                htmlFor="jo-team"
                hint={departmentId ? undefined : 'Choose a department first.'}
              >
                <NativeSelect {...form.register('teamId')} disabled={!departmentId}>
                  <option value="">Not stated</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.label}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField label="Location" htmlFor="jo-location">
                <NativeSelect {...form.register('locationId')}>
                  <option value="">Not stated</option>
                  {lookups.locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.label}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Vacancies"
                htmlFor="jo-vacancies"
                required
                error={form.formState.errors.vacancies?.message}
              >
                <Input type="number" min={1} max={999} {...form.register('vacancies')} />
              </FormField>

              <FormField label="Employment type" htmlFor="jo-type">
                <NativeSelect {...form.register('employmentType')}>
                  {EMPLOYMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {EMPLOYMENT_TYPE_LABELS[type]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              {/*
                Nullish rather than defaulted, deliberately. A vacancy that has
                not decided whether the post is probationary or permanent is
                not the same as one offering permanence, and picking a default
                here would write an answer nobody gave.
              */}
              <FormField
                label="Employment status offered"
                htmlFor="jo-employment-status"
                hint="What the successful candidate starts on."
              >
                <NativeSelect {...form.register('expectedEmploymentStatus')}>
                  <option value="">Not decided</option>
                  {EMPLOYMENT_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {EMPLOYMENT_STATUS_LABELS[value]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField label="Hiring manager" htmlFor="jo-manager">
                <NativeSelect {...form.register('hiringManagerId')}>
                  <option value="">Not assigned</option>
                  {interviewers.map((person) => (
                    <option key={person.employeeId} value={person.employeeId}>
                      {person.fullName}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField label="Recruiter" htmlFor="jo-recruiter">
                <NativeSelect {...form.register('recruiterId')}>
                  <option value="">Not assigned</option>
                  {interviewers.map((person) => (
                    <option key={person.employeeId} value={person.employeeId}>
                      {person.fullName}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Minimum experience (years)"
                htmlFor="jo-experience"
                error={form.formState.errors.minExperienceYears?.message}
              >
                <Input type="number" min={0} max={60} {...form.register('minExperienceYears')} />
              </FormField>

              <FormField label="Currency" htmlFor="jo-currency">
                <Input maxLength={8} {...form.register('salaryCurrency')} />
              </FormField>

              <FormField
                label="Salary from"
                htmlFor="jo-salary-min"
                error={form.formState.errors.salaryMin?.message}
              >
                <Input type="number" min={0} step={1000} {...form.register('salaryMin')} />
              </FormField>

              <FormField
                label="Salary to"
                htmlFor="jo-salary-max"
                error={form.formState.errors.salaryMax?.message}
              >
                <Input type="number" min={0} step={1000} {...form.register('salaryMax')} />
              </FormField>

              <FormField
                label="Opening date"
                htmlFor="jo-opening-date"
                error={form.formState.errors.openingDate?.message}
              >
                <Input type="date" {...form.register('openingDate')} />
              </FormField>

              <FormField
                label="Closing date"
                htmlFor="jo-closing-date"
                error={form.formState.errors.closingDate?.message}
              >
                <Input type="date" {...form.register('closingDate')} />
              </FormField>
            </div>

            <FormField
              label="Skills"
              htmlFor="jo-skills"
              hint="Comma separated. Searchable from the openings list."
            >
              <Input {...form.register('skills')} placeholder="Unity, C#, Shader Graph" />
            </FormField>

            <FormField label="Description" htmlFor="jo-description">
              <Textarea rows={5} {...form.register('description')} />
            </FormField>

            <FormField label="Requirements" htmlFor="jo-requirements">
              <Textarea rows={5} {...form.register('requirements')} />
            </FormField>

            {opening ? null : (
              <FormField
                label="Status"
                htmlFor="jo-status"
                hint={JOB_OPENING_STATUS_DESCRIPTIONS[status]}
              >
                <NativeSelect {...form.register('status')}>
                  {JOB_OPENING_STATUSES.filter(
                    // Creating something already cancelled or closed is not a
                    // state anybody means to be in, and both need a reason.
                    (value) => value !== 'CLOSED' && value !== 'CANCELLED',
                  ).map((value) => (
                    <option key={value} value={value}>
                      {JOB_OPENING_STATUS_LABELS[value]}
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
          <Button type="submit" form="job-opening-form" loading={mutation.isPending}>
            {opening ? 'Save changes' : 'Create opening'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
