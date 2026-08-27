import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarRange } from 'lucide-react';
import {
  APPROVAL_STATUSES,
  APPROVAL_STATUS_LABELS,
  LEAVE_DAY_PART_LABELS,
  type LeaveRequestRecord,
  type LeaveTypeRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useDebounced } from '@/lib/use-debounced';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { LEAVE_STATUS_TONE } from './my-leave-page';

const INITIAL = {
  q: '',
  status: '',
  employeeId: '',
  leaveTypeId: '',
  from: '',
  to: '',
  page: 1,
  limit: 20,
};

const days = (n: number) => `${n % 1 === 0 ? n : n.toFixed(1)}`;

/** Manager and administrator view of leave across their data scope. */
export function LeaveRequestsPage() {
  const navigate = useNavigate();
  const { lookups } = useLookups();
  const [filters, setFilters] = React.useState(INITIAL);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const types = useQuery({
    queryKey: ['leave-types', 'all'],
    queryFn: () => api.getPage<LeaveTypeRecord>('/leave-types', { query: { limit: 100 } }),
    staleTime: 5 * 60_000,
  });

  const query = useQuery({
    queryKey: ['leave', 'requests', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<LeaveRequestRecord>('/leave/requests', {
        query: {
          page: filters.page,
          limit: filters.limit,
          view: 'all',
          q: debouncedQuery || undefined,
          status: filters.status || undefined,
          employeeId: filters.employeeId || undefined,
          leaveTypeId: filters.leaveTypeId || undefined,
          from: filters.from || undefined,
          to: filters.to || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const hasFilters =
    filters.q !== '' ||
    filters.status !== '' ||
    filters.employeeId !== '' ||
    filters.leaveTypeId !== '' ||
    filters.from !== '' ||
    filters.to !== '';

  const rows = query.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Leave requests"
        description="Leave across everyone you have access to, with its approval status."
      />

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search employee, type or reason"
          hasActiveFilters={hasFilters}
          onReset={() => setFilters(INITIAL)}
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
                value={filters.employeeId}
                onChange={(e) => update({ employeeId: e.target.value })}
                aria-label="Filter by employee"
                className="w-48"
              >
                <option value="">All employees</option>
                {lookups.managers.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </NativeSelect>

              <NativeSelect
                value={filters.leaveTypeId}
                onChange={(e) => update({ leaveTypeId: e.target.value })}
                aria-label="Filter by leave type"
                className="w-44"
              >
                <option value="">All leave types</option>
                {(types.data?.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </NativeSelect>

              <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                From
                <Input
                  type="date"
                  className="h-8 w-36 text-[13px]"
                  value={filters.from}
                  onChange={(e) => update({ from: e.target.value })}
                  aria-label="From date"
                />
              </label>
              <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                To
                <Input
                  type="date"
                  className="h-8 w-36 text-[13px]"
                  value={filters.to}
                  onChange={(e) => update({ to: e.target.value })}
                  aria-label="To date"
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
                  <TR className="hover:bg-transparent">
                    <TH>Employee</TH>
                    <TH>Type</TH>
                    <TH className="w-56">Dates</TH>
                    <TH className="w-24 text-right">Days</TH>
                    <TH className="w-28">Status</TH>
                    <TH className="w-32 text-right">Approval</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={6} columns={6} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={6} className="p-0">
                        <EmptyState
                          icon={CalendarRange}
                          title={hasFilters ? 'No leave matches your filters' : 'No leave requested yet'}
                          description="Leave raised by anyone within your data scope appears here."
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR key={row.id}>
                        <TD className="text-[13px]">{row.employeeName}</TD>
                        <TD className="text-[13px]">
                          {row.leaveTypeName}
                          {row.dayPart !== 'FULL_DAY' ? (
                            <span className="block text-[12px] text-muted-foreground">
                              {LEAVE_DAY_PART_LABELS[row.dayPart]}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="tabular text-[13px]">
                          {formatDate(row.startDate)}
                          {row.startDate !== row.endDate ? ` – ${formatDate(row.endDate)}` : ''}
                        </TD>
                        <TD className="tabular text-right text-[13px] font-medium">
                          {days(row.totalDays)}
                        </TD>
                        <TD>
                          <Badge variant={LEAVE_STATUS_TONE[row.status]}>
                            {APPROVAL_STATUS_LABELS[row.status]}
                          </Badge>
                        </TD>
                        <TD>
                          <div className="flex justify-end">
                            {row.approvalRequestId ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => navigate(`/approvals/${row.approvalRequestId}`)}
                              >
                                Open
                              </Button>
                            ) : null}
                          </div>
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
