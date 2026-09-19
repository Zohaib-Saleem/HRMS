import * as React from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, UserCheck } from 'lucide-react';
import {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_DESCRIPTIONS,
  EMPLOYMENT_STATUS_LABELS,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  type CandidateConversionPreview,
  type CandidateRecord,
  type EmploymentStatus,
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
import { FormField, Input, NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { FormError, placeFieldErrors } from './form-errors';
import { useInterviewers } from './use-recruitment-data';

/**
 * Convert to Employee: the one bridge between a candidate and the staff roster.
 *
 * Three rules are visible on this form and enforced behind it.
 *
 * FIRST, A PERSON REVIEWS IT. The server proposes a mapping - name split,
 * employee number, department from the vacancy, title from the offer - and
 * this form shows every proposed value in an editable field. What is submitted
 * is what somebody looked at, not what the candidate record happened to hold.
 *
 * SECOND, DUPLICATES ARE REFUSED BY DEFAULT. Existing employees who look like
 * this person - by email, which is close to proof, or by name, which is a
 * prompt to look - are listed at the top, and the conversion is refused while
 * any are present unless a person ticks the box saying they have looked. The
 * check is re-run at the moment of writing, not trusted from this preview: a
 * preview taken ten minutes ago says nothing about the employee somebody else
 * created five minutes ago.
 *
 * THIRD, EMPLOYMENT STATUS DEFAULTS TO PROBATION, and it is a default rather
 * than a rule - HR chooses Permanent or Internee when that is the deal. It is
 * the same canonical enum the employee record uses, so nothing is translated
 * on the way across. (Permanent is refused by the server for a new hire with
 * no confirmation date, which is the employee module's own existing rule
 * applied here rather than reinvented.)
 *
 * And what this does NOT do: create a login. No user account, no invitation,
 * no password email. Giving somebody access to the system is a separate,
 * deliberate act in Settings, and the audit entry for this conversion records
 * `loginCreated: false` so the absence is a fact somebody can look up later.
 */

interface FormValues {
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  personalEmail: string;
  phone: string;
  departmentId: string;
  teamId: string;
  designationId: string;
  locationId: string;
  managerId: string;
  jobTitle: string;
  employmentType: string;
  employmentStatus: string;
  hireDate: string;
  sourceOfHire: string;
  linkedinUrl: string;
  acknowledgeDuplicates: boolean;
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function ConvertToEmployeeDialog({
  open,
  candidate,
  onClose,
}: {
  open: boolean;
  candidate: CandidateRecord;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { lookups } = useLookups();
  const { interviewers } = useInterviewers(open);
  const [formError, setFormError] = React.useState<string | null>(null);

  const preview = useQuery({
    queryKey: ['recruitment', 'candidates', candidate.id, 'conversion-preview'],
    queryFn: () =>
      api.get<CandidateConversionPreview>(
        `/recruitment/candidates/${candidate.id}/conversion-preview`,
      ),
    enabled: open,
    // A stale proposal is worse than none: department, title and joining date
    // all come from records somebody may have just changed.
    staleTime: 0,
  });

  const form = useForm<FormValues>({
    defaultValues: {
      employeeNumber: '',
      firstName: '',
      lastName: '',
      workEmail: '',
      personalEmail: '',
      phone: '',
      departmentId: '',
      teamId: '',
      designationId: '',
      locationId: '',
      managerId: '',
      jobTitle: '',
      employmentType: 'FULL_TIME',
      employmentStatus: 'PROBATION',
      hireDate: '',
      sourceOfHire: '',
      linkedinUrl: '',
      acknowledgeDuplicates: false,
    },
  });

  const suggested = preview.data?.suggested;

  React.useEffect(() => {
    if (!open || !suggested) return;
    form.reset({
      employeeNumber: suggested.employeeNumber,
      firstName: suggested.firstName,
      lastName: suggested.lastName,
      workEmail: suggested.workEmail ?? '',
      personalEmail: suggested.personalEmail ?? '',
      phone: suggested.phone ?? '',
      departmentId: suggested.departmentId ?? '',
      teamId: suggested.teamId ?? '',
      designationId: suggested.designationId ?? '',
      locationId: suggested.locationId ?? '',
      managerId: '',
      jobTitle: suggested.jobTitle ?? '',
      employmentType: suggested.employmentType,
      employmentStatus: suggested.employmentStatus,
      hireDate: suggested.hireDate ? suggested.hireDate.slice(0, 10) : '',
      sourceOfHire: suggested.sourceOfHire ?? '',
      linkedinUrl: suggested.linkedinUrl ?? '',
      acknowledgeDuplicates: false,
    });
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preview.dataUpdatedAt]);

  const departmentId = form.watch('departmentId');
  const employmentStatus = form.watch('employmentStatus') as EmploymentStatus;
  const acknowledged = form.watch('acknowledgeDuplicates');
  const teams = lookups.teams.filter((team) => !departmentId || team.departmentId === departmentId);

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      api.post<{ employee: { id: string }; candidateId: string }>(
        `/recruitment/candidates/${candidate.id}/convert`,
        {
          employeeNumber: textOrNull(values.employeeNumber),
          firstName: values.firstName,
          lastName: values.lastName,
          workEmail: textOrNull(values.workEmail),
          personalEmail: textOrNull(values.personalEmail),
          phone: textOrNull(values.phone),
          departmentId: textOrNull(values.departmentId),
          teamId: textOrNull(values.teamId),
          designationId: textOrNull(values.designationId),
          locationId: textOrNull(values.locationId),
          managerId: textOrNull(values.managerId),
          jobTitle: textOrNull(values.jobTitle),
          employmentType: values.employmentType,
          employmentStatus: values.employmentStatus,
          hireDate: textOrNull(values.hireDate),
          sourceOfHire: textOrNull(values.sourceOfHire),
          linkedinUrl: textOrNull(values.linkedinUrl),
          acknowledgeDuplicates: values.acknowledgeDuplicates,
        },
      ),
    onSuccess: async (result) => {
      toast.success(`${candidate.fullName} is now an employee. No login was created.`);
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
      await queryClient.invalidateQueries({ queryKey: ['employees'] });
      onClose();
      navigate(`/people/${result.employee.id}`);
    },
    onError: (error: unknown) => setFormError(placeFieldErrors(error, form)),
  });

  const duplicates = preview.data?.duplicates ?? [];
  const alreadyConverted = preview.data?.alreadyConvertedEmployeeId ?? null;
  const blocked = duplicates.length > 0 && !acknowledged;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="lg">
        <DialogHeader>
          <DialogTitle>Convert {candidate.fullName} to an employee</DialogTitle>
          <DialogDescription>
            Check every field. This creates a person on the staff roster - and no login.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {preview.isError ? (
            <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
          ) : preview.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={index} className="h-10" />
              ))}
            </div>
          ) : alreadyConverted ? (
            <div className="space-y-4">
              <p className="rounded-md border border-border bg-surface-muted px-3.5 py-3 text-[13.5px]">
                {candidate.fullName} has already been converted. There is one employee record for
                them, and a second would be the duplicate this check exists to prevent.
              </p>
              <Button variant="outline" onClick={() => navigate(`/people/${alreadyConverted}`)}>
                <UserCheck />
                Open their employee record
              </Button>
            </div>
          ) : (
            <form
              id="convert-form"
              className="space-y-4"
              onSubmit={form.handleSubmit((values) => {
                setFormError(null);
                mutation.mutate(values);
              })}
            >
              <FormError message={formError} />

              {duplicates.length > 0 ? (
                <div
                  className="rounded-md border border-warning/40 bg-warning-soft px-3.5 py-3 text-warning-foreground"
                  role="alert"
                >
                  <p className="flex items-center gap-2 text-[13px] font-medium">
                    <AlertTriangle className="size-4 shrink-0" aria-hidden />
                    {duplicates.length === 1
                      ? 'Somebody already on the roster looks like this person'
                      : `${duplicates.length} people already on the roster look like this person`}
                  </p>
                  <ul className="mt-2 space-y-1">
                    {duplicates.map((duplicate) => (
                      <li key={duplicate.employeeId} className="text-[12.5px]">
                        <span className="font-medium">{duplicate.fullName}</span> (
                        {duplicate.employeeNumber})
                        {duplicate.workEmail ? ` · ${duplicate.workEmail}` : ''} - matched on{' '}
                        {duplicate.matchedOn === 'EMAIL' ? 'email address' : 'name'}
                      </li>
                    ))}
                  </ul>
                  <label className="mt-3 flex items-start gap-2 text-[12.5px]">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0"
                      {...form.register('acknowledgeDuplicates')}
                    />
                    <span>
                      I have checked, and this is a different person. Two people really do share a
                      name - somebody coming back after leaving does not.
                    </span>
                  </label>
                </div>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  label="Employee number"
                  htmlFor="conv-number"
                  hint="Proposed from the last one issued."
                  error={form.formState.errors.employeeNumber?.message}
                >
                  <Input {...form.register('employeeNumber')} />
                </FormField>

                <FormField label="Hire date" htmlFor="conv-hire-date">
                  <Input type="date" {...form.register('hireDate')} />
                </FormField>

                <FormField
                  label="First name"
                  htmlFor="conv-first"
                  required
                  error={form.formState.errors.firstName?.message}
                >
                  <Input {...form.register('firstName', { required: 'First name is required.' })} />
                </FormField>

                <FormField
                  label="Last name"
                  htmlFor="conv-last"
                  required
                  error={form.formState.errors.lastName?.message}
                >
                  <Input {...form.register('lastName', { required: 'Last name is required.' })} />
                </FormField>

                <FormField
                  label="Work email"
                  htmlFor="conv-work-email"
                  hint="Left blank until IT issues one is fine."
                >
                  <Input type="email" {...form.register('workEmail')} />
                </FormField>

                <FormField label="Personal email" htmlFor="conv-personal-email">
                  <Input type="email" {...form.register('personalEmail')} />
                </FormField>

                <FormField label="Phone" htmlFor="conv-phone">
                  <Input {...form.register('phone')} />
                </FormField>

                <FormField label="Job title" htmlFor="conv-title">
                  <Input {...form.register('jobTitle')} />
                </FormField>

                <FormField label="Department" htmlFor="conv-department">
                  <NativeSelect {...form.register('departmentId')}>
                    <option value="">Not set</option>
                    {lookups.departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.label}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>

                <FormField label="Team" htmlFor="conv-team">
                  <NativeSelect {...form.register('teamId')} disabled={!departmentId}>
                    <option value="">Not set</option>
                    {teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.label}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>

                <FormField label="Designation" htmlFor="conv-designation">
                  <NativeSelect {...form.register('designationId')}>
                    <option value="">Not set</option>
                    {lookups.designations.map((designation) => (
                      <option key={designation.id} value={designation.id}>
                        {designation.label}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>

                <FormField label="Location" htmlFor="conv-location">
                  <NativeSelect {...form.register('locationId')}>
                    <option value="">Not set</option>
                    {lookups.locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.label}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>

                <FormField label="Reports to" htmlFor="conv-manager">
                  <NativeSelect {...form.register('managerId')}>
                    <option value="">Nobody yet</option>
                    {interviewers.map((person) => (
                      <option key={person.employeeId} value={person.employeeId}>
                        {person.fullName}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>

                <FormField label="Employment type" htmlFor="conv-type">
                  <NativeSelect {...form.register('employmentType')}>
                    {EMPLOYMENT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {EMPLOYMENT_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>

                <FormField
                  label="Employment status"
                  htmlFor="conv-employment-status"
                  hint={EMPLOYMENT_STATUS_DESCRIPTIONS[employmentStatus]}
                  error={form.formState.errors.employmentStatus?.message}
                >
                  <NativeSelect {...form.register('employmentStatus')}>
                    {EMPLOYMENT_STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {EMPLOYMENT_STATUS_LABELS[value]}
                        {value === 'PROBATION' ? ' (default for a new hire)' : ''}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>

                <FormField label="Source of hire" htmlFor="conv-source">
                  <Input {...form.register('sourceOfHire')} />
                </FormField>

                <FormField label="LinkedIn" htmlFor="conv-linkedin">
                  <Input {...form.register('linkedinUrl')} />
                </FormField>
              </div>

              <p className="rounded-md border border-border bg-surface-muted px-3.5 py-3 text-[13px] text-muted-foreground">
                No login is created by this. If this person needs access to the system, invite them
                from Settings once their record exists.
              </p>
            </form>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          {alreadyConverted || preview.isLoading || preview.isError ? null : (
            <Button
              type="submit"
              form="convert-form"
              loading={mutation.isPending}
              disabled={blocked}
              variant={blocked ? 'outline' : 'primary'}
            >
              {blocked ? 'Check the duplicates first' : 'Create employee record'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
