import * as React from 'react';
import { Navigate } from 'react-router-dom';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, History, RotateCcw, Save } from 'lucide-react';
import {
  LOAN_EVALUATION_MONTHS,
  LOAN_EVALUATION_MONTHS_LABELS,
  LOAN_POLICY_LABELS,
  PERMISSIONS,
  loanPolicySchema,
  type LoanEvaluationMonths,
  type LoanPolicyHistoryEntry,
  type LoanPolicyInput,
  type LoanPolicyRecord,
  type LoanPolicyView,
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
import { FormField, Input, NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { usePermissions } from '@/features/auth/session-context';
import { cn } from '@/lib/utils';

/**
 * Settings -> Loans -> Loan Policy. Super Admin's screen.
 *
 * Everything an application is measured against lives here, and nothing that
 * decides a loan lives in the code. The form is grouped the way somebody thinks
 * about the question - who may borrow, what their attendance has to look like,
 * what shape the loan may take, what employment status blocks it, who may make
 * an exception - rather than in the order the columns happen to sit in.
 *
 * Saving is confirmed against a diff of what is actually changing. Moving the
 * maximum loan from one month's salary to two is a financial decision, and a
 * settings screen that saves it silently is how such a decision gets made by
 * accident and noticed a payroll later.
 *
 * Nothing here touches a loan that already exists. Saving writes a new policy
 * VERSION; loans already granted keep the schedule they were granted on.
 */

const LOAN_POLICY_KEY = ['loans', 'policy'] as const;
const LOAN_POLICY_HISTORY_KEY = ['loans', 'policy', 'history'] as const;

/** A switch, matching the one on the attendance rules screen. */
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
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">{children}</CardContent>
    </Card>
  );
}

/** The saved values, as the form's baseline and the diff's "current". */
export function toFormValues(policy: LoanPolicyRecord): LoanPolicyInput {
  return {
    maxSalaryMultiplier: policy.maxSalaryMultiplier,
    minEmploymentMonths: policy.minEmploymentMonths,
    allowProbation: policy.allowProbation,
    minAttendancePercent: policy.minAttendancePercent,
    maxUnapprovedAbsences: policy.maxUnapprovedAbsences,
    maxLateDays: policy.maxLateDays,
    maxMissingPunches: policy.maxMissingPunches,
    evaluationMonths: policy.evaluationMonths,
    maxMonthlyDeductionPercent: policy.maxMonthlyDeductionPercent,
    oneActiveLoan: policy.oneActiveLoan,
    onePendingLoan: policy.onePendingLoan,
    blockTerminated: policy.blockTerminated,
    blockResigned: policy.blockResigned,
    minSalary: policy.minSalary,
    maxTenureMonths: policy.maxTenureMonths,
    maxInstallments: policy.maxInstallments,
    allowHrOverride: policy.allowHrOverride,
    requireOverrideReason: policy.requireOverrideReason,
  };
}

const asText = (value: unknown): string =>
  typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);

/**
 * What the save is about to change.
 *
 * Pure, and exported, so the rule can be asserted without rendering a form.
 */
export function changedFields(
  saved: LoanPolicyInput,
  next: LoanPolicyInput,
): Array<{ label: string; from: string; to: string }> {
  const out: Array<{ label: string; from: string; to: string }> = [];
  for (const key of Object.keys(saved) as Array<keyof LoanPolicyInput>) {
    if (key === 'effectiveFrom') continue;
    if (saved[key] === next[key]) continue;
    out.push({
      label: LOAN_POLICY_LABELS[key],
      from: asText(saved[key]),
      to: asText(next[key]),
    });
  }
  return out;
}

export function LoanPolicyPage() {
  const { has } = usePermissions();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const query = useQuery({
    queryKey: LOAN_POLICY_KEY,
    queryFn: () => api.get<{ data: LoanPolicyView }>('/loans/policy').then((r) => r.data),
  });

  const history = useQuery({
    queryKey: LOAN_POLICY_HISTORY_KEY,
    queryFn: () =>
      api
        .get<{ data: LoanPolicyHistoryEntry[] }>('/loans/policy/history?limit=20')
        .then((r) => r.data),
  });

  // Both gates are checked. The server's `canManage` is the real answer; the
  // permission is what decides whether the screen was ever offered.
  const canManage = has(PERMISSIONS.LOAN_POLICY_MANAGE) && (query.data?.canManage ?? false);

  const form = useForm<LoanPolicyInput>({
    resolver: zodResolver(loanPolicySchema),
    values: query.data ? toFormValues(query.data.policy) : undefined,
  });

  const save = useMutation({
    mutationFn: (values: LoanPolicyInput) => api.put('/loans/policy', values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: LOAN_POLICY_KEY });
      await queryClient.invalidateQueries({ queryKey: LOAN_POLICY_HISTORY_KEY });
      toast.success('Loan policy saved', {
        description: 'New applications are measured against it. Existing loans are unchanged.',
      });
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          form.setError(field as keyof LoanPolicyInput, {
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
          title: 'Save the loan policy?',
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
                This applies to new applications from the moment it is saved. Loans already
                granted keep the schedule they were granted on.
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

      <Section
        title="Eligibility"
        description="Who may borrow at all, and how much their salary allows."
      >
        <FormField
          label={LOAN_POLICY_LABELS.maxSalaryMultiplier}
          htmlFor="maxSalaryMultiplier"
          hint={`Multiples of monthly salary. At 1, somebody earning ${view.currency} 100,000 can borrow ${view.currency} 100,000.`}
          error={form.formState.errors.maxSalaryMultiplier?.message}
        >
          <Input type="number" step="0.1" disabled={!canManage} {...form.register('maxSalaryMultiplier')} />
        </FormField>

        <FormField
          label={LOAN_POLICY_LABELS.minEmploymentMonths}
          htmlFor="minEmploymentMonths"
          hint="Completed months of service before an application is allowed."
          error={form.formState.errors.minEmploymentMonths?.message}
        >
          <Input type="number" disabled={!canManage} {...form.register('minEmploymentMonths')} />
        </FormField>

        <FormField
          label={LOAN_POLICY_LABELS.minAttendancePercent}
          htmlFor="minAttendancePercent"
          hint="Measured by the attendance engine over the evaluation period, across the days the employee was expected to attend. Approved leave is not counted against them."
          error={form.formState.errors.minAttendancePercent?.message}
        >
          <Input type="number" step="0.1" disabled={!canManage} {...form.register('minAttendancePercent')} />
        </FormField>

        <FormField
          label={LOAN_POLICY_LABELS.evaluationMonths}
          htmlFor="evaluationMonths"
          hint="Completed calendar months only. Today's part-finished day is never counted."
          error={form.formState.errors.evaluationMonths?.message}
        >
          <NativeSelect disabled={!canManage} {...form.register('evaluationMonths')}>
            {LOAN_EVALUATION_MONTHS.map((m) => (
              <option key={m} value={m}>
                {LOAN_EVALUATION_MONTHS_LABELS[m as LoanEvaluationMonths]}
              </option>
            ))}
          </NativeSelect>
        </FormField>

        <FormField
          label={LOAN_POLICY_LABELS.minSalary}
          htmlFor="minSalary"
          hint={`In ${view.currency}. Zero allows any salary.`}
          error={form.formState.errors.minSalary?.message}
        >
          <Input type="number" disabled={!canManage} {...form.register('minSalary')} />
        </FormField>
      </Section>

      <Section
        title="Attendance restrictions"
        description="Counted over the evaluation period, by the same engine the attendance screens read."
      >
        <FormField
          label={LOAN_POLICY_LABELS.maxUnapprovedAbsences}
          htmlFor="maxUnapprovedAbsences"
          hint="Days recorded absent with no approved leave behind them."
          error={form.formState.errors.maxUnapprovedAbsences?.message}
        >
          <Input type="number" disabled={!canManage} {...form.register('maxUnapprovedAbsences')} />
        </FormField>

        <FormField
          label={LOAN_POLICY_LABELS.maxLateDays}
          htmlFor="maxLateDays"
          hint="Days flagged late after the attendance policy's own grace."
          error={form.formState.errors.maxLateDays?.message}
        >
          <Input type="number" disabled={!canManage} {...form.register('maxLateDays')} />
        </FormField>

        <FormField
          label={LOAN_POLICY_LABELS.maxMissingPunches}
          htmlFor="maxMissingPunches"
          hint="Missing punches with no correction raised. Raising one clears it."
          error={form.formState.errors.maxMissingPunches?.message}
        >
          <Input type="number" disabled={!canManage} {...form.register('maxMissingPunches')} />
        </FormField>
      </Section>

      <Section title="Loan restrictions" description="What shape a loan is allowed to take.">
        <FormField
          label={LOAN_POLICY_LABELS.maxTenureMonths}
          htmlFor="maxTenureMonths"
          hint="The longest a loan may be repaid over."
          error={form.formState.errors.maxTenureMonths?.message}
        >
          <Input type="number" disabled={!canManage} {...form.register('maxTenureMonths')} />
        </FormField>

        <FormField
          label={LOAN_POLICY_LABELS.maxInstallments}
          htmlFor="maxInstallments"
          hint="The most installments a schedule may carry."
          error={form.formState.errors.maxInstallments?.message}
        >
          <Input type="number" disabled={!canManage} {...form.register('maxInstallments')} />
        </FormField>

        <FormField
          label={LOAN_POLICY_LABELS.maxMonthlyDeductionPercent}
          htmlFor="maxMonthlyDeductionPercent"
          hint={`Percent of monthly salary. At 30, somebody earning ${view.currency} 100,000 can repay at most ${view.currency} 30,000 a month.`}
          error={form.formState.errors.maxMonthlyDeductionPercent?.message}
        >
          <Input
            type="number"
            step="0.1"
            disabled={!canManage}
            {...form.register('maxMonthlyDeductionPercent')}
          />
        </FormField>

        <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
          <Controller
            control={form.control}
            name="oneActiveLoan"
            render={({ field }) => (
              <Toggle
                label={LOAN_POLICY_LABELS.oneActiveLoan}
                hint="Blocks an application while a loan is being repaid."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={form.control}
            name="onePendingLoan"
            render={({ field }) => (
              <Toggle
                label={LOAN_POLICY_LABELS.onePendingLoan}
                hint="Blocks a second application while one is awaiting a decision."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
        </div>
      </Section>

      <Section
        title="Employment restrictions"
        description="Which employment records may borrow at all."
      >
        <div className="grid gap-3 sm:col-span-2 sm:grid-cols-3">
          <Controller
            control={form.control}
            name="allowProbation"
            render={({ field }) => (
              <Toggle
                label={LOAN_POLICY_LABELS.allowProbation}
                hint="Off blocks anyone still on probation."
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
                label={LOAN_POLICY_LABELS.blockTerminated}
                hint="Blocks a terminated employment record."
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
                label={LOAN_POLICY_LABELS.blockResigned}
                hint="Blocks a resigned employment record."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
        </div>
      </Section>

      <Section title="Approval" description="Whether a refusal can be set aside, and on what terms.">
        <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
          <Controller
            control={form.control}
            name="allowHrOverride"
            render={({ field }) => (
              <Toggle
                label={LOAN_POLICY_LABELS.allowHrOverride}
                hint="Lets an authorised user grant a loan the rules refuse. Employees can never override their own."
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
                label={LOAN_POLICY_LABELS.requireOverrideReason}
                hint="An override is recorded in the audit log either way. This makes the reason mandatory."
                checked={field.value}
                disabled={!canManage}
                onChange={field.onChange}
              />
            )}
          />
        </div>
      </Section>

      {canManage ? (
        <Card>
          <CardFooter className="flex flex-wrap items-center justify-between gap-2 py-4">
            <p className="text-[13px] text-muted-foreground">
              Saving records a new policy version. Existing loans keep their schedule.
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="size-4" aria-hidden />
            Policy history
          </CardTitle>
          <CardDescription>
            Every version, and what moved between it and the one before. Changing the maximum loan
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
