import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { RotateCcw, ScrollText, Search, X } from 'lucide-react';
import type { AuditLogEntry } from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { formatDateTime, humanise, initials } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/field';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import {
  SortableTH,
  TBody,
  TD,
  THead,
  TR,
  Table,
  TableWrapper,
} from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';

interface Filters {
  q: string;
  entityType: string;
  action: string;
  page: number;
  limit: number;
  sort: string;
  order: 'asc' | 'desc';
}

const INITIAL: Filters = {
  q: '',
  entityType: '',
  action: '',
  page: 1,
  limit: 20,
  sort: 'createdAt',
  order: 'desc',
};

export function AuditLogPage() {
  const [filters, setFilters] = React.useState<Filters>(INITIAL);
  const debouncedQuery = useDebounced(filters.q, 350);

  // Any filter change resets to the first page - otherwise you can land on a
  // page that no longer exists in the narrowed result set.
  const update = React.useCallback(
    (patch: Partial<Filters>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const filterOptions = useQuery({
    queryKey: ['audit-logs', 'filters'],
    queryFn: () => api.get<{ entityTypes: string[]; actions: string[] }>('/audit-logs/filters'),
    staleTime: 5 * 60_000,
  });

  const query = useQuery({
    queryKey: [
      'audit-logs',
      { ...filters, q: debouncedQuery },
    ],
    queryFn: () =>
      api.getPage<AuditLogEntry>('/audit-logs', {
        query: {
          page: filters.page,
          limit: filters.limit,
          sort: filters.sort,
          order: filters.order,
          q: debouncedQuery || undefined,
          entityType: filters.entityType || undefined,
          action: filters.action || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const handleSort = (field: string) =>
    update({
      sort: field,
      order: filters.sort === field && filters.order === 'desc' ? 'asc' : 'desc',
    });

  const hasFilters =
    filters.q !== '' || filters.entityType !== '' || filters.action !== '';

  const rows = query.data?.data ?? [];

  return (
    <Card className="overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3.5 lg:flex-row lg:items-center">
        <div className="relative flex-1 lg:max-w-xs">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={filters.q}
            onChange={(event) => update({ q: event.target.value })}
            placeholder="Search actions, people, records"
            aria-label="Search the audit log"
            className="pl-9 pr-9"
          />
          {filters.q ? (
            <button
              type="button"
              onClick={() => update({ q: '' })}
              className="absolute right-2.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            value={filters.entityType}
            onChange={(event) => update({ entityType: event.target.value })}
            aria-label="Filter by record type"
            className="w-40"
          >
            <option value="">All record types</option>
            {filterOptions.data?.entityTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </NativeSelect>

          <NativeSelect
            value={filters.action}
            onChange={(event) => update({ action: event.target.value })}
            aria-label="Filter by action"
            className="w-48"
          >
            <option value="">All actions</option>
            {filterOptions.data?.actions.map((action) => (
              <option key={action} value={action}>
                {humanise(action)}
              </option>
            ))}
          </NativeSelect>

          {hasFilters ? (
            <Button variant="ghost" size="sm" onClick={() => setFilters(INITIAL)}>
              <RotateCcw />
              Reset
            </Button>
          ) : null}
        </div>
      </div>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <TableWrapper>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <SortableTH
                    field="createdAt"
                    activeField={filters.sort}
                    order={filters.order}
                    onSort={handleSort}
                    className="w-44"
                  >
                    When
                  </SortableTH>
                  <SortableTH
                    field="action"
                    activeField={filters.sort}
                    order={filters.order}
                    onSort={handleSort}
                  >
                    Action
                  </SortableTH>
                  <SortableTH
                    field="entityType"
                    activeField={filters.sort}
                    order={filters.order}
                    onSort={handleSort}
                    className="w-32"
                  >
                    Record
                  </SortableTH>
                  <THeadCell>Who</THeadCell>
                  <THeadCell className="w-32">IP</THeadCell>
                </TR>
              </THead>

              <TBody>
                {query.isLoading ? (
                  <TableSkeleton rows={8} columns={5} />
                ) : rows.length === 0 ? (
                  <TR className="hover:bg-transparent">
                    <TD colSpan={5} className="p-0">
                      {hasFilters ? (
                        <EmptyState
                          title="No entries match your filters"
                          description="Try a different search term or clear the filters."
                          action={
                            <Button variant="outline" size="sm" onClick={() => setFilters(INITIAL)}>
                              <RotateCcw />
                              Clear filters
                            </Button>
                          }
                        />
                      ) : (
                        <EmptyState
                          icon={ScrollText}
                          title="The audit log is empty"
                          description="Every sign-in and change made in the system will be recorded here."
                        />
                      )}
                    </TD>
                  </TR>
                ) : (
                  rows.map((entry) => (
                    <TR key={entry.id}>
                      <TD className="tabular whitespace-nowrap text-[13px] text-muted-foreground">
                        {formatDateTime(entry.createdAt)}
                      </TD>
                      <TD>
                        <p className="text-[13.5px] font-medium">
                          {entry.summary ?? humanise(entry.action)}
                        </p>
                        <p className="font-mono text-[11.5px] text-muted-foreground">
                          {entry.action}
                        </p>
                      </TD>
                      <TD>
                        <Badge variant="outline">{entry.entityType}</Badge>
                      </TD>
                      <TD>
                        {entry.actor ? (
                          <div className="flex items-center gap-2.5">
                            <span
                              className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[10.5px] font-semibold text-muted-foreground"
                              aria-hidden
                            >
                              {initials(
                                entry.actor.fullName.split(' ')[0] ?? '',
                                entry.actor.fullName.split(' ')[1] ?? '',
                              )}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-[13px]">
                                {entry.actor.fullName}
                              </span>
                              <span className="block truncate text-[11.5px] text-muted-foreground">
                                {entry.actor.email}
                              </span>
                            </span>
                          </div>
                        ) : (
                          <span className="text-[13px] text-muted-foreground">System</span>
                        )}
                      </TD>
                      <TD className="tabular font-mono text-[12px] text-muted-foreground">
                        {entry.ipAddress ?? '--'}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </TableWrapper>

          {query.data ? (
            <Pagination
              meta={query.data.meta}
              disabled={query.isFetching}
              onPageChange={(page) => update({ page })}
              onLimitChange={(limit) => update({ limit })}
            />
          ) : null}
        </>
      )}
    </Card>
  );
}

/** Non-sortable header cell, kept local so the table markup stays symmetrical. */
function THeadCell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`h-10 whitespace-nowrap px-4 text-left align-middle text-xs font-semibold uppercase tracking-wide ${className ?? ''}`}
    >
      {children}
    </th>
  );
}
