import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Pencil, Plane, Plus, Trash2 } from 'lucide-react';
import {
  PERMISSIONS,
  type LeaveTypeInput,
  type LeaveTypeRecord,
  leaveTypeInputSchema,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
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

const INITIAL = { q: '', isActive: '', page: 1, limit: 20 };
const days = (n: number) => `${n % 1 === 0 ? n : n.toFixed(1)}`;

export function LeaveTypesPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.LEAVE_MANAGE);
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [filters, setFilters] = React.useState(INITIAL);
  const [editing, setEditing] = React.useState<LeaveTypeRecord | null>(null);
  const [creating, setCreating] = React.useState(false);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['leave-types', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<LeaveTypeRecord>('/leave-types', {
        query: {
          page: filters.page,
          limit: filters.limit,
          q: debouncedQuery || undefined,
          isActive: filters.isActive || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/leave-types/${id}`),
    onSuccess: async () => {
      toast.success('Leave type deleted.');
      await queryClient.invalidateQueries({ queryKey: ['leave-types'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const handleDelete = async (row: LeaveTypeRecord) => {
    const ok = await confirm({
      title: `Delete ${row.name}?`,
      description:
        'Types already used by a leave request cannot be deleted - deactivate them instead so history is kept.',
      confirmLabel: 'Delete',
      tone: 'destructive',
    });
    if (ok) remove.mutate(row.id);
  };

  const rows = query.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Leave types"
        description="Entitlement, monthly accrual and carry-forward rules. Every balance is calculated from these."
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              New leave type
            </Button>
          ) : null
        }
      />

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search leave types"
          hasActiveFilters={filters.q !== '' || filters.isActive !== ''}
          onReset={() => setFilters(INITIAL)}
          filters={
            <NativeSelect
              value={filters.isActive}
              onChange={(e) => update({ isActive: e.target.value })}
              aria-label="Filter by status"
              className="w-36"
            >
              <option value="">All statuses</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </NativeSelect>
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
                    <TH>Leave type</TH>
                    <TH className="w-24">Code</TH>
                    <TH className="w-28 text-right">Annual</TH>
                    <TH className="w-28 text-right">Monthly</TH>
                    <TH className="w-36">Carry forward</TH>
                    <TH className="w-24">Paid</TH>
                    <TH className="w-24 text-right">Used by</TH>
                    <TH className="w-28">Status</TH>
                    {canManage ? <TH className="w-24 text-right">Actions</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={4} columns={canManage ? 9 : 8} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={canManage ? 9 : 8} className="p-0">
                        <EmptyState
                          icon={Plane}
                          title="No leave types yet"
                          description="Define the leave your organisation offers, with its entitlement and accrual."
                          action={
                            canManage ? (
                              <Button size="sm" onClick={() => setCreating(true)}>
                                <Plus />
                                New leave type
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
                          {row.description ? (
                            <p className="truncate text-[12px] text-muted-foreground">{row.description}</p>
                          ) : null}
                        </TD>
                        <TD className="font-mono text-[12.5px] text-muted-foreground">{row.code ?? '--'}</TD>
                        <TD className="tabular text-right text-[13px]">{days(row.annualEntitlementDays)}</TD>
                        <TD className="tabular text-right text-[13px]">{days(row.monthlyAccrualDays)}</TD>
                        <TD className="text-[13px]">
                          {row.carryForwardEnabled
                            ? row.carryForwardCapDays === null
                              ? 'Uncapped'
                              : `Up to ${days(row.carryForwardCapDays)} days`
                            : 'Not allowed'}
                        </TD>
                        <TD>
                          <Badge variant={row.isPaid ? 'primary' : 'neutral'}>
                            {row.isPaid ? 'Paid' : 'Unpaid'}
                          </Badge>
                        </TD>
                        <TD className="tabular text-right text-[13px]">{row.requestCount}</TD>
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

      <LeaveTypeDrawer
        open={creating || editing !== null}
        leaveType={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </>
  );
}

function LeaveTypeDrawer({
  open,
  leaveType,
  onClose,
}: {
  open: boolean;
  leaveType: LeaveTypeRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = leaveType !== null;

  const { register, handleSubmit, formState, reset, setError, watch } = useForm<LeaveTypeInput>({
    resolver: zodResolver(leaveTypeInputSchema),
    values: {
      name: leaveType?.name ?? '',
      code: leaveType?.code ?? '',
      description: leaveType?.description ?? '',
      annualEntitlementDays: leaveType?.annualEntitlementDays ?? 12,
      monthlyAccrualDays: leaveType?.monthlyAccrualDays ?? 1,
      carryForwardEnabled: leaveType?.carryForwardEnabled ?? false,
      carryForwardCapDays: leaveType?.carryForwardCapDays ?? null,
      isPaid: leaveType?.isPaid ?? true,
      isActive: leaveType?.isActive ?? true,
    },
  });

  const carryForward = watch('carryForwardEnabled');

  const mutation = useMutation({
    mutationFn: (values: LeaveTypeInput) =>
      isEdit ? api.patch(`/leave-types/${leaveType.id}`, values) : api.post('/leave-types', values),
    onSuccess: async () => {
      toast.success(isEdit ? 'Leave type updated.' : 'Leave type created.');
      await queryClient.invalidateQueries({ queryKey: ['leave-types'] });
      await queryClient.invalidateQueries({ queryKey: ['leave'] });
      reset();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof LeaveTypeInput, { message: messages[0] });
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
            <DialogTitle>{isEdit ? `Edit ${leaveType.name}` : 'New leave type'}</DialogTitle>
            <DialogDescription>
              These figures drive every balance calculation - nothing is hard-coded.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <FormField label="Name" htmlFor="lt-name" error={formState.errors.name?.message} required className="sm:col-span-2">
              <Input {...register('name')} autoFocus />
            </FormField>
            <FormField label="Code" htmlFor="lt-code" error={formState.errors.code?.message}>
              <Input {...register('code')} />
            </FormField>
            <FormField label="Annual entitlement (days)" htmlFor="lt-annual" error={formState.errors.annualEntitlementDays?.message} required>
              <Input type="number" min={0} step="0.5" {...register('annualEntitlementDays')} />
            </FormField>
            <FormField
              label="Monthly accrual (days)"
              htmlFor="lt-monthly"
              error={formState.errors.monthlyAccrualDays?.message}
              hint="Accrual stops once the annual entitlement is reached."
              required
            >
              <Input type="number" min={0} step="0.5" {...register('monthlyAccrualDays')} />
            </FormField>
            <FormField
              label="Carry-forward cap (days)"
              htmlFor="lt-cap"
              error={formState.errors.carryForwardCapDays?.message}
              hint={carryForward ? 'Leave blank for uncapped.' : 'Enable carry-forward to set a cap.'}
            >
              <Input type="number" min={0} step="0.5" disabled={!carryForward} {...register('carryForwardCapDays')} />
            </FormField>
            <FormField label="Description" htmlFor="lt-description" error={formState.errors.description?.message} className="sm:col-span-2">
              <Textarea rows={2} {...register('description')} />
            </FormField>

            <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
              <input type="checkbox" className="size-4 rounded border-input accent-[var(--primary)]" {...register('carryForwardEnabled')} />
              Allow carry-forward
            </label>
            <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
              <input type="checkbox" className="size-4 rounded border-input accent-[var(--primary)]" {...register('isPaid')} />
              Paid leave
            </label>
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
              {isEdit ? 'Save changes' : 'Create leave type'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
