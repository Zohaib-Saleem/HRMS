import * as React from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2, Users } from 'lucide-react';
import {
  MEDICAL_DEPENDENT_STATUSES,
  MEDICAL_DEPENDENT_STATUS_LABELS,
  MEDICAL_GENDERS,
  MEDICAL_RELATIONSHIPS,
  MEDICAL_RELATIONSHIP_LABELS,
  type MedicalBenefitView,
  type MedicalDependentRecord,
  type MedicalDependentStatus,
  type MedicalGender,
  type MedicalRelationship,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField, Input, NativeSelect } from '@/components/ui/field';
import { EmptyState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { isoDay, money } from '@/features/employment/employment-shared';

/**
 * Who the benefit covers, and - for HR - the only place that list is changed.
 *
 * Dependents are HR-maintained rather than self-service, because they decide
 * who a company pays for. An employee sees exactly who is on their record and
 * which of them are covered, and cannot add to it; the buttons below appear
 * only when the server said `canManageDependents`, and the endpoints check
 * again regardless.
 *
 * `covered` is never computed here. Whether somebody is covered depends on the
 * policy in force and on how many dependents of that relationship were
 * registered ahead of them, so the server decides it on every read - which is
 * also why a dependent over the maximum is accepted rather than refused. The
 * record keeps the family's real shape, and raising the maximum later covers
 * them without anybody re-keying anything.
 */

interface DependentFormValues {
  name: string;
  relationship: MedicalRelationship;
  dateOfBirth: string;
  gender: '' | MedicalGender;
  status: MedicalDependentStatus;
}

const GENDER_LABELS: Record<MedicalGender, string> = {
  MALE: 'Male',
  FEMALE: 'Female',
  OTHER: 'Other',
  PREFER_NOT_TO_SAY: 'Prefer not to say',
};

function DependentDialog({
  open,
  onClose,
  /** Present when correcting an existing record rather than adding one. */
  dependent,
  employeeId,
}: {
  open: boolean;
  onClose: () => void;
  dependent?: MedicalDependentRecord;
  /** Whose record. Omitted means the caller's own, as the endpoint resolves it. */
  employeeId?: string;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const blank = React.useCallback(
    (): DependentFormValues => ({
      name: dependent?.name ?? '',
      relationship: dependent?.relationship ?? 'CHILD',
      dateOfBirth: dependent?.dateOfBirth ?? '',
      gender: dependent?.gender ?? '',
      status: dependent?.status ?? 'ACTIVE',
    }),
    [dependent],
  );

  const form = useForm<DependentFormValues>({ defaultValues: blank() });

  React.useEffect(() => {
    if (open) {
      form.reset(blank());
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dependent?.id]);

  const save = useMutation({
    mutationFn: (values: DependentFormValues) => {
      const body = {
        name: values.name,
        relationship: values.relationship,
        dateOfBirth: values.dateOfBirth || null,
        gender: values.gender || null,
        status: values.status,
      };
      return dependent
        ? api.patch(`/medical/dependents/${dependent.id}`, body)
        : api.post('/medical/dependents', { ...body, employeeId });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['medical'] });
      toast.success(dependent ? 'Dependent updated' : 'Dependent added', {
        description: 'Coverage is decided by the policy in force, so it is shown on the list.',
      });
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        const unplaced: string[] = [];
        for (const [field, messages] of Object.entries(error.details)) {
          const message = messages[0] ?? 'Invalid value.';
          if (field in form.getValues()) {
            form.setError(field as keyof DependentFormValues, { message });
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
      <DialogContent>
        <form
          onSubmit={form.handleSubmit((values) => save.mutate(values))}
          className="contents"
          noValidate
        >
          <DialogHeader>
            <DialogTitle>{dependent ? 'Edit dependent' : 'Add a dependent'}</DialogTitle>
            <DialogDescription>
              A name, a relationship and a date of birth is everything the policy needs. Nothing
              here records a condition.
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
                label="Name"
                htmlFor="dependent-name"
                required
                className="sm:col-span-2"
                error={errors.name?.message}
              >
                <Input
                  id="dependent-name"
                  autoFocus
                  {...form.register('name', { required: 'Enter the name.' })}
                />
              </FormField>

              <FormField label="Relationship" htmlFor="dependent-relationship" required>
                <NativeSelect id="dependent-relationship" {...form.register('relationship')}>
                  {MEDICAL_RELATIONSHIPS.map((value) => (
                    <option key={value} value={value}>
                      {MEDICAL_RELATIONSHIP_LABELS[value]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Date of birth"
                htmlFor="dependent-dob"
                hint="Optional, but some policies cover children only to a certain age."
                error={errors.dateOfBirth?.message}
              >
                <Input id="dependent-dob" type="date" {...form.register('dateOfBirth')} />
              </FormField>

              <FormField label="Gender" htmlFor="dependent-gender">
                <NativeSelect id="dependent-gender" {...form.register('gender')}>
                  <option value="">Not recorded</option>
                  {MEDICAL_GENDERS.map((value) => (
                    <option key={value} value={value}>
                      {GENDER_LABELS[value]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="Status"
                htmlFor="dependent-status"
                hint="Inactive keeps the record but covers nobody."
              >
                <NativeSelect id="dependent-status" {...form.register('status')}>
                  {MEDICAL_DEPENDENT_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {MEDICAL_DEPENDENT_STATUS_LABELS[value]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {dependent ? 'Save changes' : 'Add dependent'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Who the policy covers, in one readable sentence. */
function coverageSentence(coverage: MedicalBenefitView['dependentCoverage']): string {
  const parts: string[] = [];
  if (coverage.spouseCovered) parts.push('a spouse');
  if (coverage.childrenCovered) parts.push(`up to ${coverage.maxChildren} children`);
  if (coverage.parentsCovered) parts.push(`up to ${coverage.maxParents} parents`);
  return parts.length === 0
    ? 'The policy currently covers no dependents.'
    : `The policy covers ${parts.join(', ')}.`;
}

export function MedicalDependentsCard({ view }: { view: MedicalBenefitView }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<MedicalDependentRecord | null>(null);

  const canManage = view.canManageDependents;

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/medical/dependents/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['medical'] });
      toast.success('Dependent removed', {
        description: 'A dependent named by a claim is kept as inactive instead, so paid claims stay readable.',
      });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const handleRemove = async (dependent: MedicalDependentRecord) => {
    const ok = await confirm({
      title: `Remove ${dependent.name}?`,
      description:
        'They stop being covered from now on. If any claim names them the record is kept as inactive rather than deleted, so a paid claim still says who it was for.',
      confirmLabel: 'Remove dependent',
      tone: 'destructive',
    });
    if (ok) remove.mutate(dependent.id);
  };

  return (
    <>
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4" aria-hidden /> Dependents
            </CardTitle>
            <CardDescription>
              {view.dependentCoverage.sharesEmployeeLimit
                ? 'Dependents draw on the employee annual limit.'
                : `Dependents have a separate limit of ${money(
                    view.dependentCoverage.separateAnnualLimit ?? 0,
                    view.currency,
                  )}.`}{' '}
              {coverageSentence(view.dependentCoverage)}
            </CardDescription>
          </div>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden />
              Add
            </Button>
          ) : null}
        </CardHeader>

        <CardContent>
          {view.dependents.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No dependents recorded"
              description={
                canManage
                  ? 'Add anyone this benefit should extend to.'
                  : 'Ask HR to add anyone your benefit should extend to.'
              }
            />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {view.dependents.map((dependent) => (
                <li key={dependent.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {dependent.name}
                      {dependent.status === 'INACTIVE' ? (
                        <Badge variant="neutral" className="ml-2">
                          Inactive
                        </Badge>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {MEDICAL_RELATIONSHIP_LABELS[dependent.relationship]}
                      {dependent.dateOfBirth ? ` · born ${isoDay(dependent.dateOfBirth)}` : ''}
                      {dependent.coverageNote ? ` · ${dependent.coverageNote}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Badge variant={dependent.covered ? 'success' : 'neutral'}>
                      {dependent.covered ? 'Covered' : 'Not covered'}
                    </Badge>
                    {canManage ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Edit ${dependent.name}`}
                          onClick={() => setEditing(dependent)}
                        >
                          <Pencil className="size-4" aria-hidden />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          aria-label={`Remove ${dependent.name}`}
                          disabled={remove.isPending}
                          onClick={() => void handleRemove(dependent)}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canManage ? (
        <>
          <DependentDialog
            open={adding}
            onClose={() => setAdding(false)}
            employeeId={view.employeeId}
          />
          <DependentDialog
            open={editing !== null}
            onClose={() => setEditing(null)}
            dependent={editing ?? undefined}
            employeeId={view.employeeId}
          />
        </>
      ) : null}
    </>
  );
}
