import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Banknote, Plus, TrendingDown, TrendingUp } from 'lucide-react';
import {
  PAYROLL_COMPONENT_CALC_LABELS,
  PAYROLL_SALARY_TYPE_LABELS,
  PERMISSIONS,
  employeeComponentSchema,
  type EmployeeComponentInput,
  type EmployeeComponentRecord,
  type EmployeeSalaryRecord,
  type PayrollComponentKind,
  type SalaryComponentRecord,
  type SalaryRevisionRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/states';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { usePermissions } from '@/features/auth/session-context';
import { SalaryDialog, todayLocal } from './salary-dialog';
import { IncrementDialog } from './increment-dialog';

export { SalaryDialog } from './salary-dialog';

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
      effectiveFrom: todayLocal(),
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
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add {label === 'allowance' ? 'an' : 'a'} {label}</DialogTitle>
        </DialogHeader>

        {choices.length === 0 ? (
          <DialogBody>
            <EmptyState
              title={`No ${label} types defined`}
              description={`${label === 'allowance' ? 'Allowances' : 'Deductions'} come from the salary component catalogue in Payroll. Add one there first.`}
            />
          </DialogBody>
        ) : (
          <>
            <DialogBody>
              <form
                id="component-form"
                onSubmit={form.handleSubmit((values) => save.mutate(values))}
                className="grid gap-4 sm:grid-cols-2"
                noValidate
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
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
                Cancel
              </Button>
              <Button type="submit" form="component-form" loading={save.isPending}>
                {save.isPending ? 'Saving…' : `Add ${label}`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------------- the panel

export function EmployeeCompensation({
  employeeId,
  employeeName,
}: {
  employeeId: string;
  /** For the salary dialog's Employee field; falls back to the salary records' own name. */
  employeeName?: string;
}) {
  const { has } = usePermissions();
  const canRead = has(PERMISSIONS.PAYROLL_READ);
  const canManage = has(PERMISSIONS.PAYROLL_MANAGE);

  const [salaryOpen, setSalaryOpen] = React.useState(false);
  const [incrementOpen, setIncrementOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<EmployeeSalaryRecord | null>(null);
  const [componentKind, setComponentKind] = React.useState<PayrollComponentKind | null>(null);
  const queryClient = useQueryClient();

  // Enable or disable one allowance or deduction without leaving the page.
  const toggle = useMutation({
    mutationFn: (input: { id: string; isActive: boolean }) =>
      api.patch(`/payroll/employee-components/${input.id}`, { isActive: input.isActive }),
    onSuccess: async (_data, input) => {
      await queryClient.invalidateQueries({ queryKey: ['compensation', employeeId] });
      await queryClient.invalidateQueries({ queryKey: ['salary-overview'] });
      toast.success(input.isActive ? 'Enabled' : 'Disabled');
    },
    onError: (error: unknown) => toast.error('Could not update', { description: errorMessage(error) }),
  });

  const salaries = useQuery({
    queryKey: ['compensation', employeeId, 'salaries'],
    queryFn: () =>
      api.getPage<EmployeeSalaryRecord>('/payroll/salaries', {
        query: { employeeId, limit: 100 },
      }),
    enabled: canRead,
  });

  /**
   * The increments behind the salary history.
   *
   * A separate list rather than a column on the salary table: not every salary
   * record comes from an increment - an imported figure or a correction has no
   * decision behind it - and showing "no reason recorded" against those would
   * imply somebody failed to fill something in.
   */
  const revisions = useQuery({
    queryKey: ['salary-revisions', { employeeId }],
    queryFn: () =>
      api.getPage<SalaryRevisionRecord>('/payroll/salary-revisions', {
        query: { employeeId, limit: 50 },
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
  const revisionRows = revisions.data?.data ?? [];
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
                  {canManage ? (
                    <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        role="switch"
                        className="size-4 accent-primary"
                        checked={row.isActive}
                        disabled={toggle.isPending}
                        onChange={(event) => toggle.mutate({ id: row.id, isActive: event.target.checked })}
                        aria-label={`${row.isActive ? 'Disable' : 'Enable'} ${row.componentName}`}
                      />
                      <span className={row.isActive ? '' : 'text-muted-foreground'}>
                        {row.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </label>
                  ) : (
                    <Badge variant={row.isActive ? 'success' : 'neutral'}>
                      {row.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrapper>
    );

  // Gross at rest: basic plus the allowances whose money is known now. A
  // percentage or per-unit allowance is priced by a run, so it is counted
  // rather than added, and the label says so.
  const fixedAllowances = allowances.filter((a) => a.isActive && a.calc === 'FIXED');
  const fixedDeductions = deductions.filter((d) => d.isActive && d.calc === 'FIXED');
  const variableAllowances = allowances.filter((a) => a.isActive && a.calc !== 'FIXED').length;
  const estimatedGross = current
    ? current.amount + fixedAllowances.reduce((sum, a) => sum + a.value, 0)
    : null;
  const estimatedNet =
    estimatedGross === null ? null : estimatedGross - fixedDeductions.reduce((sum, d) => sum + d.value, 0);
  const lastRevision = history[0] ?? null;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Banknote className="size-4" aria-hidden /> Compensation
          </CardTitle>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              {current ? (
                <Button size="sm" variant="outline" onClick={() => setEditing(current)}>
                  Edit
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => setIncrementOpen(true)}>
                <TrendingUp className="size-4" aria-hidden /> Record increment
              </Button>
              <Button size="sm" onClick={() => setSalaryOpen(true)}>
                <Plus className="size-4" aria-hidden /> Record salary
              </Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent>
          {current ? (
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="sm:col-span-2 lg:col-span-4 grid gap-4 sm:grid-cols-3 rounded-lg border border-border bg-surface-muted/40 p-3">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Estimated gross</dt>
                  <dd className="text-base font-semibold tabular-nums">{money(estimatedGross ?? 0, current.currency)}</dd>
                  <dd className="text-[11px] text-muted-foreground">
                    Basic + {fixedAllowances.length} fixed allowance{fixedAllowances.length === 1 ? '' : 's'}
                    {variableAllowances > 0 ? ` (+${variableAllowances} priced at run time)` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Estimated net</dt>
                  <dd className="text-base font-semibold tabular-nums">{money(estimatedNet ?? 0, current.currency)}</dd>
                  <dd className="text-[11px] text-muted-foreground">
                    After {fixedDeductions.length} fixed deduction{fixedDeductions.length === 1 ? '' : 's'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Last revision</dt>
                  <dd className="text-sm font-medium">{lastRevision ? day(lastRevision.effectiveFrom) : '—'}</dd>
                  <dd className="text-[11px] text-muted-foreground">{lastRevision?.note ?? 'No reason recorded'}</dd>
                </div>
              </div>
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
                    <TH>Reason</TH>
                    <TH>Status</TH>
                    {canManage ? <TH className="text-right">Actions</TH> : null}
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
                      <TD className="max-w-[18rem] truncate text-muted-foreground" title={row.note ?? ''}>
                        {row.note ?? '—'}
                      </TD>
                      <TD>
                        <Badge variant={row.isCurrent ? 'success' : 'neutral'}>
                          {row.isCurrent ? 'Current' : 'Superseded'}
                        </Badge>
                      </TD>
                      {canManage ? (
                        <TD className="text-right">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(row)}>
                            Edit
                          </Button>
                        </TD>
                      ) : null}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrapper>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Increments and revisions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {revisionRows.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">
              No increment has been recorded for this employee.
            </p>
          ) : (
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Effective</TH>
                    <TH>From</TH>
                    <TH>To</TH>
                    <TH>Increment</TH>
                    <TH>%</TH>
                    <TH>Reason</TH>
                    <TH>Approved by</TH>
                  </TR>
                </THead>
                <TBody>
                  {revisionRows.map((row) => (
                    <TR key={row.id}>
                      <TD className="whitespace-nowrap font-medium">{day(row.effectiveDate)}</TD>
                      <TD className="tabular-nums text-muted-foreground">
                        {money(row.currentAmount, row.currency)}
                      </TD>
                      <TD className="tabular-nums">{money(row.newAmount, row.currency)}</TD>
                      <TD className="tabular-nums">
                        {row.incrementAmount >= 0 ? '+' : ''}
                        {money(row.incrementAmount, row.currency)}
                      </TD>
                      <TD className="tabular-nums">
                        {row.incrementPercent >= 0 ? '+' : ''}
                        {row.incrementPercent}%
                      </TD>
                      <TD className="max-w-[16rem] truncate" title={row.reason}>
                        {row.reason}
                      </TD>
                      <TD className="text-muted-foreground">{row.approvedByName ?? '—'}</TD>
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
          <IncrementDialog
            employeeId={employeeId}
            employeeName={employeeName ?? history[0]?.employeeName ?? 'This employee'}
            current={current}
            currency={currency}
            open={incrementOpen}
            onClose={() => setIncrementOpen(false)}
          />
          <SalaryDialog
            employeeId={employeeId}
            employeeName={employeeName ?? history[0]?.employeeName}
            currency={currency}
            open={salaryOpen}
            onClose={() => setSalaryOpen(false)}
          />
          <SalaryDialog
            employeeId={employeeId}
            employeeName={employeeName ?? history[0]?.employeeName}
            currency={currency}
            existing={editing}
            open={editing !== null}
            onClose={() => setEditing(null)}
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
