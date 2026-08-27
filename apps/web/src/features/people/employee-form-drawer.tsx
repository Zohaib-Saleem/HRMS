import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Lock } from 'lucide-react';
import {
  EMPLOYEE_STATUSES,
  EMPLOYEE_STATUS_LABELS,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  GENDERS,
  MARITAL_STATUSES,
  PERMISSIONS,
  type EmployeeDetail,
  type EmployeeInput,
  employeeInputSchema,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { LOOKUPS_QUERY_KEY, useLookups } from '@/lib/lookups';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePermissions } from '@/features/auth/session-context';
import { cn } from '@/lib/utils';

const SECTIONS = ['Job', 'Personal', 'Contact', 'Restricted'] as const;
type Section = (typeof SECTIONS)[number];

const humanise = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');

/**
 * Create/edit form.
 *
 * Sectioned rather than one long scroll - the employee record has ~40 fields
 * and a flat form makes the required ones hard to find.
 */
export function EmployeeFormDrawer({
  open,
  employee,
  onClose,
  onSaved,
}: {
  open: boolean;
  employee: EmployeeDetail | null;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const { lookups } = useLookups();
  const { has } = usePermissions();
  const canSeeRestricted = has(PERMISSIONS.EMPLOYEE_SENSITIVE_READ);
  const isEdit = employee !== null;

  const [section, setSection] = React.useState<Section>('Job');
  React.useEffect(() => {
    if (open) setSection('Job');
  }, [open]);

  const form = useForm<EmployeeInput>({
    resolver: zodResolver(employeeInputSchema),
    values: {
      employeeNumber: employee?.employeeNumber ?? '',
      firstName: employee?.firstName ?? '',
      middleName: employee?.middleName ?? '',
      lastName: employee?.lastName ?? '',
      displayName: employee?.displayName ?? '',
      workEmail: employee?.workEmail ?? '',
      personalEmail: employee?.personalEmail ?? '',
      phone: employee?.phone ?? '',
      personalPhone: employee?.personalPhone ?? '',
      photoUrl: employee?.photoUrl ?? '',
      jobTitle: employee?.jobTitle ?? '',
      designationId: employee?.designation?.id ?? '',
      departmentId: employee?.department?.id ?? '',
      teamId: employee?.team?.id ?? '',
      locationId: employee?.location?.id ?? '',
      managerId: employee?.manager?.id ?? '',
      secondaryManagerId: employee?.secondaryManager?.id ?? '',
      employmentType: employee?.employmentType ?? 'FULL_TIME',
      status: employee?.status ?? 'ACTIVE',
      hireDate: employee?.hireDate ?? '',
      confirmationDate: employee?.confirmationDate ?? '',
      terminationDate: employee?.terminationDate ?? '',
      sourceOfHire: employee?.sourceOfHire ?? '',
      linkedinUrl: employee?.linkedinUrl ?? '',
      priorExperienceMonths: employee?.priorExperienceMonths ?? null,
      dateOfBirth: employee?.dateOfBirth ?? '',
      gender: (employee?.gender as EmployeeInput['gender']) ?? null,
      maritalStatus: (employee?.maritalStatus as EmployeeInput['maritalStatus']) ?? null,
      nationality: employee?.nationality ?? '',
      bloodGroup: employee?.bloodGroup ?? '',
      presentAddress: employee?.presentAddress ?? '',
      permanentAddress: employee?.permanentAddress ?? '',
      emergencyContactName: employee?.emergencyContactName ?? '',
      emergencyContactPhone: employee?.emergencyContactPhone ?? '',
      emergencyContactRelationship: employee?.emergencyContactRelationship ?? '',
      nationalId: employee?.restricted?.nationalId ?? '',
      passportNumber: employee?.restricted?.passportNumber ?? '',
      passportExpiry: employee?.restricted?.passportExpiry ?? '',
      visaNumber: employee?.restricted?.visaNumber ?? '',
      visaExpiry: employee?.restricted?.visaExpiry ?? '',
      bankAccountNumber: employee?.restricted?.bankAccountNumber ?? '',
      notes: employee?.notes ?? '',
    },
  });

  const { register, handleSubmit, formState, watch, setError, reset } = form;
  const departmentId = watch('departmentId');

  // Teams belong to a department, so the options narrow as soon as one is picked.
  const teamOptions = lookups.teams.filter(
    (team) => !departmentId || team.departmentId === departmentId,
  );

  const mutation = useMutation({
    mutationFn: (values: EmployeeInput) =>
      isEdit
        ? api.patch<EmployeeDetail>(`/employees/${employee.id}`, values)
        : api.post<EmployeeDetail>('/employees', values),
    onSuccess: async (saved) => {
      toast.success(isEdit ? 'Employee updated.' : 'Employee created.');
      await queryClient.invalidateQueries({ queryKey: ['employees'] });
      await queryClient.invalidateQueries({ queryKey: LOOKUPS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ['company', 'stats'] });
      reset();
      onClose();
      onSaved?.(saved.id);
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        let firstSection: Section | null = null;
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof EmployeeInput, { message: messages[0] });
          firstSection ??= sectionForField(field);
        }
        // Jump to the section holding the first bad field, otherwise the error
        // is invisible on a section the user is not looking at.
        if (firstSection) setSection(firstSection);
        toast.error('Some fields need your attention.');
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  const errorSections = new Set(
    Object.keys(formState.errors).map((field) => sectionForField(field)),
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="lg">
        <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="contents">
          <DialogHeader>
            <DialogTitle>{isEdit ? `Edit ${employee.fullName}` : 'New employee'}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? `Employee number ${employee.employeeNumber}`
                : 'The employee number is generated automatically if you leave it blank.'}
            </DialogDescription>
          </DialogHeader>

          <div className="shrink-0 border-b border-border px-5">
            <nav className="flex gap-1 overflow-x-auto" aria-label="Form sections">
              {SECTIONS.filter((s) => s !== 'Restricted' || canSeeRestricted).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setSection(item)}
                  className={cn(
                    'flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors',
                    section === item
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {item === 'Restricted' ? <Lock className="size-3.5" aria-hidden /> : null}
                  {item}
                  {errorSections.has(item) ? (
                    <span className="size-1.5 rounded-full bg-destructive" aria-label="has errors" />
                  ) : null}
                </button>
              ))}
            </nav>
          </div>

          <DialogBody className="grid gap-4 sm:grid-cols-2">
            {section === 'Job' ? (
              <>
                <FormField label="First name" htmlFor="emp-firstName" error={formState.errors.firstName?.message} required>
                  <Input {...register('firstName')} autoFocus />
                </FormField>
                <FormField label="Last name" htmlFor="emp-lastName" error={formState.errors.lastName?.message} required>
                  <Input {...register('lastName')} />
                </FormField>
                <FormField label="Employee number" htmlFor="emp-number" error={formState.errors.employeeNumber?.message} hint={isEdit ? undefined : 'Leave blank to generate.'}>
                  <Input {...register('employeeNumber')} />
                </FormField>
                <FormField label="Work email" htmlFor="emp-workEmail" error={formState.errors.workEmail?.message}>
                  <Input type="email" {...register('workEmail')} />
                </FormField>
                <FormField label="Designation" htmlFor="emp-designation" error={formState.errors.designationId?.message}>
                  <NativeSelect {...register('designationId')}>
                    <option value="">Not set</option>
                    {lookups.designations.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Department" htmlFor="emp-department" error={formState.errors.departmentId?.message}>
                  <NativeSelect {...register('departmentId')}>
                    <option value="">Not set</option>
                    {lookups.departments.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Team" htmlFor="emp-team" error={formState.errors.teamId?.message} hint={departmentId ? undefined : 'Choose a department first.'}>
                  <NativeSelect {...register('teamId')} disabled={!departmentId}>
                    <option value="">Not set</option>
                    {teamOptions.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Location" htmlFor="emp-location" error={formState.errors.locationId?.message}>
                  <NativeSelect {...register('locationId')}>
                    <option value="">Not set</option>
                    {lookups.locations.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Reports to" htmlFor="emp-manager" error={formState.errors.managerId?.message}>
                  <NativeSelect {...register('managerId')}>
                    <option value="">Not set</option>
                    {lookups.managers.filter((m) => m.id !== employee?.id).map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Secondary manager" htmlFor="emp-secondaryManager" error={formState.errors.secondaryManagerId?.message}>
                  <NativeSelect {...register('secondaryManagerId')}>
                    <option value="">Not set</option>
                    {lookups.managers.filter((m) => m.id !== employee?.id).map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Employment type" htmlFor="emp-type" error={formState.errors.employmentType?.message} required>
                  <NativeSelect {...register('employmentType')}>
                    {EMPLOYMENT_TYPES.map((t) => (
                      <option key={t} value={t}>{EMPLOYMENT_TYPE_LABELS[t]}</option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Status" htmlFor="emp-status" error={formState.errors.status?.message} required>
                  <NativeSelect {...register('status')}>
                    {EMPLOYEE_STATUSES.map((s) => (
                      <option key={s} value={s}>{EMPLOYEE_STATUS_LABELS[s]}</option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Hire date" htmlFor="emp-hireDate" error={formState.errors.hireDate?.message}>
                  <Input type="date" {...register('hireDate')} />
                </FormField>
                <FormField label="Confirmation date" htmlFor="emp-confirmationDate" error={formState.errors.confirmationDate?.message}>
                  <Input type="date" {...register('confirmationDate')} />
                </FormField>
                <FormField label="Termination date" htmlFor="emp-terminationDate" error={formState.errors.terminationDate?.message} hint="Required when status is Terminated.">
                  <Input type="date" {...register('terminationDate')} />
                </FormField>
                <FormField label="Source of hire" htmlFor="emp-sourceOfHire" error={formState.errors.sourceOfHire?.message}>
                  <Input {...register('sourceOfHire')} />
                </FormField>
              </>
            ) : null}

            {section === 'Personal' ? (
              <>
                <FormField label="Middle name" htmlFor="emp-middleName" error={formState.errors.middleName?.message}>
                  <Input {...register('middleName')} />
                </FormField>
                <FormField label="Display name" htmlFor="emp-displayName" error={formState.errors.displayName?.message} hint="Overrides the shown name.">
                  <Input {...register('displayName')} />
                </FormField>
                <FormField label="Date of birth" htmlFor="emp-dob" error={formState.errors.dateOfBirth?.message}>
                  <Input type="date" {...register('dateOfBirth')} />
                </FormField>
                <FormField label="Gender" htmlFor="emp-gender" error={formState.errors.gender?.message}>
                  <NativeSelect {...register('gender')}>
                    <option value="">Not set</option>
                    {GENDERS.map((g) => (
                      <option key={g} value={g}>{humanise(g)}</option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Marital status" htmlFor="emp-marital" error={formState.errors.maritalStatus?.message}>
                  <NativeSelect {...register('maritalStatus')}>
                    <option value="">Not set</option>
                    {MARITAL_STATUSES.map((m) => (
                      <option key={m} value={m}>{humanise(m)}</option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Nationality" htmlFor="emp-nationality" error={formState.errors.nationality?.message}>
                  <Input {...register('nationality')} />
                </FormField>
                <FormField label="Blood group" htmlFor="emp-blood" error={formState.errors.bloodGroup?.message}>
                  <Input {...register('bloodGroup')} />
                </FormField>
                <FormField label="Prior experience (months)" htmlFor="emp-experience" error={formState.errors.priorExperienceMonths?.message}>
                  <Input type="number" min={0} {...register('priorExperienceMonths')} />
                </FormField>
                <FormField label="LinkedIn" htmlFor="emp-linkedin" error={formState.errors.linkedinUrl?.message} className="sm:col-span-2">
                  <Input {...register('linkedinUrl')} placeholder="https://" />
                </FormField>
                <FormField label="Photo URL" htmlFor="emp-photo" error={formState.errors.photoUrl?.message} className="sm:col-span-2" hint="File uploads arrive with the Documents module.">
                  <Input {...register('photoUrl')} placeholder="https://" />
                </FormField>
                <FormField label="Notes" htmlFor="emp-notes" error={formState.errors.notes?.message} className="sm:col-span-2">
                  <Textarea rows={3} {...register('notes')} />
                </FormField>
              </>
            ) : null}

            {section === 'Contact' ? (
              <>
                <FormField label="Personal email" htmlFor="emp-personalEmail" error={formState.errors.personalEmail?.message}>
                  <Input type="email" {...register('personalEmail')} />
                </FormField>
                <FormField label="Work phone" htmlFor="emp-phone" error={formState.errors.phone?.message}>
                  <Input type="tel" {...register('phone')} />
                </FormField>
                <FormField label="Personal phone" htmlFor="emp-personalPhone" error={formState.errors.personalPhone?.message}>
                  <Input type="tel" {...register('personalPhone')} />
                </FormField>
                <FormField label="Present address" htmlFor="emp-presentAddress" error={formState.errors.presentAddress?.message} className="sm:col-span-2">
                  <Textarea rows={2} {...register('presentAddress')} />
                </FormField>
                <FormField label="Permanent address" htmlFor="emp-permanentAddress" error={formState.errors.permanentAddress?.message} className="sm:col-span-2">
                  <Textarea rows={2} {...register('permanentAddress')} />
                </FormField>
                <FormField label="Emergency contact" htmlFor="emp-emergencyName" error={formState.errors.emergencyContactName?.message}>
                  <Input {...register('emergencyContactName')} />
                </FormField>
                <FormField label="Emergency phone" htmlFor="emp-emergencyPhone" error={formState.errors.emergencyContactPhone?.message}>
                  <Input type="tel" {...register('emergencyContactPhone')} />
                </FormField>
                <FormField label="Relationship" htmlFor="emp-emergencyRelationship" error={formState.errors.emergencyContactRelationship?.message}>
                  <Input {...register('emergencyContactRelationship')} />
                </FormField>
              </>
            ) : null}

            {section === 'Restricted' && canSeeRestricted ? (
              <>
                <p className="sm:col-span-2 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-[12.5px] text-warning-foreground">
                  These fields are visible only to roles with the restricted-fields permission,
                  and every view of them is written to the audit log.
                </p>
                <FormField label="National ID" htmlFor="emp-nationalId" error={formState.errors.nationalId?.message}>
                  <Input {...register('nationalId')} />
                </FormField>
                <FormField label="Bank account number" htmlFor="emp-bank" error={formState.errors.bankAccountNumber?.message}>
                  <Input {...register('bankAccountNumber')} />
                </FormField>
                <FormField label="Passport number" htmlFor="emp-passport" error={formState.errors.passportNumber?.message}>
                  <Input {...register('passportNumber')} />
                </FormField>
                <FormField label="Passport expiry" htmlFor="emp-passportExpiry" error={formState.errors.passportExpiry?.message}>
                  <Input type="date" {...register('passportExpiry')} />
                </FormField>
                <FormField label="Visa number" htmlFor="emp-visa" error={formState.errors.visaNumber?.message}>
                  <Input {...register('visaNumber')} />
                </FormField>
                <FormField label="Visa expiry" htmlFor="emp-visaExpiry" error={formState.errors.visaExpiry?.message}>
                  <Input type="date" {...register('visaExpiry')} />
                </FormField>
              </>
            ) : null}
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isEdit ? 'Save changes' : 'Create employee'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Maps a server-reported field back to the section that renders it. */
function sectionForField(field: string): Section {
  if (
    ['nationalId', 'passportNumber', 'passportExpiry', 'visaNumber', 'visaExpiry', 'bankAccountNumber'].includes(field)
  ) {
    return 'Restricted';
  }
  if (
    ['personalEmail', 'phone', 'personalPhone', 'presentAddress', 'permanentAddress', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelationship'].includes(field)
  ) {
    return 'Contact';
  }
  if (
    ['middleName', 'displayName', 'dateOfBirth', 'gender', 'maritalStatus', 'nationality', 'bloodGroup', 'priorExperienceMonths', 'linkedinUrl', 'photoUrl', 'notes'].includes(field)
  ) {
    return 'Personal';
  }
  return 'Job';
}
