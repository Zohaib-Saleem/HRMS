import * as React from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { loginSchema, type LoginInput } from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { FormField, Input, Label } from '@/components/ui/field';
import { SESSION_QUERY_KEY, useSession } from './session-context';
import { FullPageLoader } from '@/components/feedback/states';

export function LoginPage() {
  const { session, isLoading } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [showPassword, setShowPassword] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '', rememberMe: false },
  });

  if (isLoading) return <FullPageLoader label="Checking your session" />;

  if (session) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post('/auth/login', values);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(from, { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          if (field === 'email' || field === 'password') {
            setError(field, { message: messages[0] });
          }
        }
        return;
      }
      setFormError(errorMessage(error));
    }
  });

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(0,30rem)]">
      {/* Brand panel - hidden on small screens where it would just push the form down */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-12 text-sidebar-foreground lg:flex">
        <div
          className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full opacity-25 blur-3xl"
          style={{ background: 'var(--sidebar-active)' }}
          aria-hidden
        />
        <div className="relative flex items-center gap-3">
          <span
            className="grid size-9 place-items-center rounded-lg bg-sidebar-active text-sm font-bold text-white"
            aria-hidden
          >
            H
          </span>
          <span className="text-base font-semibold text-white">HRMS</span>
        </div>

        <div className="relative max-w-md space-y-4">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight text-white">
            People operations, without the spreadsheet sprawl.
          </h2>
          <p className="text-[15px] leading-relaxed text-sidebar-muted">
            One place for your organisation structure, your records and the audit trail behind
            every change.
          </p>
        </div>

        <div className="relative flex items-center gap-2 text-[13px] text-sidebar-muted">
          <ShieldCheck className="size-4" aria-hidden />
          Role-based access, with every action recorded.
        </div>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center bg-background px-5 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span
              className="grid size-9 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground"
              aria-hidden
            >
              H
            </span>
            <span className="text-base font-semibold">HRMS</span>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1.5 text-[13.5px] text-muted-foreground">
            Enter your credentials to access your workspace.
          </p>

          <form onSubmit={onSubmit} className="mt-7 space-y-4" noValidate>
            {formError ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive-soft px-3.5 py-2.5 text-[13px] text-destructive"
              >
                {formError}
              </div>
            ) : null}

            <FormField label="Email" htmlFor="email" error={errors.email?.message} required>
              <Input
                type="email"
                autoComplete="username"
                placeholder="you@company.com"
                autoFocus
                {...register('email')}
              />
            </FormField>

            <FormField label="Password" htmlFor="password" error={errors.password?.message} required>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Your password"
                  className="pr-10"
                  {...register('password')}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </FormField>

            <div className="flex items-center justify-between pt-1">
              <Label className="flex cursor-pointer items-center gap-2 font-normal text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4 rounded border-input accent-[var(--primary)]"
                  {...register('rememberMe')}
                />
                Keep me signed in
              </Label>

              <Link
                to="/forgot-password"
                className="text-[13px] text-primary transition-colors hover:underline"
              >
                Forgot password?
              </Link>
            </div>

            <Button type="submit" className="w-full" size="lg" loading={isSubmitting}>
              Sign in
            </Button>
          </form>

          <DevCredentialsHint />
        </div>
      </div>
    </div>
  );
}

/**
 * Development convenience. Vite strips this from production builds because the
 * condition folds to false at build time.
 */
function DevCredentialsHint() {
  if (!import.meta.env.DEV) return null;

  return (
    <div className="mt-8 rounded-lg border border-dashed border-border bg-surface-muted/60 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Development account
      </p>
      <dl className="mt-1.5 space-y-0.5 font-mono text-[12.5px]">
        <div className="flex gap-2">
          <dt className="w-16 text-muted-foreground">email</dt>
          <dd>admin@hrms.local</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 text-muted-foreground">password</dt>
          <dd>Admin@12345</dd>
        </div>
      </dl>
    </div>
  );
}
