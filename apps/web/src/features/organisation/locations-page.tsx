import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  PERMISSIONS,
  type LocationInput,
  type LocationRecord,
  locationInputSchema,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { LOOKUPS_QUERY_KEY } from '@/lib/lookups';
import { useDebounced } from '@/lib/use-debounced';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { SortableTH, TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { usePermissions } from '@/features/auth/session-context';

const INITIAL = { q: '', isActive: '', page: 1, limit: 20, sort: 'name', order: 'asc' as 'asc' | 'desc' };

export function LocationsPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.LOCATION_MANAGE);
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [filters, setFilters] = React.useState(INITIAL);
  const [editing, setEditing] = React.useState<LocationRecord | null>(null);
  const [creating, setCreating] = React.useState(false);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['locations', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<LocationRecord>('/locations', {
        query: {
          page: filters.page,
          limit: filters.limit,
          sort: filters.sort,
          order: filters.order,
          q: debouncedQuery || undefined,
          isActive: filters.isActive || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/locations/${id}`),
    onSuccess: async () => {
      toast.success('Location deleted.');
      await queryClient.invalidateQueries({ queryKey: ['locations'] });
      await queryClient.invalidateQueries({ queryKey: LOOKUPS_QUERY_KEY });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const handleDelete = async (row: LocationRecord) => {
    const ok = await confirm({
      title: `Delete ${row.name}?`,
      description:
        'This cannot be undone. Locations with employees assigned cannot be deleted.',
      confirmLabel: 'Delete',
      tone: 'destructive',
    });
    if (ok) remove.mutate(row.id);
  };

  const handleSort = (field: string) =>
    update({ sort: field, order: filters.sort === field && filters.order === 'asc' ? 'desc' : 'asc' });

  const hasFilters = filters.q !== '' || filters.isActive !== '';
  const rows = query.data?.data ?? [];

  return (
    <>
      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search locations"
          hasActiveFilters={hasFilters}
          onReset={() => setFilters(INITIAL)}
          filters={
            <NativeSelect
              value={filters.isActive}
              onChange={(event) => update({ isActive: event.target.value })}
              aria-label="Filter by status"
              className="w-36"
            >
              <option value="">All statuses</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </NativeSelect>
          }
          actions={
            canManage ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus />
                New location
              </Button>
            ) : null
          }
        />

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <SortableTH field="name" activeField={filters.sort} order={filters.order} onSort={handleSort}>
                      Location
                    </SortableTH>
                    <SortableTH field="city" activeField={filters.sort} order={filters.order} onSort={handleSort}>
                      City
                    </SortableTH>
                    <TH>Country</TH>
                    <TH className="w-32">Time zone</TH>
                    <TH className="w-24 text-right">People</TH>
                    <TH className="w-28">Status</TH>
                    {canManage ? <TH className="w-24 text-right">Actions</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={5} columns={canManage ? 7 : 6} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={canManage ? 7 : 6} className="p-0">
                        <EmptyState
                          icon={MapPin}
                          title={hasFilters ? 'No locations match your filters' : 'No locations yet'}
                          description="Work locations drive holiday calendars, shifts and attendance policies in later phases."
                          action={
                            canManage && !hasFilters ? (
                              <Button size="sm" onClick={() => setCreating(true)}>
                                <Plus />
                                New location
                              </Button>
                            ) : null
                          }
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR key={row.id}>
                        <TD>
                          <p className="text-[13.5px] font-medium">{row.name}</p>
                          {row.addressLine1 ? (
                            <p className="truncate text-[12px] text-muted-foreground">{row.addressLine1}</p>
                          ) : null}
                        </TD>
                        <TD className="text-[13px]">{row.city ?? '--'}</TD>
                        <TD className="text-[13px]">{row.country ?? '--'}</TD>
                        <TD className="text-[13px] text-muted-foreground">{row.timezone ?? '--'}</TD>
                        <TD className="tabular text-right text-[13px]">{row.employeeCount}</TD>
                        <TD>
                          <Badge variant={row.isActive ? 'success' : 'neutral'}>
                            {row.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </TD>
                        {canManage ? (
                          <TD>
                            <div className="flex justify-end gap-1">
                              <Button variant="ghost" size="icon-sm" aria-label={`Edit ${row.name}`} onClick={() => setEditing(row)}>
                                <Pencil />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Delete ${row.name}`}
                                className="text-destructive hover:bg-destructive-soft"
                                onClick={() => void handleDelete(row)}
                              >
                                <Trash2 />
                              </Button>
                            </div>
                          </TD>
                        ) : null}
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>

            {query.data ? (
              <Pagination
                meta={query.data.meta}
                disabled={query.isFetching}
                onPageChange={(page) => update({ page })}
                onLimitChange={(limit) => update({ limit })}
              />
            ) : null}
          </>
        )}
      </Card>

      <LocationDrawer
        open={creating || editing !== null}
        location={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </>
  );
}

function LocationDrawer({
  open,
  location,
  onClose,
}: {
  open: boolean;
  location: LocationRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = location !== null;

  const { register, handleSubmit, formState, reset, setError } = useForm<LocationInput>({
    resolver: zodResolver(locationInputSchema),
    values: {
      name: location?.name ?? '',
      code: location?.code ?? '',
      addressLine1: location?.addressLine1 ?? '',
      addressLine2: location?.addressLine2 ?? '',
      city: location?.city ?? '',
      state: location?.state ?? '',
      postalCode: location?.postalCode ?? '',
      country: location?.country ?? '',
      timezone: location?.timezone ?? '',
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      geofenceRadiusMeters: location?.geofenceRadiusMeters ?? null,
      isActive: location?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: (values: LocationInput) =>
      isEdit ? api.patch(`/locations/${location.id}`, values) : api.post('/locations', values),
    onSuccess: async () => {
      toast.success(isEdit ? 'Location updated.' : 'Location created.');
      await queryClient.invalidateQueries({ queryKey: ['locations'] });
      await queryClient.invalidateQueries({ queryKey: LOOKUPS_QUERY_KEY });
      reset();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof LocationInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="md">
        <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="contents">
          <DialogHeader>
            <DialogTitle>{isEdit ? `Edit ${location.name}` : 'New location'}</DialogTitle>
            <DialogDescription>A physical or virtual place where people work.</DialogDescription>
          </DialogHeader>

          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <FormField label="Name" htmlFor="loc-name" error={formState.errors.name?.message} required className="sm:col-span-2">
              <Input {...register('name')} autoFocus />
            </FormField>
            <FormField label="Code" htmlFor="loc-code" error={formState.errors.code?.message}>
              <Input {...register('code')} />
            </FormField>
            <FormField label="Time zone" htmlFor="loc-timezone" error={formState.errors.timezone?.message} hint="e.g. Asia/Karachi">
              <Input {...register('timezone')} />
            </FormField>
            <div className="sm:col-span-2 border-t border-border pt-4">
              <p className="text-[13px] font-medium">Check-in geofence</p>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                Optional, and only consulted when the company turns on check-in location
                restriction in the attendance policy. Leave blank if this site is not geofenced.
              </p>
            </div>
            <FormField
              label="Latitude"
              htmlFor="loc-lat"
              error={formState.errors.latitude?.message}
              hint="Decimal degrees, e.g. 24.8607"
            >
              <Input type="number" step="any" {...register('latitude')} />
            </FormField>
            <FormField
              label="Longitude"
              htmlFor="loc-lng"
              error={formState.errors.longitude?.message}
              hint="Decimal degrees, e.g. 67.0011"
            >
              <Input type="number" step="any" {...register('longitude')} />
            </FormField>
            <FormField
              label="Radius (metres)"
              htmlFor="loc-radius"
              error={formState.errors.geofenceRadiusMeters?.message}
              hint="Blank uses the company default."
              className="sm:col-span-2"
            >
              <Input type="number" min={10} {...register('geofenceRadiusMeters')} />
            </FormField>

            <FormField label="Address line 1" htmlFor="loc-address1" error={formState.errors.addressLine1?.message} className="sm:col-span-2">
              <Input {...register('addressLine1')} />
            </FormField>
            <FormField label="Address line 2" htmlFor="loc-address2" error={formState.errors.addressLine2?.message} className="sm:col-span-2">
              <Input {...register('addressLine2')} />
            </FormField>
            <FormField label="City" htmlFor="loc-city" error={formState.errors.city?.message}>
              <Input {...register('city')} />
            </FormField>
            <FormField label="State or region" htmlFor="loc-state" error={formState.errors.state?.message}>
              <Input {...register('state')} />
            </FormField>
            <FormField label="Postal code" htmlFor="loc-postal" error={formState.errors.postalCode?.message}>
              <Input {...register('postalCode')} />
            </FormField>
            <FormField label="Country" htmlFor="loc-country" error={formState.errors.country?.message}>
              <Input {...register('country')} />
            </FormField>
            <label className="flex cursor-pointer items-center gap-2.5 text-[13px] sm:col-span-2">
              <input type="checkbox" className="size-4 rounded border-input accent-[var(--primary)]" {...register('isActive')} />
              Active
            </label>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isEdit ? 'Save changes' : 'Create location'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
