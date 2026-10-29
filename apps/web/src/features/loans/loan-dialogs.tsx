import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  LOAN_KIND_LABELS,
  SALARY_ADVANCE_INSTALLMENTS,
  buildSchedule,
  loanApplicationSchema,
  loanCreateSchema,
  type LoanApplicationInput,
  type LoanCreateInput,
  type LoanDeductionMonthInfo,
  type LoanKind,
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
import { LoanEligibilityPanel } from './loan-eligibility-panel';

/**
 * The deduction month rule, as the server applies it.
 *
 * The forms default to this rather than to the browser's clock: an employee
 * whose laptop is a day out, or who opens the form in the last hour of the
 * month, would otherwise see one month and be stored against another.
 */
export function useDeductionMonth(enabled = true) {
  return useQuery({
    queryKey: ['loans', 'deduction-month'],
    queryFn: () => api.get<LoanDeductionMonthInfo>('/loans/deduction-month'),
    enabled,
    staleTime: 60_000,
  });
}
import { useLoanEligibility } from './use-loan-eligibility';

/**
 * Creating a loan, and applying for one.
 *
 * Both forms show the repayment schedule they would produce before anything is
 * saved, computed with the same `buildSchedule` the server writes rows with.
 * That matters more than it looks: "5,000 over 7 months" is not obviously
 * 714.28 six times and 714.32 once, and somebody agreeing to a deduction is
 * entitled to see the figure that will actually come out of their pay.
 *
 * A salary advance is the same form with the term taken away: it is always one
 * installment, the whole amount from one payslip, so there is no "repay over"
 * to choose and the preview names the payslip instead of a schedule.
 */

/** "October 2026" for a yyyy-MM month, read as the calendar month it names. */
export function longMonth(value: string): string {
  const parsed = new Date(`${value.slice(0, 7)}-01T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

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

function AdvancePreview({
  amount,
  month,
  currency,
}: {
  amount: number;
  month: string;
  currency: string;
}) {
  if (!(Number.isFinite(amount) && amount > 0) || !/^\d{4}-\d{2}/.test(month)) {
    return (
      <p className="rounded-lg border border-border bg-surface-muted/40 px-3.5 py-2.5 text-[12.5px] text-muted-foreground">
        Enter an amount and a month to see what will be recovered.
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-surface-muted/40 px-3.5 py-3 text-[12.5px]">
      <p className="text-foreground">
        The full <span className="font-medium tabular-nums">{money(amount, currency)}</span> is
        recovered from the <span className="font-medium">{isoMonth(month)}</span> payslip.
      </p>
      <p className="mt-1 text-muted-foreground">
        Nothing is deducted until the advance is approved and released.
      </p>
    </div>
  );
}

/** HR recording a loan - or a salary advance - for somebody. */
export function LoanCreateDialog({
  open,
  onClose,
  employees,
  currency,
  /** Pre-selects and locks the employee, for the profile screen. */
  fixedEmployeeId,
  kind = 'LOAN',
}: {
  open: boolean;
  onClose: () => void;
  employees: LookupOption[];
  currency: string;
  fixedEmployeeId?: string;
  kind?: LoanKind;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);
  const isAdvance = kind === 'SALARY_ADVANCE';

  const blank = React.useCallback(
    (): LoanCreateInput => ({
      kind,
      employeeId: fixedEmployeeId ?? '',
      principalAmount: 0,
      currency,
      installmentCount: isAdvance ? SALARY_ADVANCE_INSTALLMENTS : 6,
      startMonth: thisMonthLocal(),
      reference: null,
      purpose: null,
      notes: null,
      activate: true,
      alreadyRepaidInstallments: 0,
      alreadyRepaidReason: null,
    }),
    [fixedEmployeeId, currency, kind, isAdvance],
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
  }, [open, fixedEmployeeId, currency, kind]);

  const save = useMutation({
    mutationFn: (values: LoanCreateInput) => api.post('/loans', values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['loans'] });
      toast.success(`${LOAN_KIND_LABELS[kind]} recorded`, {
        description: isAdvance
          ? 'The recovery is on file and visible to the employee.'
          : 'The repayment schedule is on file and visible to the employee.',
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
  const deductionMonth = useDeductionMonth(open);
  const currentMonth = deductionMonth.data?.currentMonth ?? null;
  /*
   * A loan entered after the fact. Every installment due before the current
   * payroll month would otherwise come off the next payslip all at once, so
   * the form says how many that is and asks which were already repaid.
   */
  const pastInstallments =
    currentMonth && /^\d{4}-\d{2}/.test(startMonth ?? '')
      ? buildSchedule({
          principal: principal > 0 ? principal : 1,
          installments: Number.isFinite(installments) && installments > 0 ? installments : 1,
          startMonth,
        }).filter((row) => row.dueMonth.slice(0, 7) < currentMonth).length
      : 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <form
          onSubmit={form.handleSubmit((values) => save.mutate(values))}
          className="contents"
          noValidate
        >
          <DialogHeader>
            <DialogTitle>{isAdvance ? 'Record a salary advance' : 'Record a loan'}</DialogTitle>
            <DialogDescription>
              {isAdvance
                ? 'Pay handed over early. Payroll takes the whole amount back from one payslip, once the advance is released.'
                : 'The schedule is generated now. Payroll collects an installment only once the loan is released.'}
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
                label={isAdvance ? 'Advance amount' : 'Loan amount'}
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

              {isAdvance ? (
                <input type="hidden" {...form.register('installmentCount')} />
              ) : (
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
              )}

              <FormField
                label={isAdvance ? 'Recovered from (payslip month)' : 'First deduction month'}
                htmlFor="loan-start"
                required
                error={errors.startMonth?.message}
              >
                <Input id="loan-start" type="month" {...form.register('startMonth')} />
              </FormField>

              {pastInstallments > 0 ? (
                <div className="space-y-3 rounded-md border border-warning/40 bg-warning-soft p-3 text-[13px] sm:col-span-2">
                  <p role="status">
                    {pastInstallments} installment(s) fall before the current payroll month (
                    {isoMonth(currentMonth!)}). Unless they are recorded as already repaid, the next
                    payroll run collects all of them at once.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField
                      label="Installments already repaid outside HRMS"
                      htmlFor="loan-already-repaid"
                      hint="Counted from the first installment."
                      error={errors.alreadyRepaidInstallments?.message}
                    >
                      <Input
                        id="loan-already-repaid"
                        type="number"
                        min={0}
                        max={installments}
                        {...form.register('alreadyRepaidInstallments')}
                      />
                    </FormField>
                    <FormField
                      label="How they were repaid"
                      htmlFor="loan-already-repaid-reason"
                      hint="Required when any are marked repaid. Goes on the loan ledger."
                      error={errors.alreadyRepaidReason?.message}
                    >
                      <Input
                        id="loan-already-repaid-reason"
                        {...form.register('alreadyRepaidReason', { setValueAs: blankToNull })}
                      />
                    </FormField>
                  </div>
                </div>
              ) : null}

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
                {isAdvance ? (
                  <AdvancePreview
                    amount={principal}
                    month={startMonth}
                    currency={form.watch('currency') || currency}
                  />
                ) : (
                  <SchedulePreview
                    principal={principal}
                    installments={installments}
                    startMonth={startMonth}
                    currency={form.watch('currency') || currency}
                  />
                )}
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
                    {isAdvance
                      ? 'Payroll recovers it from the chosen month. Leave this off to file the advance as approved and release it later.'
                      : 'Payroll starts collecting from the first deduction month. Leave this off to file the loan as approved and release it later.'}
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
              {isAdvance ? 'Save advance' : 'Save loan'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** An employee applying for a loan - or a salary advance - for themselves. */
export function LoanApplyDialog({
  open,
  onClose,
  currency,
  kind = 'LOAN',
}: {
  open: boolean;
  onClose: () => void;
  currency: string;
  kind?: LoanKind;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);
  const isAdvance = kind === 'SALARY_ADVANCE';

  const deductionMonth = useDeductionMonth(open);
  // An advance is against this month's pay: always the month it is asked for
  // in (the company's timezone), even when that payroll is finalized - the
  // server then flags it for Payroll instead of moving it.
  const defaultMonth =
    (isAdvance ? deductionMonth.data?.currentMonth : deductionMonth.data?.defaultMonth) ?? null;
  const currentMonthClosed =
    deductionMonth.data?.closedMonths.includes(deductionMonth.data.currentMonth) ?? false;

  const blank = (): LoanApplicationInput => ({
    kind,
    principalAmount: 0,
    installmentCount: isAdvance ? SALARY_ADVANCE_INSTALLMENTS : 6,
    startMonth: defaultMonth ?? thisMonthLocal(),
    purpose: '',
    notes: null,
  });

  const form = useForm<LoanApplicationInput>({
    resolver: zodResolver(loanApplicationSchema),
    defaultValues: blank(),
  });

  // The server's month arrives after the form opened: take it, unless the
  // employee has already chosen one themselves.
  React.useEffect(() => {
    if (open && defaultMonth && !form.formState.dirtyFields.startMonth) {
      form.setValue('startMonth', defaultMonth);
    }
  }, [open, defaultMonth, form]);

  /*
   * The server's answer, asked for as the form is filled in.
   *
   * It is advisory here and authoritative on submit: `POST /loans/apply` runs
   * the same evaluation again and refuses on its own result. This exists so an
   * employee finds out what they can borrow before typing a number, not so the
   * browser can decide anything.
   */
  const watchedAmount = Number(form.watch('principalAmount'));
  const watchedInstallments = Number(form.watch('installmentCount'));
  const eligibility = useLoanEligibility({
    principalAmount: Number.isFinite(watchedAmount) && watchedAmount > 0 ? watchedAmount : undefined,
    installmentCount:
      Number.isFinite(watchedInstallments) && watchedInstallments > 0
        ? watchedInstallments
        : undefined,
    kind,
    enabled: open,
  });

  React.useEffect(() => {
    if (open) {
      form.reset(blank());
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);

  const apply = useMutation({
    // An advance sends the month it showed, or none before the server's month
    // has arrived - never one taken from the browser's clock.
    mutationFn: (values: LoanApplicationInput) =>
      api.post(
        '/loans/apply',
        isAdvance && !deductionMonth.data ? { ...values, startMonth: undefined } : values,
      ),
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
            <DialogTitle>{isAdvance ? 'Request a salary advance' : 'Apply for a loan'}</DialogTitle>
            <DialogDescription>
              {isAdvance
                ? 'Part of your pay, early. The whole amount comes back from one payslip. Your request goes to your manager, and nothing is deducted unless it is approved and released.'
                : 'Your application goes to your manager for approval. Nothing is deducted from your pay unless it is approved and released.'}
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

            {/* Above the form on purpose: a refusal is worth reading before
                filling anything in, and the ceiling is worth knowing before
                choosing an amount. */}
            <LoanEligibilityPanel
              result={eligibility.data}
              loading={eligibility.isPending}
            />

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

              {isAdvance ? (
                <input type="hidden" {...form.register('installmentCount')} />
              ) : (
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
              )}

              {isAdvance ? (
                <div className="sm:col-span-2" data-testid="advance-deduction-month">
                  <input type="hidden" {...form.register('startMonth')} />
                  <p className="text-sm">
                    <span className="text-muted-foreground">Deduction Month:</span>{' '}
                    <span className="font-medium">
                      {deductionMonth.data ? longMonth(deductionMonth.data.currentMonth) : '…'}
                    </span>
                  </p>
                  {errors.startMonth?.message ? (
                    <p className="mt-1 text-[12.5px] text-destructive">{errors.startMonth.message}</p>
                  ) : null}
                  {deductionMonth.data ? (
                    <p className="mt-1 text-[12.5px] text-muted-foreground">
                      {currentMonthClosed
                        ? `Payroll for ${longMonth(deductionMonth.data.currentMonth)} is already finalized and will not be changed. Your request keeps this month, and Payroll will confirm the month it is recovered from before anything is deducted.`
                        : 'An advance is recovered from the salary of the month you request it in.'}
                    </p>
                  ) : null}
                </div>
              ) : (
                <>
                  <FormField
                    label="First deduction month"
                    htmlFor="apply-start"
                    required
                    error={errors.startMonth?.message}
                  >
                    <Input
                      id="apply-start"
                      type="month"
                      min={deductionMonth.data?.currentMonth}
                      {...form.register('startMonth')}
                    />
                  </FormField>
                  {deductionMonth.data ? (
                    <p className="text-[12.5px] text-muted-foreground sm:col-span-2">
                      Requests made now are first deducted from the{' '}
                      <span className="font-medium">{isoMonth(deductionMonth.data.defaultMonth)}</span>{' '}
                      payslip
                      {deductionMonth.data.defaultMonth !== deductionMonth.data.currentMonth
                        ? `, because payroll for ${isoMonth(deductionMonth.data.currentMonth)} is already finalized`
                        : ', the payroll month this request is made in'}
                      . You can choose a later month; an earlier or closed one is refused.
                    </p>
                  ) : null}
                </>
              )}

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
                {isAdvance ? (
                  <AdvancePreview
                    amount={Number(form.watch('principalAmount'))}
                    month={form.watch('startMonth') ?? ''}
                    currency={currency}
                  />
                ) : (
                  <SchedulePreview
                    principal={Number(form.watch('principalAmount'))}
                    installments={Number(form.watch('installmentCount'))}
                    startMonth={form.watch('startMonth') ?? ''}
                    currency={currency}
                  />
                )}
              </div>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={apply.isPending}>
              Cancel
            </Button>
            {/*
              * Disabled while the server says no, and enabled while the answer
              * is still unknown - a button that stays dead because a request
              * failed is worse than one that submits and is refused by the
              * endpoint, which is the real gate either way.
              */}
            <Button
              type="submit"
              loading={apply.isPending}
              disabled={eligibility.data ? !eligibility.data.eligible : false}
            >
              {isAdvance ? 'Submit request' : 'Submit application'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
