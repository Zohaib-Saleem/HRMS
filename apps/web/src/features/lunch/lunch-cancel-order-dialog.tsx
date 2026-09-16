import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import {
  LUNCH_CANCEL_RESOLUTIONS,
  LUNCH_CANCEL_RESOLUTION_DESCRIPTIONS,
  LUNCH_CANCEL_RESOLUTION_LABELS,
  type LunchCancelResolution,
  type LunchOrderRecord,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
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

/**
 * The operator calling somebody's lunch off.
 *
 * Two shapes behind one dialog, and which one appears is decided by the order
 * rather than by the person: an unpaid order needs a reason and nothing else,
 * and a PAID one cannot be cancelled until somebody says what happened to the
 * money. The second case is spelled out rather than defaulted, because
 * defaulting it would mean the software deciding on its own either that cash
 * went back to an employee when it did not, or that the office boy is keeping
 * money nobody agreed he could keep.
 *
 * The reason is compulsory in both, and it is compulsory because the employee
 * reads it. That is the whole point of collecting it: somebody's lunch
 * disappeared and they are owed a sentence about why.
 */

const ERROR_BOX =
  'rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive';

export function LunchCancelOrderDialog({
  order,
  onClose,
  currency,
}: {
  order: LunchOrderRecord | null;
  onClose: () => void;
  currency: string;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = React.useState('');
  const [resolution, setResolution] = React.useState<LunchCancelResolution | ''>('');
  const [refundReason, setRefundReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const wasPaid = order?.paymentStatus === 'PAID';

  React.useEffect(() => {
    if (!order) return;
    setReason('');
    // Deliberately blank rather than pre-selected. Either answer is a decision
    // about somebody's money, and neither should be reachable by one click.
    setResolution('');
    setRefundReason('');
    setError(null);
  }, [order]);

  const cancel = useMutation({
    mutationFn: (target: LunchOrderRecord) =>
      api.post<LunchOrderRecord>(`/lunch/desk/orders/${target.id}/cancel`, {
        reason: reason.trim(),
        resolution: wasPaid ? resolution : undefined,
        refundReason: wasPaid && refundReason.trim() ? refundReason.trim() : undefined,
      }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['lunch'] });
      toast.success(`${updated.orderNumber} cancelled.`);
      onClose();
    },
    onError: (failure) => setError(errorMessage(failure)),
  });

  const ready = reason.trim().length >= 3 && (!wasPaid || resolution !== '');

  return (
    <Dialog open={order !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel lunch order</DialogTitle>
          <DialogDescription>
            {order
              ? `${order.employeeName} · ${order.orderNumber} · ${money(order.totalAmount, currency)}`
              : null}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {error ? <p className={ERROR_BOX}>{error}</p> : null}

          {/*
           * The paid case, stated before the form rather than after it. An
           * operator who reads nothing else must still see this line before
           * they cancel something somebody has already handed money over for.
           */}
          {wasPaid && order ? (
            <div className="space-y-3 rounded-md border border-warning/40 bg-warning-soft px-3 py-3">
              <p className="flex items-start gap-2 text-[13px] font-medium text-warning-foreground">
                <AlertTriangle className="mt-px size-4 shrink-0" aria-hidden />
                This order has already been paid.
              </p>

              <fieldset className="space-y-2">
                <legend className="sr-only">What happens to the money</legend>
                {LUNCH_CANCEL_RESOLUTIONS.map((value) => (
                  <label
                    key={value}
                    className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-surface px-3 py-2.5 text-[13px]"
                  >
                    <input
                      type="radio"
                      name="lunch-cancel-resolution"
                      className="mt-0.5"
                      value={value}
                      checked={resolution === value}
                      onChange={() => setResolution(value)}
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {LUNCH_CANCEL_RESOLUTION_LABELS[value]}
                      </span>
                      <span className="block text-muted-foreground">
                        {LUNCH_CANCEL_RESOLUTION_DESCRIPTIONS[value]}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </div>
          ) : null}

          <FormField
            label="Reason"
            htmlFor="lunch-cancel-reason"
            hint="Shown to the employee whose order this is."
            required
          >
            <Textarea
              id="lunch-cancel-reason"
              rows={3}
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Employee requested cancellation"
            />
          </FormField>

          {wasPaid ? (
            <FormField
              label="Note about the money"
              htmlFor="lunch-refund-note"
              hint="Optional, and kept on the desk. The employee does not see this one."
            >
              <Input
                id="lunch-refund-note"
                value={refundReason}
                maxLength={500}
                onChange={(event) => setRefundReason(event.target.value)}
                placeholder="Gave the 290 back from the box"
              />
            </FormField>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Keep the order
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={order === null || !ready || cancel.isPending}
            onClick={() => order && cancel.mutate(order)}
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
