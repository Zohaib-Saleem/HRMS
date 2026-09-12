import * as React from 'react';
import { Navigate } from 'react-router-dom';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, History, RotateCcw, Save } from 'lucide-react';
import {
  MEDICAL_CATEGORIES,
  MEDICAL_CATEGORY_DESCRIPTIONS,
  MEDICAL_CATEGORY_LABELS,
  MEDICAL_POLICY_LABELS,
  PERMISSIONS,
  medicalPolicySchema,
  type MedicalCategoryLimitInput,
  type MedicalPolicyHistoryEntry,
  type MedicalPolicyInput,
  type MedicalPolicyRecord,
  type MedicalPolicyView,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { FormField, Input, Textarea } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { usePermissions } from '@/features/auth/session-context';
import { cn } from '@/lib/utils';

/**
 * Settings -> Medical -> Medical Policy. Super Admin's screen.
 *
 * Everything a medical benefit is measured against lives here, and nothing that
 * decides one lives in the code. The form is grouped the way somebody thinks
 * about the question - who is covered, how much, for what, who else, what a
 * claim has to look like - rather than in the order the columns happen to sit
 * in.
 *
 * Saving is confirmed against a diff of what is actually changing. Moving the
 * annual limit from 100,000 to 250,000 is a financial decision, and a settings
 * screen that saves it silently is how such a decision gets made by accident
 * and noticed a quarter later.
 *
 * Nothing here touches a claim that already exists. Saving writes a new policy
 * VERSION; anything already decided keeps the rules it was decided under.
 */

const MEDICAL_POLICY_KEY = ['medical', 'policy'] as const;
const MEDICAL_POLICY_HISTORY_KEY = ['medical', 'policy', 'history'] as const;

/** A switch, matching the one on the loan policy and attendance rules screens. */
function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-3 rounded-lg border border-border p-3 transition-colors',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-accent/40',
      )}
    >
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span
          aria-hidden
          className={cn(
            'block h-5 w-9 rounded-full bg-muted transition-colors',
            'peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2',
          )}
        />
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute left-0.5 top-0.5 size-4 rounded-full bg-surface shadow transition-transform',
            checked && 'translate-x-4',
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

function Section({
  title,
  description,
  children,
  columns = 2,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  columns?: 1 | 2;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className={cn('grid gap-4', columns === 2 && 'sm:grid-cols-2')}>
        {children}
      </CardContent>
    </Card>
  );
}

/** The saved values, as the form's baseline and the diff's "current". */
export function toFormValues(policy: MedicalPolicyRecord): MedicalPolicyInput {
  return {
    enabled: policy.enabled,
    policyName: policy.policyName,
    description: policy.description,
    minEmploymentMonths: policy.minEmploymentMonths,
    allowProbation: policy.allowProbation,
    allowPermanent: policy.allowPermanent,
    blockResigned: policy.blockResigned,
    blockTerminated: policy.blockTerminated,
    annualLimitPerEmployee: policy.annualLimitPerEmployee,
    spouseCovered: policy.spouseCovered,
    childrenCovered: policy.childrenCovered,
    maxChildren: policy.maxChildren,
    parentsCovered: policy.parentsCovered,
    maxParents: policy.maxParents,
    dependentsShareEmployeeLimit: policy.dependentsShareEmployeeLimit,
    dependentAnnualLimit: policy.dependentAnnualLimit,
    requireReceipt: policy.requireReceipt,
    requirePrescription: policy.requirePrescription,
    requireDiagnosis: policy.requireDiagnosis,
    requireHospitalName: policy.requireHospitalName,
    requireTreatmentDate: policy.requireTreatmentDate,
    claimSubmissionDeadlineDays: policy.claimSubmissionDeadlineDays,
    allowBackdatedClaims: policy.allowBackdatedClaims,
    maxBackdatedDays: policy.maxBackdatedDays,
    requireHrApproval: policy.requireHrApproval,
    allowPartialApproval: policy.allowPartialApproval,
    allowEmployeeCancelPending: policy.allowEmployeeCancelPending,
    allowHrOverride: policy.allowHrOverride,
    requireOverrideReason: policy.requireOverrideReason,
    allowCarryForward: policy.allowCarryForward,
    maxCarryForwardAmount: policy.maxCarryForwardAmount,
    // Ordered by the product's own list so the form and the API agree on which
    // row is which, whatever order the response happened to arrive in.
    categories: MEDICAL_CATEGORIES.map(
      (category) =>
        policy.categories.find((c) => c.category === category) ?? {
          category,
          enabled: false,
          annualLimit: null,
          maxClaimAmount: null,
          companyContributionPercent: 100,
          employeeContributionPercent: 0,
        },
    ),
  };
}

const asText = (value: unknown): string => {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value === null || value === undefined || value === '') return 'No cap';
  return String(value);
};

/**
 * What the save is about to change, categories included.
 *
 * Pure, and exported, so the rule can be asserted without rendering a form.
 */
export function changedFields(
  saved: MedicalPolicyInput,
  next: MedicalPolicyInput,
): Array<{ label: string; from: string; to: string }> {
  const out: Array<{ label: string; from: string; to: string }> = [];

  for (const key of Object.keys(saved) as Array<keyof MedicalPolicyInput>) {
    if (key === 'effectiveFrom' || key === 'categories') continue;
    if (saved[key] === next[key]) continue;
    out.push({
      label: MEDICAL_POLICY_LABELS[key as keyof typeof MEDICAL_POLICY_LABELS],
      from: asText(saved[key]),
      to: asText(next[key]),
    });
  }

  for (const category of next.categories) {
    const before = saved.categories.find((c) => c.category === category.category);
    if (!before) continue;
    const fields: Array<[keyof MedicalCategoryLimitInput, string]> = [
      ['enabled', 'enabled'],
      ['annualLimit', 'annual limit'],
      ['maxClaimAmount', 'maximum claim'],
      ['companyContributionPercent', 'company share'],
      ['employeeContributionPercent', 'employee share'],
    ];
    for (const [key, label] of fields) {
      if (before[key] === category[key]) continue;
      out.push({
        label: `${MEDICAL_CATEGORY_LABELS[category.category]} - ${label}`,
        from: asText(before[key]),
        to: asText(category[key]),
      });
    }
  }

  return out;
}

export function MedicalPolicyPage() {
  const { has } = usePermissions();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  /*
   * `api.get` already unwraps the `{ data }` envelope, so the generic is the
   * INNER type. The history endpoint answers with `meta` alongside `data`, so
   * it needs `getPage`, which hands back the whole envelope.
   */
  const query = useQuery({
    queryKey: MEDICAL_POLICY_KEY,
    queryFn: () => api.get<MedicalPolicyView>('/medical/policy'),
  });

  const history = useQuery({
    queryKey: MEDICAL_POLICY_HISTORY_KEY,
    queryFn: () =>
      api
        .getPage<MedicalPolicyHistoryEntry>('/medical/policy/history', { query: { limit: 20 } })
        .then((page) => page.data),
  });

  // Both gates are checked. The server's `canManage` is the real answer; the
  // permission is what decides whether the screen was ever offered.
  const canManage = has(PERMISSIONS.MEDICAL_POLICY_MANAGE) && (query.data?.canManage ?? false);

  const form = useForm<MedicalPolicyInput>({
    resolver: zodResolver(medicalPolicySchema),
    values: query.data ? toFormValues(query.data.policy) : undefined,
  });

  const save = useMutation({
    mutationFn: (values: MedicalPolicyInput) => api.put('/medical/policy', values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MEDICAL_POLICY_KEY });
      await queryClient.invalidateQueries({ queryKey: MEDICAL_POLICY_HISTORY_KEY });
      toast.success('Medical policy saved', {
        description: 'New claims are measured against it. Decided claims are unchanged.',
      });
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          form.setError(field as keyof MedicalPolicyInput, {
            message: messages[0] ?? 'Invalid value.',
          });
        }
        return;
      }
      toast.error('Could not save the policy', { description: errorMessage(error) });
    },
  });

  if (query.isPending) {
    return <Skeleton className="h-96 w-full" />;
  }

  // Permission alone got them here; without the endpoint there is no screen.
  if (query.isError || !query.data) {
    if (query.error instanceof ApiError && query.error.status === 403) {
      return <Navigate to="/settings" replace />;
    }
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }

  const view = query.data;
  const saved = toFormValues(view.policy);
  const errors = form.formState.errors;
  const sharesLimit = form.watch('dependentsShareEmployeeLimit');
  const carryForward = form.watch('allowCarryForward');

  return (
    <form
      className="space-y-4"
      onSubmit={form.handleSubmit(async (values) => {
        const changes = changedFields(saved, values);
        if (changes.length === 0) {
          toast.message('Nothing to save', { description: 'No rule has been changed.' });
          return;
        }

        const ok = await confirm({
          title: 'Save the medical policy?',
          confirmLabel: 'Save policy',
          description: (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Rule</th>
                      <th className="px-3 py-2 font-semibold">Current</th>
                      <th className="px-3 py-2 font-semibold">New</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {changes.map((c) => (
                      <tr key={c.label}>
                        <td className="px-3 py-2">{c.label}</td>
                        <td className="px-3 py-2 text-muted-foreground">{c.from}</td>
                        <td className="px-3 py-2 font-semibold">{c.to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[13px] text-muted-foreground">
                This applies from the moment it is saved. Claims already decided keep the rules
                they were decided under.
              </p>
            </div>
          ),
        });
        if (!ok) return;

        await save.mutateAsync(values);
      })}
    >
      {view.scheduled ? (
        <Card>
          <CardContent className="flex items-start gap-3 py-4 text-sm">
            <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p>
              A policy version is scheduled to take effect on{' '}
              <strong>{formatDateTime(view.scheduled.effectiveFrom)}</strong>. The rules below are
              the ones in force until then.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* 1. General */}
      <Section title="General" description="What the benefit is called, and whether it is running.">
        <div className="sm:col-span-2">
          <Controller
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.enabled}
                hint="Off makes every employee ineligible without losing any of the configuration below."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
        </div>

        <FormField
          label={MEDICAL_POLICY_LABELS.policyName}
          htmlFor="policyName"
          hint="Shown to employees on their medical screen."
          error={errors.policyName?.message}
        >
          <Input disabled={!canManage} {...form.register('policyName')} />
        </FormField>

        <FormField
          label={MEDICAL_POLICY_LABELS.effectiveFrom}
          htmlFor="effectiveFrom"
          hint="Leave blank to start now. A future date announces a change before it bites."
          error={errors.effectiveFrom?.message}
        >
          <Input type="datetime-local" disabled={!canManage} {...form.register('effectiveFrom')} />
        </FormField>

        <div className="sm:col-span-2">
          <FormField
            label={MEDICAL_POLICY_LABELS.description}
            htmlFor="description"
            hint="What the benefit covers, in the company's own words."
            error={errors.description?.message}
          >
            <Textarea rows={3} disabled={!canManage} {...form.register('description')} />
          </FormField>
        </div>
      </Section>

      {/* 2. Eligibility */}
      <Section title="Eligibility" description="Which employment records the benefit reaches.">
        <FormField
          label={MEDICAL_POLICY_LABELS.minEmploymentMonths}
          htmlFor="minEmploymentMonths"
          hint="Completed months of service before the benefit applies. Zero covers everybody from day one."
          error={errors.minEmploymentMonths?.message}
        >
          <Input type="number" disabled={!canManage} {...form.register('minEmploymentMonths')} />
        </FormField>

        <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
          <Controller
            control={form.control}
            name="allowProbation"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.allowProbation}
                hint="Off excludes anyone still on probation."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={form.control}
            name="allowPermanent"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.allowPermanent}
                hint="Off excludes confirmed employees. Unusual, and available."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={form.control}
            name="blockResigned"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.blockResigned}
                hint="Blocks a resigned employment record."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={form.control}
            name="blockTerminated"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.blockTerminated}
                hint="Blocks a terminated employment record."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
        </div>
      </Section>

      {/* 3. Annual benefit */}
      <Section title="Annual benefit" description="The yearly entitlement each employee draws on.">
        <FormField
          label={MEDICAL_POLICY_LABELS.annualLimitPerEmployee}
          htmlFor="annualLimitPerEmployee"
          hint={`In ${view.currency}, per employee, per calendar year.`}
          error={errors.annualLimitPerEmployee?.message}
        >
          <Input type="number" disabled={!canManage} {...form.register('annualLimitPerEmployee')} />
        </FormField>
      </Section>

      {/* 4. Medical categories */}
      <Card>
        <CardHeader>
          <CardTitle>Medical categories</CardTitle>
          <CardDescription>
            Each category is switched on or off in its own right and carries its own limits. Leave
            a limit blank for no cap of its own, in which case only the annual benefit binds. The
            company and employee shares of a claim have to total 100%.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {MEDICAL_CATEGORIES.map((category, index) => (
            <div key={category} className="rounded-lg border border-border p-3">
              {/*
                The category itself is not editable - it identifies the row. It
                is registered so it travels with the submission rather than
                relying on the form to carry an unregistered default.
              */}
              <input type="hidden" {...form.register(`categories.${index}.category`)} />

              <div className="grid gap-3 sm:grid-cols-5 sm:items-start">
                <div className="sm:col-span-5">
                  <Controller
                    control={form.control}
                    name={`categories.${index}.enabled`}
                    render={({ field }) => (
                      <Toggle
                        label={MEDICAL_CATEGORY_LABELS[category]}
                        hint={MEDICAL_CATEGORY_DESCRIPTIONS[category]}
                        checked={field.value}
                        disabled={!canManage}
                        onChange={field.onChange}
                      />
                    )}
                  />
                </div>

                <FormField
                  label="Annual limit"
                  htmlFor={`categories.${index}.annualLimit`}
                  hint="Blank: no cap."
                  error={errors.categories?.[index]?.annualLimit?.message}
                >
                  <Input
                    type="number"
                    placeholder="No cap"
                    disabled={!canManage}
                    {...form.register(`categories.${index}.annualLimit`)}
                  />
                </FormField>

                <FormField
                  label="Maximum claim"
                  htmlFor={`categories.${index}.maxClaimAmount`}
                  hint="Blank: no cap."
                  error={errors.categories?.[index]?.maxClaimAmount?.message}
                >
                  <Input
                    type="number"
                    placeholder="No cap"
                    disabled={!canManage}
                    {...form.register(`categories.${index}.maxClaimAmount`)}
                  />
                </FormField>

                <FormField
                  label="Company %"
                  htmlFor={`categories.${index}.companyContributionPercent`}
                  error={errors.categories?.[index]?.companyContributionPercent?.message}
                >
                  <Input
                    type="number"
                    step="0.1"
                    disabled={!canManage}
                    {...form.register(`categories.${index}.companyContributionPercent`)}
                  />
                </FormField>

                <FormField
                  label="Employee %"
                  htmlFor={`categories.${index}.employeeContributionPercent`}
                  error={errors.categories?.[index]?.employeeContributionPercent?.message}
                >
                  <Input
                    type="number"
                    step="0.1"
                    disabled={!canManage}
                    {...form.register(`categories.${index}.employeeContributionPercent`)}
                  />
                </FormField>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 5. Dependents */}
      <Section title="Dependents" description="Who else the benefit extends to, and how it is funded.">
        <div className="grid gap-3 sm:col-span-2 sm:grid-cols-3">
          <Controller
            control={form.control}
            name="spouseCovered"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.spouseCovered}
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={form.control}
            name="childrenCovered"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.childrenCovered}
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={form.control}
            name="parentsCovered"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.parentsCovered}
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
        </div>

        <FormField
          label={MEDICAL_POLICY_LABELS.maxChildren}
          htmlFor="maxChildren"
          hint="Children beyond this are still recorded; they are simply not covered. Raising it covers them with no re-keying."
          error={errors.maxChildren?.message}
        >
          <Input type="number" disabled={!canManage} {...form.register('maxChildren')} />
        </FormField>

        <FormField
          label={MEDICAL_POLICY_LABELS.maxParents}
          htmlFor="maxParents"
          hint="The same rule as children: recorded either way, covered up to this many."
          error={errors.maxParents?.message}
        >
          <Input type="number" disabled={!canManage} {...form.register('maxParents')} />
        </FormField>

        <div className="sm:col-span-2">
          <Controller
            control={form.control}
            name="dependentsShareEmployeeLimit"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.dependentsShareEmployeeLimit}
                hint="On: dependents draw on the employee's annual limit. Off: they have a limit of their own, set below."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
        </div>

        {!sharesLimit ? (
          <FormField
            label={MEDICAL_POLICY_LABELS.dependentAnnualLimit}
            htmlFor="dependentAnnualLimit"
            hint={`In ${view.currency}. Read only while dependents do not share the employee limit.`}
            error={errors.dependentAnnualLimit?.message}
          >
            <Input type="number" disabled={!canManage} {...form.register('dependentAnnualLimit')} />
          </FormField>
        ) : null}
      </Section>

      {/* 6. Claim rules */}
      <Section title="Claim rules" description="How a claim is submitted and decided.">
        <FormField
          label={MEDICAL_POLICY_LABELS.claimSubmissionDeadlineDays}
          htmlFor="claimSubmissionDeadlineDays"
          hint="Days after treatment within which a claim has to be submitted."
          error={errors.claimSubmissionDeadlineDays?.message}
        >
          <Input
            type="number"
            disabled={!canManage}
            {...form.register('claimSubmissionDeadlineDays')}
          />
        </FormField>

        <FormField
          label={MEDICAL_POLICY_LABELS.maxBackdatedDays}
          htmlFor="maxBackdatedDays"
          hint="How far in the past a treatment date may be."
          error={errors.maxBackdatedDays?.message}
        >
          <Input type="number" disabled={!canManage} {...form.register('maxBackdatedDays')} />
        </FormField>

        <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
          <Controller
            control={form.control}
            name="allowBackdatedClaims"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.allowBackdatedClaims}
                hint="Off allows only treatment dated today."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={form.control}
            name="requireHrApproval"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.requireHrApproval}
                hint="Off would settle a claim without a decision. On by default, deliberately."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={form.control}
            name="allowPartialApproval"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.allowPartialApproval}
                hint="Lets a reviewer approve less than was claimed rather than refusing it outright."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={form.control}
            name="allowEmployeeCancelPending"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.allowEmployeeCancelPending}
                hint="Lets an employee withdraw a claim nobody has decided yet."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={form.control}
            name="allowHrOverride"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.allowHrOverride}
                hint="Lets an authorised user allow a claim the rules refuse. Employees can never override their own."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={form.control}
            name="requireOverrideReason"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.requireOverrideReason}
                hint="An override is recorded in the audit log either way. This makes the reason mandatory."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
        </div>
      </Section>

      {/* 7. Document requirements */}
      <Section
        title="Document requirements"
        description="What a claim has to be accompanied by. A claim that must carry a receipt is refused until one is recorded against it."
      >
        <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
          {(
            [
              ['requireReceipt', 'A receipt for what was paid.'],
              ['requirePrescription', 'A prescription for medication claimed.'],
              ['requireDiagnosis', 'A diagnosis or treatment document.'],
              ['requireHospitalName', 'The name of the hospital or clinic.'],
              ['requireTreatmentDate', 'The date the treatment happened.'],
            ] as const
          ).map(([name, hint]) => (
            <Controller
              key={name}
              control={form.control}
              name={name}
              render={({ field }) => (
                <Toggle
                  label={MEDICAL_POLICY_LABELS[name]}
                  hint={hint}
                  checked={field.value}
                  disabled={!canManage}
                  onChange={field.onChange}
                />
              )}
            />
          ))}
        </div>
      </Section>

      {/* 8. Carry forward */}
      <Section
        title="Carry forward"
        description="Whether an unused balance survives the year. Configuration only for now - nothing computes a carried balance yet, and the benefit screen does not add one."
      >
        <div className="sm:col-span-2">
          <Controller
            control={form.control}
            name="allowCarryForward"
            render={({ field }) => (
              <Toggle
                label={MEDICAL_POLICY_LABELS.allowCarryForward}
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
        </div>

        {carryForward ? (
          <FormField
            label={MEDICAL_POLICY_LABELS.maxCarryForwardAmount}
            htmlFor="maxCarryForwardAmount"
            hint={`In ${view.currency}. The most of an unused balance that may cross into next year.`}
            error={errors.maxCarryForwardAmount?.message}
          >
            <Input
              type="number"
              disabled={!canManage}
              {...form.register('maxCarryForwardAmount')}
            />
          </FormField>
        ) : null}
      </Section>

      {canManage ? (
        <Card>
          <CardFooter className="flex flex-wrap items-center justify-between gap-2 py-4">
            <p className="text-[13px] text-muted-foreground">
              Saving records a new policy version. Decided claims keep the rules they were decided
              under.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => form.reset(saved)}
                disabled={save.isPending}
              >
                <RotateCcw className="size-4" aria-hidden />
                Reset
              </Button>
              <Button type="submit" disabled={save.isPending}>
                <Save className="size-4" aria-hidden />
                {save.isPending ? 'Saving...' : 'Save policy'}
              </Button>
            </div>
          </CardFooter>
        </Card>
      ) : null}

      {/* 9. Policy history */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="size-4" aria-hidden />
            Policy history
          </CardTitle>
          <CardDescription>
            Every version, and what moved between it and the one before. Changing the annual limit
            is a financial decision, so it is kept rather than overwritten.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {history.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : history.isError ? (
            <ErrorState error={history.error} onRetry={() => history.refetch()} />
          ) : (history.data ?? []).length === 0 ? (
            <EmptyState title="No changes yet" description="The policy is still at its defaults." />
          ) : (
            <ol className="space-y-3">
              {(history.data ?? []).map((entry) => (
                <li key={entry.id} className="rounded-lg border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      Effective {formatDateTime(entry.effectiveFrom)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {entry.changedByName ? `Saved by ${entry.changedByName}` : 'Company default'}
                      {' · '}
                      {formatDateTime(entry.changedAt)}
                    </span>
                  </div>
                  {entry.changes.length === 0 ? (
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      The first version. Nothing before it to compare against.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-1">
                      {entry.changes.map((c) => (
                        <li key={c.field} className="text-[13px]">
                          <span className="text-muted-foreground">{c.label}:</span> {c.from}{' '}
                          <span aria-hidden>→</span> <strong>{c.to}</strong>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </form>
  );
}
