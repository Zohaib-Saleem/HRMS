import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DEFAULT_LUNCH_PAYMENT_METHOD,
  LUNCH_PAYMENT_METHODS,
  LUNCH_PAYMENT_METHOD_LABELS,
  type LunchOrderRecord,
  type LunchPaymentMethod,
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
import { FormField, NativeSelect } from '@/components/ui/field';
import { money } from '@/features/employment/employment-shared';

/**
 * Taking the money for one order.
 *
 * The confirmation names the amount and the person, in that order, because that
 * is the sentence somebody says out loud while counting notes into a hand:
 * "two hundred and ninety from Ali". A dialog that only said "Mark paid?" would
 * be tapped without reading, and the thing being confirmed is a fact about
 * money that is about to become hard to unpick.
 *
 * The amount is shown and never edited. It is the order's own total, and there
 * is no field here - or anywhere in this module - that could send a different
 * one.
 */
export function LunchMarkPaidDialog({
  order,
  onClose,
  currency,
}: {
  order: LunchOrderRecord | null;
  onClose: () => void;
  currency: string;
}) {
  const queryClient = useQueryClient();
  const [method, setMethod] = React.useState<LunchPaymentMethod>(DEFAULT_LUNCH_PAYMENT_METHOD);

  React.useEffect(() => {
    if (order) setMethod(DEFAULT_LUNCH_PAYMENT_METHOD);
  }, [order]);

  const pay = useMutation({
    mutationFn: (target: LunchOrderRecord) =>
      api.post<LunchOrderRecord>(`/lunch/desk/orders/${target.id}/pay`, {
        paymentMethod: method,
      }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['lunch'] });
      toast.success(
        `${money(updated.totalAmount, currency)} recorded from ${updated.employeeName}.`,
      );
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog open={order !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {order
              ? `Mark ${money(order.totalAmount, currency)} as paid by ${order.employeeName}?`
              : 'Mark as paid'}
          </DialogTitle>
          <DialogDescription>
            {order ? `${order.orderNumber} · ${order.itemSummary}` : null}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <FormField label="Payment method" htmlFor="lunch-payment-method">
            <NativeSelect
              id="lunch-payment-method"
              value={method}
              onChange={(event) => setMethod(event.target.value as LunchPaymentMethod)}
            >
              {LUNCH_PAYMENT_METHODS.map((value) => (
                <option key={value} value={value}>
                  {LUNCH_PAYMENT_METHOD_LABELS[value]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={order === null || pay.isPending}
            onClick={() => order && pay.mutate(order)}
          >
            {pay.isPending ? 'Recording…' : 'Confirm payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
