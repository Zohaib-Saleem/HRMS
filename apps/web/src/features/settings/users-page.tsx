import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { KeyRound, Plus, ShieldOff, UserCheck, UserPlus, Users } from 'lucide-react';
import {
  PERMISSIONS,
  USER_STATUSES,
  USER_STATUS_LABELS,
  USER_SUSPENSION_REASON_LABELS,
  userCreateSchema,
  type LinkableEmployee,
  type UserCreateInput,
  type UserDetail,
  type UserRecord,
  type UserStatus,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/utils';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect } from '@/components/ui/field';
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
import { Can, useSession } from '@/features/auth/session-context';

/**
 * Login accounts.
 *
 * Deliberately distinguishes three things the interface elsewhere tends to
 * blur: whether somebody is employed, whether their account can sign in, and
 * whether they are signed in anywhere right now. They move independently, and
 * an administrator looking at a suspended account needs to know which of the
 * three they are looking at.
 *
 * No password is ever entered, generated or displayed here. A new account is
 * invited and sets its own.
 */

/**
 * What `GET /roles` returns, as much of it as this screen needs.
 *
 * Declared here rather than imported: the roles screen holds the same shape in
 * its own local interface, and moving it into the shared package would mean
 * editing that screen, which this change has no other reason to touch.
 */
interface RoleRecord {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

const STATUS_TONE: Record<UserStatus, 'neutral' | 'success' | 'warning' | 'destructive'> = {
  INVITED: 'warning',
  ACTIVE: 'success',
  SUSPENDED: 'destructive',
};

const INITIAL = { q: '', status: '', page: 1, limit: 20 };

export function UsersPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = React.useState(INITIAL);
  const [creating, setCreating] = React.useState(false);
  const [openUserId, setOpenUserId] = React.useState<string | null>(null);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['users', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<UserRecord>('/users', {
        query: {
          page: filters.page,
          limit: filters.limit,
          q: debouncedQuery || undefined,
          status: filters.status || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const rows = query.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Users"
        description="Login accounts, the employee each belongs to, and what they may do."
        actions={
          <Can permission={PERMISSIONS.USER_MANAGE}>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              Invite user
            </Button>
          </Can>
        }
      />

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search name or email"
          hasActiveFilters={filters.q !== '' || filters.status !== ''}
          onReset={() => setFilters(INITIAL)}
          filters={
            <NativeSelect
              value={filters.status}
              onChange={(e) => update({ status: e.target.value })}
              aria-label="Filter by status"
              className="w-40"
            >
              <option value="">All statuses</option>
              {USER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {USER_STATUS_LABELS[s]}
                </option>
              ))}
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
                  <TR className="hover:bg-transparent">
                    <TH>User</TH>
                    <TH className="w-48">Employee</TH>
                    <TH className="w-44">Roles</TH>
                    <TH className="w-32">Account</TH>
                    <TH className="w-24 text-right">Sessions</TH>
                    <TH className="w-36">Last sign-in</TH>
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
                          icon={Users}
                          title="No accounts match"
                          description="Invite a user to give an employee a way to sign in."
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((user) => (
                      <TR key={user.id}>
                        <TD className="text-[13px]">
                          <span className="font-medium">{user.fullName}</span>
                          <span className="block text-[12px] text-muted-foreground">
                            {user.email}
                          </span>
                        </TD>
                        <TD className="text-[12.5px]">
                          {user.employee ? (
                            <>
                              {user.employee.fullName}
                              <span className="tabular block text-[11.5px] text-muted-foreground">
                                {user.employee.employeeNumber}
                                {user.employee.status === 'TERMINATED' ? ' · terminated' : ''}
                              </span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">Not linked</span>
                          )}
                        </TD>
                        <TD className="text-[12.5px] text-muted-foreground">
                          {user.roles.map((r) => r.name).join(', ') || '--'}
                        </TD>
                        <TD>
                          <Badge variant={STATUS_TONE[user.status]}>
                            {USER_STATUS_LABELS[user.status]}
                          </Badge>
                          {user.isLockedOut ? (
                            <span className="mt-1 block text-[11px] text-warning-foreground">
                              Locked out
                            </span>
                          ) : null}
                        </TD>
                        <TD className="tabular text-right text-[13px]">
                          {user.activeSessionCount}
                        </TD>
                        <TD className="tabular text-[12.5px] text-muted-foreground">
                          {user.lastLoginAt ? formatDate(user.lastLoginAt) : 'Never'}
                        </TD>
                        <TD>
                          <div className="flex justify-end">
                            <Button variant="ghost" size="sm" onClick={() => setOpenUserId(user.id)}>
                              Open
                            </Button>
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
                onPageChange={(page) => update({ page })}
              />
            ) : null}
          </>
        )}
      </Card>

      {creating ? (
        <InviteUserDialog onClose={() => setCreating(false)} onSaved={refresh} />
      ) : null}

      {openUserId ? (
        <UserDetailDrawer
          userId={openUserId}
          onClose={() => setOpenUserId(null)}
          onChanged={refresh}
        />
      ) : null}
    </>
  );
}

/** Creates an account and sends the invitation. No password is involved. */
function InviteUserDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<RoleRecord[]>('/roles'),
  });

  const employees = useQuery({
    queryKey: ['linkable-employees'],
    queryFn: () => api.get<LinkableEmployee[]>('/users/linkable-employees'),
  });

  const { register, handleSubmit, formState, setError, setValue, watch } =
    useForm<UserCreateInput>({
      resolver: zodResolver(userCreateSchema),
      defaultValues: { email: '', firstName: '', lastName: '', employeeId: '', roleIds: [] },
    });

  const selectedRoles = watch('roleIds') ?? [];
  const selectedEmployee = watch('employeeId');

  /** Choosing an employee fills the name and work email, which is usually right. */
  React.useEffect(() => {
    if (!selectedEmployee) return;
    const employee = employees.data?.find((e) => e.id === selectedEmployee);
    if (!employee) return;
    const [first, ...rest] = employee.fullName.split(' ');
    setValue('firstName', first ?? '', { shouldValidate: true });
    setValue('lastName', rest.join(' '), { shouldValidate: true });
    if (employee.workEmail) setValue('email', employee.workEmail, { shouldValidate: true });
  }, [selectedEmployee, employees.data, setValue]);

  const mutation = useMutation({
    mutationFn: (values: UserCreateInput) =>
      api.post<{ id: string }>('/users', { ...values, employeeId: values.employeeId || null }),
    onSuccess: async () => {
      toast.success('Account created. An invitation link has been emailed to them.');
      await onSaved();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof UserCreateInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  const toggleRole = (roleId: string) => {
    const next = selectedRoles.includes(roleId)
      ? selectedRoles.filter((id) => id !== roleId)
      : [...selectedRoles, roleId];
    setValue('roleIds', next, { shouldValidate: true });
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="md">
        <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="contents">
          <DialogHeader>
            <DialogTitle>Invite a user</DialogTitle>
            <DialogDescription>
              They receive a link to set their own password. No password is created here, and
              nobody else ever knows it.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Employee"
              htmlFor="user-employee"
              error={formState.errors.employeeId?.message}
              hint="Only employees without an account appear here."
              className="sm:col-span-2"
            >
              <NativeSelect {...register('employeeId')} autoFocus>
                <option value="">Not linked to an employee</option>
                {employees.data?.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.employeeNumber} — {e.fullName}
                    {e.departmentName ? ` (${e.departmentName})` : ''}
                  </option>
                ))}
              </NativeSelect>
            </FormField>

            <FormField
              label="First name"
              htmlFor="user-first"
              error={formState.errors.firstName?.message}
              required
            >
              <Input {...register('firstName')} />
            </FormField>
            <FormField
              label="Last name"
              htmlFor="user-last"
              error={formState.errors.lastName?.message}
              required
            >
              <Input {...register('lastName')} />
            </FormField>

            <FormField
              label="Email"
              htmlFor="user-email"
              error={formState.errors.email?.message}
              required
              hint="Where the invitation goes. Also the sign-in name."
              className="sm:col-span-2"
            >
              <Input type="email" {...register('email')} />
            </FormField>

            <FormField
              label="Roles"
              htmlFor="user-roles"
              error={formState.errors.roleIds?.message}
              required
              hint="What they may do, and how much they may see."
              className="sm:col-span-2"
            >
              <div className="space-y-1.5">
                {roles.data?.map((role) => (
                  <label
                    key={role.id}
                    className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-2.5 text-[13px]"
                  >
                    <input
                      type="checkbox"
                      checked={selectedRoles.includes(role.id)}
                      onChange={() => toggleRole(role.id)}
                      className="mt-0.5 size-4 shrink-0 rounded border-input accent-[var(--primary)]"
                    />
                    <span className="min-w-0">
                      <span className="font-medium">{role.name}</span>
                      {role.description ? (
                        <span className="block text-[12px] text-muted-foreground">
                          {role.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            </FormField>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              <UserPlus />
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One account: status, roles, employee link, sessions and the actions. */
function UserDetailDrawer({
  userId,
  onClose,
  onChanged,
}: {
  userId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { session } = useSession();
  const [editingRoles, setEditingRoles] = React.useState(false);

  const query = useQuery({
    queryKey: ['user', userId],
    queryFn: () => api.get<UserDetail>(`/users/${userId}`),
  });

  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<RoleRecord[]>('/roles'),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['user', userId] });
    await onChanged();
  };

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api.post(`/users/${userId}/${path}`, body),
    onSuccess: refresh,
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const setRoles = useMutation({
    mutationFn: (roleIds: string[]) => api.put(`/users/${userId}/roles`, { roleIds }),
    onSuccess: async () => {
      toast.success('Roles updated.');
      setEditingRoles(false);
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const user = query.data;
  const isSelf = session?.user.id === userId;

  const handleSuspend = async () => {
    const reason = window.prompt(
      'Why is this account being suspended? This is recorded in the audit trail.',
    );
    if (reason === null) return;
    if (reason.trim().length < 3) {
      toast.error('Give a reason of at least three characters.');
      return;
    }
    act.mutate(
      { path: 'suspend', body: { reason } },
      { onSuccess: () => toast.success('Account suspended and every session ended.') },
    );
  };

  const handleRestore = async () => {
    const ok = await confirm({
      title: 'Restore this account?',
      description:
        'They will be able to sign in again with their existing password. Existing sessions stay revoked.',
      confirmLabel: 'Restore',
    });
    if (ok) act.mutate({ path: 'restore' }, { onSuccess: () => toast.success('Account restored.') });
  };

  const handleRevoke = async () => {
    const ok = await confirm({
      title: 'Sign this user out everywhere?',
      description:
        'Every device they are signed in on stops working immediately. The account itself stays active, so they can sign in again.',
      confirmLabel: 'Revoke sessions',
      tone: 'destructive',
    });
    if (ok) {
      act.mutate(
        { path: 'revoke-sessions' },
        { onSuccess: () => toast.success('Sessions revoked.') },
      );
    }
  };

  const handleReset = async () => {
    const ok = await confirm({
      title: 'Send a password reset link?',
      description:
        'A link goes to their own email address. Nobody else sees it, and it expires shortly.',
      confirmLabel: 'Send link',
    });
    if (ok) {
      act.mutate(
        { path: 'send-reset' },
        { onSuccess: () => toast.success('Reset link sent to their email address.') },
      );
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="md">
        <DialogHeader>
          <DialogTitle>{user ? user.fullName : 'Account'}</DialogTitle>
          <DialogDescription>{user?.email ?? 'Loading…'}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          {query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : !user ? (
            <p className="text-[13px] text-muted-foreground">Loading…</p>
          ) : (
            <>
              <section className="grid gap-3 sm:grid-cols-2">
                <Fact
                  label="Account status"
                  value={USER_STATUS_LABELS[user.status]}
                  tone={STATUS_TONE[user.status]}
                />
                <Fact
                  label="Employment"
                  value={user.employee ? user.employee.status : 'No employee linked'}
                />
                <Fact label="Active sessions" value={String(user.activeSessionCount)} />
                <Fact
                  label="Last sign-in"
                  value={user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}
                />
              </section>

              {user.status === 'SUSPENDED' ? (
                <div className="rounded-md border border-destructive/30 bg-destructive-soft/40 p-3 text-[13px]">
                  <p className="font-medium text-destructive">
                    {user.suspendedReason
                      ? USER_SUSPENSION_REASON_LABELS[user.suspendedReason]
                      : 'Suspended'}
                  </p>
                  <p className="text-muted-foreground">
                    {user.suspendedAt ? `Since ${formatDateTime(user.suspendedAt)}` : ''}
                    {user.suspendedByName ? ` by ${user.suspendedByName}` : ''}
                  </p>
                  {!user.restore.allowed && user.restore.reason ? (
                    <p className="mt-1 text-muted-foreground">{user.restore.reason}</p>
                  ) : null}
                </div>
              ) : null}

              {user.status === 'INVITED' ? (
                <div className="rounded-md border border-warning/30 bg-warning-soft/40 p-3 text-[13px]">
                  <p className="font-medium text-warning-foreground">Invitation not accepted</p>
                  <p className="text-muted-foreground">
                    They cannot sign in until they follow the link and set a password. Send it
                    again if it did not arrive.
                  </p>
                </div>
              ) : null}

              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Roles
                  </h3>
                  <Can permission={PERMISSIONS.USER_MANAGE}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingRoles((open) => !open)}
                    >
                      {editingRoles ? 'Cancel' : 'Change'}
                    </Button>
                  </Can>
                </div>

                {editingRoles ? (
                  <RoleEditor
                    roles={roles.data ?? []}
                    selected={user.roles.map((r) => r.id)}
                    saving={setRoles.isPending}
                    onSave={(ids) => setRoles.mutate(ids)}
                  />
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {user.roles.map((role) => (
                      <Badge key={role.id} variant="primary">
                        {role.name}
                      </Badge>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Linked employee
                </h3>
                {user.employee ? (
                  <p className="text-[13px]">
                    {user.employee.fullName}
                    <span className="tabular block text-[12px] text-muted-foreground">
                      {user.employee.employeeNumber}
                      {user.employee.departmentName ? ` · ${user.employee.departmentName}` : ''}
                    </span>
                  </p>
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    This account is not linked to an employee, so it has no attendance, leave or
                    payslips of its own.
                  </p>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Sessions
                </h3>
                {user.sessions.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">Not signed in anywhere.</p>
                ) : (
                  <div className="overflow-hidden rounded-md border border-border">
                    {user.sessions.map((s) => (
                      <div
                        key={s.id}
                        className="border-b border-border px-3 py-2 text-[12.5px] last:border-b-0"
                      >
                        <p className="tabular">{s.ipAddress ?? 'unknown address'}</p>
                        <p className="truncate text-[11.5px] text-muted-foreground">
                          {s.userAgent ?? 'unknown device'}
                        </p>
                        <p className="text-[11.5px] text-muted-foreground">
                          Last active {formatDateTime(s.lastActivityAt)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </DialogBody>

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>

          {user && !isSelf ? (
            <Can permission={PERMISSIONS.USER_MANAGE}>
              {user.status !== 'SUSPENDED' ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => void handleReset()}>
                    <KeyRound />
                    Send reset link
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={user.activeSessionCount === 0}
                    onClick={() => void handleRevoke()}
                  >
                    Revoke sessions
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => void handleSuspend()}>
                    <ShieldOff />
                    Suspend
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  disabled={!user.restore.allowed}
                  title={user.restore.reason ?? 'Restore this account'}
                  onClick={() => void handleRestore()}
                >
                  <UserCheck />
                  Restore
                </Button>
              )}
            </Can>
          ) : null}

          {user && isSelf ? (
            <p className="text-[12.5px] text-muted-foreground">
              This is your own account. Manage it from your profile.
            </p>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoleEditor({
  roles,
  selected,
  saving,
  onSave,
}: {
  roles: RoleRecord[];
  selected: string[];
  saving: boolean;
  onSave: (ids: string[]) => void;
}) {
  const [ids, setIds] = React.useState(selected);

  return (
    <div className="space-y-2">
      {roles.map((role) => (
        <label
          key={role.id}
          className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-2.5 text-[13px]"
        >
          <input
            type="checkbox"
            checked={ids.includes(role.id)}
            onChange={() =>
              setIds((current) =>
                current.includes(role.id)
                  ? current.filter((id) => id !== role.id)
                  : [...current, role.id],
              )
            }
            className="mt-0.5 size-4 shrink-0 rounded border-input accent-[var(--primary)]"
          />
          <span className="min-w-0">
            <span className="font-medium">{role.name}</span>
            {role.description ? (
              <span className="block text-[12px] text-muted-foreground">{role.description}</span>
            ) : null}
          </span>
        </label>
      ))}
      <Button size="sm" loading={saving} disabled={ids.length === 0} onClick={() => onSave(ids)}>
        Save roles
      </Button>
      {ids.length === 0 ? (
        <p className="text-[12px] text-destructive">A user must keep at least one role.</p>
      ) : null}
    </div>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'success' | 'warning' | 'destructive';
}) {
  return (
    <div className="min-w-0">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      {tone ? (
        <Badge variant={tone}>{value}</Badge>
      ) : (
        <p className="truncate text-[13.5px] font-medium">{value}</p>
      )}
    </div>
  );
}
