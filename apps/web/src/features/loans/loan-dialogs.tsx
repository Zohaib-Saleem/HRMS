import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  buildSchedule,
  loanApplicationSchema,
  loanCreateSchema,
  type LoanApplicationInput,
  type LoanCreateInput,
  type LookupOption,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
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
import { isoMonth, money, thisMonthLocal } from '@/features/employment/employment-shared';

/**
 * Creating a loan, and applying for one.
 *
 * Both forms show the repayment schedule they would produce before anything is
 * saved, computed with the same `buildSchedule` the server writes rows with.
 * That matters more than it looks: "5,000 over 7 months" is not obviously
 * 714.28 six times and 714.32 once, and somebody agreeing to a deduction is
 * entitled to see the figure that will actually come out of their pay.
 */

const blankToNull = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

function SchedulePreview({
  principal,
  installments,
  startMonth,
  currency,
}: {
  principal: number;
  installments: number;
  startMonth: string;
  currency: string;
}) {
  const valid =
    Number.isFinite(principal) &&
    principal > 0 &&
    Number.isInteger(installments) &&
    installments > 0 &&
    installments <= 240 &&
    /^\d{4}-\d{2}/.test(startMonth);

  if (!valid) {
    return (
      <p className="rounded-lg border border-border bg-surface-muted/40 px-3.5 py-2.5 text-[12.5px] text-muted-foreground">
        Enter an amount, a number of months and a start month to see the repayment schedule.
      </p>
    );
  }

  const rows = buildSchedule({ principal, installments, startMonth });
  const first = rows[0];
  const last = rows[rows.length - 1];
  const evenAmount = first?.amount ?? 0;
  const lastDiffers = last !== undefined && last.amount !== evenAmount;

  return (
    <div className="rounded-lg border border-border bg-surface-muted/40 px-3.5 py-3 text-[12.5px]">
      <p className="text-foreground">
        <span className="font-medium tabular-nums">{money(evenAmount, currency)}</span> deducted each
        month for {installments} month{installments === 1 ? '' : 's'}, from{' '}
        <span className="font-medium">{isoMonth(first?.dueMonth ?? startMonth)}</span> to{' '}
        <span className="font-medium">{isoMonth(last?.dueMonth ?? startMonth)}</span>.
      </p>
      {lastDiffers ? (
        <p className="mt-1 text-muted-foreground">
          The final installment is {money(last.amount, currency)} so the instalments add up to
          exactly {money(principal, currency)}.
        </p>
      ) : null}
      <p className="mt-1 text-muted-foreground">
        Nothing is deducted until the loan is approved and released.
      </p>
    </div>
  );
}

/** HR recording a loan for somebody. */
export function LoanCreateDialog({
  open,
  onClose,
  employees,
  currency,
  /** Pre-selects and locks the employee, for the profile screen. */
  fixedEmployeeId,
}: {
  open: boolean;
  onClose: () => void;
  employees: LookupOption[];
  currency: string;
  fixedEmployeeId?: string;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const blank = React.useCallback(
    (): LoanCreateInput => ({
      employeeId: fixedEmployeeId ?? '',
      principalAmount: 0,
      currency,
      installmentCount: 6,
      startMonth: thisMonthLocal(),
      reference: null,
      purpose: null,
      notes: null,
      activate: true,
    }),
    [fixedEmployeeId, currency],
  );

  const form = useForm<LoanCreateInput>({
    resolver: zodResolver(loanCreateSchema),
    defaultValues: blank(),
  });

  React.useEffect(() => {
    if (open) {
      form.reset(blank());
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fixedEmployeeId, currency]);

  const save = useMutation({
    mutationFn: (values: LoanCreateInput) => api.post('/loans', values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['loans'] });
      toast.success('Loan recorded', {
        description: 'The repayment schedule is on file and visible to the employee.',
      });
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        const unplaced: string[] = [];
        for (const [field, messages] of Object.entries(error.details)) {
          const message = messages[0] ?? 'Invalid value.';
          if (field in form.getValues()) {
            form.setError(field as keyof LoanCreateInput, { message });
          } else {
            unplaced.push(message);
          }
        }
        if (unplaced.length > 0) setFormError(unplaced.join(' '));
        return;
      }
      setFormError(errorMessage(error));
    },
  });

  const errors = form.formState.errors;
  const principal = Number(form.watch('principalAmount'));
  const installments = Number(form.watch('installmentCount'));
  const startMonth = form.watch('startMonth');

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <form
          onSubmit={form.handleSubmit((values) => save.mutate(values))}
          className="contents"
          noValidate
        >
          <DialogHeader>
            <DialogTitle>Record a loan</DialogTitle>
            <DialogDescription>
              The schedule is generated now. Payroll collects an installment only once the loan is
              released.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {formError ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive"
              >
                {formError}
              </p>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              {fixedEmployeeId ? (
                <input type="hidden" {...form.register('employeeId')} />
              ) : (
                <FormField
                  label="Employee"
                  htmlFor="loan-employee"
                  required
                  className="sm:col-span-2"
                  error={errors.employeeId?.message}
                >
                  <NativeSelect id="loan-employee" {...form.register('employeeId')}>
                    <option value="">Choose an employee</option>
                    {employees.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
              )}

              <FormField
                label="Loan amount"
                htmlFor="loan-amount"
                required
                error={errors.principalAmount?.message}
              >
                <Input
                  id="loan-amount"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  {...form.register('principalAmount')}
                />
              </FormField>

              <FormField label="Currency" htmlFor="loan-currency" error={errors.currency?.message}>
                <Input
                  id="loan-currency"
                  maxLength={3}
                  className="uppercase"
                  {...form.register('currency')}
                />
              </FormField>

              <FormField
                label="Installments"
                htmlFor="loan-installments"
                required
                hint="How many monthly deductions."
                error={errors.installmentCount?.message}
              >
                <Input
                  id="loan-installments"
                  type="number"
                  min={1}
                  max={240}
                  {...form.register('installmentCount')}
                />
              </FormField>

              <FormField
                label="First deduction month"
                htmlFor="loan-start"
                required
                error={errors.startMonth?.message}
              >
                <Input id="loan-start" type="month" {...form.register('startMonth')} />
              </FormField>

              <FormField
                label="Reference"
                htmlFor="loan-reference"
                error={errors.reference?.message}
              >
                <Input
                  id="loan-reference"
                  {...form.register('reference', { setValueAs: blankToNull })}
                />
              </FormField>

              <FormField label="Purpose" htmlFor="loan-purpose" error={errors.purpose?.message}>
                <Input
                  id="loan-purpose"
                  {...form.register('purpose', { setValueAs: blankToNull })}
                />
              </FormField>

              <FormField
                label="Notes"
                htmlFor="loan-notes"
                className="sm:col-span-2"
                error={errors.notes?.message}
              >
                <Textarea
                  id="loan-notes"
                  rows={2}
                  {...form.register('notes', { setValueAs: blankToNull })}
                />
              </FormField>

              <div className="sm:col-span-2">
                <SchedulePreview
                  principal={principal}
                  installments={installments}
                  startMonth={startMonth}
                  currency={form.watch('currency') || currency}
                />
              </div>

              <label className="flex cursor-pointer items-start gap-2.5 text-[13px] sm:col-span-2">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  {...form.register('activate')}
                />
                <span>
                  Release it now
                  <span className="block text-[12.5px] text-muted-foreground">
                    Payroll starts collecting from the first deduction month. Leave this off to file
                    the loan as approved and release it later.
                  </span>
                </span>
              </label>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save loan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** An employee applying for a loan for themselves. */
export function LoanApplyDialog({
  open,
  onClose,
  currency,
}: {
  open: boolean;
  onClose: () => void;
  currency: string;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<LoanApplicationInput>({
    resolver: zodResolver(loanApplicationSchema),
    defaultValues: {
      principalAmount: 0,
      installmentCount: 6,
      startMonth: thisMonthLocal(),
      purpose: '',
      notes: null,
    },
  });

  React.useEffect(() => {
    if (open) {
      form.reset({
        principalAmount: 0,
        installmentCount: 6,
        startMonth: thisMonthLocal(),
        purpose: '',
        notes: null,
      });
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const apply = useMutation({
    mutationFn: (values: LoanApplicationInput) => api.post('/loans/apply', values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['loans'] });
      await queryClient.invalidateQueries({ queryKey: ['approvals'] });
      toast.success('Application submitted', {
        description: 'Your manager has been notified. Nothing is deducted until it is approved.',
      });
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        const unplaced: string[] = [];
        for (const [field, messages] of Object.entries(error.details)) {
          const message = messages[0] ?? 'Invalid value.';
          if (field in form.getValues()) {
            form.setError(field as keyof LoanApplicationInput, { message });
          } else {
            unplaced.push(message);
          }
        }
        if (unplaced.length > 0) setFormError(unplaced.join(' '));
        return;
      }
      setFormError(errorMessage(error));
    },
  });

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <form
          onSubmit={form.handleSubmit((values) => apply.mutate(values))}
          className="contents"
          noValidate
        >
          <DialogHeader>
            <DialogTitle>Apply for a loan</DialogTitle>
            <DialogDescription>
              Your application goes to your manager for approval. Nothing is deducted from your pay
              unless it is approved and released.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {formError ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive"
              >
                {formError}
              </p>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Amount"
                htmlFor="apply-amount"
                required
                error={errors.principalAmount?.message}
              >
                <Input
                  id="apply-amount"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  autoFocus
                  {...form.register('principalAmount')}
                />
              </FormField>

              <FormField
                label="Repay over (months)"
                htmlFor="apply-installments"
                required
                error={errors.installmentCount?.message}
              >
                <Input
                  id="apply-installments"
                  type="number"
                  min={1}
                  max={240}
                  {...form.register('installmentCount')}
                />
              </FormField>

              <FormField
                label="First deduction month"
                htmlFor="apply-start"
                required
                error={errors.startMonth?.message}
              >
                <Input id="apply-start" type="month" {...form.register('startMonth')} />
              </FormField>

              <FormField
                label="What is it for?"
                htmlFor="apply-purpose"
                required
                className="sm:col-span-2"
                error={errors.purpose?.message}
              >
                <Textarea id="apply-purpose" rows={2} {...form.register('purpose')} />
              </FormField>

              <FormField
                label="Anything else"
                htmlFor="apply-notes"
                className="sm:col-span-2"
                error={errors.notes?.message}
              >
                <Textarea
                  id="apply-notes"
                  rows={2}
                  {...form.register('notes', { setValueAs: blankToNull })}
                />
              </FormField>

              <div className="sm:col-span-2">
                <SchedulePreview
                  principal={Number(form.watch('principalAmount'))}
                  installments={Number(form.watch('installmentCount'))}
                  startMonth={form.watch('startMonth')}
                  currency={currency}
                />
              </div>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={apply.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={apply.isPending}>
              Submit application
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
