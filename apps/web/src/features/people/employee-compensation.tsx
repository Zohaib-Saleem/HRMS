import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Banknote, Plus, TrendingDown, TrendingUp } from 'lucide-react';
import {
  PAYROLL_COMPONENT_CALC_LABELS,
  PAYROLL_SALARY_TYPES,
  PAYROLL_SALARY_TYPE_LABELS,
  PERMISSIONS,
  employeeComponentSchema,
  employeeSalarySchema,
  type EmployeeComponentInput,
  type EmployeeComponentRecord,
  type EmployeeSalaryInput,
  type EmployeeSalaryRecord,
  type PayrollComponentKind,
  type SalaryComponentRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/states';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { usePermissions } from '@/features/auth/session-context';

/**
 * Compensation, inside the employee profile.
 *
 * Reads and writes the payroll module's own endpoints - there is one salary
 * store, not a second one owned by People. What this screen adds is the view
 * from the person rather than from the payroll run: what someone is paid now,
 * what they were paid before, and what recurs on top of it.
 *
 * Salary is effective-dated and never edited in place. Raising someone's pay
 * from July adds a record from July; June still reads 100,000 when a June run
 * asks, because that is what they were paid in June.
 */

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(amount);

const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** The value as it is actually applied: money, or a percentage of something. */
function componentValue(row: EmployeeComponentRecord, currency: string): string {
  if (row.calc === 'FIXED') return money(row.value, currency);
  const of = row.calc === 'PERCENT_OF_BASIC' ? 'of basic' : 'of gross';
  return `${row.value}% ${of}`;
}

// ------------------------------------------------------------------ salary form

function SalaryDialog({
  employeeId,
  currency,
  open,
  onClose,
}: {
  employeeId: string;
  currency: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const form = useForm<EmployeeSalaryInput>({
    resolver: zodResolver(employeeSalarySchema),
    defaultValues: {
      employeeId,
      salaryType: 'MONTHLY',
      amount: 0,
      currency,
      effectiveFrom: new Date().toISOString().slice(0, 10),
      effectiveTo: null,
      note: null,
    },
  });

  React.useEffect(() => {
    if (open) form.reset({ ...form.getValues(), employeeId, currency });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employeeId, currency]);

  const save = useMutation({
    mutationFn: (input: EmployeeSalaryInput) => api.post('/payroll/salaries', input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['compensation', employeeId] });
      toast.success('Salary recorded', {
        description: 'Earlier records are untouched, so past payroll still reads what it paid.',
      });
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          form.setError(field as keyof EmployeeSalaryInput, { message: messages[0] });
        }
        return;
      }
      toast.error('Could not save the salary', { description: errorMessage(error) });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a salary</DialogTitle>
        </DialogHeader>
        <form
          id="salary-form"
          onSubmit={form.handleSubmit((values) => save.mutate(values))}
          className="grid gap-4 sm:grid-cols-2"
        >
          <FormField
            label="Pay frequency"
            htmlFor="salaryType"
            error={form.formState.errors.salaryType?.message}
          >
            <NativeSelect id="salaryType" {...form.register('salaryType')}>
              {PAYROLL_SALARY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {PAYROLL_SALARY_TYPE_LABELS[type]}
                </option>
              ))}
            </NativeSelect>
          </FormField>

          <FormField label="Currency" htmlFor="currency" error={form.formState.errors.currency?.message}>
            <Input id="currency" maxLength={3} className="uppercase" {...form.register('currency')} />
          </FormField>

          <FormField
            label="Basic salary"
            htmlFor="amount"
            error={form.formState.errors.amount?.message}
            className="sm:col-span-2"
          >
            <Input id="amount" type="number" step="0.01" min={0} {...form.register('amount')} />
          </FormField>

          <FormField
            label="Effective from"
            htmlFor="effectiveFrom"
            hint="Payroll for earlier periods keeps using the previous salary."
            error={form.formState.errors.effectiveFrom?.message}
          >
            <Input id="effectiveFrom" type="date" {...form.register('effectiveFrom')} />
          </FormField>

          <FormField
            label="Effective to"
            htmlFor="effectiveTo"
            hint="Leave empty while this is the current salary."
            error={form.formState.errors.effectiveTo?.message}
          >
            <Input id="effectiveTo" type="date" {...form.register('effectiveTo')} />
          </FormField>

          <FormField label="Note" htmlFor="note" className="sm:col-span-2">
            <Textarea id="note" rows={2} {...form.register('note')} />
          </FormField>
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="salary-form" disabled={save.isPending}>
            {save.isPending ? 'Saving...' : 'Save salary'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------- component form

function ComponentDialog({
  employeeId,
  kind,
  catalogue,
  open,
  onClose,
}: {
  employeeId: string;
  kind: PayrollComponentKind;
  catalogue: SalaryComponentRecord[];
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const choices = catalogue.filter((c) => c.kind === kind && c.isActive);

  const form = useForm<EmployeeComponentInput>({
    resolver: zodResolver(employeeComponentSchema),
    defaultValues: {
      employeeId,
      componentId: '',
      value: 0,
      frequency: 'RECURRING',
      effectiveFrom: new Date().toISOString().slice(0, 10),
      effectiveTo: null,
      isActive: true,
      note: null,
    },
  });

  React.useEffect(() => {
    if (open) form.reset({ ...form.getValues(), employeeId, componentId: choices[0]?.id ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employeeId, catalogue.length]);

  const save = useMutation({
    mutationFn: (input: EmployeeComponentInput) => api.post('/payroll/employee-components', input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['compensation', employeeId] });
      toast.success(kind === 'EARNING' ? 'Allowance added' : 'Deduction added');
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          form.setError(field as keyof EmployeeComponentInput, { message: messages[0] });
        }
        return;
      }
      toast.error('Could not save', { description: errorMessage(error) });
    },
  });

  const label = kind === 'EARNING' ? 'allowance' : 'deduction';

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add {label === 'allowance' ? 'an' : 'a'} {label}</DialogTitle>
        </DialogHeader>

        {choices.length === 0 ? (
          <EmptyState
            title={`No ${label} types defined`}
            description={`${label === 'allowance' ? 'Allowances' : 'Deductions'} come from the salary component catalogue in Payroll. Add one there first.`}
          />
        ) : (
          <>
            <form
              id="component-form"
              onSubmit={form.handleSubmit((values) => save.mutate(values))}
              className="grid gap-4 sm:grid-cols-2"
            >
              <FormField
                label={label === 'allowance' ? 'Allowance' : 'Deduction'}
                htmlFor="componentId"
                error={form.formState.errors.componentId?.message}
                className="sm:col-span-2"
              >
                <NativeSelect id="componentId" {...form.register('componentId')}>
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} &mdash; {PAYROLL_COMPONENT_CALC_LABELS[c.calc]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Amount or percentage"
                htmlFor="value"
                hint="Read as money for a fixed component, and as a percentage for the others."
                error={form.formState.errors.value?.message}
              >
                <Input id="value" type="number" step="0.01" min={0} {...form.register('value')} />
              </FormField>

              <FormField label="Frequency" htmlFor="frequency">
                <NativeSelect id="frequency" {...form.register('frequency')}>
                  <option value="RECURRING">Every period</option>
                  <option value="ONE_TIME">Once</option>
                </NativeSelect>
              </FormField>

              <FormField
                label="Start date"
                htmlFor="componentFrom"
                error={form.formState.errors.effectiveFrom?.message}
              >
                <Input id="componentFrom" type="date" {...form.register('effectiveFrom')} />
              </FormField>

              <FormField
                label="End date"
                htmlFor="componentTo"
                hint="Leave empty to continue indefinitely."
                error={form.formState.errors.effectiveTo?.message}
              >
                <Input id="componentTo" type="date" {...form.register('effectiveTo')} />
              </FormField>

              <FormField label="Note" htmlFor="componentNote" className="sm:col-span-2">
                <Textarea id="componentNote" rows={2} {...form.register('note')} />
              </FormField>
            </form>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" form="component-form" disabled={save.isPending}>
                {save.isPending ? 'Saving...' : `Add ${label}`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------------- the panel

export function EmployeeCompensation({ employeeId }: { employeeId: string }) {
  const { has } = usePermissions();
  const canRead = has(PERMISSIONS.PAYROLL_READ);
  const canManage = has(PERMISSIONS.PAYROLL_MANAGE);

  const [salaryOpen, setSalaryOpen] = React.useState(false);
  const [componentKind, setComponentKind] = React.useState<PayrollComponentKind | null>(null);

  const salaries = useQuery({
    queryKey: ['compensation', employeeId, 'salaries'],
    queryFn: () =>
      api.getPage<EmployeeSalaryRecord>('/payroll/salaries', {
        query: { employeeId, limit: 100 },
      }),
    enabled: canRead,
  });

  const components = useQuery({
    queryKey: ['compensation', employeeId, 'components'],
    queryFn: () =>
      api.getPage<EmployeeComponentRecord>('/payroll/employee-components', {
        query: { employeeId, limit: 100 },
      }),
    enabled: canRead,
  });

  // Only for the fallback currency when no salary is on record yet. Every
  // signed-in user may read the company, so this costs no extra permission.
  const company = useQuery({
    queryKey: ['company'],
    queryFn: () => api.get<{ currency: string }>('/company'),
  });

  const catalogue = useQuery({
    queryKey: ['compensation', 'catalogue'],
    queryFn: () => api.getPage<SalaryComponentRecord>('/payroll/components', { query: { limit: 200 } }),
    enabled: canManage,
  });

  // The permission is the gate; this only decides whether to render the panel
  // at all. Someone without payroll.read sees nothing rather than an error.
  if (!canRead) return null;

  if (salaries.isLoading || components.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Banknote className="size-4" aria-hidden /> Compensation
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-24" />
        </CardContent>
      </Card>
    );
  }

  const history = salaries.data?.data ?? [];
  const current = history.find((row) => row.isCurrent) ?? null;
  const currency = current?.currency ?? company.data?.currency ?? 'USD';

  const rows = components.data?.data ?? [];
  const allowances = rows.filter((r) => r.kind === 'EARNING');
  const deductions = rows.filter((r) => r.kind === 'DEDUCTION');

  const componentTable = (list: EmployeeComponentRecord[], empty: string) =>
    list.length === 0 ? (
      <p className="px-5 py-4 text-sm text-muted-foreground">{empty}</p>
    ) : (
      <TableWrapper>
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Value</TH>
              <TH>From</TH>
              <TH>To</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {list.map((row) => (
              <TR key={row.id}>
                <TD className="font-medium">{row.componentName}</TD>
                <TD className="tabular-nums">{componentValue(row, currency)}</TD>
                <TD className="whitespace-nowrap">{day(row.effectiveFrom)}</TD>
                <TD className="whitespace-nowrap text-muted-foreground">
                  {row.effectiveTo ? day(row.effectiveTo) : '—'}
                </TD>
                <TD>
                  <Badge variant={row.isActive ? 'success' : 'neutral'}>
                    {row.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrapper>
    );

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Banknote className="size-4" aria-hidden /> Compensation
          </CardTitle>
          {canManage ? (
            <Button size="sm" onClick={() => setSalaryOpen(true)}>
              <Plus className="size-4" aria-hidden /> Record salary
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          {current ? (
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Basic salary</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {money(current.amount, current.currency)}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Pay frequency</dt>
                <dd className="text-sm font-medium">
                  {PAYROLL_SALARY_TYPE_LABELS[current.salaryType]}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Currency</dt>
                <dd className="text-sm font-medium">{current.currency}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Effective from</dt>
                <dd className="text-sm font-medium">{day(current.effectiveFrom)}</dd>
              </div>
            </dl>
          ) : (
            <EmptyState
              title="No salary on record"
              description={
                canManage
                  ? 'Record one to include this employee in a payroll run.'
                  : 'Nobody has recorded a salary for this employee yet.'
              }
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="size-4" aria-hidden /> Allowances
          </CardTitle>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setComponentKind('EARNING')}>
              <Plus className="size-4" aria-hidden /> Add
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {componentTable(allowances, 'No recurring allowances.')}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingDown className="size-4" aria-hidden /> Deductions
          </CardTitle>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setComponentKind('DEDUCTION')}>
              <Plus className="size-4" aria-hidden /> Add
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {componentTable(deductions, 'No recurring deductions.')}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Salary history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {history.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">Nothing recorded yet.</p>
          ) : (
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Effective from</TH>
                    <TH>Effective to</TH>
                    <TH>Basic salary</TH>
                    <TH>Frequency</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {history.map((row) => (
                    <TR key={row.id}>
                      <TD className="whitespace-nowrap font-medium">{day(row.effectiveFrom)}</TD>
                      <TD className="whitespace-nowrap text-muted-foreground">
                        {row.effectiveTo ? day(row.effectiveTo) : '—'}
                      </TD>
                      <TD className="tabular-nums">{money(row.amount, row.currency)}</TD>
                      <TD>{PAYROLL_SALARY_TYPE_LABELS[row.salaryType]}</TD>
                      <TD>
                        <Badge variant={row.isCurrent ? 'success' : 'neutral'}>
                          {row.isCurrent ? 'Current' : 'Superseded'}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrapper>
          )}
        </CardContent>
      </Card>

      {canManage ? (
        <>
          <SalaryDialog
            employeeId={employeeId}
            currency={currency}
            open={salaryOpen}
            onClose={() => setSalaryOpen(false)}
          />
          <ComponentDialog
            employeeId={employeeId}
            kind={componentKind ?? 'EARNING'}
            catalogue={catalogue.data?.data ?? []}
            open={componentKind !== null}
            onClose={() => setComponentKind(null)}
          />
        </>
      ) : null}
    </div>
  );
}
