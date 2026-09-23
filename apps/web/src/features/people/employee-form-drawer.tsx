import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Lock } from 'lucide-react';
import {
  EMPLOYEE_STATUSES,
  EMPLOYEE_STATUS_LABELS,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_DESCRIPTIONS,
  EMPLOYMENT_STATUS_LABELS,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  GENDERS,
  MARITAL_STATUSES,
  PERMISSIONS,
  type DeviceMappingRecord,
  type DeviceRecord,
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

const SECTIONS = ['Job', 'Attendance', 'Personal', 'Contact', 'Restricted'] as const;
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
  /*
   * A punch code is a device mapping, so it is gated by the device grants
   * rather than by `employee.manage`. HR Admin and Super Admin hold both, so
   * the people who actually onboard employees see the field; a role given only
   * the employee grant does not, and the API refuses it there too.
   */
  const canSeePunchCode = has(PERMISSIONS.DEVICE_READ);
  const canSetPunchCode = canSeePunchCode && has(PERMISSIONS.DEVICE_MANAGE);
  const isEdit = employee !== null;

  const [section, setSection] = React.useState<Section>('Job');
  React.useEffect(() => {
    if (open) setSection('Job');
  }, [open]);

  /*
   * The punch code is not a column on the employee - it is the device mapping
   * that decides whose attendance a punch becomes - so it is read from and
   * written through the device module rather than kept twice.
   *
   * Read here, written by the employee create/update endpoint, which calls the
   * same mapping service the Device User Mapping screen does. That is what
   * makes the two screens incapable of disagreeing.
   */
  const devicesQuery = useQuery({
    queryKey: ['devices', 'lookup'],
    queryFn: () => api.getPage<DeviceRecord>('/attendance/devices', { query: { limit: 100 } }),
    enabled: open && canSeePunchCode,
    staleTime: 60_000,
  });
  const devices = devicesQuery.data?.data ?? [];

  const mappingsQuery = useQuery({
    queryKey: ['device-mappings', 'employee', employee?.id],
    queryFn: () =>
      api.get<DeviceMappingRecord[]>('/attendance/mappings', {
        query: { employeeId: employee?.id },
      }),
    enabled: open && canSeePunchCode && isEdit,
  });
  // The one in force. Closed mappings are the audit trail of who held a PIN
  // before and are deliberately not offered as something to edit here.
  const currentMapping = (mappingsQuery.data ?? []).find((m) => m.isActive) ?? null;
  const currentPunchCode = currentMapping?.deviceUserId ?? '';
  // One device is the usual case and the form does not ask about it. Several
  // is a choice nobody should make by accident, so the select appears.
  const punchDeviceId = currentMapping?.deviceId ?? (devices.length === 1 ? devices[0]!.id : '');

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
      // Null, never a default. A new record is unclassified until somebody
      // classifies it; defaulting to Probation would put a status on 80 people
      // that nobody chose, and both benefit engines would then act on it.
      employmentStatus: employee?.employmentStatus ?? null,
      hireDate: employee?.hireDate ?? '',
      confirmationDate: employee?.confirmationDate ?? '',
      nextIncrementDueDate: employee?.nextIncrementDueDate ?? '',
      terminationDate: employee?.terminationDate ?? '',
      resignationDate: employee?.resignationDate ?? '',
      sourceOfHire: employee?.sourceOfHire ?? '',
      linkedinUrl: employee?.linkedinUrl ?? '',
      priorExperienceMonths: employee?.priorExperienceMonths ?? null,
      excludedFromAttendance: employee?.excludedFromAttendance ?? false,
      // NEVER defaulted from the employee number. 1021 punches as 51 here;
      // copying one into the other is precisely the mistake that files a
      // stranger's attendance against somebody's record.
      punchCode: currentPunchCode,
      punchDeviceId,
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

  /*
   * The employment status as the form currently holds it, and what the record
   * arrived as.
   *
   * The pair is what makes Probation -> Permanent a visible transition rather
   * than a field edit: the confirmation date announces itself as required the
   * moment Permanent is chosen, and stays prompted while an employee who WAS on
   * probation has not been given one.
   */
  const employmentStatus = watch('employmentStatus') || null;
  const wasProbation = employee?.employmentStatus === 'PROBATION';

  /*
   * EVERY team is offered, whatever department is picked. Department and team
   * are independent facts about a person - Development AND Team Alpha - so
   * narrowing one by the other would hide the very combinations this form
   * exists to record.
   */

  const mutation = useMutation({
    mutationFn: (values: EmployeeInput) => {
      /*
       * Without the device grant the punch-code field was never rendered, so
       * the form holds a blank it never asked about. Sending that blank would
       * read as "clear their punch code" and quietly unmap somebody. Omitting
       * the keys is what "leave the mapping alone" looks like to the API.
       */
      const body = { ...values };
      if (!canSetPunchCode) {
        delete (body as Partial<EmployeeInput>).punchCode;
        delete (body as Partial<EmployeeInput>).punchDeviceId;
      }
      return isEdit
        ? api.patch<EmployeeDetail>(`/employees/${employee.id}`, body)
        : api.post<EmployeeDetail>('/employees', body);
    },
    onSuccess: async (saved) => {
      toast.success(isEdit ? 'Employee updated.' : 'Employee created.');
      await queryClient.invalidateQueries({ queryKey: ['employees'] });
      await queryClient.invalidateQueries({ queryKey: LOOKUPS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ['company', 'stats'] });
      // A punch code that changed re-attributes raw punches, so the mapping
      // screen, the punch list and the profile strip are all now stale.
      await queryClient.invalidateQueries({ queryKey: ['device-mappings'] });
      await queryClient.invalidateQueries({ queryKey: ['punches'] });
      reset();
      onClose();
      onSaved?.(saved.id);
    },
    onError: (error: unknown) => {
      /*
       * A punch code already held by somebody else comes back as a conflict,
       * not a validation error - it is a fact about another employee's record,
       * not a badly typed field. Pinning it to the field anyway is what puts
       * the message where the person who typed it is looking.
       */
      if (error instanceof ApiError && error.status === 409 && /punch code/i.test(error.message)) {
        setError('punchCode', { message: error.message });
        setSection('Attendance');
        toast.error(error.message);
        return;
      }
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
                <FormField label="Team" htmlFor="emp-team" error={formState.errors.teamId?.message}>
                  <NativeSelect {...register('teamId')}>
                    <option value="">Not set</option>
                    {lookups.teams.map((o) => (
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
                {/*
                  Employment status sits between Status and the dates, because
                  that is the order the questions are actually asked in: is this
                  person employed, on what terms, how far through, since when.
                */}
                <FormField
                  label="Employment status"
                  htmlFor="emp-employmentStatus"
                  error={formState.errors.employmentStatus?.message}
                  hint={
                    employmentStatus
                      ? EMPLOYMENT_STATUS_DESCRIPTIONS[employmentStatus]
                      : 'Not set. Separate from Status and from Employment type.'
                  }
                >
                  <NativeSelect id="emp-employmentStatus" {...register('employmentStatus')}>
                    <option value="">Not set</option>
                    {EMPLOYMENT_STATUSES.map((s) => (
                      <option key={s} value={s}>{EMPLOYMENT_STATUS_LABELS[s]}</option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Hire date" htmlFor="emp-hireDate" error={formState.errors.hireDate?.message}>
                  <Input type="date" {...register('hireDate')} />
                </FormField>
                {/*
                  Confirming somebody means saying when, so the hint turns into
                  a requirement the moment Permanent is chosen. The server
                  enforces the same rule against the stored record - this only
                  says so before the round trip.
                */}
                <FormField
                  label="Confirmation date"
                  htmlFor="emp-confirmationDate"
                  error={formState.errors.confirmationDate?.message}
                  required={employmentStatus === 'PERMANENT'}
                  hint={
                    employmentStatus === 'PERMANENT'
                      ? 'Required: the day this employee was confirmed.'
                      : wasProbation
                        ? 'Set this when confirming the employee as Permanent.'
                        : undefined
                  }
                >
                  <Input type="date" {...register('confirmationDate')} />
                </FormField>
                <FormField label="Next increment due" htmlFor="emp-nextIncrementDueDate" error={formState.errors.nextIncrementDueDate?.message} hint="When the next salary review falls due.">
                  <Input type="date" {...register('nextIncrementDueDate')} />
                </FormField>
                <FormField label="Resignation date" htmlFor="emp-resignationDate" error={formState.errors.resignationDate?.message} hint="Required when status is Resigned.">
                  <Input type="date" {...register('resignationDate')} />
                </FormField>
                <FormField label="Termination date" htmlFor="emp-terminationDate" error={formState.errors.terminationDate?.message} hint="Required when status is Terminated.">
                  <Input type="date" {...register('terminationDate')} />
                </FormField>
                <FormField label="Source of hire" htmlFor="emp-sourceOfHire" error={formState.errors.sourceOfHire?.message}>
                  <Input {...register('sourceOfHire')} />
                </FormField>
              </>
            ) : null}

            {/*
              ATTENDANCE. Its own section, not an advanced page: the punch code
              is what decides whether a person's punches are theirs, and it has
              to be answerable while the employee is being created.
            */}
            {section === 'Attendance' ? (
              <>
                {canSeePunchCode ? (
                  <>
                    {devices.length > 1 ? (
                      <FormField
                        label="Device"
                        htmlFor="emp-punchDeviceId"
                        error={formState.errors.punchDeviceId?.message}
                        hint="Which terminal this punch code belongs to."
                      >
                        <NativeSelect id="emp-punchDeviceId" {...register('punchDeviceId')} disabled={!canSetPunchCode}>
                          <option value="">Choose a device</option>
                          {devices.map((d) => (
                            <option key={d.id} value={d.id}>{d.name}</option>
                          ))}
                        </NativeSelect>
                      </FormField>
                    ) : null}
                    <FormField
                      label="Punch code"
                      htmlFor="emp-punchCode"
                      error={formState.errors.punchCode?.message}
                      hint="ZKTeco device User ID/PIN used for attendance. This is different from Employee ID."
                    >
                      <Input
                        id="emp-punchCode"
                        inputMode="numeric"
                        autoComplete="off"
                        placeholder="e.g. 284"
                        className="font-mono"
                        disabled={!canSetPunchCode}
                        {...register('punchCode')}
                      />
                    </FormField>
                    <p className="text-[12.5px] leading-relaxed text-muted-foreground sm:col-span-2">
                      Optional - leave it blank for somebody who has no biometric account
                      yet, and their punches stay Unmapped until it is filled in. Entering
                      it attributes the punches already recorded under that code to this
                      person; no punch is edited, deleted or re-timed.
                      {isEdit && currentPunchCode ? (
                        <>
                          {' '}Currently <span className="font-mono">{currentPunchCode}</span>.
                        </>
                      ) : null}
                      {!canSetPunchCode ? ' You may see this but not change it.' : null}
                    </p>
                  </>
                ) : null}
                <label className={cn('flex cursor-pointer items-start gap-3 text-[13.5px]', 'sm:col-span-2')}>
                  <input
                    type="checkbox"
                    {...register('excludedFromAttendance')}
                    className="mt-0.5 size-4 shrink-0 rounded border-input accent-[var(--primary)]"
                  />
                  <span>
                    <span className="block font-medium">Does not punch in</span>
                    <span className="block text-[12.5px] text-muted-foreground">
                      Keeps this person out of attendance entirely - no absent rows, and no
                      row on the sheet, the reports or the analytics. They stay active
                      everywhere else: the org chart, approvals, assets and leave. For a
                      partner or a director, not for somebody who is simply away.
                    </span>
                  </span>
                </label>
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
                <FormField label="Photo URL" htmlFor="emp-photo" error={formState.errors.photoUrl?.message} className="sm:col-span-2" hint="A link to a photo hosted elsewhere. To upload one, use the camera button on the profile header - an uploaded photo takes precedence over this link.">
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
  if (['punchCode', 'punchDeviceId', 'excludedFromAttendance'].includes(field)) return 'Attendance';
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
