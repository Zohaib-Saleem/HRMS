import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle, TrendingUp } from 'lucide-react';
import {
  incrementFigures,
  salaryRevisionSchema,
  type EmployeeSalaryRecord,
  type SalaryRevisionInput,
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
import { FormField, Input, Textarea } from '@/components/ui/field';
import { money } from '@/features/employment/employment-shared';
import { todayLocal } from './salary-dialog';

/**
 * Recording an increment.
 *
 * Distinct from "Record salary" on purpose. Adding a salary record is a
 * bookkeeping action; an increment is a decision, and the decision is what
 * people ask about afterwards - what it was, what it became, why, and who
 * agreed. Both end up writing the same effective-dated salary row, which is
 * what payroll reads.
 *
 * The increment and the percentage are shown live but never sent. The server
 * derives both from the salary actually in force on the effective date, so a
 * form left open while somebody else changed the salary records the change
 * that really happened rather than the one this screen was imagining.
 */
export function IncrementDialog({
  employeeId,
  employeeName,
  current,
  currency,
  open,
  onClose,
}: {
  employeeId: string;
  employeeName: string;
  /** The salary in force now, for the read-only "current" figure. */
  current: EmployeeSalaryRecord | null;
  currency: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const blank = React.useCallback(
    (): SalaryRevisionInput => ({
      employeeId,
      newAmount: current?.amount ?? 0,
      salaryType: current?.salaryType ?? 'MONTHLY',
      currency: current?.currency ?? currency,
      effectiveDate: todayLocal(),
      reason: '',
      notes: null,
      approvedByName: null,
      approvedByUserId: null,
    }),
    [employeeId, current, currency],
  );

  const form = useForm<SalaryRevisionInput>({
    resolver: zodResolver(salaryRevisionSchema),
    defaultValues: blank(),
  });

  React.useEffect(() => {
    if (open) {
      form.reset(blank());
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employeeId, current?.id]);

  const save = useMutation({
    mutationFn: (values: SalaryRevisionInput) => api.post('/payroll/salary-revisions', values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['compensation', employeeId] });
      await queryClient.invalidateQueries({ queryKey: ['salary-revisions'] });
      await queryClient.invalidateQueries({ queryKey: ['salary-overview'] });
      toast.success('Increment recorded', {
        description:
          'The previous salary is closed the day before and kept. Payroll for earlier periods still reads what it paid.',
      });
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        const unplaced: string[] = [];
        for (const [field, messages] of Object.entries(error.details)) {
          const message = messages[0] ?? 'Invalid value.';
          if (field in form.getValues()) {
            form.setError(field as keyof SalaryRevisionInput, { message });
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
  const currentAmount = current?.amount ?? 0;
  const newAmount = Number(form.watch('newAmount'));
  const figures = incrementFigures(currentAmount, Number.isFinite(newAmount) ? newAmount : 0);
  const displayCurrency = current?.currency ?? currency;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <form
          onSubmit={form.handleSubmit((values) => save.mutate(values))}
          className="contents"
          noValidate
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TrendingUp className="size-4" aria-hidden /> Record an increment
            </DialogTitle>
            <DialogDescription>
              {employeeName}. The new salary applies from its effective date; every earlier period
              keeps the salary it was paid.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {formError ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{formError}</span>
              </div>
            ) : null}

            <input type="hidden" {...form.register('employeeId')} />
            <input type="hidden" {...form.register('salaryType')} />
            <input type="hidden" {...form.register('currency')} />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Current salary" htmlFor="increment-current">
                <Input
                  id="increment-current"
                  value={current ? money(currentAmount, displayCurrency) : 'None on record'}
                  readOnly
                  aria-readonly="true"
                  tabIndex={-1}
                  className="bg-surface-muted/40 text-muted-foreground"
                />
              </FormField>

              <FormField
                label="New salary"
                htmlFor="increment-new"
                required
                error={errors.newAmount?.message}
              >
                <Input
                  id="increment-new"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  autoFocus
                  {...form.register('newAmount')}
                />
              </FormField>

              <div className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-surface-muted/40 p-3 sm:col-span-2">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Increment amount
                  </p>
                  <p
                    className="text-base font-semibold tabular"
                    data-testid="increment-amount"
                  >
                    {figures.incrementAmount >= 0 ? '+' : ''}
                    {money(figures.incrementAmount, displayCurrency)}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Increment percentage
                  </p>
                  <p
                    className="text-base font-semibold tabular"
                    data-testid="increment-percent"
                  >
                    {figures.incrementPercent >= 0 ? '+' : ''}
                    {figures.incrementPercent}%
                  </p>
                  {currentAmount === 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      No previous salary to be a percentage of.
                    </p>
                  ) : null}
                </div>
              </div>

              <FormField
                label="Effective date"
                htmlFor="increment-effective"
                required
                hint="The previous salary is closed the day before this."
                error={errors.effectiveDate?.message}
              >
                <Input
                  id="increment-effective"
                  type="date"
                  {...form.register('effectiveDate')}
                />
              </FormField>

              <FormField
                label="Approved by"
                htmlFor="increment-approver"
                hint="The person who signed it off, as you would write it on the paperwork."
                error={errors.approvedByName?.message}
              >
                <Input
                  id="increment-approver"
                  {...form.register('approvedByName', {
                    setValueAs: (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
                  })}
                />
              </FormField>

              <FormField
                label="Reason"
                htmlFor="increment-reason"
                required
                className="sm:col-span-2"
                hint="Annual review, promotion, market adjustment - it is kept with the record."
                error={errors.reason?.message}
              >
                <Textarea id="increment-reason" rows={2} {...form.register('reason')} />
              </FormField>

              <FormField
                label="Notes"
                htmlFor="increment-notes"
                className="sm:col-span-2"
                error={errors.notes?.message}
              >
                <Textarea
                  id="increment-notes"
                  rows={2}
                  {...form.register('notes', {
                    setValueAs: (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
                  })}
                />
              </FormField>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Record increment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
