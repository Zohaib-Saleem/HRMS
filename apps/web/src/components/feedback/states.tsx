import type { LucideIcon } from 'lucide-react';
import { AlertCircle, Loader2, Lock, RefreshCw, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

/** Shown when a query succeeded but returned nothing. */
export function EmptyState({
  icon: Icon = SearchX,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-14 text-center', className)}>
      <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}

/** Shown when a query failed. Distinguishes "not allowed" from "broke". */
export function ErrorState({ error, onRetry, className }: ErrorStateProps) {
  const forbidden = error instanceof ApiError && error.isForbidden;

  return (
    <div className={cn('flex flex-col items-center px-6 py-14 text-center', className)}>
      <span
        className={cn(
          'mb-3 grid size-11 place-items-center rounded-full',
          forbidden ? 'bg-warning-soft text-warning-foreground' : 'bg-destructive-soft text-destructive',
        )}
      >
        {forbidden ? (
          <Lock className="size-5" aria-hidden />
        ) : (
          <AlertCircle className="size-5" aria-hidden />
        )}
      </span>
      <p className="text-sm font-medium">
        {forbidden ? 'You do not have access to this' : 'Could not load this'}
      </p>
      <p className="mt-1 max-w-md text-[13px] text-muted-foreground">{errorMessage(error)}</p>
      {onRetry && !forbidden ? (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          <RefreshCw />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Full-viewport loader, used while the session is being resolved. */
export function FullPageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="grid h-full place-items-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" aria-hidden />
        <p className="text-sm">{label}</p>
      </div>
    </div>
  );
}
