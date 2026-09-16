import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Minus, Plus } from 'lucide-react';
import {
  LUNCH_ORDER_MAX_QUANTITY,
  lunchOrderTotal,
  type LunchMenuItemRecord,
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
import { Input } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { money } from '@/features/employment/employment-shared';

/**
 * Ordering lunch.
 *
 * The form is a menu with a quantity beside each line, because that is what
 * choosing lunch is. What it deliberately is not is a form with a price on it:
 * the total shown here is a PREVIEW, computed from the same shared function the
 * server uses, and the request carries only ids and quantities. If the two ever
 * disagreed - somebody re-priced the karahi while this dialog was open - the
 * server's figure is the one that lands on the order, which is the correct way
 * round.
 */

const ERROR_BOX =
  'rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive';

export function LunchOrderDialog({
  open,
  onClose,
  currency,
}: {
  open: boolean;
  onClose: () => void;
  currency: string;
}) {
  const queryClient = useQueryClient();
  const [quantities, setQuantities] = React.useState<Record<string, number>>({});
  const [note, setNote] = React.useState('');
  const [formError, setFormError] = React.useState<string | null>(null);

  // Only fetched while the dialog is open: the menu is the form's vocabulary,
  // and a closed dialog has no form.
  const menu = useQuery({
    queryKey: ['lunch', 'menu'],
    queryFn: () => api.get<LunchMenuItemRecord[]>('/lunch/menu'),
    enabled: open,
  });

  React.useEffect(() => {
    if (!open) return;
    setQuantities({});
    setNote('');
    setFormError(null);
  }, [open]);

  const items = menu.data ?? [];

  const chosen = items
    .map((item) => ({ item, quantity: quantities[item.id] ?? 0 }))
    .filter((line) => line.quantity > 0);

  const total = lunchOrderTotal(
    chosen.map((line) => ({ unitPrice: line.item.price, quantity: line.quantity })),
  );

  const step = (item: LunchMenuItemRecord, delta: number) => {
    setQuantities((prev) => {
      const next = Math.min(LUNCH_ORDER_MAX_QUANTITY, Math.max(0, (prev[item.id] ?? 0) + delta));
      const { [item.id]: _dropped, ...rest } = prev;
      return next === 0 ? rest : { ...rest, [item.id]: next };
    });
  };

  const place = useMutation({
    mutationFn: () =>
      api.post<LunchOrderRecord>('/lunch/orders', {
        items: chosen.map((line) => ({ menuItemId: line.item.id, quantity: line.quantity })),
        note: note.trim() || undefined,
      }),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ['lunch'] });
      toast.success(`Order ${order.orderNumber} placed. Pay when your lunch arrives.`);
      onClose();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Order lunch</DialogTitle>
          <DialogDescription>
            Pay whoever brings it. Nothing is deducted from your salary.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {formError ? <p className={ERROR_BOX}>{formError}</p> : null}

          {menu.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : menu.isError ? (
            <ErrorState error={menu.error} onRetry={() => void menu.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              title="Nothing on the menu"
              description="Nobody has set up the lunch menu yet. Ask whoever runs the lunch round."
            />
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {items.map((item) => {
                const quantity = quantities[item.id] ?? 0;
                return (
                  <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium">{item.name}</p>
                      {item.description ? (
                        <p className="truncate text-xs text-muted-foreground">{item.description}</p>
                      ) : null}
                    </div>
                    <span className="tabular shrink-0 text-[13px] text-muted-foreground">
                      {money(item.price, currency)}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        aria-label={`One fewer ${item.name}`}
                        disabled={quantity === 0}
                        onClick={() => step(item, -1)}
                      >
                        <Minus className="size-3.5" aria-hidden />
                      </Button>
                      <span className="tabular w-6 text-center text-[13px]">{quantity}</span>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        aria-label={`One more ${item.name}`}
                        disabled={quantity >= LUNCH_ORDER_MAX_QUANTITY}
                        onClick={() => step(item, 1)}
                      >
                        <Plus className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="space-y-1.5">
            <label className="text-[13px] font-medium" htmlFor="lunch-note">
              Anything to pass on? <span className="text-muted-foreground">(optional)</span>
            </label>
            <Input
              id="lunch-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="No chillies"
              maxLength={200}
            />
          </div>

          <div className="flex items-baseline justify-between rounded-md bg-muted px-3 py-2.5">
            <span className="text-[13px] text-muted-foreground">Total to pay</span>
            <span className="tabular text-lg font-semibold">{money(total, currency)}</span>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={chosen.length === 0 || place.isPending}
            onClick={() => {
              setFormError(null);
              place.mutate();
            }}
          >
            {place.isPending ? 'Placing…' : 'Place order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
