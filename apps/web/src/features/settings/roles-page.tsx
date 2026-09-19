import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Eye, KeyRound, Lock, Pencil, Plus, ShieldCheck, Trash2, Users } from 'lucide-react';
import {
  ASSIGNABLE_DATA_SCOPES,
  DATA_SCOPE_LABELS,
  PERMISSION_GROUPS,
  PERMISSIONS,
  roleCreateSchema,
  roleKeyFromName,
  type AssignableDataScope,
  type Permission,
  type RoleCreateInput,
  type RoleRecord,
} from '@hrms/shared';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
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
import { SESSION_QUERY_KEY, usePermissions } from '@/features/auth/session-context';
import { cn } from '@/lib/utils';

export function RolesPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.ROLE_MANAGE);
  const [editing, setEditing] = React.useState<RoleRecord | null>(null);
  const [details, setDetails] = React.useState<RoleRecord | 'new' | null>(null);

  const query = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<RoleRecord[]>('/roles'),
  });

  if (query.isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index}>
            <CardContent className="space-y-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-6 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const roles = query.data ?? [];

  if (roles.length === 0) {
    return (
      <>
        <Card>
          <EmptyState
            icon={KeyRound}
            title="No roles yet"
            description="A role decides what somebody may do and how much of the company they can see."
            action={
              canManage ? (
                <Button onClick={() => setDetails('new')}>
                  <Plus />
                  New role
                </Button>
              ) : undefined
            }
          />
        </Card>
        <RoleDetailsDialog role={details} onClose={() => setDetails(null)} />
      </>
    );
  }

  return (
    <>
      {canManage ? (
        <div className="mb-4 flex justify-end">
          <Button onClick={() => setDetails('new')}>
            <Plus />
            New role
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {roles.map((role) => (
          <Card key={role.id} className="flex flex-col">
            <CardContent className="flex-1 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-[15px] font-semibold">{role.name}</h3>
                    {role.isProtected ? (
                      <Badge variant="primary">
                        <ShieldCheck className="size-3" aria-hidden />
                        Protected
                      </Badge>
                    ) : role.isSystem ? (
                      <Badge variant="neutral">System</Badge>
                    ) : null}
                  </div>
                  {role.description ? (
                    <p className="mt-1 text-[13px] text-muted-foreground">{role.description}</p>
                  ) : null}
                </div>

                {canManage ? (
                  <div className="flex flex-none gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={role.isProtected}
                      title={
                        role.isProtected
                          ? 'This role always has full access and cannot be edited.'
                          : 'Rename it, or change how much it can see'
                      }
                      onClick={() => setDetails(role)}
                    >
                      <Pencil />
                      Details
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={role.isProtected}
                      title={
                        role.isProtected
                          ? 'This role always has full access and cannot be edited.'
                          : undefined
                      }
                      onClick={() => setEditing(role)}
                    >
                      {role.isProtected ? <Lock /> : <KeyRound />}
                      Permissions
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Users className="size-3.5" aria-hidden />
                  {role.userCount} {role.userCount === 1 ? 'user' : 'users'}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound className="size-3.5" aria-hidden />
                  {role.permissions.length} permissions
                </span>
                {/*
                  Shown beside the permission count because the two answer
                  different halves of one question, and a role with
                  `employee.read` at OWN scope looks powerful in the list and
                  sees nothing in practice.
                */}
                <span className="inline-flex items-center gap-1.5">
                  <Eye className="size-3.5" aria-hidden />
                  {DATA_SCOPE_LABELS[role.dataScope]}
                </span>
              </div>

              <PermissionSummary permissions={role.permissions} />
            </CardContent>
          </Card>
        ))}
      </div>

      <RoleEditor role={editing} onClose={() => setEditing(null)} />
      <RoleDetailsDialog role={details} onClose={() => setDetails(null)} />
    </>
  );
}

/**
 * Creating a role, and editing everything about one that is not a permission.
 *
 * One dialog for both, because the fields are identical and a separate "new
 * role" screen would drift from the edit one the first time a field is added.
 * What differs is the key line and the delete button, and both are driven by
 * whether a role was passed in.
 */
function RoleDetailsDialog({
  role,
  onClose,
}: {
  role: RoleRecord | 'new' | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const creating = role === 'new';
  const existing = role === 'new' || role === null ? null : role;

  const { register, handleSubmit, formState, setError, watch, reset } = useForm<RoleCreateInput>({
    resolver: zodResolver(roleCreateSchema),
    defaultValues: {
      name: '',
      description: '',
      dataScope: 'OWN' as AssignableDataScope,
    },
  });

  React.useEffect(() => {
    if (!role) return;
    reset(
      existing
        ? {
            name: existing.name,
            description: existing.description ?? '',
            dataScope: existing.dataScope as AssignableDataScope,
          }
        : { name: '', description: '', dataScope: 'OWN' as AssignableDataScope },
    );
  }, [role, existing, reset]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['roles'] });
    // A scope change alters what the signed-in user can see the moment it
    // lands, so the session's own copy has to go too.
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  };

  const save = useMutation({
    mutationFn: (values: RoleCreateInput) =>
      existing
        ? api.patch<RoleRecord>(`/roles/${existing.id}`, values)
        : api.post<RoleRecord>('/roles', values),
    onSuccess: async (saved) => {
      toast.success(existing ? `${saved.name} updated.` : `${saved.name} created.`);
      await refresh();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          if (field === '_') {
            toast.error(messages[0]);
            continue;
          }
          setError(field as keyof RoleCreateInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/roles/${existing?.id}`),
    onSuccess: async () => {
      toast.success(`${existing?.name} deleted.`);
      await refresh();
      onClose();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const handleDelete = async () => {
    if (!existing) return;
    const ok = await confirm({
      title: `Delete the ${existing.name} role?`,
      description:
        'The role and its permissions go for good. Nobody holds it, so nobody loses access.',
      confirmLabel: 'Delete role',
      tone: 'destructive',
    });
    if (ok) remove.mutate();
  };

  if (!role) return null;

  const name = watch('name') ?? '';
  const deletable = existing !== null && !existing.isSystem && !existing.isProtected;

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent size="md">
        <form onSubmit={handleSubmit((values) => save.mutate(values))} className="contents">
          <DialogHeader>
            <DialogTitle>{creating ? 'New role' : `Edit ${existing?.name}`}</DialogTitle>
            <DialogDescription>
              A role decides what somebody may do, and how much of the company they can see.
              Permissions are chosen separately.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <FormField
              label="Name"
              htmlFor="role-name"
              error={formState.errors.name?.message}
              hint={
                creating
                  ? `Stored as ${name.trim() ? roleKeyFromName(name) : '…'}, which never changes afterwards.`
                  : `Stored as ${existing?.key}. The name can change; that identifier cannot.`
              }
              required
            >
              <Input id="role-name" autoFocus placeholder="IT Manager" {...register('name')} />
            </FormField>

            <FormField
              label="Description"
              htmlFor="role-description"
              error={formState.errors.description?.message}
              hint="Optional. What this role is for, in a line."
            >
              <Textarea
                id="role-description"
                rows={2}
                placeholder="Runs IT: issues equipment and keeps the attendance terminals working."
                {...register('description')}
              />
            </FormField>

            <FormField
              label="How much it can see"
              htmlFor="role-scope"
              error={formState.errors.dataScope?.message}
              hint="Narrows every list and record, whatever the permissions allow."
              required
            >
              <NativeSelect id="role-scope" {...register('dataScope')}>
                {ASSIGNABLE_DATA_SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {DATA_SCOPE_LABELS[scope]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            {existing?.isSystem ? (
              <p className="text-[12.5px] text-muted-foreground">
                This is a built-in role. You can rename it and change what it sees, but it cannot
                be deleted — the system recreates it on every start.
              </p>
            ) : null}

            {existing && existing.userCount > 0 && !existing.isSystem ? (
              <p className="text-[12.5px] text-muted-foreground">
                {existing.userCount} {existing.userCount === 1 ? 'account holds' : 'accounts hold'}{' '}
                this role. Move {existing.userCount === 1 ? 'it' : 'them'} elsewhere before deleting
                it.
              </p>
            ) : null}
          </DialogBody>

          <DialogFooter className="flex-wrap gap-2">
            {deletable && existing.userCount === 0 ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="mr-auto"
                loading={remove.isPending}
                onClick={() => void handleDelete()}
              >
                <Trash2 />
                Delete
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {creating ? 'Create role' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Compact per-group counts, so a card stays readable at 15 permissions. */
function PermissionSummary({ permissions }: { permissions: string[] }) {
  const owned = new Set(permissions);

  return (
    <div className="flex flex-wrap gap-1.5 pt-0.5">
      {PERMISSION_GROUPS.map((group) => {
        const total = group.permissions.length;
        const count = group.permissions.filter((p) => owned.has(p.value)).length;
        return (
          <Badge
            key={group.key}
            variant={count === 0 ? 'neutral' : count === total ? 'success' : 'outline'}
            className={cn(count === 0 && 'opacity-60')}
          >
            {group.label}
            <span className="tabular font-semibold">
              {count}/{total}
            </span>
          </Badge>
        );
      })}
    </div>
  );
}

function RoleEditor({ role, onClose }: { role: RoleRecord | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    setSelected(new Set(role?.permissions ?? []));
  }, [role]);

  const mutation = useMutation({
    mutationFn: (permissions: string[]) =>
      api.put(`/roles/${role?.id}/permissions`, { permissions }),
    onSuccess: async () => {
      toast.success(`Permissions updated for ${role?.name}.`);
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      // The current user's own grants may have changed.
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      onClose();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const toggle = (permission: Permission) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  };

  const toggleGroup = (groupKey: string, enable: boolean) => {
    const group = PERMISSION_GROUPS.find((g) => g.key === groupKey);
    if (!group) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const permission of group.permissions) {
        if (enable) next.add(permission.value);
        else next.delete(permission.value);
      }
      return next;
    });
  };

  const changed =
    role !== null &&
    (selected.size !== role.permissions.length ||
      role.permissions.some((p) => !selected.has(p)));

  const handleSave = async () => {
    if (selected.size === 0) {
      const ok = await confirm({
        title: 'Remove every permission?',
        description: `Users with the ${role?.name} role will not be able to see anything beyond their own profile.`,
        confirmLabel: 'Remove all',
        tone: 'destructive',
      });
      if (!ok) return;
    }
    mutation.mutate([...selected]);
  };

  return (
    <Dialog open={role !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent variant="drawer" size="lg">
        <DialogHeader>
          <DialogTitle>{role?.name}</DialogTitle>
          <DialogDescription>
            Choose what this role can see and change. The API enforces these on every request.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          {PERMISSION_GROUPS.map((group) => {
            const all = group.permissions.every((p) => selected.has(p.value));
            return (
              <section key={group.key}>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-[13.5px] font-semibold">{group.label}</h4>
                    <p className="text-[12px] text-muted-foreground">{group.description}</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleGroup(group.key, !all)}
                  >
                    {all ? 'Clear' : 'Select all'}
                  </Button>
                </div>

                <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                  {group.permissions.map((permission) => {
                    const checked = selected.has(permission.value);
                    return (
                      <li key={permission.value}>
                        <label
                          className={cn(
                            'flex cursor-pointer items-start gap-3 px-3.5 py-2.5 transition-colors hover:bg-accent/50',
                            checked && 'bg-primary-soft/35',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(permission.value)}
                            className="mt-0.5 size-4 shrink-0 rounded border-input accent-[var(--primary)]"
                          />
                          <span className="min-w-0">
                            <span className="block text-[13px] font-medium">{permission.label}</span>
                            <span className="block text-[12px] text-muted-foreground">
                              {permission.description}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </DialogBody>

        <DialogFooter>
          <span className="tabular mr-auto self-center text-[13px] text-muted-foreground">
            {selected.size} selected
          </span>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={mutation.isPending} disabled={!changed} onClick={() => void handleSave()}>
            Save permissions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
