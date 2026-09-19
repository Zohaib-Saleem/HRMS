import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Card } from './card';
import { Skeleton } from './skeleton';

type Tone = 'default' | 'primary' | 'success' | 'warning' | 'destructive';

const TONES: Record<Tone, string> = {
  default: 'bg-muted text-muted-foreground',
  primary: 'bg-primary-soft text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning-foreground',
  destructive: 'bg-destructive-soft text-destructive',
};

interface StatCardProps {
  label: string;
  value: number | string | undefined;
  icon: LucideIcon;
  hint?: string;
  tone?: Tone;
  loading?: boolean;
  /**
   * Where the tile goes when it is pressed.
   *
   * For a tile whose number IS a filtered list somewhere else - "Lost: 3"
   * leading to the register showing those three. Absent for a tile that is just
   * a figure, which is most of them: making every tile clickable teaches people
   * that clicking one does nothing.
   */
  to?: string;
}

/** KPI tile. Number first, label second - scannable in a grid. */
export function StatCard({
  label,
  value,
  icon: Icon,
  hint,
  tone = 'default',
  loading = false,
  to,
}: StatCardProps) {
  const card = (
    <Card className={cn('p-5', to && 'h-full transition-colors hover:bg-accent/45')}>
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

  return to ? (
    <Link to={to} className="block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      {card}
    </Link>
  ) : (
    card
  );
}
