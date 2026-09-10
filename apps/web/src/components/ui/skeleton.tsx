import { cn } from '@/lib/utils';
import { TD, TR } from './table';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

/**
 * Loading rows for a list that is NOT inside a `<table>`.
 *
 * `TableSkeleton` emits bare `<tr>` elements, which are only valid inside one.
 * Dropped into a card or a dialog they produce `<tr> cannot be a child of
 * <div>` in the console and an unpredictable layout, because the browser hoists
 * them out. This is the same placeholder in plain blocks.
 */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-4">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * Loading rows that match the real table's shape, so the layout does not jump
 * when data arrives. Only valid inside a `<TBody>` - use `ListSkeleton`
 * anywhere else.
 */
export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <TR key={rowIndex} className="hover:bg-transparent">
          {Array.from({ length: columns }).map((__, colIndex) => (
            <TD key={colIndex}>
              <Skeleton
                className="h-4"
                style={{ width: `${[70, 45, 85, 55, 40, 60][colIndex % 6]}%` }}
              />
            </TD>
          ))}
        </TR>
      ))}
    </>
  );
}
