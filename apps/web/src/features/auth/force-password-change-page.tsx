import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { type ChangePasswordInput, changePasswordSchema } from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { FormField, Input } from '@/components/ui/field';
import { AuthShell } from './password-reset-pages';
import { SESSION_QUERY_KEY, useSession } from './session-context';

/**
 * The gate in front of an account carrying `mustChangePassword`.
 *
 * Two kinds of account arrive here, and the wording has to serve both without
 * knowing which one is reading: somebody created by
 * `scripts/create-employee-logins.mjs`, and somebody an administrator has just
 * handed a temporary password to under `user.password.manage`. In both cases a
 * password they did not choose is currently the only thing protecting their
 * payslips, and somebody else has seen it.
 *
 * It is a ROUTE-LEVEL gate rather than a banner, because a banner is a
 * suggestion. `ProtectedRoutes` renders this instead of `AppShell`, so there is
 * no screen to navigate to and no URL to type that gets past it. The only two
 * ways out are setting a password or signing out.
 *
 * The form asks for the temporary password as well as the new one. That is not
 * ceremony: it goes to `PATCH /me/password`, the same endpoint the profile
 * screen uses, which verifies the current password before writing. Anyone who
 * walks up to an unlocked machine mid-onboarding therefore still cannot take
 * the account, and this screen needs no endpoint of its own - no second code
 * path that sets a password, no second place to get the rules wrong.
 */
export function ForcePasswordChangePage() {
  const { session, clear } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { register, handleSubmit, formState, setError } = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const mutation = useMutation({
    mutationFn: (values: ChangePasswordInput) => api.patch('/me/password', values),
    onSuccess: async () => {
      toast.success('Password set. Welcome in.');
      // Refetching is what opens the app: the gate below reads
      // `mustChangePassword` off the session, and the server has just cleared
      // it. Invalidate rather than patch the cache, so the flag that lets us
      // through is the server's answer and not this screen's assumption.
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
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

  const signOut = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Signing out locally matters more than the server's answer here: this
      // screen must never become a place somebody is stuck.
    }
    clear();
    navigate('/login', { replace: true });
  };

  return (
    <AuthShell>
      <div className="rounded-xl border border-border bg-card p-6">
        <span
          className="mb-3 grid size-11 place-items-center rounded-full bg-warning-soft text-warning"
          aria-hidden
        >
          <KeyRound className="size-5" />
        </span>

        <h1 className="text-lg font-semibold">Choose your own password</h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          {session?.user.firstName ? `${session.user.firstName}, the` : 'The'} password you signed in
          with was issued to you by someone else, so it cannot stay. Choose one only you know to
          carry on.
        </p>

        <form className="mt-5 grid gap-4" onSubmit={handleSubmit((v) => mutation.mutate(v))}>
          <FormField
            label="The password you were given"
            htmlFor="currentPassword"
            error={formState.errors.currentPassword?.message}
            required
          >
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              autoFocus
              {...register('currentPassword')}
            />
          </FormField>

          <FormField
            label="New password"
            htmlFor="newPassword"
            error={formState.errors.newPassword?.message}
            hint="At least 10 characters, with a letter and a number."
            required
          >
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              {...register('newPassword')}
            />
          </FormField>

          <FormField
            label="Confirm new password"
            htmlFor="confirmPassword"
            error={formState.errors.confirmPassword?.message}
            required
          >
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              {...register('confirmPassword')}
            />
          </FormField>

          <Button type="submit" className="w-full" loading={mutation.isPending}>
            Set password and continue
          </Button>
        </form>

        <p className="mt-4 text-center text-[12.5px] text-muted-foreground">
          Not you?{' '}
          <button
            type="button"
            className="font-medium text-foreground underline underline-offset-2"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </p>
      </div>
    </AuthShell>
  );
}
