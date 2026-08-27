import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Building2, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  PERMISSIONS,
  type DepartmentInput,
  type DepartmentRecord,
  type Paginated,
  departmentInputSchema,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { LOOKUPS_QUERY_KEY, useLookups } from '@/lib/lookups';
import { useDebounced } from '@/lib/use-debounced';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
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

export function DepartmentsPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.DEPARTMENT_MANAGE);
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [filters, setFilters] = React.useState(INITIAL);
  const [editing, setEditing] = React.useState<DepartmentRecord | null>(null);
  const [creating, setCreating] = React.useState(false);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['departments', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<DepartmentRecord>('/departments', {
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
    mutationFn: (id: string) => api.delete(`/departments/${id}`),
    onSuccess: async () => {
      toast.success('Department deleted.');
      await queryClient.invalidateQueries({ queryKey: ['departments'] });
      await queryClient.invalidateQueries({ queryKey: LOOKUPS_QUERY_KEY });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const handleDelete = async (row: DepartmentRecord) => {
    const ok = await confirm({
      title: `Delete ${row.name}?`,
      description:
        'This cannot be undone. Departments that still have employees, teams or sub-departments cannot be deleted.',
      confirmLabel: 'Delete',
      tone: 'destructive',
    });
    if (ok) remove.mutate(row.id);
  };

  const handleSort = (field: string) =>
    update({
      sort: field,
      order: filters.sort === field && filters.order === 'asc' ? 'desc' : 'asc',
    });

  const hasFilters = filters.q !== '' || filters.isActive !== '';
  const rows = query.data?.data ?? [];

  return (
    <>
      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search departments"
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
                New department
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
                      Department
                    </SortableTH>
                    <TH className="w-32">Code</TH>
                    <TH>Parent</TH>
                    <TH>Head</TH>
                    <TH className="w-24 text-right">People</TH>
                    <TH className="w-24 text-right">Teams</TH>
                    <TH className="w-28">Status</TH>
                    {canManage ? <TH className="w-24 text-right">Actions</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={6} columns={canManage ? 8 : 7} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={canManage ? 8 : 7} className="p-0">
                        <EmptyState
                          icon={Building2}
                          title={hasFilters ? 'No departments match your filters' : 'No departments yet'}
                          description={
                            hasFilters
                              ? 'Try a different search term or clear the filters.'
                              : 'Create your first department to start building the org structure.'
                          }
                          action={
                            canManage && !hasFilters ? (
                              <Button size="sm" onClick={() => setCreating(true)}>
                                <Plus />
                                New department
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
                        <TD className="text-[13px]">{row.parentDepartmentName ?? '--'}</TD>
                        <TD className="text-[13px]">{row.headEmployeeName ?? '--'}</TD>
                        <TD className="tabular text-right text-[13px]">{row.employeeCount}</TD>
                        <TD className="tabular text-right text-[13px]">{row.teamCount}</TD>
                        <TD>
                          <Badge variant={row.isActive ? 'success' : 'neutral'}>
                            {row.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </TD>
                        {canManage ? (
                          <TD>
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Edit ${row.name}`}
                                onClick={() => setEditing(row)}
                              >
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

      <DepartmentDrawer
        open={creating || editing !== null}
        department={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </>
  );
}

function DepartmentDrawer({
  open,
  department,
  onClose,
}: {
  open: boolean;
  department: DepartmentRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { lookups } = useLookups();
  const isEdit = department !== null;

  const { register, handleSubmit, formState, reset, setError } = useForm<DepartmentInput>({
    resolver: zodResolver(departmentInputSchema),
    values: {
      name: department?.name ?? '',
      code: department?.code ?? '',
      description: department?.description ?? '',
      parentDepartmentId: department?.parentDepartmentId ?? '',
      headEmployeeId: department?.headEmployeeId ?? '',
      isActive: department?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: (values: DepartmentInput) =>
      isEdit
        ? api.patch(`/departments/${department.id}`, values)
        : api.post('/departments', values),
    onSuccess: async () => {
      toast.success(isEdit ? 'Department updated.' : 'Department created.');
      await queryClient.invalidateQueries({ queryKey: ['departments'] });
      await queryClient.invalidateQueries({ queryKey: LOOKUPS_QUERY_KEY });
      reset();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof DepartmentInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  // A department cannot be its own parent - the server enforces the full cycle
  // check, this just keeps the obvious case out of the dropdown.
  const parentOptions = lookups.departments.filter((d) => d.id !== department?.id);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="md">
        <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="contents">
          <DialogHeader>
            <DialogTitle>{isEdit ? `Edit ${department.name}` : 'New department'}</DialogTitle>
            <DialogDescription>
              Departments group teams and employees, and can nest under a parent.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <FormField label="Name" htmlFor="dept-name" error={formState.errors.name?.message} required>
              <Input {...register('name')} autoFocus />
            </FormField>

            <FormField label="Code" htmlFor="dept-code" error={formState.errors.code?.message} hint="Short identifier, e.g. ENG.">
              <Input {...register('code')} />
            </FormField>

            <FormField label="Parent department" htmlFor="dept-parent" error={formState.errors.parentDepartmentId?.message}>
              <NativeSelect {...register('parentDepartmentId')}>
                <option value="">None - top level</option>
                {parentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField label="Department head" htmlFor="dept-head" error={formState.errors.headEmployeeId?.message}>
              <NativeSelect {...register('headEmployeeId')}>
                <option value="">Not assigned</option>
                {lookups.managers.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField label="Description" htmlFor="dept-description" error={formState.errors.description?.message}>
              <Textarea {...register('description')} rows={3} />
            </FormField>

            <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
              <input
                type="checkbox"
                className="size-4 rounded border-input accent-[var(--primary)]"
                {...register('isActive')}
              />
              Active
            </label>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isEdit ? 'Save changes' : 'Create department'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type { Paginated };
