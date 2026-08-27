import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Layers3, Plus, Trash2 } from 'lucide-react';
import {
  ATTENDANCE_POLICY_SCOPES,
  ATTENDANCE_POLICY_SCOPE_LABELS,
  PERMISSIONS,
  attendancePolicyAssignmentSchema,
  attendancePolicyInputSchema,
  type AttendancePolicyAssignmentInput,
  type AttendancePolicyAssignmentRecord,
  type AttendancePolicyInputPayload,
  type AttendancePolicyRecord,
  type AttendancePolicyScope,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { formatDate } from '@/lib/utils';
import { usePermissions } from '@/features/auth/session-context';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Scoped attendance policies.
 *
 * These override the company baseline on the Attendance policy tab; they do not
 * replace it. Anyone not covered by an assignment keeps the baseline, which is
 * why a company can ignore this screen entirely and lose nothing.
 */

const BLANK: AttendancePolicyInputPayload = {
  name: '',
  description: '',
  graceMinutes: 10,
  halfDayMinutes: 240,
  fullDayMinutes: 480,
  earlyLeaveGraceMinutes: 10,
  overtimeEnabled: true,
  overtimeAfterMinutes: 480,
  overtimeDailyCapMinutes: 240,
  isActive: true,
};

export function AttendancePoliciesPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.COMPANY_MANAGE);
  const [editing, setEditing] = React.useState<AttendancePolicyRecord | 'new' | null>(null);
  const [assigning, setAssigning] = React.useState(false);
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const policies = useQuery({
    queryKey: ['attendance-policies'],
    queryFn: () => api.getPage<AttendancePolicyRecord>('/attendance-policies', {
      query: { limit: 100 },
    }),
    placeholderData: keepPreviousData,
  });

  const assignments = useQuery({
    queryKey: ['attendance-policies', 'assignments'],
    queryFn: () =>
      api.getPage<AttendancePolicyAssignmentRecord>('/attendance-policies/assignments', {
        query: { limit: 100 },
      }),
    placeholderData: keepPreviousData,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['attendance-policies'] });
    // A policy change alters how days are scored from here on.
    await queryClient.invalidateQueries({ queryKey: ['attendance'] });
  };

  const removePolicy = useMutation({
    mutationFn: (id: string) => api.delete(`/attendance-policies/${id}`),
    onSuccess: async () => {
      toast.success('Policy removed. Anyone it covered falls back to the company baseline.');
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const removeAssignment = useMutation({
    mutationFn: (id: string) => api.delete(`/attendance-policies/assignments/${id}`),
    onSuccess: async () => {
      toast.success('Assignment removed.');
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const policyRows = policies.data?.data ?? [];
  const assignmentRows = assignments.data?.data ?? [];

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeader bordered className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Policy overrides</CardTitle>
            <CardDescription>
              Named threshold sets for part of the workforce. Anyone without one is scored by the
              company baseline on the Attendance policy tab.
            </CardDescription>
          </div>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
              <Plus />
              New policy
            </Button>
          ) : null}
        </CardHeader>

        {policies.isError ? (
          <ErrorState error={policies.error} onRetry={() => void policies.refetch()} />
        ) : (
          <TableWrapper>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Policy</TH>
                  <TH className="w-24 text-right">Grace</TH>
                  <TH className="w-24 text-right">Half day</TH>
                  <TH className="w-24 text-right">Full day</TH>
                  <TH className="w-28 text-right">Overtime</TH>
                  <TH className="w-24 text-right">In use</TH>
                  <TH className="w-24" />
                </TR>
              </THead>
              <TBody>
                {policies.isLoading ? (
                  <TableSkeleton rows={3} columns={7} />
                ) : policyRows.length === 0 ? (
                  <TR className="hover:bg-transparent">
                    <TD colSpan={7} className="p-0">
                      <EmptyState
                        icon={Layers3}
                        title="No policy overrides"
                        description="Every employee is scored by the company baseline. Create a policy only when part of the workforce needs different thresholds."
                      />
                    </TD>
                  </TR>
                ) : (
                  policyRows.map((row) => (
                    <TR
                      key={row.id}
                      className={canManage ? 'cursor-pointer' : undefined}
                      onClick={canManage ? () => setEditing(row) : undefined}
                    >
                      <TD className="text-[13px]">
                        <span className="font-medium">{row.name}</span>
                        {!row.isActive ? (
                          <Badge variant="neutral" className="ml-2">Inactive</Badge>
                        ) : null}
                        {row.description ? (
                          <span className="block text-[12px] text-muted-foreground">
                            {row.description}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="tabular text-right text-[13px]">{row.graceMinutes}m</TD>
                      <TD className="tabular text-right text-[13px]">{row.halfDayMinutes}m</TD>
                      <TD className="tabular text-right text-[13px]">{row.fullDayMinutes}m</TD>
                      <TD className="tabular text-right text-[13px]">
                        {row.overtimeEnabled ? `after ${row.overtimeAfterMinutes}m` : 'Off'}
                      </TD>
                      <TD className="tabular text-right text-[13px]">{row.assignmentCount}</TD>
                      <TD className="text-right">
                        {canManage ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Delete ${row.name}`}
                            onClick={async (e) => {
                              e.stopPropagation();
                              const ok = await confirm({
                                title: `Delete "${row.name}"?`,
                                description:
                                  'Its assignments go with it and those employees fall back to the company baseline. Attendance already scored is not changed.',
                                confirmLabel: 'Delete',
                                tone: 'destructive',
                              });
                              if (ok) removePolicy.mutate(row.id);
                            }}
                          >
                            <Trash2 />
                          </Button>
                        ) : null}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </TableWrapper>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader bordered className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Who each policy applies to</CardTitle>
            <CardDescription>
              Most specific wins: an individual beats a team, a team beats a department, a
              department beats a company-wide override. Effective dates mean a day is always scored
              by the policy that was in force on that day.
            </CardDescription>
          </div>
          {canManage && policyRows.length > 0 ? (
            <Button size="sm" variant="outline" onClick={() => setAssigning(true)}>
              <Plus />
              Assign
            </Button>
          ) : null}
        </CardHeader>

        {assignments.isError ? (
          <ErrorState error={assignments.error} onRetry={() => void assignments.refetch()} />
        ) : (
          <TableWrapper>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Policy</TH>
                  <TH className="w-36">Applies to</TH>
                  <TH>Who</TH>
                  <TH className="w-32">From</TH>
                  <TH className="w-32">Until</TH>
                  <TH className="w-16" />
                </TR>
              </THead>
              <TBody>
                {assignments.isLoading ? (
                  <TableSkeleton rows={3} columns={6} />
                ) : assignmentRows.length === 0 ? (
                  <TR className="hover:bg-transparent">
                    <TD colSpan={6} className="p-0">
                      <EmptyState
                        icon={Layers3}
                        title="Nothing assigned"
                        description="A policy with no assignment changes nothing. Assign one to a department, a team or a person."
                      />
                    </TD>
                  </TR>
                ) : (
                  assignmentRows.map((row) => (
                    <TR key={row.id}>
                      <TD className="text-[13px] font-medium">{row.policyName}</TD>
                      <TD>
                        <Badge variant="neutral">
                          {ATTENDANCE_POLICY_SCOPE_LABELS[row.scope]}
                        </Badge>
                      </TD>
                      <TD className="text-[13px]">
                        {row.scope === 'COMPANY' ? 'Everyone' : (row.targetName ?? '--')}
                      </TD>
                      <TD className="tabular text-[13px]">{formatDate(row.effectiveFrom)}</TD>
                      <TD className="tabular text-[13px] text-muted-foreground">
                        {row.effectiveTo ? formatDate(row.effectiveTo) : 'Ongoing'}
                      </TD>
                      <TD className="text-right">
                        {canManage ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Remove assignment"
                            onClick={() => removeAssignment.mutate(row.id)}
                          >
                            <Trash2 />
                          </Button>
                        ) : null}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </TableWrapper>
        )}
      </Card>

      <PolicyDrawer
        policy={editing === 'new' ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />
      <AssignDrawer
        open={assigning}
        policies={policyRows}
        onClose={() => setAssigning(false)}
        onSaved={refresh}
      />
    </div>
  );
}

function PolicyDrawer({
  policy,
  open,
  onClose,
  onSaved,
}: {
  policy: AttendancePolicyRecord | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isEdit = policy !== null;

  const { register, handleSubmit, formState, setError } = useForm<AttendancePolicyInputPayload>({
    resolver: zodResolver(attendancePolicyInputSchema),
    values: policy
      ? {
          name: policy.name,
          description: policy.description ?? '',
          graceMinutes: policy.graceMinutes,
          halfDayMinutes: policy.halfDayMinutes,
          fullDayMinutes: policy.fullDayMinutes,
          earlyLeaveGraceMinutes: policy.earlyLeaveGraceMinutes,
          overtimeEnabled: policy.overtimeEnabled,
          overtimeAfterMinutes: policy.overtimeAfterMinutes,
          overtimeDailyCapMinutes: policy.overtimeDailyCapMinutes,
          isActive: policy.isActive,
        }
      : BLANK,
  });

  const mutation = useMutation({
    mutationFn: (values: AttendancePolicyInputPayload) =>
      isEdit
        ? api.patch(`/attendance-policies/${policy.id}`, values)
        : api.post('/attendance-policies', values),
    onSuccess: async () => {
      toast.success(isEdit ? 'Policy updated.' : 'Policy created.');
      await onSaved();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof AttendancePolicyInputPayload, { message: messages[0] });
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
            <DialogTitle>{isEdit ? `Edit ${policy.name}` : 'New attendance policy'}</DialogTitle>
            <DialogDescription>
              Thresholds for the people this policy is assigned to. Weekends and check-in
              restrictions stay company-wide and are not set here.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Name"
              htmlFor="pol-name"
              error={formState.errors.name?.message}
              required
              className="sm:col-span-2"
            >
              <Input {...register('name')} autoFocus placeholder="Night shift crew" />
            </FormField>
            <FormField
              label="Description"
              htmlFor="pol-desc"
              error={formState.errors.description?.message}
              className="sm:col-span-2"
            >
              <Textarea rows={2} {...register('description')} />
            </FormField>

            <FormField label="Late grace (minutes)" htmlFor="pol-grace" error={formState.errors.graceMinutes?.message}>
              <Input type="number" min={0} {...register('graceMinutes')} />
            </FormField>
            <FormField label="Early-leave grace (minutes)" htmlFor="pol-early" error={formState.errors.earlyLeaveGraceMinutes?.message}>
              <Input type="number" min={0} {...register('earlyLeaveGraceMinutes')} />
            </FormField>
            <FormField label="Half day from (minutes)" htmlFor="pol-half" error={formState.errors.halfDayMinutes?.message}>
              <Input type="number" min={0} {...register('halfDayMinutes')} />
            </FormField>
            <FormField label="Full day from (minutes)" htmlFor="pol-full" error={formState.errors.fullDayMinutes?.message}>
              <Input type="number" min={1} {...register('fullDayMinutes')} />
            </FormField>
            <FormField label="Overtime after (minutes)" htmlFor="pol-ot" error={formState.errors.overtimeAfterMinutes?.message}>
              <Input type="number" min={0} {...register('overtimeAfterMinutes')} />
            </FormField>
            <FormField label="Daily overtime cap (minutes)" htmlFor="pol-otcap" error={formState.errors.overtimeDailyCapMinutes?.message}>
              <Input type="number" min={0} {...register('overtimeDailyCapMinutes')} />
            </FormField>

            <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px] sm:col-span-2">
              <input
                type="checkbox"
                {...register('overtimeEnabled')}
                className="size-4 shrink-0 rounded border-input accent-[var(--primary)]"
              />
              Calculate overtime for these employees
            </label>
            <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px] sm:col-span-2">
              <input
                type="checkbox"
                {...register('isActive')}
                className="size-4 shrink-0 rounded border-input accent-[var(--primary)]"
              />
              Active — an inactive policy is ignored and the baseline applies
            </label>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isEdit ? 'Save policy' : 'Create policy'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssignDrawer({
  open,
  policies,
  onClose,
  onSaved,
}: {
  open: boolean;
  policies: AttendancePolicyRecord[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { lookups } = useLookups();

  const { register, handleSubmit, formState, watch, setError, reset } =
    useForm<AttendancePolicyAssignmentInput>({
      resolver: zodResolver(attendancePolicyAssignmentSchema),
      values: {
        policyId: policies[0]?.id ?? '',
        scope: 'DEPARTMENT',
        targetId: '',
        effectiveFrom: new Date().toISOString().slice(0, 10),
        effectiveTo: '',
      },
    });

  const scope = watch('scope') as AttendancePolicyScope;

  const targets =
    scope === 'DEPARTMENT'
      ? lookups.departments
      : scope === 'TEAM'
        ? lookups.teams
        : scope === 'EMPLOYEE'
          ? lookups.managers
          : [];

  const mutation = useMutation({
    mutationFn: (values: AttendancePolicyAssignmentInput) =>
      api.post('/attendance-policies/assignments', {
        ...values,
        targetId: values.scope === 'COMPANY' ? null : values.targetId,
        effectiveTo: values.effectiveTo || null,
      }),
    onSuccess: async () => {
      toast.success('Policy assigned.');
      await onSaved();
      reset();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof AttendancePolicyAssignmentInput, { message: messages[0] });
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
            <DialogTitle>Assign a policy</DialogTitle>
            <DialogDescription>
              From the effective date onwards, days for these people are scored by this policy
              instead of the company baseline.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <FormField label="Policy" htmlFor="asg-policy" error={formState.errors.policyId?.message} required>
              <NativeSelect {...register('policyId')}>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField label="Applies to" htmlFor="asg-scope" error={formState.errors.scope?.message} required>
              <NativeSelect {...register('scope')}>
                {ATTENDANCE_POLICY_SCOPES.map((s) => (
                  <option key={s} value={s}>{ATTENDANCE_POLICY_SCOPE_LABELS[s]}</option>
                ))}
              </NativeSelect>
            </FormField>

            {scope !== 'COMPANY' ? (
              <FormField label="Who" htmlFor="asg-target" error={formState.errors.targetId?.message} required>
                <NativeSelect {...register('targetId')}>
                  <option value="">Choose one</option>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </NativeSelect>
              </FormField>
            ) : null}

            <FormField label="Effective from" htmlFor="asg-from" error={formState.errors.effectiveFrom?.message} required>
              <Input type="date" {...register('effectiveFrom')} />
            </FormField>
            <FormField
              label="Until"
              htmlFor="asg-to"
              hint="Leave blank while it stays in force."
              error={formState.errors.effectiveTo?.message}
            >
              <Input type="date" {...register('effectiveTo')} />
            </FormField>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Assign
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
