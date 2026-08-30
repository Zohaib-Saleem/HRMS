import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Plus, Wallet } from 'lucide-react';
import {
  PAYROLL_COMPONENT_FREQUENCIES,
  PAYROLL_OVERTIME_MODE_LABELS,
  PAYROLL_SALARY_TYPES,
  PAYROLL_SALARY_TYPE_LABELS,
  PERMISSIONS,
  employeeComponentSchema,
  employeeSalarySchema,
  type EmployeeComponentInput,
  type EmployeeComponentRecord,
  type EmployeeSalaryInput,
  type EmployeeSalaryRecord,
  type PayrollProfileRecord,
  type SalaryComponentRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useDebounced } from '@/lib/use-debounced';
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
import { Can } from '@/features/auth/session-context';
import { money } from './payroll-shared';

/**
 * Payroll profiles: what each employee is paid, and on what terms.
 *
 * Salary is never edited in place once a run has used it - a new record is
 * opened from a date and the old one closed. The drawer shows the history for
 * that reason: an effective-dated list is the evidence that June was not
 * quietly repriced when July's raise was entered.
 */

const INITIAL = { q: '', page: 1, limit: 20 };

export function PayrollProfilesPage() {
  const [filters, setFilters] = React.useState(INITIAL);
  const [openEmployee, setOpenEmployee] = React.useState<PayrollProfileRecord | null>(null);
  const debounced = useDebounced(filters.q, 350);

  const profiles = useQuery({
    queryKey: ['payroll-profiles', { ...filters, q: debounced }],
    queryFn: () =>
      api.getPage<PayrollProfileRecord>('/payroll/profiles', {
        query: { page: filters.page, limit: filters.limit, q: debounced || undefined },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = profiles.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Payroll profiles"
        description="Salary, overtime terms and recurring allowances, per employee."
      />

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => setFilters((f) => ({ ...f, q, page: 1 }))}
          placeholder="Search employee or number"
          hasActiveFilters={filters.q !== ''}
          onReset={() => setFilters(INITIAL)}
        />

        {profiles.isError ? (
          <ErrorState error={profiles.error} onRetry={() => void profiles.refetch()} />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Employee</TH>
                    <TH className="w-36">Salary type</TH>
                    <TH className="w-36 text-right">Current salary</TH>
                    <TH className="w-40">Overtime</TH>
                    <TH className="w-28">Status</TH>
                    <TH className="w-28 text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {profiles.isLoading ? (
                    <TableSkeleton rows={5} columns={6} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={6} className="p-0">
                        <EmptyState
                          icon={Wallet}
                          title="No payroll profiles yet"
                          description="A profile is created the first time you set someone's salary. Open an employee from the people list, or set a salary below."
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((profile) => (
                      <TR key={profile.id}>
                        <TD className="text-[13px]">
                          <span className="font-medium">{profile.employeeName}</span>
                          <span className="tabular block text-[12px] text-muted-foreground">
                            {profile.employeeNumber}
                          </span>
                        </TD>
                        <TD className="text-[13px]">
                          {profile.currentSalary
                            ? PAYROLL_SALARY_TYPE_LABELS[profile.currentSalary.salaryType]
                            : '--'}
                        </TD>
                        <TD className="tabular text-right text-[13px] font-medium">
                          {profile.currentSalary
                            ? money(profile.currentSalary.amount, profile.currentSalary.currency)
                            : '--'}
                        </TD>
                        <TD className="text-[12.5px] text-muted-foreground">
                          {profile.overtimeMode
                            ? PAYROLL_OVERTIME_MODE_LABELS[profile.overtimeMode]
                            : 'Company setting'}
                          {profile.overtimeMultiplier !== null ? (
                            <span className="tabular block">×{profile.overtimeMultiplier}</span>
                          ) : null}
                        </TD>
                        <TD>
                          <Badge variant={profile.isActive ? 'success' : 'neutral'}>
                            {profile.isActive ? 'In payroll' : 'Excluded'}
                          </Badge>
                        </TD>
                        <TD>
                          <div className="flex justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setOpenEmployee(profile)}
                            >
                              Open
                            </Button>
                          </div>
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>

            {profiles.data ? (
              <Pagination
                meta={profiles.data.meta}
                disabled={profiles.isFetching}
                onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
              />
            ) : null}
          </>
        )}
      </Card>

      {openEmployee ? (
        <EmployeePayrollDrawer profile={openEmployee} onClose={() => setOpenEmployee(null)} />
      ) : null}
    </>
  );
}

/** Salary history and allowances for one employee. */
function EmployeePayrollDrawer({
  profile,
  onClose,
}: {
  profile: PayrollProfileRecord;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [addingSalary, setAddingSalary] = React.useState(false);
  const [addingAllowance, setAddingAllowance] = React.useState(false);

  const salaries = useQuery({
    queryKey: ['payroll-salaries', profile.employeeId],
    queryFn: () =>
      api.getPage<EmployeeSalaryRecord>('/payroll/salaries', {
        query: { employeeId: profile.employeeId, limit: 50 },
      }),
  });

  const allowances = useQuery({
    queryKey: ['payroll-employee-components', profile.employeeId],
    queryFn: () =>
      api.getPage<EmployeeComponentRecord>('/payroll/employee-components', {
        query: { employeeId: profile.employeeId, limit: 50 },
      }),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['payroll-salaries', profile.employeeId] });
    await queryClient.invalidateQueries({
      queryKey: ['payroll-employee-components', profile.employeeId],
    });
    await queryClient.invalidateQueries({ queryKey: ['payroll-profiles'] });
  };

  const removeAllowance = useMutation({
    mutationFn: (id: string) => api.delete(`/payroll/employee-components/${id}`),
    onSuccess: async () => {
      toast.success('Allowance removed.');
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  return (
    <>
      <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
        <DialogContent variant="drawer" size="lg">
          <DialogHeader>
            <DialogTitle>{profile.employeeName}</DialogTitle>
            <DialogDescription>
              {profile.employeeNumber} · salary history and recurring components
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-6">
            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Salary history
                </h3>
                <Can permission={PERMISSIONS.PAYROLL_MANAGE}>
                  <Button variant="outline" size="sm" onClick={() => setAddingSalary(true)}>
                    <Plus />
                    New salary
                  </Button>
                </Can>
              </div>
              <p className="mb-3 text-[12.5px] text-muted-foreground">
                A raise opens a new record from its date. Editing one a finalized payroll has
                already used is refused, so past payslips cannot move.
              </p>

              <div className="overflow-hidden rounded-md border border-border">
                {salaries.isLoading ? (
                  <p className="px-3 py-3 text-[13px] text-muted-foreground">Loading…</p>
                ) : (salaries.data?.data.length ?? 0) === 0 ? (
                  <p className="px-3 py-3 text-[13px] text-muted-foreground">
                    No salary on record. Payroll cannot calculate anything for this employee until
                    one is set.
                  </p>
                ) : (
                  salaries.data?.data.map((salary) => (
                    <div
                      key={salary.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-3 py-2 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <p className="tabular text-[13.5px] font-medium">
                          {money(salary.amount, salary.currency)}
                          <span className="ml-2 text-[12px] font-normal text-muted-foreground">
                            {PAYROLL_SALARY_TYPE_LABELS[salary.salaryType]}
                          </span>
                        </p>
                        <p className="tabular text-[12px] text-muted-foreground">
                          From {formatDate(salary.effectiveFrom)}
                          {salary.effectiveTo ? ` to ${formatDate(salary.effectiveTo)}` : ' onward'}
                        </p>
                      </div>
                      {salary.isCurrent ? <Badge variant="success">In force</Badge> : null}
                    </div>
                  ))
                )}
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Allowances and deductions
                </h3>
                <Can permission={PERMISSIONS.PAYROLL_MANAGE}>
                  <Button variant="outline" size="sm" onClick={() => setAddingAllowance(true)}>
                    <Plus />
                    Assign
                  </Button>
                </Can>
              </div>

              <div className="overflow-hidden rounded-md border border-border">
                {(allowances.data?.data.length ?? 0) === 0 ? (
                  <p className="px-3 py-3 text-[13px] text-muted-foreground">
                    Nothing assigned. Basic pay and any attendance deductions still apply.
                  </p>
                ) : (
                  allowances.data?.data.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-3 py-2 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <p className="text-[13.5px] font-medium">
                          {item.componentName}
                          <Badge
                            variant={item.kind === 'EARNING' ? 'success' : 'warning'}
                            className="ml-2"
                          >
                            {item.kind === 'EARNING' ? 'Earning' : 'Deduction'}
                          </Badge>
                        </p>
                        <p className="tabular text-[12px] text-muted-foreground">
                          {item.calc === 'FIXED' ? money(item.value) : `${item.value}%`} ·{' '}
                          {item.frequency === 'ONE_TIME' ? 'One time' : 'Recurring'} · from{' '}
                          {formatDate(item.effectiveFrom)}
                        </p>
                      </div>
                      <Can permission={PERMISSIONS.PAYROLL_MANAGE}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Remove ${item.componentName}?`,
                              description:
                                'It stops applying to future runs. Payroll already finalized is unaffected.',
                              confirmLabel: 'Remove',
                              tone: 'destructive',
                            });
                            if (ok) removeAllowance.mutate(item.id);
                          }}
                        >
                          Remove
                        </Button>
                      </Can>
                    </div>
                  ))
                )}
              </div>
            </section>
          </DialogBody>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {addingSalary ? (
        <SalaryDialog
          employeeId={profile.employeeId}
          employeeName={profile.employeeName}
          onClose={() => setAddingSalary(false)}
          onSaved={refresh}
        />
      ) : null}

      {addingAllowance ? (
        <AllowanceDialog
          employeeId={profile.employeeId}
          onClose={() => setAddingAllowance(false)}
          onSaved={refresh}
        />
      ) : null}
    </>
  );
}

function SalaryDialog({
  employeeId,
  employeeName,
  onClose,
  onSaved,
}: {
  employeeId: string;
  employeeName: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { register, handleSubmit, formState, setError } = useForm<EmployeeSalaryInput>({
    resolver: zodResolver(employeeSalarySchema),
    defaultValues: {
      employeeId,
      salaryType: 'MONTHLY',
      amount: 0,
      effectiveFrom: new Date().toISOString().slice(0, 10),
      effectiveTo: '',
      note: '',
    },
  });

  const mutation = useMutation({
    mutationFn: (values: EmployeeSalaryInput) =>
      api.post<{ id: string }>('/payroll/salaries', {
        ...values,
        effectiveTo: values.effectiveTo || null,
        note: values.note || null,
      }),
    onSuccess: async () => {
      toast.success('Salary recorded.');
      await onSaved();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof EmployeeSalaryInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="sm">
        <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="contents">
          <DialogHeader>
            <DialogTitle>New salary for {employeeName}</DialogTitle>
            <DialogDescription>
              Effective from a date. If a salary is already in force, close it first - two records
              covering the same day are refused.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" {...register('employeeId')} />
            <FormField
              label="Salary type"
              htmlFor="salary-type"
              error={formState.errors.salaryType?.message}
              required
            >
              <NativeSelect {...register('salaryType')}>
                {PAYROLL_SALARY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {PAYROLL_SALARY_TYPE_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField
              label="Amount"
              htmlFor="salary-amount"
              error={formState.errors.amount?.message}
              required
            >
              <Input type="number" step="0.01" {...register('amount')} className="tabular" autoFocus />
            </FormField>
            <FormField
              label="Effective from"
              htmlFor="salary-from"
              error={formState.errors.effectiveFrom?.message}
              required
            >
              <Input type="date" {...register('effectiveFrom')} className="tabular" />
            </FormField>
            <FormField
              label="Effective to"
              htmlFor="salary-to"
              error={formState.errors.effectiveTo?.message}
              hint="Leave blank for open-ended."
            >
              <Input type="date" {...register('effectiveTo')} className="tabular" />
            </FormField>
            <FormField
              label="Note"
              htmlFor="salary-note"
              error={formState.errors.note?.message}
              className="sm:col-span-2"
            >
              <Input {...register('note')} placeholder="Annual review, promotion..." />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Save salary
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AllowanceDialog({
  employeeId,
  onClose,
  onSaved,
}: {
  employeeId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const components = useQuery({
    queryKey: ['salary-components', { limit: 100 }],
    queryFn: () =>
      api.getPage<SalaryComponentRecord>('/payroll/components', { query: { limit: 100 } }),
  });

  const { register, handleSubmit, formState, setError } = useForm<EmployeeComponentInput>({
    resolver: zodResolver(employeeComponentSchema),
    defaultValues: {
      employeeId,
      componentId: '',
      value: 0,
      frequency: 'RECURRING',
      effectiveFrom: new Date().toISOString().slice(0, 10),
      effectiveTo: '',
      isActive: true,
      note: '',
    },
  });

  const mutation = useMutation({
    mutationFn: (values: EmployeeComponentInput) =>
      api.post<{ id: string }>('/payroll/employee-components', {
        ...values,
        effectiveTo: values.effectiveTo || null,
        note: values.note || null,
      }),
    onSuccess: async () => {
      toast.success('Component assigned.');
      await onSaved();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof EmployeeComponentInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  const active = components.data?.data.filter((c) => c.isActive) ?? [];

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="sm">
        <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="contents">
          <DialogHeader>
            <DialogTitle>Assign a component</DialogTitle>
            <DialogDescription>
              A one-time entry is closed on the day it starts, so a bonus cannot repeat next month.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" {...register('employeeId')} />
            <FormField
              label="Component"
              htmlFor="component"
              error={formState.errors.componentId?.message}
              required
              className="sm:col-span-2"
            >
              <NativeSelect {...register('componentId')} autoFocus>
                <option value="">Choose a component</option>
                {active.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.kind === 'EARNING' ? 'earning' : 'deduction'})
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            {active.length === 0 && !components.isLoading ? (
              <p className="text-[13px] text-muted-foreground sm:col-span-2">
                No active components. Create one on the salary components screen first.
              </p>
            ) : null}
            <FormField
              label="Value"
              htmlFor="component-value"
              error={formState.errors.value?.message}
              required
              hint="An amount, or a percentage if the component is defined that way."
            >
              <Input type="number" step="0.01" {...register('value')} className="tabular" />
            </FormField>
            <FormField
              label="Frequency"
              htmlFor="component-frequency"
              error={formState.errors.frequency?.message}
              required
            >
              <NativeSelect {...register('frequency')}>
                {PAYROLL_COMPONENT_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {f === 'RECURRING' ? 'Every period' : 'One time'}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField
              label="Effective from"
              htmlFor="component-from"
              error={formState.errors.effectiveFrom?.message}
              required
            >
              <Input type="date" {...register('effectiveFrom')} className="tabular" />
            </FormField>
            <FormField
              label="Effective to"
              htmlFor="component-to"
              error={formState.errors.effectiveTo?.message}
              hint="Ignored for a one-time entry."
            >
              <Input type="date" {...register('effectiveTo')} className="tabular" />
            </FormField>
            <FormField
              label="Note"
              htmlFor="component-note"
              error={formState.errors.note?.message}
              className="sm:col-span-2"
            >
              <Input {...register('note')} placeholder="Optional" />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending} disabled={active.length === 0}>
              Assign
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
