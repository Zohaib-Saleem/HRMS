import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { CalendarHeart, Globe2, MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  PERMISSIONS,
  type HolidayInput,
  type HolidayRecord,
  holidayInputSchema,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useDebounced } from '@/lib/use-debounced';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
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

const thisYear = new Date().getUTCFullYear();
const INITIAL = { q: '', locationId: '', year: String(thisYear), page: 1, limit: 50 };

export function HolidaysPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.HOLIDAY_MANAGE);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { lookups } = useLookups();

  const [filters, setFilters] = React.useState(INITIAL);
  const [editing, setEditing] = React.useState<HolidayRecord | null>(null);
  const [creating, setCreating] = React.useState(false);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['holidays', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<HolidayRecord>('/holidays', {
        query: {
          page: filters.page,
          limit: filters.limit,
          q: debouncedQuery || undefined,
          locationId: filters.locationId || undefined,
          year: filters.year || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/holidays/${id}`),
    onSuccess: async () => {
      toast.success('Holiday deleted.');
      await queryClient.invalidateQueries({ queryKey: ['holidays'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const handleDelete = async (row: HolidayRecord) => {
    const ok = await confirm({
      title: `Delete ${row.name}?`,
      description:
        'Leave already approved keeps the day count it was granted with, so balances are unaffected.',
      confirmLabel: 'Delete',
      tone: 'destructive',
    });
    if (ok) remove.mutate(row.id);
  };

  const years = [thisYear - 1, thisYear, thisYear + 1];
  const rows = query.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Holidays"
        description={
          canManage
            ? 'Non-working days per location. Employees inherit the calendar for the location they are assigned to.'
            : 'Non-working days that apply to you: your location plus company-wide holidays.'
        }
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              New holiday
            </Button>
          ) : null
        }
      />

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search holidays"
          hasActiveFilters={filters.q !== '' || filters.locationId !== '' || filters.year !== String(thisYear)}
          onReset={() => setFilters(INITIAL)}
          filters={
            <>
              <NativeSelect
                value={filters.year}
                onChange={(e) => update({ year: e.target.value })}
                aria-label="Filter by year"
                className="w-28"
              >
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </NativeSelect>
              {canManage ? (
                <NativeSelect
                  value={filters.locationId}
                  onChange={(e) => update({ locationId: e.target.value })}
                  aria-label="Filter by location"
                  className="w-48"
                >
                  <option value="">All locations</option>
                  <option value="ALL">Company-wide only</option>
                  {lookups.locations.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </NativeSelect>
              ) : null}
            </>
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
                    <TH className="w-40">Date</TH>
                    <TH>Holiday</TH>
                    <TH>Applies to</TH>
                    <TH className="w-28">Status</TH>
                    {canManage ? <TH className="w-24 text-right">Actions</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={5} columns={canManage ? 5 : 4} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={canManage ? 5 : 4} className="p-0">
                        <EmptyState
                          icon={CalendarHeart}
                          title="No holidays for this year"
                          description="Holidays are excluded automatically when leave days are counted."
                          action={
                            canManage ? (
                              <Button size="sm" onClick={() => setCreating(true)}>
                                <Plus />
                                New holiday
                              </Button>
                            ) : null
                          }
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR key={row.id}>
                        <TD className="tabular text-[13px]">{formatDate(row.date)}</TD>
                        <TD className="text-[13.5px] font-medium">{row.name}</TD>
                        <TD>
                          <span className="inline-flex items-center gap-1.5 text-[13px]">
                            {row.locationId ? (
                              <>
                                <MapPin className="size-3.5 text-muted-foreground" aria-hidden />
                                {row.locationName}
                              </>
                            ) : (
                              <>
                                <Globe2 className="size-3.5 text-muted-foreground" aria-hidden />
                                All locations
                              </>
                            )}
                          </span>
                        </TD>
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

      <HolidayDrawer
        open={creating || editing !== null}
        holiday={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </>
  );
}

function HolidayDrawer({
  open,
  holiday,
  onClose,
}: {
  open: boolean;
  holiday: HolidayRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { lookups } = useLookups();
  const isEdit = holiday !== null;

  const { register, handleSubmit, formState, reset, setError } = useForm<HolidayInput>({
    resolver: zodResolver(holidayInputSchema),
    values: {
      name: holiday?.name ?? '',
      date: holiday?.date ?? new Date().toISOString().slice(0, 10),
      locationId: holiday?.locationId ?? '',
      isActive: holiday?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: (values: HolidayInput) =>
      isEdit ? api.patch(`/holidays/${holiday.id}`, values) : api.post('/holidays', values),
    onSuccess: async () => {
      toast.success(isEdit ? 'Holiday updated.' : 'Holiday created.');
      await queryClient.invalidateQueries({ queryKey: ['holidays'] });
      reset();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof HolidayInput, { message: messages[0] });
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
            <DialogTitle>{isEdit ? `Edit ${holiday.name}` : 'New holiday'}</DialogTitle>
            <DialogDescription>
              Leave a location unset to make the holiday apply to everyone.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <FormField label="Name" htmlFor="hol-name" error={formState.errors.name?.message} required>
              <Input {...register('name')} autoFocus />
            </FormField>
            <FormField label="Date" htmlFor="hol-date" error={formState.errors.date?.message} required>
              <Input type="date" {...register('date')} />
            </FormField>
            <FormField label="Applies to" htmlFor="hol-location" error={formState.errors.locationId?.message}>
              <NativeSelect {...register('locationId')}>
                <option value="">All locations</option>
                {lookups.locations.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </NativeSelect>
            </FormField>
            <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
              <input type="checkbox" className="size-4 rounded border-input accent-[var(--primary)]" {...register('isActive')} />
              Active
            </label>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isEdit ? 'Save changes' : 'Create holiday'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
