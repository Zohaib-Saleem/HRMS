import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Clock, Pencil, Plus, Repeat } from 'lucide-react';
import {
  PERMISSIONS,
  type ShiftChangeRequestInput,
  type ShiftInput,
  type ShiftRecord,
  shiftChangeRequestSchema,
  shiftInputSchema,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
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
import { Can, usePermissions } from '@/features/auth/session-context';
import { useDebounced } from '@/lib/use-debounced';
import { useLookups, LOOKUPS_QUERY_KEY } from '@/lib/lookups';
import { formatDate } from '@/lib/utils';
import { CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState as EmptyStateAlias } from '@/components/feedback/states';
import type { ShiftAssignmentRecord, ShiftAssignmentInput } from '@hrms/shared';
import { shiftAssignmentSchema } from '@hrms/shared';

const INITIAL = { q: '', page: 1, limit: 20 };

export function ShiftsPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.SHIFT_MANAGE);
  const [filters, setFilters] = React.useState(INITIAL);
  const [editing, setEditing] = React.useState<ShiftRecord | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [requesting, setRequesting] = React.useState(false);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['shifts', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<ShiftRecord>('/shifts', {
        query: { page: filters.page, limit: filters.limit, q: debouncedQuery || undefined },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Shifts"
        description="Working patterns employees can be assigned to. Changing your own shift goes through approval."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setRequesting(true)}>
              <Repeat />
              Request change
            </Button>
            <Can permission={PERMISSIONS.SHIFT_MANAGE}>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus />
                New shift
              </Button>
            </Can>
          </>
        }
      />

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search shifts"
          hasActiveFilters={filters.q !== ''}
          onReset={() => setFilters(INITIAL)}
        />

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Shift</TH>
                    <TH className="w-28">Code</TH>
                    <TH className="w-40">Hours</TH>
                    <TH className="w-28 text-right">Break</TH>
                    <TH className="w-28 text-right">Assigned</TH>
                    <TH className="w-28">Status</TH>
                    {canManage ? <TH className="w-20 text-right">Actions</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={4} columns={canManage ? 7 : 6} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={canManage ? 7 : 6} className="p-0">
                        <EmptyState
                          icon={Clock}
                          title="No shifts yet"
                          description="Define the working patterns your organisation uses."
                          action={
                            canManage ? (
                              <Button size="sm" onClick={() => setCreating(true)}>
                                <Plus />
                                New shift
                              </Button>
                            ) : null
                          }
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR key={row.id}>
                        <TD className="text-[13.5px] font-medium">{row.name}</TD>
                        <TD className="font-mono text-[12.5px] text-muted-foreground">{row.code ?? '--'}</TD>
                        <TD className="tabular text-[13px]">
                          {row.startTime} – {row.endTime}
                        </TD>
                        <TD className="tabular text-right text-[13px] text-muted-foreground">
                          {row.breakMinutes}m
                        </TD>
                        <TD className="tabular text-right text-[13px]">{row.assignedCount}</TD>
                        <TD>
                          <Badge variant={row.isActive ? 'success' : 'neutral'}>
                            {row.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </TD>
                        {canManage ? (
                          <TD>
                            <div className="flex justify-end">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Edit ${row.name}`}
                                onClick={() => setEditing(row)}
                              >
                                <Pencil />
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

      <ShiftAssignments canManage={canManage} />

      <ShiftDrawer
        open={creating || editing !== null}
        shift={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      <ShiftChangeDrawer
        open={requesting}
        shifts={rows}
        onClose={() => setRequesting(false)}
      />
    </>
  );
}

function ShiftDrawer({
  open,
  shift,
  onClose,
}: {
  open: boolean;
  shift: ShiftRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = shift !== null;

  const { register, handleSubmit, formState, reset, setError } = useForm<ShiftInput>({
    resolver: zodResolver(shiftInputSchema),
    values: {
      name: shift?.name ?? '',
      code: shift?.code ?? '',
      startTime: shift?.startTime ?? '09:00',
      endTime: shift?.endTime ?? '18:00',
      breakMinutes: shift?.breakMinutes ?? 60,
      isActive: shift?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: (values: ShiftInput) =>
      isEdit ? api.patch(`/shifts/${shift.id}`, values) : api.post('/shifts', values),
    onSuccess: async () => {
      toast.success(isEdit ? 'Shift updated.' : 'Shift created.');
      await queryClient.invalidateQueries({ queryKey: ['shifts'] });
      reset();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof ShiftInput, { message: messages[0] });
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
            <DialogTitle>{isEdit ? `Edit ${shift.name}` : 'New shift'}</DialogTitle>
            <DialogDescription>Times are local to the employee’s work location.</DialogDescription>
          </DialogHeader>

          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <FormField label="Name" htmlFor="shift-name" error={formState.errors.name?.message} required className="sm:col-span-2">
              <Input {...register('name')} autoFocus />
            </FormField>
            <FormField label="Code" htmlFor="shift-code" error={formState.errors.code?.message}>
              <Input {...register('code')} />
            </FormField>
            <FormField label="Break (minutes)" htmlFor="shift-break" error={formState.errors.breakMinutes?.message}>
              <Input type="number" min={0} {...register('breakMinutes')} />
            </FormField>
            <FormField label="Start time" htmlFor="shift-start" error={formState.errors.startTime?.message} required>
              <Input type="time" {...register('startTime')} />
            </FormField>
            <FormField label="End time" htmlFor="shift-end" error={formState.errors.endTime?.message} required>
              <Input type="time" {...register('endTime')} />
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
              {isEdit ? 'Save changes' : 'Create shift'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ShiftChangeDrawer({
  open,
  shifts,
  onClose,
}: {
  open: boolean;
  shifts: ShiftRecord[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const { register, handleSubmit, formState, reset, setError } = useForm<ShiftChangeRequestInput>({
    resolver: zodResolver(shiftChangeRequestSchema),
    values: {
      requestedShiftId: '',
      effectiveFrom: new Date().toISOString().slice(0, 10),
      reason: '',
    },
  });

  const mutation = useMutation({
    mutationFn: (values: ShiftChangeRequestInput) => api.post('/shifts/change-requests', values),
    onSuccess: async () => {
      toast.success('Shift change requested. Your manager has been notified.');
      await queryClient.invalidateQueries({ queryKey: ['approvals'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      reset();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof ShiftChangeRequestInput, { message: messages[0] });
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
            <DialogTitle>Request a shift change</DialogTitle>
            <DialogDescription>
              Routed to your reporting manager. Your assignment only changes once approved.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <FormField label="Move to shift" htmlFor="scr-shift" error={formState.errors.requestedShiftId?.message} required>
              <NativeSelect {...register('requestedShiftId')} autoFocus>
                <option value="">Choose a shift</option>
                {shifts.filter((s) => s.isActive).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.startTime}–{s.endTime})
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Effective from" htmlFor="scr-from" error={formState.errors.effectiveFrom?.message} required>
              <Input type="date" {...register('effectiveFrom')} />
            </FormField>
            <FormField label="Reason" htmlFor="scr-reason" error={formState.errors.reason?.message} required>
              <Textarea rows={4} {...register('reason')} />
            </FormField>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Submit request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Employee shift assignments.
 *
 * The API for this existed from phase 3 but nothing consumed it, so the
 * "Assigned" count on the table above had no way to be inspected. This is that
 * missing screen rather than a new capability.
 */
function ShiftAssignments({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const { lookups } = useLookups();
  const [assigning, setAssigning] = React.useState(false);

  const query = useQuery({
    queryKey: ['shifts', 'assignments'],
    queryFn: () =>
      api.getPage<ShiftAssignmentRecord>('/shifts/assignments', { query: { limit: 50 } }),
  });

  const shifts = useQuery({
    queryKey: ['shifts', 'options'],
    queryFn: () => api.getPage<ShiftRecord>('/shifts', { query: { limit: 100 } }),
    enabled: assigning,
  });

  const { register, handleSubmit, formState, reset, setError } = useForm<ShiftAssignmentInput>({
    resolver: zodResolver(shiftAssignmentSchema),
    values: {
      employeeId: '',
      shiftId: '',
      effectiveFrom: new Date().toISOString().slice(0, 10),
      effectiveTo: '',
    },
  });

  const mutation = useMutation({
    mutationFn: (values: ShiftAssignmentInput) => api.post('/shifts/assignments', values),
    onSuccess: async () => {
      toast.success('Shift assigned.');
      await queryClient.invalidateQueries({ queryKey: ['shifts'] });
      await queryClient.invalidateQueries({ queryKey: LOOKUPS_QUERY_KEY });
      reset();
      setAssigning(false);
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof ShiftAssignmentInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  const rows = query.data?.data ?? [];

  return (
    <>
      <Card className="mt-6 overflow-hidden">
        <CardHeader bordered className="flex-row items-center justify-between">
          <CardTitle>Shift assignments</CardTitle>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setAssigning(true)}>
              <Plus />
              Assign shift
            </Button>
          ) : null}
        </CardHeader>

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <TableWrapper>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Employee</TH>
                  <TH>Shift</TH>
                  <TH className="w-40">Effective from</TH>
                  <TH className="w-40">Until</TH>
                </TR>
              </THead>
              <TBody>
                {query.isLoading ? (
                  <TableSkeleton rows={4} columns={4} />
                ) : rows.length === 0 ? (
                  <TR className="hover:bg-transparent">
                    <TD colSpan={4} className="p-0">
                      <EmptyStateAlias
                        icon={Clock}
                        title="No shift assignments yet"
                        description="Assign a shift so attendance can tell how late a check-in is."
                      />
                    </TD>
                  </TR>
                ) : (
                  rows.map((row) => (
                    <TR key={row.id}>
                      <TD className="text-[13px]">{row.employeeName}</TD>
                      <TD className="text-[13px]">{row.shiftName}</TD>
                      <TD className="tabular text-[13px]">{formatDate(row.effectiveFrom)}</TD>
                      <TD className="tabular text-[13px] text-muted-foreground">
                        {row.effectiveTo ? formatDate(row.effectiveTo) : 'Ongoing'}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </TableWrapper>
        )}
      </Card>

      <Dialog open={assigning} onOpenChange={(next) => (next ? null : setAssigning(false))}>
        <DialogContent variant="drawer" size="md">
          <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="contents">
            <DialogHeader>
              <DialogTitle>Assign a shift</DialogTitle>
              <DialogDescription>
                Any shift already in force for that employee is closed off the day before.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="space-y-4">
              <FormField label="Employee" htmlFor="sa-emp" error={formState.errors.employeeId?.message} required>
                <NativeSelect {...register('employeeId')} autoFocus>
                  <option value="">Choose an employee</option>
                  {lookups.managers.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Shift" htmlFor="sa-shift" error={formState.errors.shiftId?.message} required>
                <NativeSelect {...register('shiftId')}>
                  <option value="">Choose a shift</option>
                  {(shifts.data?.data ?? []).filter((s) => s.isActive).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.startTime}–{s.endTime})
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Effective from" htmlFor="sa-from" error={formState.errors.effectiveFrom?.message} required>
                <Input type="date" {...register('effectiveFrom')} />
              </FormField>
              <FormField label="Until" htmlFor="sa-to" error={formState.errors.effectiveTo?.message} hint="Leave blank for ongoing.">
                <Input type="date" {...register('effectiveTo')} />
              </FormField>
            </DialogBody>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAssigning(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={mutation.isPending}>
                Assign shift
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
