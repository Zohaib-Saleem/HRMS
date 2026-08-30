import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Layers3, Plus } from 'lucide-react';
import {
  PAYROLL_COMPONENT_CALCS,
  PAYROLL_COMPONENT_CALC_LABELS,
  PAYROLL_COMPONENT_KINDS,
  PERMISSIONS,
  salaryComponentSchema,
  type SalaryComponentInput,
  type SalaryComponentRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
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
import { Can } from '@/features/auth/session-context';

/**
 * The catalogue of things that can appear on a payslip besides basic pay.
 *
 * A definition only. What any particular person receives is an assignment on
 * their payroll profile - splitting the two is what lets a company rename
 * "Conveyance" to "Transport" without touching anyone's pay.
 *
 * Components are deactivated rather than deleted: a finalized payslip names the
 * component it paid, and that name has to keep meaning something.
 */

export function SalaryComponentsPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [editing, setEditing] = React.useState<SalaryComponentRecord | null>(null);
  const [creating, setCreating] = React.useState(false);

  const query = useQuery({
    queryKey: ['salary-components', page],
    queryFn: () =>
      api.getPage<SalaryComponentRecord>('/payroll/components', { query: { page, limit: 25 } }),
    placeholderData: keepPreviousData,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['salary-components'] });
  };

  const rows = query.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Salary components"
        description="Allowances, bonuses and recurring deductions that can be assigned to an employee."
        actions={
          <Can permission={PERMISSIONS.PAYROLL_MANAGE}>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              New component
            </Button>
          </Can>
        }
      />

      <Card className="overflow-hidden">
        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Name</TH>
                    <TH className="w-24">Code</TH>
                    <TH className="w-28">Type</TH>
                    <TH className="w-48">Calculated as</TH>
                    <TH className="w-24 text-right">Assigned</TH>
                    <TH className="w-28">Status</TH>
                    <TH className="w-24 text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={5} columns={7} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={7} className="p-0">
                        <EmptyState
                          icon={Layers3}
                          title="No components yet"
                          description="Add a transport allowance, a bonus or a loan repayment, then assign it to people."
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((component) => (
                      <TR key={component.id}>
                        <TD className="text-[13px] font-medium">
                          {component.name}
                          {component.description ? (
                            <span className="block text-[12px] font-normal text-muted-foreground">
                              {component.description}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="tabular text-[12.5px] text-muted-foreground">
                          {component.code ?? '--'}
                        </TD>
                        <TD>
                          <Badge variant={component.kind === 'EARNING' ? 'success' : 'warning'}>
                            {component.kind === 'EARNING' ? 'Earning' : 'Deduction'}
                          </Badge>
                        </TD>
                        <TD className="text-[12.5px] text-muted-foreground">
                          {PAYROLL_COMPONENT_CALC_LABELS[component.calc]}
                          {component.isTaxable ? (
                            <span className="block text-[11.5px]">Taxable</span>
                          ) : null}
                        </TD>
                        <TD className="tabular text-right text-[13px]">
                          {component.assignedCount}
                        </TD>
                        <TD>
                          <Badge variant={component.isActive ? 'success' : 'neutral'}>
                            {component.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </TD>
                        <TD>
                          <div className="flex justify-end">
                            <Can permission={PERMISSIONS.PAYROLL_MANAGE}>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditing(component)}
                              >
                                Edit
                              </Button>
                            </Can>
                          </div>
                        </TD>
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
                onPageChange={setPage}
              />
            ) : null}
          </>
        )}
      </Card>

      {creating || editing ? (
        <ComponentDialog
          component={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={refresh}
        />
      ) : null}
    </>
  );
}

function ComponentDialog({
  component,
  onClose,
  onSaved,
}: {
  component: SalaryComponentRecord | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isEdit = component !== null;

  const { register, handleSubmit, formState, setError } = useForm<SalaryComponentInput>({
    resolver: zodResolver(salaryComponentSchema),
    values: component
      ? {
          name: component.name,
          code: component.code ?? '',
          description: component.description ?? '',
          kind: component.kind,
          calc: component.calc,
          isTaxable: component.isTaxable,
          isActive: component.isActive,
        }
      : {
          name: '',
          code: '',
          description: '',
          kind: 'EARNING',
          calc: 'FIXED',
          isTaxable: true,
          isActive: true,
        },
  });

  const mutation = useMutation({
    mutationFn: (values: SalaryComponentInput) => {
      const payload = {
        ...values,
        code: values.code || null,
        description: values.description || null,
      };
      return isEdit
        ? api.patch(`/payroll/components/${component.id}`, payload)
        : api.post('/payroll/components', payload);
    },
    onSuccess: async () => {
      toast.success(isEdit ? 'Component updated.' : 'Component created.');
      await onSaved();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof SalaryComponentInput, { message: messages[0] });
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
            <DialogTitle>{isEdit ? `Edit ${component.name}` : 'New salary component'}</DialogTitle>
            <DialogDescription>
              A definition. What each employee receives is set on their payroll profile.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Name"
              htmlFor="component-name"
              error={formState.errors.name?.message}
              required
              className="sm:col-span-2"
            >
              <Input {...register('name')} autoFocus placeholder="Transport allowance" />
            </FormField>
            <FormField label="Code" htmlFor="component-code" error={formState.errors.code?.message}>
              <Input {...register('code')} className="tabular" placeholder="TRANSPORT" />
            </FormField>
            <FormField
              label="Type"
              htmlFor="component-kind"
              error={formState.errors.kind?.message}
              required
            >
              <NativeSelect {...register('kind')}>
                {PAYROLL_COMPONENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k === 'EARNING' ? 'Earning' : 'Deduction'}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField
              label="Calculated as"
              htmlFor="component-calc"
              error={formState.errors.calc?.message}
              required
              className="sm:col-span-2"
              hint="A percentage of gross is read against everything above it on the payslip."
            >
              <NativeSelect {...register('calc')}>
                {PAYROLL_COMPONENT_CALCS.map((c) => (
                  <option key={c} value={c}>
                    {PAYROLL_COMPONENT_CALC_LABELS[c]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField
              label="Description"
              htmlFor="component-description"
              error={formState.errors.description?.message}
              className="sm:col-span-2"
            >
              <Textarea {...register('description')} rows={2} placeholder="Optional" />
            </FormField>
            <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px]">
              <input
                type="checkbox"
                {...register('isTaxable')}
                className="size-4 shrink-0 rounded border-input accent-[var(--primary)]"
              />
              Taxable
            </label>
            <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px]">
              <input
                type="checkbox"
                {...register('isActive')}
                className="size-4 shrink-0 rounded border-input accent-[var(--primary)]"
              />
              Active
            </label>
            <p className="text-[12px] text-muted-foreground sm:col-span-2">
              Nothing computes tax today. The taxable flag is stored so a tax module has something
              to read later without every component having to be revisited.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isEdit ? 'Save component' : 'Create component'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
