import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { GraduationCap, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  PERMISSIONS,
  educationInputSchema,
  type EducationInput,
  type EmployeeEducationRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField, Input } from '@/components/ui/field';
import { EmptyState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { Can, usePermissions } from '@/features/auth/session-context';

/**
 * Qualifications, with the management HR needs to correct them.
 *
 * Most of these rows arrived from the employee master roster, where a degree
 * was sometimes recorded as a level and a level sometimes as free text. Editing
 * is offered because that is the honest fix for a bad import; deleting asks
 * first, because a qualification removed by accident is not recoverable from
 * the screen that removed it.
 */
export function EmployeeEducation({
  employeeId,
  education,
}: {
  employeeId: string;
  education: EmployeeEducationRecord[];
}) {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.EMPLOYEE_MANAGE);
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [editing, setEditing] = React.useState<EmployeeEducationRecord | null>(null);
  const [adding, setAdding] = React.useState(false);

  const remove = useMutation({
    mutationFn: (entryId: string) => api.delete(`/employees/${employeeId}/education/${entryId}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['employees', employeeId] });
      toast.success('Qualification removed');
    },
    onError: (error: unknown) =>
      toast.error('Could not remove it', { description: errorMessage(error) }),
  });

  const handleRemove = async (entry: EmployeeEducationRecord) => {
    const ok = await confirm({
      title: `Remove ${entry.degree ?? entry.level}?`,
      description: 'The qualification is deleted from this employee. This cannot be undone.',
      confirmLabel: 'Remove',
      tone: 'destructive',
    });
    if (ok) remove.mutate(entry.id);
  };

  return (
    <>
      <Card>
        <CardHeader bordered className="flex-row items-center justify-between gap-3">
          <CardTitle>Education</CardTitle>
          <Can permission={PERMISSIONS.EMPLOYEE_MANAGE}>
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus />
              Add
            </Button>
          </Can>
        </CardHeader>

        {education.length === 0 ? (
          <EmptyState
            icon={GraduationCap}
            title="No qualifications recorded"
            description="Degrees and diplomas appear here once added."
          />
        ) : (
          <ul className="divide-y divide-border">
            {education.map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[13.5px] font-medium">{entry.degree ?? entry.level}</p>
                    {/* The year is optional on this record, so the column is left
                        empty rather than filled with a placeholder date. */}
                    {entry.yearCompleted !== null ? (
                      <p className="tabular text-[12.5px] text-muted-foreground">
                        {entry.yearCompleted}
                      </p>
                    ) : null}
                  </div>
                  {entry.degree ? (
                    <p className="text-[13px] text-muted-foreground">{entry.level}</p>
                  ) : null}
                  {entry.institution ? (
                    <p className="mt-1 text-[12.5px] text-muted-foreground">{entry.institution}</p>
                  ) : null}
                </div>
                {canManage ? (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${entry.degree ?? entry.level}`}
                      onClick={() => setEditing(entry)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive"
                      aria-label={`Remove ${entry.degree ?? entry.level}`}
                      onClick={() => void handleRemove(entry)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <EducationDialog
        employeeId={employeeId}
        entry={editing}
        open={adding || editing !== null}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
      />
    </>
  );
}

function EducationDialog({
  employeeId,
  entry,
  open,
  onClose,
}: {
  employeeId: string;
  /** Null adds a new qualification; a record edits that one in place. */
  entry: EmployeeEducationRecord | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const blank = React.useCallback(
    (): EducationInput => ({
      level: entry?.level ?? '',
      degree: entry?.degree ?? null,
      institution: entry?.institution ?? null,
      yearCompleted: entry?.yearCompleted ?? null,
    }),
    [entry],
  );

  const form = useForm<EducationInput>({
    resolver: zodResolver(educationInputSchema),
    defaultValues: blank(),
  });

  React.useEffect(() => {
    if (open) {
      form.reset(blank());
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry?.id]);

  const save = useMutation({
    mutationFn: (values: EducationInput) =>
      entry
        ? api.patch(`/employees/${employeeId}/education/${entry.id}`, values)
        : api.post(`/employees/${employeeId}/education`, values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['employees', employeeId] });
      toast.success(entry ? 'Qualification updated' : 'Qualification added');
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        const unplaced: string[] = [];
        for (const [field, messages] of Object.entries(error.details)) {
          const message = messages[0] ?? 'Invalid value.';
          if (field in form.getValues()) {
            form.setError(field as keyof EducationInput, { message });
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
            <DialogTitle>{entry ? 'Edit qualification' : 'Add a qualification'}</DialogTitle>
            <DialogDescription>
              Level is free text - "Bachelors", "Masters", "Diploma" - so a
              qualification from any country can be recorded as it is actually named.
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

            <FormField label="Level" htmlFor="edu-level" required error={errors.level?.message}>
              <Input id="edu-level" placeholder="Bachelors" {...form.register('level')} />
            </FormField>

            <FormField label="Degree" htmlFor="edu-degree" error={errors.degree?.message}>
              <Input id="edu-degree" placeholder="BSc Computer Science" {...form.register('degree')} />
            </FormField>

            <FormField
              label="Institution"
              htmlFor="edu-institution"
              error={errors.institution?.message}
            >
              <Input id="edu-institution" {...form.register('institution')} />
            </FormField>

            <FormField
              label="Year completed"
              htmlFor="edu-year"
              hint="Leave empty when the year is not known."
              error={errors.yearCompleted?.message}
            >
              <Input
                id="edu-year"
                type="number"
                min={1900}
                max={2100}
                {...form.register('yearCompleted')}
              />
            </FormField>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {entry ? 'Save changes' : 'Add qualification'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
