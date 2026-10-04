import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { z } from 'zod';
import {
  MEDICAL_ELIGIBILITY_OVERRIDES,
  MEDICAL_ELIGIBILITY_OVERRIDE_LABELS,
  type MedicalBenefitView,
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
import { money } from '@/features/employment/employment-shared';

/**
 * HR's per-employee exception to the medical policy.
 *
 * Two things can be set for one person: whether the benefit is theirs
 * (follow the policy, eligible, or not eligible) and an annual limit of their
 * own. Everything else - categories, contribution split, dependents' cover -
 * stays the company policy's, edited in Settings by Super Admin.
 *
 * A reason is compulsory whenever the result departs from the policy; the
 * server enforces the same rule and keeps the old and new values on the audit
 * log under `medical.override.update`.
 */

const formSchema = z
  .object({
    eligibility: z.enum(MEDICAL_ELIGIBILITY_OVERRIDES),
    annualLimit: z
      .string()
      .trim()
      .refine((v) => v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0), {
        message: 'Enter an amount of zero or more, or leave it blank.',
      }),
    note: z.string().trim().max(500, 'Keep the reason under 500 characters.'),
  })
  .superRefine((value, ctx) => {
    const departs = value.eligibility !== 'FOLLOW_POLICY' || value.annualLimit !== '';
    if (departs && value.note.length < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: 'Give the reason for departing from the policy.',
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;

const FIELD_NAMES = new Set<keyof FormValues>(['eligibility', 'annualLimit', 'note']);

export function MedicalOverrideDialog({
  open,
  onClose,
  view,
}: {
  open: boolean;
  onClose: () => void;
  view: MedicalBenefitView;
}) {
  const queryClient = useQueryClient();
  const { override, policyBenefitLimit } = view.eligibility;

  const current = React.useCallback(
    (): FormValues => ({
      eligibility: override.eligibility,
      annualLimit: override.annualLimit === null ? '' : String(override.annualLimit),
      note: override.note ?? '',
    }),
    [override.eligibility, override.annualLimit, override.note],
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: current(),
  });
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      form.reset(current());
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = useMutation({
    mutationFn: (values: FormValues) =>
      api.put('/medical/override', {
        employeeId: view.employeeId,
        eligibility: values.eligibility,
        annualLimit: values.annualLimit === '' ? null : Number(values.annualLimit),
        note: values.note || null,
      }),
    onSuccess: async () => {
      // Every medical screen reads under this prefix: the profile tab, the
      // employee's own page and their dashboard card.
      await queryClient.invalidateQueries({ queryKey: ['medical'] });
      toast.success('Medical settings saved', {
        description: 'The old and new values and your reason are on the audit log.',
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
  const title = 'Edit medical eligibility and limit';

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent>
        <form onSubmit={submit} className="contents" noValidate aria-label={title}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {view.employeeName}. An exception to the company medical policy for this employee
              only. It cannot switch the benefit on while the policy has it off, or cover a
              suspended, inactive or ended record.
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

            <fieldset className="min-w-0 space-y-4" disabled={save.isPending}>
              <FormField
                label="Eligibility"
                htmlFor="medical-override-eligibility"
                required
                hint="Not eligible also removes Medical from the employee's menu and dashboard."
                error={errors.eligibility?.message}
              >
                <NativeSelect {...form.register('eligibility')}>
                  {MEDICAL_ELIGIBILITY_OVERRIDES.map((value) => (
                    <option key={value} value={value}>
                      {MEDICAL_ELIGIBILITY_OVERRIDE_LABELS[value]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label={`Annual limit (${view.currency})`}
                htmlFor="medical-override-limit"
                hint={`Leave blank to use the policy's ${money(policyBenefitLimit, view.currency)}.`}
                error={errors.annualLimit?.message}
              >
                <Input type="number" min={0} step="1" {...form.register('annualLimit')} />
              </FormField>

              <FormField
                label="Reason"
                htmlFor="medical-override-note"
                hint="Required for any exception. Kept on the audit log."
                error={errors.note?.message}
              >
                <Textarea rows={3} {...form.register('note')} />
              </FormField>
            </fieldset>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
