import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Table primitives. Horizontal overflow is owned by the wrapper, so a wide
 * table scrolls inside its card instead of pushing the page sideways.
 */

export function TableWrapper({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('w-full overflow-x-auto', className)} {...props} />;
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full caption-bottom text-sm', className)} {...props} />;
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn('border-b border-border bg-surface-muted/60 text-muted-foreground', className)}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-border', className)} {...props} />;
}

export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('transition-colors hover:bg-accent/45', className)} {...props} />;
}

export function TH({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'h-10 whitespace-nowrap px-4 text-left align-middle text-xs font-semibold uppercase tracking-wide',
        className,
      )}
      {...props}
    />
  );
}

export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-4 py-3 align-middle', className)} {...props} />;
}

interface SortableTHProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  field: string;
  activeField?: string;
  order?: 'asc' | 'desc';
  onSort: (field: string) => void;
}

export function SortableTH({
  field,
  activeField,
  order = 'desc',
  onSort,
  children,
  className,
  ...props
}: SortableTHProps) {
  const active = activeField === field;
  const Icon = !active ? ChevronsUpDown : order === 'asc' ? ArrowUp : ArrowDown;

  return (
    <TH
      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('p-0', className)}
      {...props}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn(
          'flex h-10 w-full items-center gap-1.5 px-4 text-left transition-colors hover:text-foreground',
          active && 'text-foreground',
        )}
      >
        {children}
        <Icon className={cn('size-3.5', !active && 'opacity-45')} aria-hidden />
      </button>
    </TH>
  );
}
