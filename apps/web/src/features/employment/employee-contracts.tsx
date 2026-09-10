import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink, FileSignature, Plus } from 'lucide-react';
import {
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPES,
  CONTRACT_TYPE_LABELS,
  PERMISSIONS,
  contractInputSchema,
  type ContractInput,
  type ContractRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/states';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { usePermissions } from '@/features/auth/session-context';
import {
  CONTRACT_EXPIRY_TONE,
  CONTRACT_STATUS_TONE,
  expiryLabel,
  isoDay,
  todayLocal,
} from './employment-shared';

/**
 * Contracts, on the employee profile.
 *
 * The whole history, newest first, with the current one at the top - because
 * "what are they on now?" and "what were they on in March?" are both questions
 * this tab exists to answer, and only one of them is served by showing the
 * latest record alone.
 *
 * Renewing is the primary action rather than editing. Editing a contract that
 * has run out to say something else destroys the evidence of what it said;
 * renewing writes a new one and closes the old, which is what actually
 * happened.
 */

export function ContractDialog({
  employeeId,
  employeeName,
  /** Set to renew this contract: it is closed and the new one points back. */
  renewing = null,
  open,
  onClose,
}: {
  employeeId: string;
  employeeName?: string;
  renewing?: ContractRecord | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const blank = React.useCallback(
    (): ContractInput => ({
      employeeId,
      contractType: renewing?.contractType ?? 'PERMANENT',
      status: 'ACTIVE',
      reference: null,
      // A renewal naturally starts the day after the contract it replaces ends.
      startDate: renewing?.endDate ? nextDay(renewing.endDate) : todayLocal(),
      endDate: null,
      documentUrl: null,
      documentName: null,
      notes: null,
      previousContractId: renewing?.id ?? null,
    }),
    [employeeId, renewing],
  );

  const form = useForm<ContractInput>({
    resolver: zodResolver(contractInputSchema),
    defaultValues: blank(),
  });

  React.useEffect(() => {
    if (open) {
      form.reset(blank());
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employeeId, renewing?.id]);

  const save = useMutation({
    mutationFn: (values: ContractInput) => api.post('/contracts', values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['contracts'] });
      toast.success(renewing ? 'Contract renewed' : 'Contract recorded', {
        description: renewing
          ? 'The previous contract is marked renewed and kept on the record.'
          : 'It appears in the contract history immediately.',
      });
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        const unplaced: string[] = [];
        for (const [field, messages] of Object.entries(error.details)) {
          const message = messages[0] ?? 'Invalid value.';
          if (field in form.getValues()) {
            form.setError(field as keyof ContractInput, { message });
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

  const contractType = form.watch('contractType');
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
            <DialogTitle>{renewing ? 'Renew contract' : 'Record a contract'}</DialogTitle>
            <DialogDescription>
              {renewing
                ? `The current contract is kept and marked renewed. ${employeeName ?? 'The employee'} keeps every record attached to it.`
                : 'Contracts are kept forever. Ending one sets a status; nothing is ever removed.'}
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

            <input type="hidden" {...form.register('employeeId')} />
            <input type="hidden" {...form.register('previousContractId')} />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Contract type"
                htmlFor="contract-type"
                required
                error={errors.contractType?.message}
              >
                <NativeSelect id="contract-type" {...form.register('contractType')}>
                  {CONTRACT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {CONTRACT_TYPE_LABELS[type]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField label="Status" htmlFor="contract-status" error={errors.status?.message}>
                <NativeSelect id="contract-status" {...form.register('status')}>
                  {CONTRACT_STATUSES.filter((s) => s !== 'RENEWED').map((status) => (
                    <option key={status} value={status}>
                      {CONTRACT_STATUS_LABELS[status]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Start date"
                htmlFor="contract-start"
                required
                error={errors.startDate?.message}
              >
                <Input id="contract-start" type="date" {...form.register('startDate')} />
              </FormField>

              <FormField
                label="End date"
                htmlFor="contract-end"
                hint={
                  contractType === 'FIXED_TERM'
                    ? 'Required for a fixed-term contract.'
                    : 'Leave empty for an open-ended contract.'
                }
                error={errors.endDate?.message}
              >
                <Input
                  id="contract-end"
                  type="date"
                  {...form.register('endDate', { setValueAs: blankToNull })}
                />
              </FormField>

              <FormField
                label="Reference"
                htmlFor="contract-reference"
                hint="The number on the paperwork, if there is one."
                error={errors.reference?.message}
              >
                <Input
                  id="contract-reference"
                  {...form.register('reference', { setValueAs: blankToNull })}
                />
              </FormField>

              <FormField
                label="Document name"
                htmlFor="contract-doc-name"
                error={errors.documentName?.message}
              >
                <Input
                  id="contract-doc-name"
                  placeholder="Signed contract.pdf"
                  {...form.register('documentName', { setValueAs: blankToNull })}
                />
              </FormField>

              <FormField
                label="Document link"
                htmlFor="contract-doc"
                className="sm:col-span-2"
                hint="A link to where the signed contract is stored. File uploads arrive with the Documents module."
                error={errors.documentUrl?.message}
              >
                <Input
                  id="contract-doc"
                  placeholder="https://"
                  {...form.register('documentUrl', { setValueAs: blankToNull })}
                />
              </FormField>

              <FormField
                label="Notes"
                htmlFor="contract-notes"
                className="sm:col-span-2"
                error={errors.notes?.message}
              >
                <Textarea
                  id="contract-notes"
                  rows={3}
                  {...form.register('notes', { setValueAs: blankToNull })}
                />
              </FormField>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {renewing ? 'Renew contract' : 'Save contract'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const blankToNull = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

/** The calendar day after a yyyy-MM-dd date, in UTC so it never slips. */
function nextDay(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function EmployeeContracts({
  employeeId,
  employeeName,
}: {
  employeeId: string;
  employeeName: string;
}) {
  const { has } = usePermissions();
  const canRead = has(PERMISSIONS.CONTRACT_READ);
  const canManage = has(PERMISSIONS.CONTRACT_MANAGE);

  const [creating, setCreating] = React.useState(false);
  const [renewing, setRenewing] = React.useState<ContractRecord | null>(null);

  const query = useQuery({
    queryKey: ['contracts', { employeeId }],
    queryFn: () =>
      api.getPage<ContractRecord>('/contracts', { query: { employeeId, limit: 100 } }),
    enabled: canRead && employeeId !== '',
  });

  if (!canRead) return null;

  if (query.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contracts</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32" />
        </CardContent>
      </Card>
    );
  }

  const rows = query.data?.data ?? [];
  // The list arrives newest first, so the current contract is the first one
  // that has not been superseded or torn up.
  const current = rows.find((row) => row.status === 'ACTIVE') ?? null;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <FileSignature className="size-4" aria-hidden /> Current contract
          </CardTitle>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              {current ? (
                <Button size="sm" variant="outline" onClick={() => setRenewing(current)}>
                  Renew
                </Button>
              ) : null}
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-4" aria-hidden /> Record contract
              </Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent>
          {current ? (
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Type</dt>
                <dd className="text-sm font-medium">
                  {CONTRACT_TYPE_LABELS[current.contractType]}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Starts</dt>
                <dd className="text-sm font-medium">{isoDay(current.startDate)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Ends</dt>
                <dd className="text-sm font-medium">
                  {current.endDate ? isoDay(current.endDate) : 'Open-ended'}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Expiry</dt>
                <dd className="mt-0.5">
                  <Badge variant={CONTRACT_EXPIRY_TONE[current.expiryState]}>
                    {expiryLabel(current.expiryState, current.daysRemaining)}
                  </Badge>
                </dd>
              </div>
              {current.reference ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Reference
                  </dt>
                  <dd className="font-mono text-sm">{current.reference}</dd>
                </div>
              ) : null}
              {current.documentUrl ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Document
                  </dt>
                  <dd className="text-sm">
                    <a
                      href={current.documentUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      {current.documentName ?? 'Open'}
                      <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                  </dd>
                </div>
              ) : null}
              {current.notes ? (
                <div className="sm:col-span-2 lg:col-span-4">
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Notes</dt>
                  <dd className="text-sm">{current.notes}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <EmptyState
              icon={FileSignature}
              title="No active contract"
              description={
                canManage
                  ? 'Record one so the employment terms are on file.'
                  : 'Nobody has recorded a contract for this employee yet.'
              }
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contract history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">Nothing recorded yet.</p>
          ) : (
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Type</TH>
                    <TH>From</TH>
                    <TH>To</TH>
                    <TH>Status</TH>
                    <TH>Expiry</TH>
                    <TH>Reference</TH>
                    <TH>Document</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={row.id}>
                      <TD className="font-medium">{CONTRACT_TYPE_LABELS[row.contractType]}</TD>
                      <TD className="whitespace-nowrap">{isoDay(row.startDate)}</TD>
                      <TD className="whitespace-nowrap text-muted-foreground">
                        {row.endDate ? isoDay(row.endDate) : '—'}
                      </TD>
                      <TD>
                        <Badge variant={CONTRACT_STATUS_TONE[row.status]}>
                          {CONTRACT_STATUS_LABELS[row.status]}
                        </Badge>
                      </TD>
                      <TD>
                        <span className="text-[12.5px] text-muted-foreground">
                          {expiryLabel(row.expiryState, row.daysRemaining)}
                        </span>
                      </TD>
                      <TD className="font-mono text-[12.5px] text-muted-foreground">
                        {row.reference ?? '—'}
                      </TD>
                      <TD>
                        {row.documentUrl ? (
                          <a
                            href={row.documentUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                          >
                            {row.documentName ?? 'Open'}
                            <ExternalLink className="size-3.5" aria-hidden />
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrapper>
          )}
        </CardContent>
      </Card>

      <ContractDialog
        employeeId={employeeId}
        employeeName={employeeName}
        open={creating || renewing !== null}
        renewing={renewing}
        onClose={() => {
          setCreating(false);
          setRenewing(null);
        }}
      />
    </div>
  );
}
