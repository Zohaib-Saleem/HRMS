import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  PAYROLL_BASES,
  PAYROLL_BASIS_LABELS,
  PAYROLL_FREQUENCIES,
  PAYROLL_FREQUENCY_LABELS,
  PAYROLL_OVERTIME_MODES,
  PAYROLL_OVERTIME_MODE_LABELS,
  PAYROLL_TIME_DEDUCTION_LABELS,
  PAYROLL_TIME_DEDUCTION_MODES,
  PERMISSIONS,
  payrollSettingsSchema,
  type PayrollSettingsInput,
  type PayrollSettingsRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect } from '@/components/ui/field';
import { ErrorState, FullPageLoader } from '@/components/feedback/states';
import { Can } from '@/features/auth/session-context';

/**
 * Payroll settings.
 *
 * Every number a company argues about, in one place and none of it hard-coded.
 * The basis in particular: a company paying by calendar days and one paying by
 * a fixed thirty produce different figures from the same salary and the same
 * attendance, and both are right for their own contracts.
 *
 * Each of these can be overridden per employee on their payroll profile.
 */

export function PayrollSettingsPage() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['payroll-settings'],
    queryFn: () => api.get<PayrollSettingsRecord>('/payroll/settings'),
  });

  const { register, handleSubmit, formState, watch, setError, reset } =
    useForm<PayrollSettingsInput>({
      resolver: zodResolver(payrollSettingsSchema),
      values: query.data,
    });

  const mutation = useMutation({
    mutationFn: (values: PayrollSettingsInput) =>
      api.patch<PayrollSettingsRecord>('/payroll/settings', values),
    onSuccess: async (saved) => {
      toast.success('Payroll settings saved.');
      reset(saved);
      await queryClient.invalidateQueries({ queryKey: ['payroll-settings'] });
      await queryClient.invalidateQueries({ queryKey: ['payroll-dashboard'] });
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof PayrollSettingsInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  if (query.isLoading) return <FullPageLoader />;
  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const basis = watch('basis');
  const overtimeMode = watch('overtimeMode');
  const lateMode = watch('lateDeductionMode');
  const earlyMode = watch('earlyLeaveDeductionMode');

  return (
    <form onSubmit={handleSubmit((values) => mutation.mutate(values))}>
      <PageHeader
        title="Payroll settings"
        description="What a day is worth, what an absence costs, and how overtime is priced. Every employee can override these individually."
        actions={
          <Can permission={PERMISSIONS.PAYROLL_MANAGE}>
            <Button type="submit" size="sm" loading={mutation.isPending} disabled={!formState.isDirty}>
              Save settings
            </Button>
          </Can>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-1 text-[13.5px] font-semibold">Pay cycle and basis</h2>
          <p className="mb-4 text-[12.5px] text-muted-foreground">
            The basis is what a monthly salary is divided by to reach a daily rate. It is the single
            most consequential number here.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Payroll frequency"
              htmlFor="frequency"
              error={formState.errors.frequency?.message}
              hint="Reporting only. The calculation reads each period's own dates."
            >
              <NativeSelect {...register('frequency')}>
                {PAYROLL_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {PAYROLL_FREQUENCY_LABELS[f]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField
              label="Payroll basis"
              htmlFor="basis"
              error={formState.errors.basis?.message}
              required
            >
              <NativeSelect {...register('basis')}>
                {PAYROLL_BASES.map((b) => (
                  <option key={b} value={b}>
                    {PAYROLL_BASIS_LABELS[b]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            {basis === 'FIXED_DAYS' ? (
              <FormField
                label="Days per month"
                htmlFor="fixedBasisDays"
                error={formState.errors.fixedBasisDays?.message}
                required
                hint="Usually 30 or 26."
              >
                <Input type="number" min={1} max={31} {...register('fixedBasisDays')} className="tabular" />
              </FormField>
            ) : null}
            <FormField
              label="Standard hours per day"
              htmlFor="standardHoursPerDay"
              error={formState.errors.standardHoursPerDay?.message}
              required
              hint="Turns a daily rate into an hourly one."
            >
              <Input
                type="number"
                step="0.5"
                {...register('standardHoursPerDay')}
                className="tabular"
              />
            </FormField>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 text-[13.5px] font-semibold">Overtime</h2>
          <p className="mb-4 text-[12.5px] text-muted-foreground">
            Unapproved hours are always counted and reported. Whether they are paid is this setting.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="How overtime is paid"
              htmlFor="overtimeMode"
              error={formState.errors.overtimeMode?.message}
              required
            >
              <NativeSelect {...register('overtimeMode')}>
                {PAYROLL_OVERTIME_MODES.map((m) => (
                  <option key={m} value={m}>
                    {PAYROLL_OVERTIME_MODE_LABELS[m]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            {overtimeMode === 'MULTIPLIER' ? (
              <FormField
                label="Multiplier"
                htmlFor="overtimeMultiplier"
                error={formState.errors.overtimeMultiplier?.message}
                required
                hint="1.5 is time and a half."
              >
                <Input
                  type="number"
                  step="0.1"
                  {...register('overtimeMultiplier')}
                  className="tabular"
                />
              </FormField>
            ) : null}
            {overtimeMode === 'FIXED_RATE' ? (
              <FormField
                label="Rate per hour"
                htmlFor="overtimeFixedRate"
                error={formState.errors.overtimeFixedRate?.message}
                required
              >
                <Input
                  type="number"
                  step="0.01"
                  {...register('overtimeFixedRate')}
                  className="tabular"
                />
              </FormField>
            ) : null}
            <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px] sm:col-span-2">
              <input
                type="checkbox"
                {...register('requireApprovedOvertime')}
                className="size-4 shrink-0 rounded border-input accent-[var(--primary)]"
              />
              Only pay overtime covered by an approved timesheet
            </label>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 text-[13.5px] font-semibold">Attendance deductions</h2>
          <p className="mb-4 text-[12.5px] text-muted-foreground">
            Only monthly salaries carry an absence deduction. Daily and hourly staff were never
            credited for the day, so deducting would charge them twice.
          </p>
          <div className="space-y-3">
            <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px]">
              <input
                type="checkbox"
                {...register('deductUnpaidAbsence')}
                className="size-4 shrink-0 rounded border-input accent-[var(--primary)]"
              />
              Deduct for unpaid absence
            </label>
            <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px]">
              <input
                type="checkbox"
                {...register('deductUnpaidLeave')}
                className="size-4 shrink-0 rounded border-input accent-[var(--primary)]"
              />
              Deduct for leave on an unpaid leave type
            </label>

            <div className="grid gap-4 border-t border-border pt-3 sm:grid-cols-3">
              <FormField
                label="Late arrival"
                htmlFor="lateDeductionMode"
                error={formState.errors.lateDeductionMode?.message}
              >
                <NativeSelect {...register('lateDeductionMode')}>
                  {PAYROLL_TIME_DEDUCTION_MODES.map((m) => (
                    <option key={m} value={m}>
                      {PAYROLL_TIME_DEDUCTION_LABELS[m]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              {lateMode !== 'NONE' ? (
                <>
                  <FormField
                    label="Rate"
                    htmlFor="lateDeductionRate"
                    error={formState.errors.lateDeductionRate?.message}
                  >
                    <Input
                      type="number"
                      step="0.01"
                      {...register('lateDeductionRate')}
                      className="tabular"
                    />
                  </FormField>
                  <FormField
                    label="Grace (minutes)"
                    htmlFor="lateGraceMinutes"
                    error={formState.errors.lateGraceMinutes?.message}
                    hint="On top of the attendance policy grace."
                  >
                    <Input type="number" {...register('lateGraceMinutes')} className="tabular" />
                  </FormField>
                </>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                label="Early leaving"
                htmlFor="earlyLeaveDeductionMode"
                error={formState.errors.earlyLeaveDeductionMode?.message}
              >
                <NativeSelect {...register('earlyLeaveDeductionMode')}>
                  {PAYROLL_TIME_DEDUCTION_MODES.map((m) => (
                    <option key={m} value={m}>
                      {PAYROLL_TIME_DEDUCTION_LABELS[m]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              {earlyMode !== 'NONE' ? (
                <>
                  <FormField
                    label="Rate"
                    htmlFor="earlyLeaveDeductionRate"
                    error={formState.errors.earlyLeaveDeductionRate?.message}
                  >
                    <Input
                      type="number"
                      step="0.01"
                      {...register('earlyLeaveDeductionRate')}
                      className="tabular"
                    />
                  </FormField>
                  <FormField
                    label="Grace (minutes)"
                    htmlFor="earlyLeaveGraceMinutes"
                    error={formState.errors.earlyLeaveGraceMinutes?.message}
                  >
                    <Input
                      type="number"
                      {...register('earlyLeaveGraceMinutes')}
                      className="tabular"
                    />
                  </FormField>
                </>
              ) : null}
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 text-[13.5px] font-semibold">Rounding, payslips and tax</h2>
          <p className="mb-4 text-[12.5px] text-muted-foreground">
            Each amount is rounded once, where it is shown, and the totals are the sum of the
            rounded lines - so a payslip adds up exactly as printed.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Decimal places"
              htmlFor="roundingDecimals"
              error={formState.errors.roundingDecimals?.message}
              required
            >
              <Input type="number" min={0} max={4} {...register('roundingDecimals')} className="tabular" />
            </FormField>
            <FormField
              label="Payslip prefix"
              htmlFor="payslipPrefix"
              error={formState.errors.payslipPrefix?.message}
              required
              hint="Numbers run sequentially after it."
            >
              <Input {...register('payslipPrefix')} className="tabular" />
            </FormField>
            <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px] sm:col-span-2">
              <input
                type="checkbox"
                {...register('taxEnabled')}
                className="size-4 shrink-0 rounded border-input accent-[var(--primary)]"
              />
              Tax module enabled
            </label>
            <p className="text-[12px] text-muted-foreground sm:col-span-2">
              Nothing computes tax yet, and no rate is stored here - a rate that is wrong for a
              jurisdiction is worse than no rate at all. Components carry a taxable flag so a tax
              module has something to read when one is built.
            </p>
          </div>
        </Card>
      </div>
    </form>
  );
}
