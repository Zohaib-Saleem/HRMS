import * as React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Flame, Headset, Inbox, UserCheck, UserPlus } from 'lucide-react';
import {
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  CASE_STATUSES,
  CASE_STATUS_LABELS,
  PERMISSIONS,
  type CaseAgentOption,
  type CaseQueueSummary,
  type CaseRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { StatCard } from '@/components/ui/stat-card';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import { CASE_PRIORITY_TONE, CASE_STATUS_TONE, caseDay } from './case-shared';
import { flattenCatalogue, useCaseCatalogue } from './use-case-catalogue';

/**
 * The queue: the cases somebody on the desk is meant to work.
 *
 * A different screen from "My cases" rather than a toggle on it, because the
 * two answer different questions and would fight over every column. This one
 * shows who raised each case - which the employee's own list has no column for,
 * there being only one possible answer - and orders by priority rather than by
 * date, because a queue is worked worst-first and a personal list is read
 * newest-first.
 *
 * How much of the company is behind this list is not this screen's business.
 * The endpoint answers with whatever the caller's grants allow - their own
 * department, or everything - and the page renders what it is given. There is
 * no "show all departments" control here for the same reason there is no
 * employee picker on the other screen: a control that widens a query is a
 * control that has to be checked, and the check already happened on the server.
 */

const INITIAL = {
  q: '',
  assignee: '',
  status: '',
  priority: '',
  departmentId: '',
  categoryId: '',
  from: '',
  to: '',
  /** Live-only by default: a queue is a list of what is still somebody's job. */
  live: true,
  page: 1,
  limit: 20,
};

export function CaseQueuePage() {
  const { has } = usePermissions();
  const canAssign = has(PERMISSIONS.CASE_ASSIGN);

  // `?assignee=unassigned` (or `me`) is where the dashboard's links land.
  const [params] = useSearchParams();
  const [filters, setFilters] = React.useState(() => ({
    ...INITIAL,
    assignee: params.get('assignee') ?? INITIAL.assignee,
  }));
  const debouncedQuery = useDebounced(filters.q, 350);

  const { catalogue } = useCaseCatalogue();
  const categories = React.useMemo(() => flattenCatalogue(catalogue), [catalogue]);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const summary = useQuery({
    queryKey: ['cases', 'queue', 'summary'],
    queryFn: () => api.get<CaseQueueSummary>('/cases/queue/summary'),
  });

  /** Only fetched when the caller can actually hand a case to somebody. */
  const agents = useQuery({
    queryKey: ['cases', 'queue', 'agents'],
    queryFn: () => api.get<CaseAgentOption[]>('/cases/queue/agents'),
    enabled: canAssign,
    staleTime: 5 * 60_000,
  });

  const query = useQuery({
    queryKey: ['cases', 'queue', 'list', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<CaseRecord>('/cases/queue', {
        query: {
          q: debouncedQuery || undefined,
          assignee: filters.assignee || undefined,
          status: filters.status || undefined,
          priority: filters.priority || undefined,
          departmentId: filters.departmentId || undefined,
          categoryId: filters.categoryId || undefined,
          from: filters.from || undefined,
          to: filters.to || undefined,
          live: filters.live ? 'true' : undefined,
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
    filters.assignee !== '' ||
    filters.status !== '' ||
    filters.priority !== '' ||
    filters.departmentId !== '' ||
    filters.categoryId !== '' ||
    filters.from !== '' ||
    filters.to !== '' ||
    filters.live !== INITIAL.live;

  const columns = 8;

  return (
    <>
      <PageHeader
        title="Case queue"
        description="Everything raised with the desks you work, worst first."
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Still open"
          value={summary.data?.live}
          icon={Inbox}
          hint="Raised and not yet finished"
          loading={summary.isLoading}
        />
        <StatCard
          label="Nobody's"
          value={summary.data?.unassigned}
          icon={UserPlus}
          hint="Waiting to be picked up"
          tone="warning"
          loading={summary.isLoading}
        />
        <StatCard
          label="Yours"
          value={summary.data?.mine}
          icon={UserCheck}
          hint="Assigned to you"
          tone="primary"
          loading={summary.isLoading}
        />
        <StatCard
          label="High or urgent"
          value={summary.data?.urgent}
          icon={Flame}
          hint="Open and pressing"
          tone="warning"
          loading={summary.isLoading}
        />
      </div>

      <Card>
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search by case number, subject or who raised it"
          hasActiveFilters={hasActiveFilters}
          onReset={() => setFilters(INITIAL)}
          filters={
            <>
              {/* "Mine" and "unassigned" are words rather than ids: the server
                  is the only thing that can be trusted to know whose session
                  this is, so it resolves them. */}
              <NativeSelect
                aria-label="Assigned to"
                value={filters.assignee}
                onChange={(event) => update({ assignee: event.target.value })}
                className="xl:w-48"
              >
                <option value="">Anyone</option>
                <option value="me">Assigned to me</option>
                <option value="unassigned">Unassigned</option>
                {(agents.data ?? []).map((agent) => (
                  <option key={agent.userId} value={agent.userId}>
                    {agent.name}
                  </option>
                ))}
              </NativeSelect>

              <NativeSelect
                aria-label="Show"
                value={filters.live ? 'live' : 'all'}
                onChange={(event) => update({ live: event.target.value === 'live' })}
                className="xl:w-40"
              >
                <option value="live">Still open</option>
                <option value="all">Everything</option>
              </NativeSelect>

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
                    <TH>Raised by</TH>
                    <TH>Queue</TH>
                    <TH>Priority</TH>
                    <TH>Status</TH>
                    <TH>Assigned to</TH>
                    <TH>Last activity</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={5} columns={columns} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={columns} className="p-0">
                        <EmptyState
                          icon={Headset}
                          title={hasActiveFilters ? 'Nothing matches those filters' : 'The queue is empty'}
                          description={
                            hasActiveFilters
                              ? 'Clear the filters to see everything you can work.'
                              : 'Nothing has been raised with the desks you work. If you were expecting something here, check that your employee record has the right department.'
                          }
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR key={row.id}>
                        <TD>
                          <Link
                            to={`/case-queue/${row.id}`}
                            className="font-mono text-[12.5px] font-medium text-primary hover:underline"
                          >
                            {row.caseNumber}
                          </Link>
                        </TD>
                        <TD className="max-w-xs">
                          <Link
                            to={`/case-queue/${row.id}`}
                            className="block truncate text-[13.5px] hover:underline"
                          >
                            {row.subject}
                          </Link>
                          {/* Replies rather than messages: the count comes from
                              the same figure the requester sees, so internal
                              notes are not in it and saying "messages" here
                              would overstate what is on the case. */}
                          {row.messageCount > 0 ? (
                            <p className="text-[11.5px] text-muted-foreground">
                              {row.messageCount} {row.messageCount === 1 ? 'reply' : 'replies'}
                              {row.attachmentCount > 0
                                ? ` · ${row.attachmentCount} attachment${row.attachmentCount === 1 ? '' : 's'}`
                                : ''}
                            </p>
                          ) : null}
                        </TD>
                        <TD className="text-[13px]">
                          {row.requesterName}
                          <span className="block font-mono text-[11.5px] text-muted-foreground">
                            {row.requesterEmployeeNumber}
                          </span>
                        </TD>
                        <TD className="text-[13px]">
                          {row.departmentName}
                          <span className="block text-[11.5px] text-muted-foreground">
                            {row.categoryName}
                            {row.subcategoryName ? ` · ${row.subcategoryName}` : ''}
                          </span>
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
                        <TD className="text-[13px]">
                          {row.assignedToName ?? (
                            <span className="text-muted-foreground">Nobody yet</span>
                          )}
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
    </>
  );
}
