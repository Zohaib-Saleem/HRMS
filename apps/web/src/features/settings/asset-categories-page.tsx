import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Boxes, Plus } from 'lucide-react';
import type { AssetCategoryRecord } from '@hrms/shared';
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
import { ASSET_CATEGORIES_QUERY_KEY, useAssetCategories } from '@/features/assets/use-asset-data';

/**
 * Asset management: the category catalogue.
 *
 * Company configuration, alongside the other settings screens, and the one
 * thing worth saying on it is said on it: categories are RETIRED, never
 * deleted. Assets point at them, so removing a category would either orphan
 * every asset filed under it or refuse for exactly the categories somebody
 * wanted rid of. Retiring takes it off the create form and leaves last year's
 * report adding up.
 *
 * Two levels, and the second is not decoration: the GROUP is what a report is
 * grouped by ("what are we spending on IT kit") and the TYPE under it is what
 * somebody picks on the asset form ("Laptop"). An asset may be filed against
 * either, so a company that only wants "Vehicles" is not made to invent a child
 * row it will never use.
 *
 * Retired rows are shown rather than hidden, because this is the only screen
 * from which one can be brought back - and a company that cannot see the
 * retired "Fax Machine" creates a second one called "Fax machine".
 */

interface DraftTarget {
  /** Editing an existing row, or null when creating. */
  category: AssetCategoryRecord | null;
  /** The group a new type is created under. Null creates a group. */
  parent: AssetCategoryRecord | null;
}

export function AssetCategoriesPage() {
  const queryClient = useQueryClient();
  const { categories, isLoading, error } = useAssetCategories();
  const [draft, setDraft] = React.useState<DraftTarget | null>(null);

  const retire = useMutation({
    mutationFn: (category: AssetCategoryRecord) =>
      api.patch<AssetCategoryRecord>(`/assets/categories/${category.id}`, {
        isActive: !category.isActive,
      }),
    onSuccess: (category) => {
      void queryClient.invalidateQueries({ queryKey: ASSET_CATEGORIES_QUERY_KEY });
      toast.success(category.isActive ? `${category.name} is back.` : `${category.name} retired.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  /** Groups and their types, flattened into rows the table can render in order. */
  const rows = React.useMemo(
    () =>
      categories.flatMap((group) => [
        { category: group, parent: null as AssetCategoryRecord | null },
        ...group.children.map((child) => ({ category: child, parent: group })),
      ]),
    [categories],
  );

  return (
    <>
      <PageHeader
        title="Asset management"
        description="The categories assets are filed under. Retired, never deleted — assets point at these."
        actions={
          <Button size="sm" onClick={() => setDraft({ category: null, parent: null })}>
            <Plus className="size-4" aria-hidden />
            Add group
          </Button>
        }
      />

      <Card>
        <TableWrapper>
          <Table>
            <THead>
              <TR>
                <TH>Category</TH>
                <TH className="text-right">Assets</TH>
                <TH>Order</TH>
                <TH>In use</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {isLoading ? (
                <TableSkeleton rows={6} columns={5} />
              ) : error ? (
                <TR>
                  <TD colSpan={5}>
                    <ErrorState
                      error={error}
                      onRetry={() =>
                        void queryClient.invalidateQueries({ queryKey: ASSET_CATEGORIES_QUERY_KEY })
                      }
                    />
                  </TD>
                </TR>
              ) : rows.length === 0 ? (
                <TR>
                  <TD colSpan={5}>
                    <EmptyState
                      icon={Boxes}
                      title="No categories yet"
                      description="Add a group — IT Equipment, Vehicles — and the types that go under it."
                      action={
                        <Button size="sm" onClick={() => setDraft({ category: null, parent: null })}>
                          Add group
                        </Button>
                      }
                    />
                  </TD>
                </TR>
              ) : (
                rows.map(({ category, parent }) => (
                  <TR key={category.id}>
                    <TD>
                      <p className={parent ? 'pl-6 text-[13.5px]' : 'font-medium'}>
                        {category.name}
                      </p>
                      {category.description ? (
                        <p
                          className={
                            parent
                              ? 'pl-6 text-xs text-muted-foreground'
                              : 'text-xs text-muted-foreground'
                          }
                        >
                          {category.description}
                        </p>
                      ) : null}
                    </TD>
                    <TD className="tabular text-right text-[13px]">{category.assetCount}</TD>
                    <TD className="tabular text-muted-foreground">{category.sortOrder}</TD>
                    <TD>
                      <Badge variant={category.isActive ? 'success' : 'neutral'}>
                        {category.isActive ? 'In use' : 'Retired'}
                      </Badge>
                    </TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-2">
                        {parent ? null : (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDraft({ category: null, parent: category })}
                          >
                            Add type
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDraft({ category, parent })}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={retire.isPending}
                          onClick={() => retire.mutate(category)}
                        >
                          {category.isActive ? 'Retire' : 'Restore'}
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

      <CategoryDialog open={draft !== null} draft={draft} onClose={() => setDraft(null)} />
    </>
  );
}

/** Adding a group, adding a type under one, or renaming either. One shape. */
function CategoryDialog({
  open,
  draft,
  onClose,
}: {
  open: boolean;
  draft: DraftTarget | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [sortOrder, setSortOrder] = React.useState('0');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  const category = draft?.category ?? null;
  const parent = draft?.parent ?? null;

  React.useEffect(() => {
    if (!open) return;
    setName(category?.name ?? '');
    setDescription(category?.description ?? '');
    setSortOrder(String(category?.sortOrder ?? 0));
    setErrors({});
    setFormError(null);
  }, [open, category]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        sortOrder: Number(sortOrder) || 0,
      };
      return category
        ? api.patch<AssetCategoryRecord>(`/assets/categories/${category.id}`, body)
        : api.post<AssetCategoryRecord>('/assets/categories', {
            ...body,
            // Creating a type under a group; null creates a group.
            parentCategoryId: parent?.id ?? null,
          });
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ASSET_CATEGORIES_QUERY_KEY });
      toast.success(category ? `${saved.name} updated.` : `${saved.name} added.`);
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

  const title = category
    ? `Edit ${category.name}`
    : parent
      ? `Add a type under ${parent.name}`
      : 'Add a category group';

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Categories are retired rather than deleted, because assets point at them. Renaming one
            renames it everywhere, including on assets already filed under it.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {formError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive">
              {formError}
            </p>
          ) : null}

          <FormField label="Name" htmlFor="asset-category-name" error={errors.name} required>
            <Input
              id="asset-category-name"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          </FormField>

          <FormField
            label="Description"
            htmlFor="asset-category-description"
            error={errors.description}
          >
            <Input
              id="asset-category-description"
              value={description}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
            />
          </FormField>

          <FormField
            label="Display order"
            htmlFor="asset-category-sort"
            hint="Lower numbers come first on the asset form."
            error={errors.sortOrder}
          >
            <Input
              id="asset-category-sort"
              type="number"
              min={0}
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </FormField>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving...' : category ? 'Save changes' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
