import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, FolderTree, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  type CaseCatalogueAdminGroup,
  type CaseCategoryAdminRecord,
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
import { FormField, Input, Textarea } from '@/components/ui/field';
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

  const query = useQuery({
    queryKey: ['cases', 'catalogue', 'admin'],
    queryFn: () => api.get<CaseCatalogueAdminGroup[]>('/cases/catalogue'),
  });

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
              </CardHeader>
              <CardContent>
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
  onEdit,
  onAddChild,
  onRetire,
  onDelete,
}: {
  row: CaseCategoryAdminRecord;
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
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {onAddChild ? (
          <Button variant="ghost" size="sm" onClick={onAddChild}>
            <ChevronRight className="size-4" aria-hidden />
            Subcategory
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
