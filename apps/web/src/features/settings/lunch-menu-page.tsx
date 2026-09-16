import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Sandwich } from 'lucide-react';
import { type LunchMenuItemRecord } from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField, Input } from '@/components/ui/field';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useSession } from '@/features/auth/session-context';
import { money } from '@/features/employment/employment-shared';

/**
 * The lunch menu.
 *
 * Company configuration, alongside the other settings screens, and the one
 * thing worth saying on it is said on it: a price change applies from now on
 * and to nothing already ordered. Order lines carry the price they were placed
 * at, so putting the karahi up by fifty rupees does not change what fifty
 * people already owe - and somebody editing this field deserves to know that
 * before they wonder.
 *
 * Items are retired, never deleted, which is why the only destructive-looking
 * control here turns one off. An item with orders behind it is history.
 */

interface DraftValues {
  name: string;
  description: string;
  price: string;
  sortOrder: string;
}

const BLANK: DraftValues = { name: '', description: '', price: '', sortOrder: '0' };

export function LunchMenuPage() {
  const queryClient = useQueryClient();
  const { session } = useSession();
  const currency = session?.company.currency ?? 'PKR';

  const [editing, setEditing] = React.useState<LunchMenuItemRecord | null>(null);
  const [creating, setCreating] = React.useState(false);

  const query = useQuery({
    queryKey: ['lunch', 'menu-items'],
    queryFn: () => api.get<LunchMenuItemRecord[]>('/lunch/menu-items'),
  });

  const retire = useMutation({
    mutationFn: (item: LunchMenuItemRecord) =>
      api.patch<LunchMenuItemRecord>(`/lunch/menu-items/${item.id}`, { isActive: !item.isActive }),
    onSuccess: (item) => {
      void queryClient.invalidateQueries({ queryKey: ['lunch'] });
      toast.success(item.isActive ? `${item.name} is back on the menu.` : `${item.name} retired.`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const items = query.data ?? [];

  return (
    <>
      <PageHeader
        title="Lunch menu"
        description="What people can order, and what it costs. Prices apply to new orders only."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden />
            Add item
          </Button>
        }
      />

      <Card>
        <TableWrapper>
          <Table>
            <THead>
              <TR>
                <TH>Item</TH>
                <TH className="text-right">Price</TH>
                <TH>Order</TH>
                <TH>On the menu</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {query.isLoading ? (
                <TableSkeleton rows={4} columns={5} />
              ) : query.isError ? (
                <TR>
                  <TD colSpan={5}>
                    <ErrorState error={query.error} onRetry={() => void query.refetch()} />
                  </TD>
                </TR>
              ) : items.length === 0 ? (
                <TR>
                  <TD colSpan={5}>
                    <EmptyState
                      icon={Sandwich}
                      title="Nothing on the menu yet"
                      description="Add what the office can order, with what it costs."
                      action={
                        <Button size="sm" onClick={() => setCreating(true)}>
                          Add item
                        </Button>
                      }
                    />
                  </TD>
                </TR>
              ) : (
                items.map((item) => (
                  <TR key={item.id}>
                    <TD>
                      <p className="font-medium">{item.name}</p>
                      {item.description ? (
                        <p className="text-xs text-muted-foreground">{item.description}</p>
                      ) : null}
                    </TD>
                    <TD className="tabular text-right">{money(item.price, currency)}</TD>
                    <TD className="tabular text-muted-foreground">{item.sortOrder}</TD>
                    <TD>
                      <Badge variant={item.isActive ? 'success' : 'neutral'}>
                        {item.isActive ? 'On the menu' : 'Retired'}
                      </Badge>
                    </TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setEditing(item)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={retire.isPending}
                          onClick={() => retire.mutate(item)}
                        >
                          {item.isActive ? 'Retire' : 'Restore'}
                        </Button>
                      </div>
                    </TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </TableWrapper>
      </Card>

      <MenuItemDialog
        open={creating || editing !== null}
        item={editing}
        currency={currency}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </>
  );
}

/** Adding an item, or re-pricing one. One form, because they are one shape. */
function MenuItemDialog({
  open,
  item,
  currency,
  onClose,
}: {
  open: boolean;
  item: LunchMenuItemRecord | null;
  currency: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = React.useState<DraftValues>(BLANK);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setValues(
      item
        ? {
            name: item.name,
            description: item.description ?? '',
            price: String(item.price),
            sortOrder: String(item.sortOrder),
          }
        : BLANK,
    );
    setErrors({});
    setFormError(null);
  }, [open, item]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: values.name.trim(),
        description: values.description.trim() || undefined,
        price: Number(values.price),
        sortOrder: Number(values.sortOrder) || 0,
      };
      return item
        ? api.patch<LunchMenuItemRecord>(`/lunch/menu-items/${item.id}`, body)
        : api.post<LunchMenuItemRecord>('/lunch/menu-items', body);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['lunch'] });
      toast.success(item ? `${saved.name} updated.` : `${saved.name} added to the menu.`);
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        setErrors(
          Object.fromEntries(
            Object.entries(error.details).map(([field, messages]) => [field, messages[0] ?? '']),
          ),
        );
        return;
      }
      setFormError(errorMessage(error));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{item ? `Edit ${item.name}` : 'Add a menu item'}</DialogTitle>
          <DialogDescription>
            A price change applies to new orders only. Orders already placed keep the price they
            were placed at.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {formError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive">
              {formError}
            </p>
          ) : null}

          <FormField label="Name" htmlFor="menu-name" error={errors.name} required>
            <Input
              id="menu-name"
              value={values.name}
              maxLength={120}
              onChange={(event) => setValues((prev) => ({ ...prev, name: event.target.value }))}
            />
          </FormField>

          <FormField label="Description" htmlFor="menu-description" error={errors.description}>
            <Input
              id="menu-description"
              value={values.description}
              maxLength={300}
              onChange={(event) =>
                setValues((prev) => ({ ...prev, description: event.target.value }))
              }
            />
          </FormField>

          <FormField
            label={`Price (${currency})`}
            htmlFor="menu-price"
            error={errors.price}
            required
          >
            <Input
              id="menu-price"
              type="number"
              min={0}
              step="0.01"
              value={values.price}
              onChange={(event) => setValues((prev) => ({ ...prev, price: event.target.value }))}
            />
          </FormField>

          <FormField
            label="Display order"
            htmlFor="menu-sort"
            hint="Lower numbers come first on the order form."
            error={errors.sortOrder}
          >
            <Input
              id="menu-sort"
              type="number"
              min={0}
              value={values.sortOrder}
              onChange={(event) =>
                setValues((prev) => ({ ...prev, sortOrder: event.target.value }))
              }
            />
          </FormField>
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={values.name.trim() === '' || values.price === '' || save.isPending}
            onClick={() => {
              setErrors({});
              setFormError(null);
              save.mutate();
            }}
          >
            {save.isPending ? 'Saving…' : item ? 'Save changes' : 'Add item'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
