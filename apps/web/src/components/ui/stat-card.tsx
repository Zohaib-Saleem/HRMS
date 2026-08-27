import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from './card';
import { Skeleton } from './skeleton';

type Tone = 'default' | 'primary' | 'success' | 'warning';

const TONES: Record<Tone, string> = {
  default: 'bg-muted text-muted-foreground',
  primary: 'bg-primary-soft text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning-foreground',
};

interface StatCardProps {
  label: string;
  value: number | string | undefined;
  icon: LucideIcon;
  hint?: string;
  tone?: Tone;
  loading?: boolean;
}

/** KPI tile. Number first, label second - scannable in a grid. */
export function StatCard({
  label,
  value,
  icon: Icon,
  hint,
  tone = 'default',
  loading = false,
}: StatCardProps) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-[13px] font-medium text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <p className="tabular text-3xl font-semibold leading-none tracking-tight">
              {value ?? '--'}
            </p>
          )}
          {hint ? <p className="truncate pt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <span
          className={cn('grid size-10 shrink-0 place-items-center rounded-lg', TONES[tone])}
          aria-hidden
        >
          <Icon className="size-5" />
        </span>
      </div>
    </Card>
  );
}
