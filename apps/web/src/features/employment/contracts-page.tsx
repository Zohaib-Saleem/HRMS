import * as React from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, FileSignature } from 'lucide-react';
import {
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPES,
  CONTRACT_TYPE_LABELS,
  type ContractRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { StatCard } from '@/components/ui/stat-card';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import {
  CONTRACT_EXPIRY_TONE,
  CONTRACT_STATUS_TONE,
  expiryLabel,
  isoDay,
} from './employment-shared';

/**
 * Every contract in the company, with the ones running out at the top of mind.
 *
 * The two counts in the header are the reason this screen exists at all: a
 * fixed-term contract that lapses unnoticed is somebody working without one.
 * They are counted server-side across the whole company rather than derived
 * from the page on screen, so the warning does not depend on which page you
 * happen to be looking at.
 */

const INITIAL = { q: '', status: '', contractType: '', expiry: '', page: 1, limit: 20 };

export function ContractsPage() {
  const [filters, setFilters] = React.useState(INITIAL);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const summary = useQuery({
    queryKey: ['contracts', 'expiring-summary'],
    queryFn: () =>
      api.get<{ expiringSoon: number; expired: number; warningDays: number }>(
        '/contracts/expiring/summary',
      ),
  });

  const query = useQuery({
    queryKey: ['contracts', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<ContractRecord>('/contracts', {
        query: {
          q: debouncedQuery || undefined,
          status: filters.status || undefined,
          contractType: filters.contractType || undefined,
          expiry: filters.expiry || undefined,
          page: filters.page,
          limit: filters.limit,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;
  const hasActiveFilters =
    filters.q !== '' || filters.status !== '' || filters.contractType !== '' || filters.expiry !== '';

  return (
    <>
      <PageHeader
        title="Contracts"
        description="Employment contracts across the company. A contract is never deleted - it is renewed, or its status changes."
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label={`Expiring within ${summary.data?.warningDays ?? 30} days`}
          value={summary.data?.expiringSoon ?? 0}
          icon={CalendarClock}
          tone={summary.data?.expiringSoon ? 'warning' : 'default'}
          hint="Still marked active or draft."
          loading={summary.isLoading}
        />
        <StatCard
          label="Already past their end date"
          value={summary.data?.expired ?? 0}
          icon={AlertTriangle}
          tone={summary.data?.expired ? 'warning' : 'default'}
          hint="Nobody has closed or renewed these yet."
          loading={summary.isLoading}
        />
      </div>

      <Card>
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search by employee or reference"
          hasActiveFilters={hasActiveFilters}
          onReset={() => setFilters(INITIAL)}
          filters={
            <>
              <NativeSelect
                aria-label="Expiry"
                value={filters.expiry}
                onChange={(event) => update({ expiry: event.target.value })}
                className="xl:w-44"
              >
                <option value="">Any expiry</option>
                <option value="expiring">Expiring soon</option>
                <option value="expired">Expired</option>
                <option value="active">Not expiring</option>
              </NativeSelect>
              <NativeSelect
                aria-label="Status"
                value={filters.status}
                onChange={(event) => update({ status: event.target.value })}
                className="xl:w-40"
              >
                <option value="">All statuses</option>
                {CONTRACT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {CONTRACT_STATUS_LABELS[status]}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label="Contract type"
                value={filters.contractType}
                onChange={(event) => update({ contractType: event.target.value })}
                className="xl:w-44"
              >
                <option value="">All types</option>
                {CONTRACT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {CONTRACT_TYPE_LABELS[type]}
                  </option>
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
                  <TR>
                    <TH>Employee</TH>
                    <TH>Type</TH>
                    <TH>From</TH>
                    <TH>To</TH>
                    <TH>Expiry</TH>
                    <TH>Status</TH>
                    <TH>Reference</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={6} columns={7} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={7} className="p-0">
                        <EmptyState
                          icon={FileSignature}
                          title={
                            hasActiveFilters ? 'No contracts match those filters' : 'No contracts yet'
                          }
                          description={
                            hasActiveFilters
                              ? 'Clear the filters to see everything.'
                              : 'Record a contract from an employee’s Contracts tab.'
                          }
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR key={row.id}>
                        <TD>
                          <Link
                            to={`/people/${row.employeeId}`}
                            className="text-[13.5px] font-medium text-primary hover:underline"
                          >
                            {row.employeeName}
                          </Link>
                          <p className="font-mono text-[11.5px] text-muted-foreground">
                            {row.employeeNumber}
                          </p>
                        </TD>
                        <TD className="text-[13px]">{CONTRACT_TYPE_LABELS[row.contractType]}</TD>
                        <TD className="whitespace-nowrap text-[13px]">{isoDay(row.startDate)}</TD>
                        <TD className="whitespace-nowrap text-[13px] text-muted-foreground">
                          {row.endDate ? isoDay(row.endDate) : '—'}
                        </TD>
                        <TD>
                          <Badge variant={CONTRACT_EXPIRY_TONE[row.expiryState]}>
                            {expiryLabel(row.expiryState, row.daysRemaining)}
                          </Badge>
                        </TD>
                        <TD>
                          <Badge variant={CONTRACT_STATUS_TONE[row.status]}>
                            {CONTRACT_STATUS_LABELS[row.status]}
                          </Badge>
                        </TD>
                        <TD className="font-mono text-[12.5px] text-muted-foreground">
                          {row.reference ?? '—'}
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>
            {meta ? <Pagination meta={meta} onPageChange={(page) => update({ page })} /> : null}
          </>
        )}
      </Card>
    </>
  );
}
