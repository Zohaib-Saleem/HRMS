import { cn } from '@/lib/utils';
import { TD, TR } from './table';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

/**
 * Loading rows that match the real table's shape, so the layout does not jump
 * when data arrives.
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
