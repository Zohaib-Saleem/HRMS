import type { ReactNode } from 'react';
import { RotateCcw, Search, X } from 'lucide-react';
import { Button } from './button';
import { Input } from './field';
import { cn } from '@/lib/utils';

interface ListToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  placeholder?: string;
  /** Filter controls rendered next to the search box. */
  filters?: ReactNode;
  /** Shown when at least one filter or the search term is active. */
  onReset?: () => void;
  hasActiveFilters?: boolean;
  actions?: ReactNode;
  className?: string;
}

/** Shared table toolbar: search, filters, reset, primary actions. */
export function ListToolbar({
  search,
  onSearchChange,
  placeholder = 'Search',
  filters,
  onReset,
  hasActiveFilters = false,
  actions,
  className,
}: ListToolbarProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-b border-border px-5 py-3.5 xl:flex-row xl:items-center',
        className,
      )}
    >
      <div className="relative flex-1 xl:max-w-xs">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="pl-9 pr-9"
        />
        {search ? (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="absolute right-2.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>

      {filters ? <div className="flex flex-wrap items-center gap-2">{filters}</div> : null}

      {hasActiveFilters && onReset ? (
        <Button variant="ghost" size="sm" onClick={onReset}>
          <RotateCcw />
          Reset
        </Button>
      ) : null}

      {actions ? <div className="flex items-center gap-2 xl:ml-auto">{actions}</div> : null}
    </div>
  );
}
