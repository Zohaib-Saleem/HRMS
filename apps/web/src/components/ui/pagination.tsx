import type { PaginationMeta } from '@hrms/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './button';
import { NativeSelect } from './field';

interface PaginationProps {
  meta: PaginationMeta;
  onPageChange: (page: number) => void;
  onLimitChange?: (limit: number) => void;
  disabled?: boolean;
}

const PAGE_SIZES = [10, 20, 50, 100];

export function Pagination({ meta, onPageChange, onLimitChange, disabled }: PaginationProps) {
  const { page, limit, total, totalPages } = meta;
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  return (
    <div className="flex flex-col gap-3 border-t border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="tabular text-[13px] text-muted-foreground">
        {total === 0 ? (
          'No results'
        ) : (
          <>
            Showing <span className="font-medium text-foreground">{from}</span> to{' '}
            <span className="font-medium text-foreground">{to}</span> of{' '}
            <span className="font-medium text-foreground">{total}</span>
          </>
        )}
      </p>

      <div className="flex items-center gap-3">
        {onLimitChange ? (
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span className="hidden sm:inline">Rows</span>
            <NativeSelect
              className="h-8 w-18 text-[13px]"
              value={limit}
              disabled={disabled}
              onChange={(event) => onLimitChange(Number(event.target.value))}
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : null}

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={disabled || page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft />
          </Button>
          <span className="tabular px-2 text-[13px] text-muted-foreground">
            {totalPages === 0 ? '0 / 0' : `${page} / ${totalPages}`}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={disabled || page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
