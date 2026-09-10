import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink, Plus, ScrollText, Users } from 'lucide-react';
import {
  PERMISSIONS,
  POLICY_ACKNOWLEDGEMENT_LABELS,
  POLICY_ACKNOWLEDGEMENT_STATUSES,
  policyInputSchema,
  type PolicyAssignmentRecord,
  type PolicyInput,
  type PolicyRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
import { POLICY_STATUS_TONE, isoDay, todayLocal } from './employment-shared';

/**
 * Company policies, their versions, and who has signed off on each.
 *
 * Publishing a new version supersedes the old one rather than editing it: the
 * form offers "New version of" precisely so nobody has to choose between
 * changing the text under existing signatures and losing the version history.
 * The old version is deactivated - not deleted - and every acknowledgement it
 * collected stays exactly where it was.
 */

const INITIAL = { q: '', isActive: '', page: 1, limit: 20 };

const blankToNull = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

function PolicyDialog({
  open,
  onClose,
  supersedes,
  policies,
}: {
  open: boolean;
  onClose: () => void;
  /** Pre-selects the version this one replaces. */
  supersedes: PolicyRecord | null;
  policies: PolicyRecord[];
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const blank = React.useCallback(
    (): PolicyInput => ({
      name: supersedes?.name ?? '',
      version: supersedes ? nextVersion(supersedes.version) : '1.0',
      category: supersedes?.category ?? null,
      description: supersedes?.description ?? null,
      effectiveDate: todayLocal(),
      documentUrl: null,
      documentName: null,
      isActive: true,
      supersedesId: supersedes?.id ?? null,
    }),
    [supersedes],
  );

  const form = useForm<PolicyInput>({
    resolver: zodResolver(policyInputSchema),
    defaultValues: blank(),
  });

  React.useEffect(() => {
    if (open) {
      form.reset(blank());
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, supersedes?.id]);

  const save = useMutation({
    mutationFn: (values: PolicyInput) => api.post('/policies', values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['policies'] });
      toast.success('Policy published', {
        description: supersedes
          ? 'The previous version is withdrawn from assignment; its acknowledgements are kept.'
          : 'Assign it to employees to start collecting acknowledgements.',
      });
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        const unplaced: string[] = [];
        for (const [field, messages] of Object.entries(error.details)) {
          const message = messages[0] ?? 'Invalid value.';
          if (field in form.getValues()) {
            form.setError(field as keyof PolicyInput, { message });
          } else {
            unplaced.push(message);
          }
        }
        if (unplaced.length > 0) setFormError(unplaced.join(' '));
        return;
      }
      setFormError(errorMessage(error));
    },
  });

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <form
          onSubmit={form.handleSubmit((values) => save.mutate(values))}
          className="contents"
          noValidate
        >
          <DialogHeader>
            <DialogTitle>{supersedes ? 'Publish a new version' : 'Publish a policy'}</DialogTitle>
            <DialogDescription>
              {supersedes
                ? `Version ${supersedes.version} is withdrawn from further assignment. Everything already acknowledged against it stays on the record.`
                : 'A policy version is fixed once somebody acknowledges it. Changing the text later means publishing a new version.'}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {formError ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive"
              >
                {formError}
              </p>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Policy name"
                htmlFor="policy-name"
                required
                className="sm:col-span-2"
                error={errors.name?.message}
              >
                <Input id="policy-name" autoFocus {...form.register('name')} />
              </FormField>

              <FormField
                label="Version"
                htmlFor="policy-version"
                required
                hint="Whatever your company calls it: 1.0, Rev C, 2026-Q1."
                error={errors.version?.message}
              >
                <Input id="policy-version" {...form.register('version')} />
              </FormField>

              <FormField
                label="Effective date"
                htmlFor="policy-effective"
                required
                error={errors.effectiveDate?.message}
              >
                <Input id="policy-effective" type="date" {...form.register('effectiveDate')} />
              </FormField>

              <FormField label="Category" htmlFor="policy-category" error={errors.category?.message}>
                <Input
                  id="policy-category"
                  placeholder="Conduct, Security, Leave"
                  {...form.register('category', { setValueAs: blankToNull })}
                />
              </FormField>

              <FormField
                label="Replaces version"
                htmlFor="policy-supersedes"
                hint="Leave blank for a brand new policy."
                error={errors.supersedesId?.message}
              >
                <NativeSelect
                  id="policy-supersedes"
                  {...form.register('supersedesId', { setValueAs: blankToNull })}
                >
                  <option value="">Nothing</option>
                  {policies.map((policy) => (
                    <option key={policy.id} value={policy.id}>
                      {policy.name} v{policy.version}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Document name"
                htmlFor="policy-doc-name"
                error={errors.documentName?.message}
              >
                <Input
                  id="policy-doc-name"
                  placeholder="Employee handbook.pdf"
                  {...form.register('documentName', { setValueAs: blankToNull })}
                />
              </FormField>

              <FormField
                label="Document link"
                htmlFor="policy-doc"
                hint="Where employees can read it. File uploads arrive with the Documents module."
                error={errors.documentUrl?.message}
              >
                <Input
                  id="policy-doc"
                  placeholder="https://"
                  {...form.register('documentUrl', { setValueAs: blankToNull })}
                />
              </FormField>

              <FormField
                label="Description"
                htmlFor="policy-description"
                className="sm:col-span-2"
                error={errors.description?.message}
              >
                <Textarea
                  id="policy-description"
                  rows={3}
                  {...form.register('description', { setValueAs: blankToNull })}
                />
              </FormField>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Publish
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "1.0" -> "1.1"; anything unparseable falls back to appending a suffix. */
function nextVersion(version: string): string {
  const match = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return `${version}-next`;
  return `${match[1]}.${Number(match[2]) + 1}`;
}

/** Who holds one policy, and what they said about it. */
function AssignmentsDialog({
  policy,
  onClose,
}: {
  policy: PolicyRecord | null;
  onClose: () => void;
}) {
  const [status, setStatus] = React.useState('');

  const query = useQuery({
    queryKey: ['policy-assignments', { policyId: policy?.id, status }],
    queryFn: () =>
      api.getPage<PolicyAssignmentRecord>('/policy-assignments', {
        query: { policyId: policy?.id, status: status || undefined, limit: 200 },
      }),
    enabled: policy !== null,
  });

  const rows = query.data?.data ?? [];

  return (
    <Dialog open={policy !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent variant="drawer" size="lg">
        <DialogHeader>
          <DialogTitle>
            {policy?.name} v{policy?.version}
          </DialogTitle>
          <DialogDescription>
            {policy?.acknowledgedCount ?? 0} of {policy?.assignedCount ?? 0} assigned employees have
            acknowledged this version.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="mb-4">
            <NativeSelect
              aria-label="Acknowledgement status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="sm:w-56"
            >
              <option value="">All responses</option>
              {POLICY_ACKNOWLEDGEMENT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {POLICY_ACKNOWLEDGEMENT_LABELS[value]}
                </option>
              ))}
            </NativeSelect>
          </div>

          {rows.length === 0 ? (
            <EmptyState
              icon={Users}
              title="Nobody assigned yet"
              description="Assign the policy to employees to start collecting acknowledgements."
            />
          ) : (
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Employee</TH>
                    <TH>Assigned</TH>
                    <TH>Due</TH>
                    <TH>Status</TH>
                    <TH>Responded</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={row.id}>
                      <TD>
                        <p className="text-[13.5px] font-medium">{row.employeeName}</p>
                        <p className="font-mono text-[11.5px] text-muted-foreground">
                          {row.employeeNumber}
                        </p>
                      </TD>
                      <TD className="whitespace-nowrap text-[13px]">
                        {isoDay(row.assignedAt.slice(0, 10))}
                      </TD>
                      <TD className="whitespace-nowrap text-[13px] text-muted-foreground">
                        {row.dueDate ? isoDay(row.dueDate) : '—'}
                      </TD>
                      <TD>
                        <Badge variant={POLICY_STATUS_TONE[row.status]}>
                          {POLICY_ACKNOWLEDGEMENT_LABELS[row.status]}
                        </Badge>
                      </TD>
                      <TD className="whitespace-nowrap text-[13px] text-muted-foreground">
                        {row.acknowledgedAt ? isoDay(row.acknowledgedAt.slice(0, 10)) : '—'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrapper>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function PoliciesPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.POLICY_MANAGE);
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [filters, setFilters] = React.useState(INITIAL);
  const [creating, setCreating] = React.useState(false);
  const [superseding, setSuperseding] = React.useState<PolicyRecord | null>(null);
  const [viewing, setViewing] = React.useState<PolicyRecord | null>(null);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['policies', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<PolicyRecord>('/policies', {
        query: {
          q: debouncedQuery || undefined,
          isActive: filters.isActive || undefined,
          page: filters.page,
          limit: filters.limit,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const assign = useMutation({
    mutationFn: (policyId: string) =>
      api.post<{ assigned: number; alreadyAssigned: number }>('/policies/assign', {
        policyId,
        employeeIds: [],
      }),
    onSuccess: async (result: { assigned: number; alreadyAssigned: number }) => {
      await queryClient.invalidateQueries({ queryKey: ['policies'] });
      await queryClient.invalidateQueries({ queryKey: ['policy-assignments'] });
      toast.success(`Assigned to ${result.assigned} employee(s)`, {
        description:
          result.alreadyAssigned > 0
            ? `${result.alreadyAssigned} already held this version and were left untouched.`
            : undefined,
      });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;
  const hasActiveFilters = filters.q !== '' || filters.isActive !== '';

  const handleAssign = async (policy: PolicyRecord) => {
    const ok = await confirm({
      title: `Assign ${policy.name} v${policy.version} to everyone?`,
      description:
        'Every employee still in service gets it. Anyone who already holds this version keeps the response they gave.',
      confirmLabel: 'Assign to all',
    });
    if (ok) assign.mutate(policy.id);
  };

  return (
    <>
      <PageHeader
        title="Policies"
        description="Policy documents, their versions and who has acknowledged each one."
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              Publish a policy
            </Button>
          ) : null
        }
      />

      <Card>
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search policies"
          hasActiveFilters={hasActiveFilters}
          onReset={() => setFilters(INITIAL)}
          filters={
            <NativeSelect
              aria-label="Availability"
              value={filters.isActive}
              onChange={(event) => update({ isActive: event.target.value })}
              className="xl:w-48"
            >
              <option value="">All versions</option>
              <option value="true">Current only</option>
              <option value="false">Withdrawn only</option>
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
                  <TR>
                    <TH>Policy</TH>
                    <TH>Version</TH>
                    <TH>Effective</TH>
                    <TH>Acknowledged</TH>
                    <TH>Document</TH>
                    <TH>Status</TH>
                    {canManage ? <TH className="text-right">Actions</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={5} columns={canManage ? 7 : 6} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={canManage ? 7 : 6} className="p-0">
                        <EmptyState
                          icon={ScrollText}
                          title={hasActiveFilters ? 'No policies match' : 'No policies yet'}
                          description="Publish a policy, then assign it to the employees who need to acknowledge it."
                          action={
                            canManage && !hasActiveFilters ? (
                              <Button size="sm" onClick={() => setCreating(true)}>
                                <Plus className="size-4" aria-hidden />
                                Publish a policy
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
                          <button
                            type="button"
                            onClick={() => setViewing(row)}
                            className="text-left text-[13.5px] font-medium text-primary hover:underline"
                          >
                            {row.name}
                          </button>
                          {row.category ? (
                            <p className="text-[12px] text-muted-foreground">{row.category}</p>
                          ) : null}
                        </TD>
                        <TD className="font-mono text-[12.5px]">{row.version}</TD>
                        <TD className="whitespace-nowrap text-[13px]">
                          {isoDay(row.effectiveDate)}
                        </TD>
                        <TD className="tabular text-[13px]">
                          {row.acknowledgedCount}/{row.assignedCount}
                        </TD>
                        <TD>
                          {row.documentUrl ? (
                            <a
                              href={row.documentUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 text-[13px] text-primary hover:underline"
                            >
                              {row.documentName ?? 'Open'}
                              <ExternalLink className="size-3.5" aria-hidden />
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TD>
                        <TD>
                          <Badge variant={row.isActive ? 'success' : 'neutral'}>
                            {row.isActive ? 'Current' : 'Withdrawn'}
                          </Badge>
                        </TD>
                        {canManage ? (
                          <TD>
                            <div className="flex justify-end gap-1">
                              {row.isActive ? (
                                <>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={assign.isPending}
                                    onClick={() => void handleAssign(row)}
                                  >
                                    Assign to all
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setSuperseding(row)}
                                  >
                                    New version
                                  </Button>
                                </>
                              ) : null}
                            </div>
                          </TD>
                        ) : null}
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>
            {meta ? <Pagination meta={meta} onPageChange={(page) => update({ page })} /> : null}
          </>
        )}
      </Card>

      <PolicyDialog
        open={creating || superseding !== null}
        supersedes={superseding}
        policies={rows.filter((row) => row.isActive)}
        onClose={() => {
          setCreating(false);
          setSuperseding(null);
        }}
      />
      <AssignmentsDialog policy={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
