import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { type LunchOrderRecord } from '@hrms/shared';
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
import { FormField, Textarea } from '@/components/ui/field';
import { money } from '@/features/employment/employment-shared';

/**
 * Putting a payment back to unpaid.
 *
 * A dialog with a compulsory reason rather than a confirm, because this is the
 * one action on the screen that rewrites a fact about money already counted -
 * the day's Collected figure moves when it is used, and somebody will ask why.
 * The reason goes into the audit entry alongside the before and the after, so
 * the answer to that question outlives whoever clicked.
 *
 * Only unmarking is offered here. Marking something paid is the other dialog
 * and the other grant: correcting a payment is undoing one, and a screen that
 * let the same button do both would be a screen where a slip of the mouse
 * records money nobody handed over.
 */
export function LunchCorrectPaymentDialog({
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
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (order) {
      setReason('');
      setError(null);
    }
  }, [order]);

  const correct = useMutation({
    mutationFn: (target: LunchOrderRecord) =>
      api.post<LunchOrderRecord>(`/lunch/desk/orders/${target.id}/payment-correction`, {
        paymentStatus: 'UNPAID',
        reason: reason.trim(),
      }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['lunch'] });
      toast.success(`${updated.orderNumber} is unpaid again.`);
      onClose();
    },
    onError: (failure) => setError(errorMessage(failure)),
  });

  return (
    <Dialog open={order !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Correct this payment</DialogTitle>
          <DialogDescription>
            {order
              ? `${order.orderNumber} · ${order.employeeName} · ${money(order.totalAmount, currency)}. This puts the order back to unpaid and moves today's collected total.`
              : null}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive">
              {error}
            </p>
          ) : null}

          <FormField
            label="Why is this being corrected?"
            htmlFor="lunch-correction-reason"
            hint="Kept with the order, so the change can be explained later."
            required
          >
            <Textarea
              id="lunch-correction-reason"
              rows={3}
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Marked the wrong Ali paid."
            />
          </FormField>
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={order === null || reason.trim().length < 3 || correct.isPending}
            onClick={() => order && correct.mutate(order)}
          >
            {correct.isPending ? 'Correcting…' : 'Mark unpaid'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
