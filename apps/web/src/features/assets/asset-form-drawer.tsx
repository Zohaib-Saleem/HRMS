import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ASSET_CONDITIONS,
  ASSET_CONDITION_LABELS,
  ASSET_STATUSES,
  ASSET_STATUS_LABELS,
  isAssignmentDrivenStatus,
  type AssetRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
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
import { useAssetCategories } from './use-asset-data';
import { categoryOptions } from './assets-shared';

/**
 * Adding an asset, or correcting one. One form, because they are one shape.
 *
 * Four fields are required - the tag, the name, the category and nothing else -
 * and the rest is optional on purpose. An asset arrives on somebody's desk long
 * before the invoice and the warranty paperwork catch up, and a form that
 * insists on a purchase price is a form people work around by typing a zero.
 *
 * Note which statuses are absent from the dropdown: ASSIGNED and RETURNED. An
 * asset becomes assigned by being assigned to somebody, which writes the row
 * that says whose desk it is on; offering it here would let somebody mark a
 * laptop as being with a person this system cannot name. The server refuses it
 * too - this dropdown just does not pretend otherwise.
 */

interface DraftValues {
  assetTag: string;
  name: string;
  categoryId: string;
  brand: string;
  model: string;
  serialNumber: string;
  purchaseDate: string;
  purchasePrice: string;
  currentValue: string;
  vendor: string;
  warrantyStart: string;
  warrantyEnd: string;
  locationId: string;
  location: string;
  departmentId: string;
  condition: string;
  status: string;
  notes: string;
}

const BLANK: DraftValues = {
  assetTag: '',
  name: '',
  categoryId: '',
  brand: '',
  model: '',
  serialNumber: '',
  purchaseDate: '',
  purchasePrice: '',
  currentValue: '',
  vendor: '',
  warrantyStart: '',
  warrantyEnd: '',
  locationId: '',
  location: '',
  departmentId: '',
  condition: 'GOOD',
  status: 'AVAILABLE',
  notes: '',
};

/** Blank means "not stated", which is a null rather than an empty string. */
const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));

export function AssetFormDrawer({
  open,
  asset,
  onClose,
}: {
  open: boolean;
  asset: AssetRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { lookups } = useLookups();
  const { categories } = useAssetCategories();

  const [values, setValues] = React.useState<DraftValues>(BLANK);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  const options = React.useMemo(() => categoryOptions(categories), [categories]);

  React.useEffect(() => {
    if (!open) return;
    setValues(
      asset
        ? {
            assetTag: asset.assetTag,
            name: asset.name,
            categoryId: asset.category?.id ?? '',
            brand: asset.brand ?? '',
            model: asset.model ?? '',
            serialNumber: asset.serialNumber ?? '',
            purchaseDate: asset.purchaseDate ?? '',
            purchasePrice: asset.purchasePrice === null ? '' : String(asset.purchasePrice),
            currentValue: asset.currentValue === null ? '' : String(asset.currentValue),
            vendor: asset.vendor ?? '',
            warrantyStart: asset.warrantyStart ?? '',
            warrantyEnd: asset.warrantyEnd ?? '',
            locationId: asset.site?.id ?? '',
            location: asset.location ?? '',
            departmentId: asset.department?.id ?? '',
            condition: asset.condition,
            status: asset.status,
            notes: asset.notes ?? '',
          }
        : BLANK,
    );
    setErrors({});
    setFormError(null);
  }, [open, asset]);

  const set = (patch: Partial<DraftValues>) => setValues((prev) => ({ ...prev, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        assetTag: values.assetTag.trim(),
        name: values.name.trim(),
        categoryId: values.categoryId,
        brand: orNull(values.brand),
        model: orNull(values.model),
        serialNumber: orNull(values.serialNumber),
        purchaseDate: orNull(values.purchaseDate),
        purchasePrice: numberOrNull(values.purchasePrice),
        currentValue: numberOrNull(values.currentValue),
        vendor: orNull(values.vendor),
        warrantyStart: orNull(values.warrantyStart),
        warrantyEnd: orNull(values.warrantyEnd),
        locationId: orNull(values.locationId),
        location: orNull(values.location),
        departmentId: orNull(values.departmentId),
        condition: values.condition,
        notes: orNull(values.notes),
        /*
         * The status rides along only when it is one somebody may set here.
         * An asset that is currently ASSIGNED keeps that status through an
         * ordinary edit rather than having it sent back and refused.
         */
        ...(isAssignmentDrivenStatus(values.status as never) ? {} : { status: values.status }),
      };

      return asset
        ? api.patch<AssetRecord>(`/assets/${asset.id}`, body)
        : api.post<AssetRecord>('/assets', body);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      toast.success(asset ? `${saved.assetTag} updated.` : `${saved.assetTag} added.`);
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{asset ? `Edit ${asset.assetTag}` : 'Add an asset'}</DialogTitle>
          <DialogDescription>
            The tag, a name and a category are all that is needed. Everything else can be filled
            in when the paperwork catches up.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {formError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive">
              {formError}
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="Asset tag"
              htmlFor="asset-tag"
              hint="What is on the sticker, e.g. IT-LAP-0042."
              error={errors.assetTag}
              required
            >
              <Input
                id="asset-tag"
                value={values.assetTag}
                maxLength={40}
                onChange={(event) => set({ assetTag: event.target.value })}
              />
            </FormField>

            <FormField label="Name" htmlFor="asset-name" error={errors.name} required>
              <Input
                id="asset-name"
                value={values.name}
                maxLength={160}
                onChange={(event) => set({ name: event.target.value })}
              />
            </FormField>

            <FormField
              label="Category"
              htmlFor="asset-category"
              error={errors.categoryId}
              required
            >
              <NativeSelect
                id="asset-category"
                value={values.categoryId}
                onChange={(event) => set({ categoryId: event.target.value })}
              >
                <option value="">Choose a category</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField
              label="Serial number"
              htmlFor="asset-serial"
              hint="Optional. Must be unique when given."
              error={errors.serialNumber}
            >
              <Input
                id="asset-serial"
                value={values.serialNumber}
                maxLength={120}
                onChange={(event) => set({ serialNumber: event.target.value })}
              />
            </FormField>

            <FormField label="Brand" htmlFor="asset-brand" error={errors.brand}>
              <Input
                id="asset-brand"
                value={values.brand}
                maxLength={80}
                onChange={(event) => set({ brand: event.target.value })}
              />
            </FormField>

            <FormField label="Model" htmlFor="asset-model" error={errors.model}>
              <Input
                id="asset-model"
                value={values.model}
                maxLength={80}
                onChange={(event) => set({ model: event.target.value })}
              />
            </FormField>

            <FormField label="Purchase date" htmlFor="asset-purchased" error={errors.purchaseDate}>
              <Input
                id="asset-purchased"
                type="date"
                value={values.purchaseDate.slice(0, 10)}
                onChange={(event) => set({ purchaseDate: event.target.value })}
              />
            </FormField>

            <FormField label="Vendor" htmlFor="asset-vendor" error={errors.vendor}>
              <Input
                id="asset-vendor"
                value={values.vendor}
                maxLength={160}
                onChange={(event) => set({ vendor: event.target.value })}
              />
            </FormField>

            <FormField
              label="Purchase price"
              htmlFor="asset-price"
              error={errors.purchasePrice}
            >
              <Input
                id="asset-price"
                type="number"
                min={0}
                step="0.01"
                value={values.purchasePrice}
                onChange={(event) => set({ purchasePrice: event.target.value })}
              />
            </FormField>

            <FormField
              label="Current value"
              htmlFor="asset-value"
              hint="What it is reckoned to be worth now. Nothing computes this."
              error={errors.currentValue}
            >
              <Input
                id="asset-value"
                type="number"
                min={0}
                step="0.01"
                value={values.currentValue}
                onChange={(event) => set({ currentValue: event.target.value })}
              />
            </FormField>

            <FormField label="Warranty starts" htmlFor="asset-warranty-start" error={errors.warrantyStart}>
              <Input
                id="asset-warranty-start"
                type="date"
                value={values.warrantyStart.slice(0, 10)}
                onChange={(event) => set({ warrantyStart: event.target.value })}
              />
            </FormField>

            <FormField label="Warranty ends" htmlFor="asset-warranty-end" error={errors.warrantyEnd}>
              <Input
                id="asset-warranty-end"
                type="date"
                value={values.warrantyEnd.slice(0, 10)}
                onChange={(event) => set({ warrantyEnd: event.target.value })}
              />
            </FormField>

            <FormField label="Office" htmlFor="asset-site" error={errors.locationId}>
              <NativeSelect
                id="asset-site"
                value={values.locationId}
                onChange={(event) => set({ locationId: event.target.value })}
              >
                <option value="">No office</option>
                {lookups.locations.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField
              label="Where it is"
              htmlFor="asset-location"
              hint="A desk, a room, a shelf."
              error={errors.location}
            >
              <Input
                id="asset-location"
                value={values.location}
                maxLength={160}
                onChange={(event) => set({ location: event.target.value })}
              />
            </FormField>

            <FormField
              label="Department"
              htmlFor="asset-department"
              hint="Which part of the company owns it. Not who is holding it."
              error={errors.departmentId}
            >
              <NativeSelect
                id="asset-department"
                value={values.departmentId}
                onChange={(event) => set({ departmentId: event.target.value })}
              >
                <option value="">No department</option>
                {lookups.departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField label="Condition" htmlFor="asset-condition" error={errors.condition}>
              <NativeSelect
                id="asset-condition"
                value={values.condition}
                onChange={(event) => set({ condition: event.target.value })}
              >
                {ASSET_CONDITIONS.map((condition) => (
                  <option key={condition} value={condition}>
                    {ASSET_CONDITION_LABELS[condition]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField
              label="Status"
              htmlFor="asset-status"
              hint="Assigning and returning are their own actions, so neither is here."
              error={errors.status}
            >
              <NativeSelect
                id="asset-status"
                value={values.status}
                disabled={isAssignmentDrivenStatus(values.status as never)}
                onChange={(event) => set({ status: event.target.value })}
              >
                {isAssignmentDrivenStatus(values.status as never) ? (
                  <option value={values.status}>
                    {ASSET_STATUS_LABELS[values.status as keyof typeof ASSET_STATUS_LABELS]}
                  </option>
                ) : null}
                {ASSET_STATUSES.filter((status) => !isAssignmentDrivenStatus(status)).map(
                  (status) => (
                    <option key={status} value={status}>
                      {ASSET_STATUS_LABELS[status]}
                    </option>
                  ),
                )}
              </NativeSelect>
            </FormField>
          </div>

          <FormField label="Notes" htmlFor="asset-notes" error={errors.notes}>
            <Textarea
              id="asset-notes"
              rows={3}
              value={values.notes}
              maxLength={4000}
              onChange={(event) => set({ notes: event.target.value })}
            />
          </FormField>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving...' : asset ? 'Save changes' : 'Add asset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
