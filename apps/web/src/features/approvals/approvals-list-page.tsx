import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck } from 'lucide-react';
import {
  APPROVAL_STATUSES,
  APPROVAL_STATUS_LABELS,
  APPROVAL_SUBJECT_LABELS,
  APPROVAL_SUBJECT_TYPES,
  type ApprovalListItem,
  type ApprovalStatus,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { formatRelative } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { SortableTH, TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { cn } from '@/lib/utils';

export const APPROVAL_STATUS_TONE: Record<
  ApprovalStatus,
  'warning' | 'success' | 'destructive' | 'neutral'
> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'destructive',
  CANCELLED: 'neutral',
};

const VIEWS = [
  { value: 'inbox', label: 'Awaiting me' },
  { value: 'mine', label: 'Raised by me' },
  { value: 'all', label: 'All visible' },
] as const;

const INITIAL = {
  q: '',
  status: '',
  subjectType: '',
  view: 'inbox' as (typeof VIEWS)[number]['value'],
  page: 1,
  limit: 20,
  sort: 'createdAt',
  order: 'desc' as 'asc' | 'desc',
};

export function ApprovalsListPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = React.useState(INITIAL);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['approvals', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<ApprovalListItem>('/approvals', {
        query: {
          page: filters.page,
          limit: filters.limit,
          sort: filters.sort,
          order: filters.order,
          view: filters.view,
          q: debouncedQuery || undefined,
          status: filters.status || undefined,
          subjectType: filters.subjectType || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const handleSort = (field: string) =>
    update({ sort: field, order: filters.sort === field && filters.order === 'desc' ? 'asc' : 'desc' });

  const hasFilters = filters.q !== '' || filters.status !== '' || filters.subjectType !== '';
  const rows = query.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Requests raised by your team and by you, with their full decision history."
      />

      <div className="mb-5 flex flex-wrap gap-1 border-b border-border">
        {VIEWS.map((view) => (
          <button
            key={view.value}
            type="button"
            onClick={() => update({ view: view.value })}
            className={cn(
              'border-b-2 px-3 py-2.5 text-[13.5px] font-medium transition-colors',
              filters.view === view.value
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {view.label}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search requests"
          hasActiveFilters={hasFilters}
          onReset={() => setFilters({ ...INITIAL, view: filters.view })}
          filters={
            <>
              <NativeSelect
                value={filters.status}
                onChange={(e) => update({ status: e.target.value })}
                aria-label="Filter by status"
                className="w-36"
              >
                <option value="">All statuses</option>
                {APPROVAL_STATUSES.map((s) => (
                  <option key={s} value={s}>{APPROVAL_STATUS_LABELS[s]}</option>
                ))}
              </NativeSelect>
              <NativeSelect
                value={filters.subjectType}
                onChange={(e) => update({ subjectType: e.target.value })}
                aria-label="Filter by request type"
                className="w-48"
              >
                <option value="">All types</option>
                {APPROVAL_SUBJECT_TYPES.map((t) => (
                  <option key={t} value={t}>{APPROVAL_SUBJECT_LABELS[t]}</option>
                ))}
              </NativeSelect>
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
                  <TR className="hover:bg-transparent">
                    <SortableTH field="title" activeField={filters.sort} order={filters.order} onSort={handleSort}>
                      Request
                    </SortableTH>
                    <TH className="w-44">Type</TH>
                    <TH>Raised by</TH>
                    <TH className="w-28">Step</TH>
                    <SortableTH field="createdAt" activeField={filters.sort} order={filters.order} onSort={handleSort} className="w-36">
                      Raised
                    </SortableTH>
                    <SortableTH field="status" activeField={filters.sort} order={filters.order} onSort={handleSort} className="w-32">
                      Status
                    </SortableTH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={6} columns={6} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={6} className="p-0">
                        <EmptyState
                          icon={filters.view === 'inbox' ? CheckCircle2 : ClipboardCheck}
                          title={
                            filters.view === 'inbox'
                              ? 'Nothing waiting on you'
                              : hasFilters
                                ? 'No requests match your filters'
                                : 'No requests yet'
                          }
                          description={
                            filters.view === 'inbox'
                              ? 'Requests assigned to you for a decision will appear here.'
                              : 'Attendance corrections, shift changes and timesheets all appear here once raised.'
                          }
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR
                        key={row.id}
                        className="cursor-pointer"
                        onClick={() => navigate(`/approvals/${row.id}`)}
                      >
                        <TD>
                          <div className="flex items-center gap-2">
                            {row.awaitingMyDecision ? (
                              <span
                                className="size-1.5 shrink-0 rounded-full bg-warning"
                                aria-label="Awaiting your decision"
                              />
                            ) : null}
                            <div className="min-w-0">
                              <p className="truncate text-[13.5px] font-medium">{row.title}</p>
                              {row.summary ? (
                                <p className="truncate text-[12px] text-muted-foreground">{row.summary}</p>
                              ) : null}
                            </div>
                          </div>
                        </TD>
                        <TD className="text-[13px]">{APPROVAL_SUBJECT_LABELS[row.subjectType]}</TD>
                        <TD className="text-[13px]">{row.requesterName}</TD>
                        <TD className="tabular text-[13px] text-muted-foreground">
                          {row.status === 'PENDING' ? `${row.currentStep} of ${row.totalSteps}` : '--'}
                        </TD>
                        <TD className="text-[13px] text-muted-foreground">
                          {formatRelative(row.createdAt)}
                        </TD>
                        <TD>
                          <Badge variant={APPROVAL_STATUS_TONE[row.status]}>
                            {APPROVAL_STATUS_LABELS[row.status]}
                          </Badge>
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
    </>
  );
}
