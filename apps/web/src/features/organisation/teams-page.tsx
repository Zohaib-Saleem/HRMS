import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2, Users2 } from 'lucide-react';
import { PERMISSIONS, type TeamInput, type TeamRecord, teamInputSchema } from '@hrms/shared';
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

const INITIAL = {
  q: '',
  departmentId: '',
  isActive: '',
  page: 1,
  limit: 20,
  sort: 'name',
  order: 'asc' as 'asc' | 'desc',
};

export function TeamsPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.TEAM_MANAGE);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { lookups } = useLookups();

  const [filters, setFilters] = React.useState(INITIAL);
  const [editing, setEditing] = React.useState<TeamRecord | null>(null);
  const [creating, setCreating] = React.useState(false);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['teams', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<TeamRecord>('/teams', {
        query: {
          page: filters.page,
          limit: filters.limit,
          sort: filters.sort,
          order: filters.order,
          q: debouncedQuery || undefined,
          departmentId: filters.departmentId || undefined,
          isActive: filters.isActive || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/teams/${id}`),
    onSuccess: async () => {
      toast.success('Team deleted.');
      await queryClient.invalidateQueries({ queryKey: ['teams'] });
      await queryClient.invalidateQueries({ queryKey: LOOKUPS_QUERY_KEY });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const handleDelete = async (row: TeamRecord) => {
    const ok = await confirm({
      title: `Delete ${row.name}?`,
      description: 'This cannot be undone. Teams that still have employees cannot be deleted.',
      confirmLabel: 'Delete',
      tone: 'destructive',
    });
    if (ok) remove.mutate(row.id);
  };

  const handleSort = (field: string) =>
    update({ sort: field, order: filters.sort === field && filters.order === 'asc' ? 'desc' : 'asc' });

  const hasFilters = filters.q !== '' || filters.departmentId !== '' || filters.isActive !== '';
  const rows = query.data?.data ?? [];

  return (
    <>
      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search teams"
          hasActiveFilters={hasFilters}
          onReset={() => setFilters(INITIAL)}
          filters={
            <>
              <NativeSelect
                value={filters.departmentId}
                onChange={(event) => update({ departmentId: event.target.value })}
                aria-label="Filter by department"
                className="w-48"
              >
                <option value="">All departments</option>
                {lookups.departments.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
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
            </>
          }
          actions={
            canManage ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus />
                New team
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
                      Team
                    </SortableTH>
                    <TH>Department</TH>
                    <TH>Lead</TH>
                    <TH className="w-24 text-right">People</TH>
                    <TH className="w-28">Status</TH>
                    {canManage ? <TH className="w-24 text-right">Actions</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={6} columns={canManage ? 6 : 5} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={canManage ? 6 : 5} className="p-0">
                        <EmptyState
                          icon={Users2}
                          title={hasFilters ? 'No teams match your filters' : 'No teams yet'}
                          description={
                            hasFilters
                              ? 'Try a different search term or clear the filters.'
                              : 'Teams sit inside a department and group people who work together.'
                          }
                          action={
                            canManage && !hasFilters ? (
                              <Button size="sm" onClick={() => setCreating(true)}>
                                <Plus />
                                New team
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
                        <TD className="text-[13px]">{row.departmentName}</TD>
                        <TD className="text-[13px]">{row.leadEmployeeName ?? '--'}</TD>
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

      <TeamDrawer
        open={creating || editing !== null}
        team={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </>
  );
}

function TeamDrawer({
  open,
  team,
  onClose,
}: {
  open: boolean;
  team: TeamRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { lookups } = useLookups();
  const isEdit = team !== null;

  const { register, handleSubmit, formState, reset, setError } = useForm<TeamInput>({
    resolver: zodResolver(teamInputSchema),
    values: {
      name: team?.name ?? '',
      departmentId: team?.departmentId ?? '',
      description: team?.description ?? '',
      leadEmployeeId: team?.leadEmployeeId ?? '',
      isActive: team?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: (values: TeamInput) =>
      isEdit ? api.patch(`/teams/${team.id}`, values) : api.post('/teams', values),
    onSuccess: async () => {
      toast.success(isEdit ? 'Team updated.' : 'Team created.');
      await queryClient.invalidateQueries({ queryKey: ['teams'] });
      await queryClient.invalidateQueries({ queryKey: LOOKUPS_QUERY_KEY });
      reset();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof TeamInput, { message: messages[0] });
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
            <DialogTitle>{isEdit ? `Edit ${team.name}` : 'New team'}</DialogTitle>
            <DialogDescription>Every team belongs to exactly one department.</DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <FormField label="Name" htmlFor="team-name" error={formState.errors.name?.message} required>
              <Input {...register('name')} autoFocus />
            </FormField>

            <FormField label="Department" htmlFor="team-department" error={formState.errors.departmentId?.message} required>
              <NativeSelect {...register('departmentId')}>
                <option value="">Choose a department</option>
                {lookups.departments.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField label="Team lead" htmlFor="team-lead" error={formState.errors.leadEmployeeId?.message}>
              <NativeSelect {...register('leadEmployeeId')}>
                <option value="">Not assigned</option>
                {lookups.managers.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField label="Description" htmlFor="team-description" error={formState.errors.description?.message}>
              <Textarea {...register('description')} rows={3} />
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
              {isEdit ? 'Save changes' : 'Create team'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
