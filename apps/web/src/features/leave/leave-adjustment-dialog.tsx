import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { z } from 'zod';
import { balanceAdjustmentSchema, type LeaveBalanceRecord } from '@hrms/shared';
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

/**
 * The one editable number on an employee's leave balance.
 *
 * Entitlement comes from the leave type, accrual from the calendar, used and
 * pending from the leave requests, and remaining is the sum of all of them.
 * None of those is typed in here. What HR can set is the ADJUSTMENT for one
 * leave type and one year - the administrative correction the balance service
 * already reads - and the reason for it, which is compulsory and is shown
 * beside the figure afterwards.
 *
 * The adjustment is how one employee's allocation differs from the leave
 * type's: 15 days a year plus an adjustment of 5 is an allocation of 20. The
 * dialog shows that allocation and the remaining balance before and after as
 * the figure is typed, and the server refuses a figure that would take the
 * allocation below zero or the balance below what has already been taken.
 *
 * The figure replaces the stored adjustment rather than adding to it, so what
 * the dialog opens with is what is on record now and what it saves is what
 * will be on record next. The server writes the old and new value to the
 * audit log under `leave.balance.adjust`.
 */

const REQUIRED_DAYS = 'Enter the adjustment in days. Zero clears it.';

/** The shared rules, plus a required message for an empty box. */
export const leaveAdjustmentFormSchema = balanceAdjustmentSchema
  .pick({ adjustmentDays: true, adjustmentNote: true })
  .extend({
    adjustmentDays: z
      .union([z.string(), z.number()])
      .refine((v) => !(typeof v === 'string' && v.trim() === ''), REQUIRED_DAYS)
      .pipe(balanceAdjustmentSchema.shape.adjustmentDays),
  });

type FormValues = z.input<typeof leaveAdjustmentFormSchema>;

const FIELD_NAMES = new Set<keyof FormValues>(['adjustmentDays', 'adjustmentNote']);

export interface LeaveAdjustmentDialogProps {
  open: boolean;
  onClose: () => void;
  employeeId: string;
  employeeName?: string;
  year: number;
  /** The balance row being adjusted; null while nothing is selected. */
  balance: LeaveBalanceRecord | null;
  /**
   * Every leave type's row for the year. When given, the dialog offers a
   * leave-type picker and reports a change through `onChoose`.
   */
  choices?: readonly LeaveBalanceRecord[];
  onChoose?: (balance: LeaveBalanceRecord) => void;
}

export function LeaveAdjustmentDialog({
  open,
  onClose,
  employeeId,
  employeeName,
  year,
  balance,
  choices,
  onChoose,
}: LeaveAdjustmentDialogProps) {
  const queryClient = useQueryClient();

  const current = React.useCallback(
    (): FormValues => ({
      adjustmentDays: balance ? String(balance.adjustmentDays) : '',
      adjustmentNote: balance?.adjustmentNote ?? '',
    }),
    [balance],
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(leaveAdjustmentFormSchema),
    defaultValues: current(),
  });

  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      form.reset(current());
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, balance?.leaveTypeId, year]);

  const save = useMutation({
    // The resolver has already coerced the box to a number; `Number` only
    // narrows the type, which still says "string | number" for the input.
    mutationFn: (values: FormValues) =>
      api.post('/leave/balances/adjust', {
        employeeId,
        leaveTypeId: balance?.leaveTypeId,
        year,
        adjustmentDays: Number(values.adjustmentDays),
        adjustmentNote: values.adjustmentNote,
      }),
    onSuccess: async () => {
      // The balance table and the profile's "Leave remaining" card both read
      // the same service; both are refreshed so neither shows the old figure.
      await queryClient.invalidateQueries({ queryKey: ['leave', 'balances'] });
      await queryClient.invalidateQueries({ queryKey: ['employees', employeeId, 'profile-summary'] });
      toast.success('Leave balance adjusted', {
        description: 'The old and new figure and your reason are on the audit log.',
      });
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        const unplaced: string[] = [];
        for (const [field, messages] of Object.entries(error.details)) {
          const message = messages[0] ?? 'Invalid value.';
          if (FIELD_NAMES.has(field as keyof FormValues)) {
            form.setError(field as keyof FormValues, { message });
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

  const errors = form.formState.errors;
  const title = balance ? `Edit ${balance.leaveTypeName} leave ${year}` : 'Edit leave balance';

  /*
   * The before and after of what the adjustment moves, worked out from the
   * figures the server sent. A preview only: the server recomputes both
   * before it saves anything.
   */
  const typed = form.watch('adjustmentDays');
  const typedNumber = typeof typed === 'number' ? typed : Number(String(typed).trim());
  const preview =
    balance && String(typed).trim() !== '' && Number.isFinite(typedNumber)
      ? (() => {
          const delta = typedNumber - balance.adjustmentDays;
          const base = balance.annualEntitlementDays + balance.openingDays;
          return {
            allocationBefore: round2(base + balance.adjustmentDays),
            allocationAfter: round2(base + typedNumber),
            remainingBefore: balance.availableDays,
            remainingAfter: round2(balance.availableDays + delta),
          };
        })()
      : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent>
        <form onSubmit={submit} className="contents" noValidate aria-label={title}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {employeeName ? `${employeeName}. ` : ''}
              Entitlement, accrual, used and pending days are worked out from the leave type and
              the leave requests and are not edited here. This sets the manual correction that is
              added to the balance, and replaces any correction already on record.
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

            {balance ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted/40 px-3 py-2 text-[13px] sm:grid-cols-4">
                <Figure label="Entitlement" value={balance.annualEntitlementDays} />
                <Figure label="Accrued" value={balance.accruedDays} />
                <Figure label="Used" value={balance.usedDays} />
                <Figure label="Remaining" value={balance.availableDays} />
              </dl>
            ) : null}

            <fieldset className="min-w-0 space-y-4" disabled={save.isPending}>
              {choices && choices.length > 1 && onChoose ? (
                <FormField label="Leave type" htmlFor="leave-adjustment-type">
                  <NativeSelect
                    value={balance?.leaveTypeId ?? ''}
                    onChange={(event) => {
                      const next = choices.find((c) => c.leaveTypeId === event.target.value);
                      if (next) onChoose(next);
                    }}
                  >
                    {choices.map((c) => (
                      <option key={c.leaveTypeId} value={c.leaveTypeId}>
                        {c.leaveTypeName}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
              ) : null}

              <FormField
                label="Adjustment (days)"
                htmlFor="leave-adjustment-days"
                required
                hint="Positive grants days, negative takes them away, in whole or half days. Zero removes the correction."
                error={errors.adjustmentDays?.message}
              >
                <Input
                  type="number"
                  step="0.5"
                  min={-365}
                  max={365}
                  autoFocus
                  {...form.register('adjustmentDays')}
                />
              </FormField>

              {preview ? (
                <dl
                  data-testid="leave-adjustment-preview"
                  className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border border-border px-3 py-2 text-[13px]"
                >
                  <div>
                    <dt className="text-xs text-muted-foreground">Allocation for {year}</dt>
                    <dd className="tabular font-medium">
                      {fmt(preview.allocationBefore)} → {fmt(preview.allocationAfter)} days
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Remaining</dt>
                    <dd
                      className={
                        preview.remainingAfter < 0
                          ? 'tabular font-medium text-destructive'
                          : 'tabular font-medium'
                      }
                    >
                      {fmt(preview.remainingBefore)} → {fmt(preview.remainingAfter)} days
                    </dd>
                  </div>
                </dl>
              ) : null}

              <FormField
                label="Reason"
                htmlFor="leave-adjustment-note"
                required
                hint="Shown beside the figure on the profile and kept on the audit log."
                error={errors.adjustmentNote?.message}
              >
                <Textarea rows={3} {...form.register('adjustmentNote')} />
              </FormField>
            </fieldset>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save adjustment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''));

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular font-medium">
        {Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '')}
      </dd>
    </div>
  );
}
