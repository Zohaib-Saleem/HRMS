import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, MailCheck } from 'lucide-react';
import { toast } from 'sonner';
import {
  type ForgotPasswordInput,
  type ResetPasswordInput,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { FormField, Input } from '@/components/ui/field';

/** Shared chrome so both reset screens match the login page. */
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <span
            className="grid size-9 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground"
            aria-hidden
          >
            H
          </span>
          <span className="text-base font-semibold">HRMS</span>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [sent, setSent] = React.useState(false);

  const { register, handleSubmit, formState } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await api.post('/auth/forgot-password', values);
      // The API answers identically whether or not the address exists, and so
      // does this screen - anything else would leak which emails have accounts.
      setSent(true);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  });

  if (sent) {
    return (
      <AuthShell>
        <div className="rounded-xl border border-border bg-card p-6 text-center">
          <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-success-soft text-success">
            <MailCheck className="size-5" aria-hidden />
          </span>
          <h1 className="text-lg font-semibold">Check your email</h1>
          <p className="mt-1.5 text-[13.5px] text-muted-foreground">
            If that address has an account, a reset link is on its way. The link expires shortly and
            can only be used once.
          </p>
          <Button variant="outline" className="mt-5 w-full" asChild>
            <Link to="/login">Back to sign in</Link>
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold tracking-tight">Forgot your password?</h1>
      <p className="mt-1.5 text-[13.5px] text-muted-foreground">
        Enter your email and we will send you a link to choose a new one.
      </p>

      <form onSubmit={onSubmit} className="mt-7 space-y-4" noValidate>
        <FormField label="Email" htmlFor="forgot-email" error={formState.errors.email?.message} required>
          <Input type="email" autoComplete="username" placeholder="you@company.com" autoFocus {...register('email')} />
        </FormField>

        <Button type="submit" className="w-full" size="lg" loading={formState.isSubmitting}>
          Send reset link
        </Button>

        <Button variant="ghost" className="w-full" asChild>
          <Link to="/login">Back to sign in</Link>
        </Button>
      </form>
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [done, setDone] = React.useState(false);

  const { register, handleSubmit, formState, setError } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    values: { token, newPassword: '', confirmPassword: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await api.post('/auth/reset-password', values);
      setDone(true);
    } catch (error) {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof ResetPasswordInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    }
  });

  if (done) {
    return (
      <AuthShell>
        <div className="rounded-xl border border-border bg-card p-6 text-center">
          <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-success-soft text-success">
            <CheckCircle2 className="size-5" aria-hidden />
          </span>
          <h1 className="text-lg font-semibold">Password updated</h1>
          <p className="mt-1.5 text-[13.5px] text-muted-foreground">
            Every other session has been signed out. Use your new password to sign in.
          </p>
          <Button className="mt-5 w-full" onClick={() => navigate('/login', { replace: true })}>
            Go to sign in
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
      <p className="mt-1.5 text-[13.5px] text-muted-foreground">
        Setting a new password signs you out everywhere else.
      </p>

      <form onSubmit={onSubmit} className="mt-7 space-y-4" noValidate>
        <input type="hidden" {...register('token')} />

        {!token ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive-soft px-3.5 py-2.5 text-[13px] text-destructive"
          >
            This link is missing its token. Request a new reset link.
          </div>
        ) : null}
        {formState.errors.token ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive-soft px-3.5 py-2.5 text-[13px] text-destructive"
          >
            {formState.errors.token.message}
          </div>
        ) : null}

        <FormField
          label="New password"
          htmlFor="reset-new"
          error={formState.errors.newPassword?.message}
          hint="At least 10 characters, with a letter and a number."
          required
        >
          <Input type="password" autoComplete="new-password" autoFocus {...register('newPassword')} />
        </FormField>

        <FormField label="Confirm password" htmlFor="reset-confirm" error={formState.errors.confirmPassword?.message} required>
          <Input type="password" autoComplete="new-password" {...register('confirmPassword')} />
        </FormField>

        <Button type="submit" className="w-full" size="lg" loading={formState.isSubmitting} disabled={!token}>
          Set new password
        </Button>

        <Button variant="ghost" className="w-full" asChild>
          <Link to="/login">Back to sign in</Link>
        </Button>
      </form>
    </AuthShell>
  );
}
