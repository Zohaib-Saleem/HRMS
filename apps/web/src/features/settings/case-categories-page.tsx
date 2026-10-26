import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, FolderTree, Pencil, Plus, RotateCcw, Route, Trash2 } from 'lucide-react';
import {
  type CaseCatalogueAdminGroup,
  type CaseCategoryAdminRecord,
  type CaseRoutingOverview,
  type CaseRoutingRuleRecord,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
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
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { CASE_CATALOGUE_QUERY_KEY } from '@/features/cases/use-case-catalogue';

/**
 * The queues cases are filed under.
 *
 * Everything on this screen is ordinary configuration, and that is the point of
 * the module being built this way: nothing in the web app knows that IT has an
 * "Email" queue or that HR has "Attendance & Leaves". The create form renders
 * whatever these rows say, so a company shapes its own helpdesk here rather
 * than asking for a release.
 *
 * Two things the screen is deliberately opinionated about.
 *
 * Retiring is the ordinary act and deleting is the exception. A queue with
 * cases behind it cannot be deleted at all - the server refuses it - because
 * the history of why a case was routed somewhere outlives the queue's
 * usefulness. Retiring takes it off the form and leaves that history intact, so
 * it is the button that gets the prominence.
 *
 * The departments are the company's own. There is no way to add one from here,
 * because a helpdesk that kept its own department list would drift from the org
 * chart inside a release - a department with no queues appears as an empty
 * group waiting for its first.
 */

interface EditorState {
  mode: 'create' | 'edit';
  departmentId: string;
  departmentName: string;
  /** Set when adding a subcategory, or when editing one. */
  parent: CaseCategoryAdminRecord | null;
  row: CaseCategoryAdminRecord | null;
}

export function CaseCategoriesPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [editor, setEditor] = React.useState<EditorState | null>(null);
  const [routing, setRouting] = React.useState<RoutingScope | null>(null);

  const query = useQuery({
    queryKey: ['cases', 'catalogue', 'admin'],
    queryFn: () => api.get<CaseCatalogueAdminGroup[]>('/cases/catalogue'),
  });
  const routingQuery = useQuery({
    queryKey: ['cases', 'catalogue', 'routing'],
    queryFn: () => api.get<CaseRoutingOverview>('/cases/catalogue/routing'),
  });
  const ruleFor = (departmentId: string, categoryId: string | null) =>
    routingQuery.data?.rules.find(
      (r) => r.departmentId === departmentId && r.categoryId === categoryId,
    ) ?? null;

  /**
   * Both caches, every time.
   *
   * This screen's list and the create form's catalogue are two reads of one
   * table, and an administrator who retires a queue and then raises a case
   * would otherwise be offered the queue they just retired.
   */
  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['cases', 'catalogue', 'admin'] });
    void queryClient.invalidateQueries({ queryKey: CASE_CATALOGUE_QUERY_KEY });
  }, [queryClient]);

  const retireMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/cases/catalogue/${id}`, { isActive }),
    onSuccess: (_data, variables) => {
      refresh();
      toast.success(variables.isActive ? 'Queue restored.' : 'Queue retired.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/cases/catalogue/${id}`),
    onSuccess: () => {
      refresh();
      toast.success('Queue deleted.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const remove = async (row: CaseCategoryAdminRecord) => {
    const ok = await confirm({
      title: `Delete ${row.name}?`,
      description:
        row.children.length > 0
          ? 'Its subcategories go with it. This cannot be undone, and it is only possible because no case has ever been filed here.'
          : 'This cannot be undone, and it is only possible because no case has ever been filed here.',
      confirmLabel: 'Delete',
      tone: 'destructive',
    });
    if (ok) deleteMutation.mutate(row.id);
  };

  const groups = query.data ?? [];

  return (
    <>
      <PageHeader
        title="Case categories"
        description="The departments, categories and subcategories a case can be filed under."
      />

      {query.isError ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      ) : query.isLoading ? (
        <Card>
          <CardContent className="space-y-3 py-6">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </CardContent>
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={FolderTree}
            title="No departments yet"
            description="Cases are filed against the company's own departments. Add one under Organisation, and its queues can be set up here."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <Card key={group.departmentId}>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  {group.departmentName}
                  {!group.departmentIsActive ? (
                    <Badge variant="neutral">Department retired</Badge>
                  ) : null}
                </CardTitle>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setRouting({
                        departmentId: group.departmentId,
                        departmentName: group.departmentName,
                        categoryId: null,
                        label: `${group.departmentName} (department default)`,
                      })
                    }
                  >
                    <Route className="size-4" aria-hidden />
                    Default routing
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setEditor({
                        mode: 'create',
                        departmentId: group.departmentId,
                        departmentName: group.departmentName,
                        parent: null,
                        row: null,
                      })
                    }
                  >
                    <Plus className="size-4" aria-hidden />
                    Add a category
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <RoutingLine
                  rule={ruleFor(group.departmentId, null)}
                  fallback="No department default: cases with no rule of their own stay unassigned and the department's queue owners are told."
                />
                {group.categories.length === 0 ? (
                  <p className="py-4 text-[13px] text-muted-foreground">
                    No queues yet, so nothing can be filed with {group.departmentName}. Add a
                    category to put it on the form.
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {group.categories.map((category) => (
                      <li key={category.id} className="py-3">
                        <Row
                          row={category}
                          routing={
                            <RoutingLine
                              rule={ruleFor(group.departmentId, category.id)}
                              fallback={
                                ruleFor(group.departmentId, null)
                                  ? 'Uses the department default.'
                                  : 'Unrouted: new cases stay unassigned.'
                              }
                            />
                          }
                          onRoute={() =>
                            setRouting({
                              departmentId: group.departmentId,
                              departmentName: group.departmentName,
                              categoryId: category.id,
                              label: `${group.departmentName} › ${category.name}`,
                            })
                          }
                          onEdit={() =>
                            setEditor({
                              mode: 'edit',
                              departmentId: group.departmentId,
                              departmentName: group.departmentName,
                              parent: null,
                              row: category,
                            })
                          }
                          onAddChild={() =>
                            setEditor({
                              mode: 'create',
                              departmentId: group.departmentId,
                              departmentName: group.departmentName,
                              parent: category,
                              row: null,
                            })
                          }
                          onRetire={() =>
                            retireMutation.mutate({ id: category.id, isActive: !category.isActive })
                          }
                          onDelete={() => void remove(category)}
                        />

                        {category.children.length > 0 ? (
                          <ul className="mt-2 space-y-2 border-l border-border pl-4">
                            {category.children.map((child) => (
                              <li key={child.id}>
                                <Row
                                  row={child}
                                  routing={
                                    <RoutingLine
                                      rule={ruleFor(group.departmentId, child.id)}
                                      fallback={
                                        ruleFor(group.departmentId, category.id)
                                          ? `Uses the ${category.name} rule.`
                                          : ruleFor(group.departmentId, null)
                                            ? 'Uses the department default.'
                                            : 'Unrouted: new cases stay unassigned.'
                                      }
                                    />
                                  }
                                  onRoute={() =>
                                    setRouting({
                                      departmentId: group.departmentId,
                                      departmentName: group.departmentName,
                                      categoryId: child.id,
                                      label: `${group.departmentName} › ${category.name} › ${child.name}`,
                                    })
                                  }
                                  onEdit={() =>
                                    setEditor({
                                      mode: 'edit',
                                      departmentId: group.departmentId,
                                      departmentName: group.departmentName,
                                      parent: category,
                                      row: child,
                                    })
                                  }
                                  onRetire={() =>
                                    retireMutation.mutate({ id: child.id, isActive: !child.isActive })
                                  }
                                  onDelete={() => void remove(child)}
                                />
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CategoryDialog state={editor} onClose={() => setEditor(null)} onSaved={refresh} />
      <RoutingDialog
        scope={routing}
        rule={routing ? ruleFor(routing.departmentId, routing.categoryId) : null}
        candidates={routingQuery.data?.candidates ?? []}
        onClose={() => setRouting(null)}
        onSaved={() => void queryClient.invalidateQueries({ queryKey: ['cases', 'catalogue', 'routing'] })}
      />
    </>
  );
}

/**
 * One queue.
 *
 * The case count is the fact that makes every control on this row decidable:
 * it is why delete is absent once anything has been filed here, and why
 * retiring is the button that is always offered.
 */
function Row({
  row,
  routing,
  onRoute,
  onEdit,
  onAddChild,
  onRetire,
  onDelete,
}: {
  row: CaseCategoryAdminRecord;
  routing?: React.ReactNode;
  onRoute?: () => void;
  onEdit: () => void;
  onAddChild?: () => void;
  onRetire: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className={cn('text-[13.5px] font-medium', !row.isActive && 'text-muted-foreground')}>
          {row.name}
          {!row.isActive ? (
            <Badge variant="neutral" className="ml-2">
              Retired
            </Badge>
          ) : null}
        </p>
        {row.description ? (
          <p className="text-[12.5px] text-muted-foreground">{row.description}</p>
        ) : null}
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          {row.caseCount === 0
            ? 'No cases filed here'
            : `${row.caseCount} case${row.caseCount === 1 ? '' : 's'} filed here`}
          {row.sortOrder ? ` · sort ${row.sortOrder}` : ''}
        </p>
        {routing}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {onAddChild ? (
          <Button variant="ghost" size="sm" onClick={onAddChild}>
            <ChevronRight className="size-4" aria-hidden />
            Subcategory
          </Button>
        ) : null}
        {onRoute ? (
          <Button variant="ghost" size="sm" onClick={onRoute}>
            <Route className="size-4" aria-hidden />
            Routing
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="size-4" aria-hidden />
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={onRetire}>
          <RotateCcw className="size-4" aria-hidden />
          {row.isActive ? 'Retire' : 'Restore'}
        </Button>
        {/* Only ever offered for a row nothing has been filed under. The server
            refuses the rest, and offering a button that always fails is worse
            than not offering it. */}
        {row.caseCount === 0 ? (
          <Button variant="ghost" size="sm" onClick={onDelete}>
            <Trash2 className="size-4" aria-hidden />
            Delete
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Adding or editing one.
 *
 * Where a queue sits is not editable, and the dialog says where it is rather
 * than offering to move it: changing a queue's department would silently
 * re-file every case behind it, and the honest way to do that is a new queue
 * and a retirement.
 */
function CategoryDialog({
  state,
  onClose,
  onSaved,
}: {
  state: EditorState | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [sortOrder, setSortOrder] = React.useState('0');
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});

  React.useEffect(() => {
    if (!state) return;
    setName(state.row?.name ?? '');
    setDescription(state.row?.description ?? '');
    setSortOrder(String(state.row?.sortOrder ?? 0));
    setErrors({});
  }, [state]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!state) return;
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        sortOrder: Number(sortOrder) || 0,
      };

      if (state.mode === 'edit' && state.row) {
        await api.patch(`/cases/catalogue/${state.row.id}`, body);
        return;
      }
      await api.post('/cases/catalogue', {
        ...body,
        // A subcategory takes its department from its parent; the server
        // ignores this field in that case, and it is not sent.
        ...(state.parent ? { parentCategoryId: state.parent.id } : { departmentId: state.departmentId }),
      });
    },
    onSuccess: () => {
      onSaved();
      onClose();
      toast.success(state?.mode === 'edit' ? 'Queue updated.' : 'Queue added.');
    },
    onError: (error: unknown) => {
      const details = (error as { details?: Record<string, string[]> }).details;
      if (details) setErrors(details);
      toast.error(errorMessage(error));
    },
  });

  const where = state
    ? state.parent
      ? `${state.departmentName} · ${state.parent.name}`
      : state.departmentName
    : '';

  return (
    <Dialog open={state !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {state?.mode === 'edit'
              ? `Edit ${state.row?.name ?? 'queue'}`
              : state?.parent
                ? 'Add a subcategory'
                : 'Add a category'}
          </DialogTitle>
          <DialogDescription>In {where}.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length < 2) return;
            mutation.mutate();
          }}
        >
          <DialogBody className="space-y-3">
            <FormField label="Name" htmlFor="category-name" required error={errors.name?.[0]}>
              <Input
                id="category-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={state?.parent ? 'Password reset' : 'Account access'}
              />
            </FormField>

            <FormField
              label="Description"
              htmlFor="category-description"
              hint="Shown under the name on the form, so somebody picks the right queue."
              error={errors.description?.[0]}
            >
              <Textarea
                id="category-description"
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </FormField>

            <FormField
              label="Sort order"
              htmlFor="category-sort"
              hint="Lower comes first. Ties fall back to the name."
              error={errors.sortOrder?.[0]}
            >
              <Input
                id="category-sort"
                type="number"
                min={0}
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value)}
                className="w-28"
              />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || name.trim().length < 2}>
              {mutation.isPending ? 'Saving...' : state?.mode === 'edit' ? 'Save' : 'Add it'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- routing -------------------------------------------------------------------

interface RoutingScope {
  departmentId: string;
  departmentName: string;
  /** Null for the department default. */
  categoryId: string | null;
  label: string;
}

/** Who a queue's new cases go to, in one line. */
function RoutingLine({ rule, fallback }: { rule: CaseRoutingRuleRecord | null; fallback: string }) {
  if (!rule) {
    return <p className="mt-0.5 text-[11.5px] text-muted-foreground">{fallback}</p>;
  }
  const who = (p: { name: string; eligible: boolean }) => (p.eligible ? p.name : `${p.name} (cannot take cases)`);
  return (
    <p className={cn('mt-0.5 text-[11.5px]', rule.isActive ? 'text-foreground' : 'text-muted-foreground')}>
      {rule.isActive ? 'New cases go to ' : 'Routing off - was '}
      <span className="font-medium">{who(rule.responsible)}</span>
      {rule.backup ? <> · backup {who(rule.backup)}</> : null}
      {rule.escalation ? <> · escalates to {rule.escalation.name}</> : null}
      {!rule.responsible.eligible && rule.isActive ? (
        <Badge variant="warning" className="ml-2">
          Check routing
        </Badge>
      ) : null}
    </p>
  );
}

/**
 * Setting who a queue's new cases go to.
 *
 * The people offered are the accounts that can actually work cases - the
 * server refuses anybody else - so a rule cannot point at somebody who could
 * not open the case they were given. Saving changes only what happens to the
 * next case; nothing already filed moves.
 */
function RoutingDialog({
  scope,
  rule,
  candidates,
  onClose,
  onSaved,
}: {
  scope: RoutingScope | null;
  rule: CaseRoutingRuleRecord | null;
  candidates: CaseRoutingOverview['candidates'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const confirm = useConfirm();
  const [responsible, setResponsible] = React.useState('');
  const [backup, setBackup] = React.useState('');
  const [escalation, setEscalation] = React.useState('');
  const [active, setActive] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!scope) return;
    setResponsible(rule?.responsible.userId ?? '');
    setBackup(rule?.backup?.userId ?? '');
    setEscalation(rule?.escalation?.userId ?? '');
    setActive(rule?.isActive ?? true);
    setError(null);
  }, [scope, rule]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/cases/catalogue/routing', {
        departmentId: scope!.departmentId,
        categoryId: scope!.categoryId,
        responsibleUserId: responsible,
        backupUserId: backup || null,
        escalationUserId: escalation || null,
        isActive: active,
      }),
    onSuccess: () => {
      onSaved();
      toast.success('Routing saved.', { description: 'It applies to new cases; existing cases keep their assignee.' });
      onClose();
    },
    onError: (e: unknown) => setError(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/cases/catalogue/routing/${rule!.id}`),
    onSuccess: () => {
      onSaved();
      toast.success('Routing removed.');
      onClose();
    },
    onError: (e: unknown) => setError(errorMessage(e)),
  });

  if (!scope) return null;

  const options = (exclude?: string) =>
    candidates
      .filter((c) => c.userId !== exclude)
      .map((c) => (
        <option key={c.userId} value={c.userId}>
          {c.name}
          {c.departmentName ? ` - ${c.departmentName}` : ''}
        </option>
      ));

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Routing for {scope.label}</DialogTitle>
            <DialogDescription>
              New cases filed here are assigned to the responsible person and appear in their queue.
              When they cannot take it - their account is inactive, they can no longer work cases, or
              they filed it themselves - it goes to the backup. With neither, it stays unassigned and
              the queue owners and the escalation recipient are told.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {error ? (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive">
                {error}
              </p>
            ) : null}
            <FormField label="Responsible person" htmlFor="routing-responsible" required>
              <NativeSelect value={responsible} onChange={(e) => setResponsible(e.target.value)}>
                <option value="">Choose a person</option>
                {options()}
              </NativeSelect>
            </FormField>
            <FormField label="Backup (optional)" htmlFor="routing-backup">
              <NativeSelect value={backup} onChange={(e) => setBackup(e.target.value)}>
                <option value="">No backup</option>
                {options(responsible)}
              </NativeSelect>
            </FormField>
            <FormField
              label="Escalation recipient (optional)"
              htmlFor="routing-escalation"
              hint="Told when a case went to the backup or could not be assigned."
            >
              <NativeSelect value={escalation} onChange={(e) => setEscalation(e.target.value)}>
                <option value="">Nobody</option>
                {options()}
              </NativeSelect>
            </FormField>
            <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
              <input
                type="checkbox"
                className="size-4 rounded border-input accent-[var(--primary)]"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Active
            </label>
          </DialogBody>
          <DialogFooter>
            {rule ? (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-destructive"
                loading={remove.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Remove this routing?',
                    description: 'New cases fall back to the next rule up, or stay unassigned. Existing cases are not touched.',
                    confirmLabel: 'Remove',
                    tone: 'destructive',
                  });
                  if (ok) remove.mutate();
                }}
              >
                Remove
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!responsible}>
              Save routing
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
