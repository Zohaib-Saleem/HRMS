import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { z } from 'zod';
import {
  PAYROLL_SALARY_TYPES,
  PAYROLL_SALARY_TYPE_LABELS,
  employeeSalarySchema,
  type EmployeeSalaryInput,
  type EmployeeSalaryRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
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

/**
 * Records a new salary, or corrects one already on record.
 *
 * Editing is for fixing a record - a typo in the amount, the wrong start
 * date. A raise is not an edit: it is a new record from a new date, so the
 * period already paid keeps reading what it paid. The screen says so.
 *
 * The rules are the shared `employeeSalarySchema`, the same one the API
 * parses the request with. This file only adds what a form needs on top:
 * a required message for an empty box (the schema sees a coerced 0 or an
 * empty string, not "nothing typed"), and the end-before-start check the
 * API also makes, repeated here so the message lands next to the field
 * before a round trip rather than after one.
 */

/** Today as the calendar day where the user is, not the UTC day. */
export function todayLocal(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const REQUIRED_AMOUNT = 'Enter the basic salary.';
const REQUIRED_FROM = 'Enter the date this salary takes effect.';
const ENDS_BEFORE_START = 'A salary cannot end before it starts.';

const blankToNull = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

export const salaryFormSchema = employeeSalarySchema
  .extend({
    amount: z
      .union([z.string(), z.number()])
      .refine((v) => !(typeof v === 'string' && v.trim() === ''), REQUIRED_AMOUNT)
      .pipe(employeeSalarySchema.shape.amount),
    effectiveFrom: z.string().min(1, REQUIRED_FROM).pipe(employeeSalarySchema.shape.effectiveFrom),
    effectiveTo: z.preprocess(blankToNull, employeeSalarySchema.shape.effectiveTo),
    note: z.preprocess(blankToNull, employeeSalarySchema.shape.note),
  })
  .superRefine((values, ctx) => {
    if (values.effectiveTo && values.effectiveTo < values.effectiveFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['effectiveTo'], message: ENDS_BEFORE_START });
    }
  });

/** What the dates say about the record, for the read-only Status field. */
export function salaryStatus(
  effectiveFrom: string,
  effectiveTo: string | null | undefined,
  today = todayLocal(),
): { label: 'Current' | 'Scheduled' | 'Ended'; variant: 'success' | 'primary' | 'warning'; hint: string } {
  if (effectiveFrom && effectiveFrom > today) {
    return { label: 'Scheduled', variant: 'primary', hint: 'Starts on a future date.' };
  }
  if (effectiveTo && effectiveTo < today) {
    return { label: 'Ended', variant: 'warning', hint: 'No longer in force.' };
  }
  return {
    label: 'Current',
    variant: 'success',
    hint: effectiveTo ? 'In force until the end date.' : 'Open-ended: the salary in force now.',
  };
}

const FIELD_NAMES: ReadonlySet<string> = new Set([
  'employeeId',
  'salaryType',
  'amount',
  'currency',
  'effectiveFrom',
  'effectiveTo',
  'note',
]);

export interface SalaryDialogProps {
  employeeId: string;
  /** Shown read-only at the top of the form so it is clear whose salary this is. */
  employeeName?: string;
  currency: string;
  /** When set, the dialog edits this record instead of creating one. */
  existing?: EmployeeSalaryRecord | null;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export function SalaryDialog({
  employeeId,
  employeeName,
  currency,
  existing = null,
  open,
  onClose,
  onSaved,
}: SalaryDialogProps) {
  const queryClient = useQueryClient();
  const isEdit = existing !== null;

  const blank = (): EmployeeSalaryInput => ({
    employeeId,
    salaryType: 'MONTHLY',
    amount: 0,
    currency,
    effectiveFrom: todayLocal(),
    effectiveTo: null,
    note: null,
  });

  const fromExisting = (row: EmployeeSalaryRecord): EmployeeSalaryInput => ({
    employeeId: row.employeeId,
    salaryType: row.salaryType,
    amount: row.amount,
    currency: row.currency,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    note: row.note,
  });

  const form = useForm<EmployeeSalaryInput>({
    resolver: zodResolver(salaryFormSchema),
    defaultValues: existing ? fromExisting(existing) : blank(),
  });

  // Anything the API rejected that is not one field's fault. Announced and
  // brought into view when it appears, since the body may be scrolled past it.
  const [formError, setFormError] = React.useState<string | null>(null);
  const alertRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!formError) return;
    alertRef.current?.scrollIntoView?.({ block: 'nearest' });
    alertRef.current?.focus();
  }, [formError]);

  React.useEffect(() => {
    if (open) {
      form.reset(existing ? fromExisting(existing) : blank());
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employeeId, currency, existing?.id]);

  const save = useMutation({
    mutationFn: (input: EmployeeSalaryInput) =>
      isEdit
        ? api.patch(`/payroll/salaries/${existing.id}`, input)
        : api.post('/payroll/salaries', input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['compensation', employeeId] });
      await queryClient.invalidateQueries({ queryKey: ['salary-overview'] });
      toast.success(isEdit ? 'Salary record updated' : 'Salary recorded', {
        description: isEdit
          ? 'This corrected the record in place. For a raise, record a new salary from its start date instead.'
          : 'Earlier records are untouched, so past payroll still reads what it paid.',
      });
      onSaved?.();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        const unplaced: string[] = [];
        for (const [field, messages] of Object.entries(error.details)) {
          const message = messages[0] ?? 'Invalid value.';
          if (FIELD_NAMES.has(field)) {
            form.setError(field as keyof EmployeeSalaryInput, { message });
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

  const submit = form.handleSubmit((values) => {
    if (save.isPending) return;
    setFormError(null);
    save.mutate(values);
  });

  const watchedFrom = form.watch('effectiveFrom');
  const watchedTo = form.watch('effectiveTo');
  const status = salaryStatus(watchedFrom, watchedTo);
  const errors = form.formState.errors;

  const title = isEdit ? 'Edit salary' : 'Add salary';
  const employeeLabel = employeeName ?? existing?.employeeName ?? employeeId;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent
        size="lg"
        // The first control is the read-only Employee field; start on the
        // first one the user can actually type into.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById('salary-amount')?.focus();
        }}
      >
        <form onSubmit={submit} className="contents" noValidate aria-label={title}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? 'Corrects this record in place. For a raise, add a new salary from its start date instead.'
                : 'Salary is effective-dated. Earlier periods keep reading the salary they were paid.'}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-5">
            {formError ? (
              <div
                ref={alertRef}
                role="alert"
                tabIndex={-1}
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive outline-none"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{formError}</span>
              </div>
            ) : null}

            <fieldset className="min-w-0 space-y-4" disabled={save.isPending}>
              <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Salary
              </legend>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Employee" htmlFor="salary-employee" className="sm:col-span-2">
                  <Input
                    id="salary-employee"
                    value={employeeLabel}
                    readOnly
                    aria-readonly="true"
                    tabIndex={-1}
                    className="bg-surface-muted/40 text-muted-foreground"
                  />
                </FormField>
                <input type="hidden" {...form.register('employeeId')} />

                <FormField
                  label="Basic salary"
                  htmlFor="salary-amount"
                  required
                  error={errors.amount?.message}
                >
                  <Input
                    id="salary-amount"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min={0}
                    {...form.register('amount')}
                  />
                </FormField>

                <FormField label="Currency" htmlFor="salary-currency" error={errors.currency?.message}>
                  <Input
                    id="salary-currency"
                    maxLength={3}
                    autoCapitalize="characters"
                    className="uppercase"
                    {...form.register('currency')}
                  />
                </FormField>

                <FormField
                  label="Pay frequency"
                  htmlFor="salary-type"
                  error={errors.salaryType?.message}
                  className="sm:col-span-2"
                >
                  <NativeSelect id="salary-type" {...form.register('salaryType')}>
                    {PAYROLL_SALARY_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {PAYROLL_SALARY_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>

                <FormField
                  label="Effective from"
                  htmlFor="salary-effective-from"
                  required
                  hint="Payroll for earlier periods keeps using the previous salary."
                  error={errors.effectiveFrom?.message}
                >
                  <Input id="salary-effective-from" type="date" {...form.register('effectiveFrom')} />
                </FormField>

                <FormField
                  label="Effective to"
                  htmlFor="salary-effective-to"
                  hint="Leave empty while this is the current salary."
                  error={errors.effectiveTo?.message}
                >
                  <Input
                    id="salary-effective-to"
                    type="date"
                    min={watchedFrom || undefined}
                    {...form.register('effectiveTo', { setValueAs: blankToNull })}
                  />
                </FormField>

                <div className="space-y-1.5 sm:col-span-2">
                  <span className="text-[13px] font-medium leading-none text-foreground">Status</span>
                  <div className="flex flex-wrap items-center gap-2" data-testid="salary-status">
                    <Badge variant={status.variant}>{status.label}</Badge>
                    <span className="text-[13px] text-muted-foreground">{status.hint}</span>
                  </div>
                </div>

                <FormField
                  label="Reason / note"
                  htmlFor="salary-note"
                  hint="Kept with the record and shown in the history - a promotion, an annual review, a correction."
                  error={errors.note?.message}
                  className="sm:col-span-2"
                >
                  <Textarea
                    id="salary-note"
                    rows={2}
                    maxLength={500}
                    {...form.register('note', { setValueAs: blankToNull })}
                  />
                </FormField>
              </div>
            </fieldset>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Save salary'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
