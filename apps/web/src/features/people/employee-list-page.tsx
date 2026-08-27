import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, GitBranch, Plus, Users } from 'lucide-react';
import {
  EMPLOYEE_STATUSES,
  EMPLOYEE_STATUS_LABELS,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  PERMISSIONS,
  type EmployeeListItem,
  type EmployeeStatus,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useDebounced } from '@/lib/use-debounced';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { SortableTH, TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Can, usePermissions } from '@/features/auth/session-context';
import { EmployeeFormDrawer } from './employee-form-drawer';

const STATUS_TONE: Record<EmployeeStatus, 'success' | 'warning' | 'destructive' | 'neutral'> = {
  ACTIVE: 'success',
  ON_LEAVE: 'warning',
  SUSPENDED: 'destructive',
  TERMINATED: 'neutral',
};

const INITIAL = {
  q: '',
  status: '',
  employmentType: '',
  departmentId: '',
  teamId: '',
  designationId: '',
  locationId: '',
  page: 1,
  limit: 20,
  sort: 'lastName',
  order: 'asc' as 'asc' | 'desc',
};

export function EmployeeListPage() {
  const navigate = useNavigate();
  const { has } = usePermissions();
  const { lookups } = useLookups();

  const [filters, setFilters] = React.useState(INITIAL);
  const [creating, setCreating] = React.useState(false);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['employees', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<EmployeeListItem>('/employees', {
        query: {
          page: filters.page,
          limit: filters.limit,
          sort: filters.sort,
          order: filters.order,
          q: debouncedQuery || undefined,
          status: filters.status || undefined,
          employmentType: filters.employmentType || undefined,
          departmentId: filters.departmentId || undefined,
          teamId: filters.teamId || undefined,
          designationId: filters.designationId || undefined,
          locationId: filters.locationId || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const handleSort = (field: string) =>
    update({ sort: field, order: filters.sort === field && filters.order === 'asc' ? 'desc' : 'asc' });

  const hasFilters =
    filters.q !== '' ||
    filters.status !== '' ||
    filters.employmentType !== '' ||
    filters.departmentId !== '' ||
    filters.teamId !== '' ||
    filters.designationId !== '' ||
    filters.locationId !== '';

  const teamOptions = lookups.teams.filter(
    (team) => !filters.departmentId || team.departmentId === filters.departmentId,
  );

  const rows = query.data?.data ?? [];
  const canManage = has(PERMISSIONS.EMPLOYEE_MANAGE);

  return (
    <>
      <PageHeader
        title="People"
        description="Everyone in the organisation, with their role and reporting line."
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to="/people/org-chart">
                <GitBranch />
                Org chart
              </Link>
            </Button>
            <Can permission={PERMISSIONS.EMPLOYEE_EXPORT}>
              <Button variant="outline" size="sm" asChild>
                <a href="/api/v1/employees/export">
                  <Download />
                  Export
                </a>
              </Button>
            </Can>
            <Can permission={PERMISSIONS.EMPLOYEE_MANAGE}>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus />
                New employee
              </Button>
            </Can>
          </>
        }
      />

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search name, number, email"
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
                {EMPLOYEE_STATUSES.map((s) => (
                  <option key={s} value={s}>{EMPLOYEE_STATUS_LABELS[s]}</option>
                ))}
              </NativeSelect>

              <NativeSelect
                value={filters.departmentId}
                onChange={(e) => update({ departmentId: e.target.value, teamId: '' })}
                aria-label="Filter by department"
                className="w-44"
              >
                <option value="">All departments</option>
                {lookups.departments.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </NativeSelect>

              <NativeSelect
                value={filters.teamId}
                onChange={(e) => update({ teamId: e.target.value })}
                aria-label="Filter by team"
                className="w-40"
              >
                <option value="">All teams</option>
                {teamOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </NativeSelect>

              <NativeSelect
                value={filters.designationId}
                onChange={(e) => update({ designationId: e.target.value })}
                aria-label="Filter by designation"
                className="w-44"
              >
                <option value="">All designations</option>
                {lookups.designations.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </NativeSelect>

              <NativeSelect
                value={filters.locationId}
                onChange={(e) => update({ locationId: e.target.value })}
                aria-label="Filter by location"
                className="w-40"
              >
                <option value="">All locations</option>
                {lookups.locations.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </NativeSelect>

              <NativeSelect
                value={filters.employmentType}
                onChange={(e) => update({ employmentType: e.target.value })}
                aria-label="Filter by employment type"
                className="w-40"
              >
                <option value="">All types</option>
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t} value={t}>{EMPLOYMENT_TYPE_LABELS[t]}</option>
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
                    <SortableTH field="lastName" activeField={filters.sort} order={filters.order} onSort={handleSort}>
                      Employee
                    </SortableTH>
                    <SortableTH field="employeeNumber" activeField={filters.sort} order={filters.order} onSort={handleSort} className="w-32">
                      Number
                    </SortableTH>
                    <TH>Designation</TH>
                    <TH>Department</TH>
                    <TH>Reports to</TH>
                    <SortableTH field="hireDate" activeField={filters.sort} order={filters.order} onSort={handleSort} className="w-32">
                      Hired
                    </SortableTH>
                    <SortableTH field="status" activeField={filters.sort} order={filters.order} onSort={handleSort} className="w-28">
                      Status
                    </SortableTH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={8} columns={7} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={7} className="p-0">
                        <EmptyState
                          icon={Users}
                          title={hasFilters ? 'No employees match your filters' : 'No employees yet'}
                          description={
                            hasFilters
                              ? 'Try a different search term or clear the filters.'
                              : 'Add your first employee to start building the directory.'
                          }
                          action={
                            canManage && !hasFilters ? (
                              <Button size="sm" onClick={() => setCreating(true)}>
                                <Plus />
                                New employee
                              </Button>
                            ) : null
                          }
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR
                        key={row.id}
                        className="cursor-pointer"
                        onClick={() => navigate(`/people/${row.id}`)}
                      >
                        <TD>
                          <div className="flex items-center gap-2.5">
                            <Avatar name={row.fullName} photoUrl={row.photoUrl} colorKey={row.id} size="sm" />
                            <div className="min-w-0">
                              <p className="truncate text-[13.5px] font-medium">{row.fullName}</p>
                              <p className="truncate text-[12px] text-muted-foreground">
                                {row.workEmail ?? '--'}
                              </p>
                            </div>
                          </div>
                        </TD>
                        <TD className="font-mono text-[12.5px] text-muted-foreground">{row.employeeNumber}</TD>
                        <TD className="text-[13px]">{row.jobTitle ?? '--'}</TD>
                        <TD className="text-[13px]">
                          {row.department?.name ?? '--'}
                          {row.team ? (
                            <span className="block text-[12px] text-muted-foreground">{row.team.name}</span>
                          ) : null}
                        </TD>
                        <TD className="text-[13px]">{row.manager?.fullName ?? '--'}</TD>
                        <TD className="tabular text-[13px] text-muted-foreground">{formatDate(row.hireDate)}</TD>
                        <TD>
                          <Badge variant={STATUS_TONE[row.status]}>
                            {EMPLOYEE_STATUS_LABELS[row.status]}
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

      <EmployeeFormDrawer
        open={creating}
        employee={null}
        onClose={() => setCreating(false)}
        onSaved={(id) => navigate(`/people/${id}`)}
      />
    </>
  );
}
