import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LogOut, Monitor, Save, ShieldCheck } from 'lucide-react';
import {
  changePasswordSchema,
  updateProfileSchema,
  type ChangePasswordInput,
  type UpdateProfileInput,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative, initials } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FormField, Input } from '@/components/ui/field';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { SESSION_QUERY_KEY, useAuthenticatedSession } from '@/features/auth/session-context';

interface SessionRow {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export function ProfilePage() {
  const session = useAuthenticatedSession();
  const { user } = session;

  return (
    <>
      <PageHeader title="My profile" description="Your account details and active sessions." />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <ProfileForm />
          <PasswordForm />
        </div>

        <div className="space-y-5">
          <Card>
            <CardContent className="flex flex-col items-center py-7 text-center">
              <span
                className="grid size-16 place-items-center rounded-full text-xl font-semibold text-white"
                style={{ backgroundColor: user.avatarColor }}
                aria-hidden
              >
                {initials(user.firstName, user.lastName)}
              </span>
              <p className="mt-3 text-[15px] font-semibold">{user.fullName}</p>
              <p className="text-[13px] text-muted-foreground">{user.email}</p>

              <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                {user.roles.map((role) => (
                  <Badge key={role.id} variant="primary">
                    <ShieldCheck className="size-3" aria-hidden />
                    {role.name}
                  </Badge>
                ))}
              </div>

              {user.employee ? (
                <dl className="mt-5 w-full space-y-2 border-t border-border pt-4 text-left text-[13px]">
                  <Row label="Employee no." value={user.employee.employeeNumber} />
                  <Row label="Job title" value={user.employee.jobTitle ?? '--'} />
                  <Row label="Department" value={user.employee.departmentName ?? '--'} />
                  <Row label="Team" value={user.employee.teamName ?? '--'} />
                </dl>
              ) : null}

              <p className="mt-4 text-[12px] text-muted-foreground">
                Last signed in {formatRelative(user.lastLoginAt)}
              </p>
            </CardContent>
          </Card>

          <ActiveSessions />
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

function ProfileForm() {
  const session = useAuthenticatedSession();
  const queryClient = useQueryClient();

  const { register, handleSubmit, formState, reset } = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: { firstName: session.user.firstName, lastName: session.user.lastName },
  });

  const mutation = useMutation({
    mutationFn: (values: UpdateProfileInput) => api.patch('/me', values),
    onSuccess: async (_data, values) => {
      toast.success('Profile updated.');
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      reset(values);
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  return (
    <Card>
      <form onSubmit={handleSubmit((values) => mutation.mutate(values))}>
        <CardHeader bordered>
          <CardTitle>Personal details</CardTitle>
          <CardDescription>How your name appears across the system.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField label="First name" htmlFor="firstName" error={formState.errors.firstName?.message} required>
            <Input {...register('firstName')} />
          </FormField>
          <FormField label="Last name" htmlFor="lastName" error={formState.errors.lastName?.message} required>
            <Input {...register('lastName')} />
          </FormField>
          <FormField label="Email" htmlFor="profileEmail" hint="Contact an administrator to change your sign-in email.">
            <Input value={session.user.email} disabled readOnly />
          </FormField>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" loading={mutation.isPending} disabled={!formState.isDirty}>
            <Save />
            Save
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function PasswordForm() {
  const { register, handleSubmit, formState, reset, setError } = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: ChangePasswordInput) => api.patch('/me/password', values),
    onSuccess: async (result: unknown) => {
      const revoked = (result as { revokedSessions?: number })?.revokedSessions ?? 0;
      toast.success(
        revoked > 0
          ? `Password changed. ${revoked} other session${revoked === 1 ? '' : 's'} signed out.`
          : 'Password changed.',
      );
      reset();
      await queryClient.invalidateQueries({ queryKey: ['me', 'sessions'] });
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof ChangePasswordInput, { message: messages[0] });
        }
        return;
      }
      if (error instanceof ApiError && error.isUnauthorized) {
        setError('currentPassword', { message: error.message });
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  return (
    <Card>
      <form onSubmit={handleSubmit((values) => mutation.mutate(values))}>
        <CardHeader bordered>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            Changing your password signs out every other device automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Current password"
            htmlFor="currentPassword"
            error={formState.errors.currentPassword?.message}
            required
            className="sm:col-span-2"
          >
            <Input type="password" autoComplete="current-password" {...register('currentPassword')} />
          </FormField>
          <FormField
            label="New password"
            htmlFor="newPassword"
            error={formState.errors.newPassword?.message}
            hint="At least 10 characters, with a letter and a number."
            required
          >
            <Input type="password" autoComplete="new-password" {...register('newPassword')} />
          </FormField>
          <FormField
            label="Confirm new password"
            htmlFor="confirmPassword"
            error={formState.errors.confirmPassword?.message}
            required
          >
            <Input type="password" autoComplete="new-password" {...register('confirmPassword')} />
          </FormField>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" loading={mutation.isPending}>
            Update password
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function ActiveSessions() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['me', 'sessions'],
    queryFn: () => api.get<SessionRow[]>('/me/sessions'),
  });

  const mutation = useMutation({
    mutationFn: () => api.post<{ revoked: number }>('/auth/logout-others'),
    onSuccess: async (result) => {
      toast.success(
        result.revoked > 0
          ? `Signed out ${result.revoked} other session${result.revoked === 1 ? '' : 's'}.`
          : 'No other sessions were active.',
      );
      await queryClient.invalidateQueries({ queryKey: ['me', 'sessions'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const others = (query.data ?? []).filter((s) => !s.isCurrent);

  const handleRevoke = async () => {
    const ok = await confirm({
      title: 'Sign out other sessions?',
      description: 'Every device except this one will need to sign in again.',
      confirmLabel: 'Sign them out',
      tone: 'destructive',
    });
    if (ok) mutation.mutate();
  };

  return (
    <Card>
      <CardHeader bordered>
        <CardTitle>Active sessions</CardTitle>
        <CardDescription>Devices currently signed in to your account.</CardDescription>
      </CardHeader>

      <ul className="divide-y divide-border">
        {(query.data ?? []).map((row) => (
          <li key={row.id} className="flex items-start gap-3 px-5 py-3">
            <Monitor className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-[13px] font-medium">
                  {shortenUserAgent(row.userAgent)}
                </p>
                {row.isCurrent ? <Badge variant="success">This device</Badge> : null}
              </div>
              <p className="truncate text-[12px] text-muted-foreground">
                {row.ipAddress ?? 'Unknown IP'} - active {formatRelative(row.lastActivityAt)}
              </p>
              <p className="truncate text-[11.5px] text-muted-foreground/80">
                Expires {formatDateTime(row.expiresAt)}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {others.length > 0 ? (
        <CardFooter>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            loading={mutation.isPending}
            onClick={() => void handleRevoke()}
          >
            <LogOut />
            Sign out {others.length} other {others.length === 1 ? 'session' : 'sessions'}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** Turns a full UA string into something a person can recognise. */
function shortenUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser =
    /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\//.test(userAgent) ? 'Opera'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : 'Browser';
  const os =
    /Windows/.test(userAgent) ? 'Windows'
    : /Macintosh|Mac OS/.test(userAgent) ? 'macOS'
    : /Android/.test(userAgent) ? 'Android'
    : /iPhone|iPad/.test(userAgent) ? 'iOS'
    : /Linux/.test(userAgent) ? 'Linux'
    : '';
  return os ? `${browser} on ${os}` : browser;
}
