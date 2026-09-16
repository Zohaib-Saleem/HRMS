import * as React from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { LifeBuoy, Plus } from 'lucide-react';
import {
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  CASE_STATUSES,
  CASE_STATUS_LABELS,
  PERMISSIONS,
  type CaseRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import { CASE_PRIORITY_TONE, CASE_STATUS_TONE, caseDay } from './case-shared';
import { CaseCreateDialog } from './case-create-dialog';
import { flattenCatalogue, useCaseCatalogue } from './use-case-catalogue';

/**
 * My cases.
 *
 * One screen, and in Phase 1 it is genuinely one person's: the endpoint behind
 * it returns the caller's own cases and there is no parameter that widens it -
 * not a data scope, not an employee id, not a `view=all`. So there is no
 * "whose cases" control here and no employee column, because there is nothing
 * for them to switch between. Phase 2's agent queue is a different screen with
 * a different grant rather than a toggle bolted onto this one.
 *
 * Every filter goes to the server. The page never holds more than one page of
 * cases, which is the difference between a screen that still works after four
 * years of them and one that quietly starts taking six seconds to open.
 */

const INITIAL = {
  q: '',
  status: '',
  priority: '',
  departmentId: '',
  categoryId: '',
  from: '',
  to: '',
  page: 1,
  limit: 20,
};

export function CasesPage() {
  const { has } = usePermissions();
  const canCreate = has(PERMISSIONS.CASE_CREATE);

  const [filters, setFilters] = React.useState(INITIAL);
  const [creating, setCreating] = React.useState(false);
  const debouncedQuery = useDebounced(filters.q, 350);

  const { catalogue } = useCaseCatalogue();
  const categories = React.useMemo(() => flattenCatalogue(catalogue), [catalogue]);

  /** Any change but a page change returns to page one. */
  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['cases', 'list', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<CaseRecord>('/cases', {
        query: {
          q: debouncedQuery || undefined,
          status: filters.status || undefined,
          priority: filters.priority || undefined,
          departmentId: filters.departmentId || undefined,
          categoryId: filters.categoryId || undefined,
          from: filters.from || undefined,
          to: filters.to || undefined,
          page: filters.page,
          limit: filters.limit,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;
  const hasActiveFilters =
    filters.q !== '' ||
    filters.status !== '' ||
    filters.priority !== '' ||
    filters.departmentId !== '' ||
    filters.categoryId !== '' ||
    filters.from !== '' ||
    filters.to !== '';

  const columns = 8;

  return (
    <>
      <PageHeader
        title="My cases"
        description="Anything you have asked HR, Finance, IT or Admin to sort out, and where each one got to."
        actions={
          canCreate ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              Raise a case
            </Button>
          ) : undefined
        }
      />

      <Card>
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search by case number or subject"
          hasActiveFilters={hasActiveFilters}
          onReset={() => setFilters(INITIAL)}
          filters={
            <>
              <NativeSelect
                aria-label="Status"
                value={filters.status}
                onChange={(event) => update({ status: event.target.value })}
                className="xl:w-44"
              >
                <option value="">All statuses</option>
                {CASE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {CASE_STATUS_LABELS[status]}
                  </option>
                ))}
              </NativeSelect>

              <NativeSelect
                aria-label="Priority"
                value={filters.priority}
                onChange={(event) => update({ priority: event.target.value })}
                className="xl:w-40"
              >
                <option value="">All priorities</option>
                {CASE_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {CASE_PRIORITY_LABELS[priority]}
                  </option>
                ))}
              </NativeSelect>

              {/* Both lists come from the catalogue, so they hold whatever the
                  company configured and nothing this file knows about. */}
              <NativeSelect
                aria-label="Department"
                value={filters.departmentId}
                onChange={(event) => update({ departmentId: event.target.value })}
                className="xl:w-44"
              >
                <option value="">All departments</option>
                {catalogue.map((entry) => (
                  <option key={entry.departmentId} value={entry.departmentId}>
                    {entry.departmentName}
                  </option>
                ))}
              </NativeSelect>

              <NativeSelect
                aria-label="Category"
                value={filters.categoryId}
                onChange={(event) => update({ categoryId: event.target.value })}
                className="xl:w-56"
              >
                <option value="">All categories</option>
                {categories.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </NativeSelect>

              <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <span className="hidden sm:inline">From</span>
                <Input
                  type="date"
                  aria-label="Raised from"
                  value={filters.from}
                  max={filters.to || undefined}
                  onChange={(event) => update({ from: event.target.value })}
                  className="h-9 w-40"
                />
              </label>
              <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <span className="hidden sm:inline">To</span>
                <Input
                  type="date"
                  aria-label="Raised to"
                  value={filters.to}
                  min={filters.from || undefined}
                  onChange={(event) => update({ to: event.target.value })}
                  className="h-9 w-40"
                />
              </label>
            </>
          }
        />

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Case #</TH>
                    <TH>Subject</TH>
                    <TH>Department</TH>
                    <TH>Category</TH>
                    <TH>Priority</TH>
                    <TH>Status</TH>
                    <TH>Created</TH>
                    <TH>Updated</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={5} columns={columns} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={columns} className="p-0">
                        <EmptyState
                          icon={LifeBuoy}
                          title={hasActiveFilters ? 'No cases match those filters' : 'No cases yet'}
                          description={
                            hasActiveFilters
                              ? 'Clear the filters to see everything.'
                              : canCreate
                                ? 'Raise one when something needs sorting out and you want it tracked.'
                                : 'Cases you raise will appear here.'
                          }
                          action={
                            canCreate && !hasActiveFilters ? (
                              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                                Raise a case
                              </Button>
                            ) : undefined
                          }
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR key={row.id}>
                        <TD>
                          {/* A link rather than a row click: a case number is
                              something people copy, open in a new tab and send
                              to somebody, and none of that works on a div. */}
                          <Link
                            to={`/cases/${row.id}`}
                            className="font-mono text-[12.5px] font-medium text-primary hover:underline"
                          >
                            {row.caseNumber}
                          </Link>
                        </TD>
                        <TD className="max-w-xs">
                          <Link to={`/cases/${row.id}`} className="block truncate text-[13.5px] hover:underline">
                            {row.subject}
                          </Link>
                          {row.messageCount > 0 ? (
                            <p className="text-[11.5px] text-muted-foreground">
                              {row.messageCount} {row.messageCount === 1 ? 'reply' : 'replies'}
                              {row.attachmentCount > 0
                                ? ` · ${row.attachmentCount} attachment${row.attachmentCount === 1 ? '' : 's'}`
                                : ''}
                            </p>
                          ) : null}
                        </TD>
                        <TD className="text-[13px]">{row.departmentName}</TD>
                        <TD className="text-[13px]">
                          {row.categoryName}
                          {row.subcategoryName ? (
                            <span className="block text-[11.5px] text-muted-foreground">
                              {row.subcategoryName}
                            </span>
                          ) : null}
                        </TD>
                        <TD>
                          <Badge variant={CASE_PRIORITY_TONE[row.priority]}>
                            {CASE_PRIORITY_LABELS[row.priority]}
                          </Badge>
                        </TD>
                        <TD>
                          <Badge variant={CASE_STATUS_TONE[row.status]}>
                            {CASE_STATUS_LABELS[row.status]}
                          </Badge>
                        </TD>
                        <TD className="whitespace-nowrap text-[13px] text-muted-foreground">
                          {caseDay(row.createdAt)}
                        </TD>
                        <TD className="whitespace-nowrap text-[13px] text-muted-foreground">
                          {caseDay(row.lastMessageAt ?? row.updatedAt)}
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>
            {meta ? (
              <Pagination
                meta={meta}
                onPageChange={(page) => update({ page })}
                onLimitChange={(limit) => update({ limit })}
              />
            ) : null}
          </>
        )}
      </Card>

      <CaseCreateDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
