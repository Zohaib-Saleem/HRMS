import * as React from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Briefcase, Plus } from 'lucide-react';
import {
  EMPLOYMENT_TYPE_LABELS,
  JOB_OPENING_STATUSES,
  JOB_OPENING_STATUS_LABELS,
  type EmploymentType,
  type JobOpeningRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { useLookups } from '@/lib/lookups';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { JOB_OPENING_STATUS_TONE, salaryRange } from './recruitment-shared';
import { JobOpeningFormDrawer } from './job-opening-form-drawer';
import { useInterviewers, useRecruitmentAccess } from './use-recruitment-data';

/**
 * Job openings.
 *
 * How much of this list a reader gets is NOT this screen's business, and there
 * is deliberately no control on it that widens the query. Somebody holding
 * `recruitment.read` alone is served the openings they are named on - as
 * hiring manager or as recruiter - by a WHERE clause on the server; HR holding
 * `recruitment.manage` is served the company's. The page renders what it is
 * given, which is why there is no "show all departments" toggle here: a
 * control that widens a query is a control that has to be checked, and the
 * check already happened somewhere that cannot be edited from a browser.
 *
 * On a phone the table becomes a list of cards. A seven-column table at 375px
 * is a table nobody reads, and the columns that survive the transition are
 * the ones somebody scans for - the title, who is running it, and where it is
 * up to.
 */

const INITIAL = {
  q: '',
  status: '',
  departmentId: '',
  hiringManagerId: '',
  recruiterId: '',
  page: 1,
  limit: 20,
};

export function JobOpeningsPage() {
  const { canManageRecruitment } = useRecruitmentAccess();
  const { lookups } = useLookups();
  const { interviewers } = useInterviewers();

  const [filters, setFilters] = React.useState(INITIAL);
  const [creating, setCreating] = React.useState(false);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['recruitment', 'job-openings', 'list', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<JobOpeningRecord>('/recruitment/job-openings', {
        query: {
          q: debouncedQuery || undefined,
          status: filters.status || undefined,
          departmentId: filters.departmentId || undefined,
          hiringManagerId: filters.hiringManagerId || undefined,
          recruiterId: filters.recruiterId || undefined,
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
    filters.departmentId !== '' ||
    filters.hiringManagerId !== '' ||
    filters.recruiterId !== '';

  const columns = 7;

  return (
    <>
      <PageHeader
        title="Job openings"
        description="Every vacancy you are running, and how far each has got."
        actions={
          canManageRecruitment ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              New opening
            </Button>
          ) : null
        }
      />

      <Card>
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search by title, reference or skill"
          hasActiveFilters={hasActiveFilters}
          onReset={() => setFilters(INITIAL)}
          filters={
            <>
              <NativeSelect
                aria-label="Status"
                value={filters.status}
                onChange={(event) => update({ status: event.target.value })}
                className="xl:w-40"
              >
                <option value="">All statuses</option>
                {JOB_OPENING_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {JOB_OPENING_STATUS_LABELS[status]}
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
                {lookups.departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.label}
                  </option>
                ))}
              </NativeSelect>

              <NativeSelect
                aria-label="Hiring manager"
                value={filters.hiringManagerId}
                onChange={(event) => update({ hiringManagerId: event.target.value })}
                className="xl:w-48"
              >
                <option value="">Any hiring manager</option>
                {interviewers.map((person) => (
                  <option key={person.employeeId} value={person.employeeId}>
                    {person.fullName}
                  </option>
                ))}
              </NativeSelect>

              <NativeSelect
                aria-label="Recruiter"
                value={filters.recruiterId}
                onChange={(event) => update({ recruiterId: event.target.value })}
                className="xl:w-44"
              >
                <option value="">Any recruiter</option>
                {interviewers.map((person) => (
                  <option key={person.employeeId} value={person.employeeId}>
                    {person.fullName}
                  </option>
                ))}
              </NativeSelect>
            </>
          }
        />

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <>
            <div className="md:hidden">
              <TableWrapper>
                <Table>
                  <TBody>
                    <TableSkeleton rows={4} columns={1} />
                  </TBody>
                </Table>
              </TableWrapper>
            </div>
            <div className="hidden md:block">
              <TableWrapper>
                <Table>
                  <TBody>
                    <TableSkeleton rows={5} columns={columns} />
                  </TBody>
                </Table>
              </TableWrapper>
            </div>
          </>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title={hasActiveFilters ? 'Nothing matches those filters' : 'No openings yet'}
            description={
              hasActiveFilters
                ? 'Clear the filters to see everything you can open.'
                : canManageRecruitment
                  ? 'Create a vacancy to start collecting candidates against it.'
                  : 'You are shown the openings you are named on as hiring manager or recruiter.'
            }
            action={
              canManageRecruitment && !hasActiveFilters ? (
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus />
                  New opening
                </Button>
              ) : null
            }
          />
        ) : (
          <>
            {/* Phones: one card per opening. */}
            <ul className="divide-y divide-border md:hidden">
              {rows.map((opening) => (
                <li key={opening.id}>
                  <Link
                    to={`/recruitment/job-openings/${opening.id}`}
                    className="block px-5 py-3.5 transition-colors hover:bg-accent/45"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-medium">{opening.title}</p>
                        <p className="font-mono text-[11.5px] text-muted-foreground">
                          {opening.reference}
                        </p>
                      </div>
                      <Badge variant={JOB_OPENING_STATUS_TONE[opening.status]}>
                        {JOB_OPENING_STATUS_LABELS[opening.status]}
                      </Badge>
                    </div>
                    <p className="mt-1.5 text-[12.5px] text-muted-foreground">
                      {opening.department?.name ?? 'No department'}
                      {opening.hiringManager ? ` · ${opening.hiringManager.fullName}` : ''}
                    </p>
                    <p className="tabular mt-1 text-[12.5px] text-muted-foreground">
                      {opening.applicationCount} candidate
                      {opening.applicationCount === 1 ? '' : 's'} · {opening.vacancies} vacanc
                      {opening.vacancies === 1 ? 'y' : 'ies'}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="hidden md:block">
              <TableWrapper>
                <Table>
                  <THead>
                    <TR>
                      <TH>Opening</TH>
                      <TH>Department</TH>
                      <TH>Hiring manager</TH>
                      <TH>Type</TH>
                      <TH>Salary range</TH>
                      <TH>Candidates</TH>
                      <TH>Status</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((opening) => (
                      <TR key={opening.id}>
                        <TD className="max-w-xs">
                          <Link
                            to={`/recruitment/job-openings/${opening.id}`}
                            className="block truncate text-[13.5px] font-medium hover:underline"
                          >
                            {opening.title}
                          </Link>
                          <span className="block font-mono text-[11.5px] text-muted-foreground">
                            {opening.reference}
                          </span>
                        </TD>
                        <TD className="text-[13px]">
                          {opening.department?.name ?? (
                            <span className="text-muted-foreground">--</span>
                          )}
                          {opening.team ? (
                            <span className="block text-[11.5px] text-muted-foreground">
                              {opening.team.name}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="text-[13px]">
                          {opening.hiringManager?.fullName ?? (
                            <span className="text-muted-foreground">Not assigned</span>
                          )}
                          {opening.recruiter ? (
                            <span className="block text-[11.5px] text-muted-foreground">
                              {opening.recruiter.fullName}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="whitespace-nowrap text-[13px]">
                          {EMPLOYMENT_TYPE_LABELS[opening.employmentType as EmploymentType] ??
                            opening.employmentType}
                        </TD>
                        <TD className="tabular whitespace-nowrap text-[13px]">
                          {salaryRange(opening.salaryMin, opening.salaryMax, opening.salaryCurrency)}
                        </TD>
                        <TD className="tabular text-[13px]">
                          {opening.applicationCount}
                          <span className="text-muted-foreground">
                            {' / '}
                            {opening.vacancies} wanted
                          </span>
                          {opening.hiredCount > 0 ? (
                            <span className="block text-[11.5px] text-success">
                              {opening.hiredCount} hired
                            </span>
                          ) : null}
                        </TD>
                        <TD>
                          <Badge variant={JOB_OPENING_STATUS_TONE[opening.status]}>
                            {JOB_OPENING_STATUS_LABELS[opening.status]}
                          </Badge>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrapper>
            </div>

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

      <JobOpeningFormDrawer
        open={creating}
        opening={null}
        onClose={() => setCreating(false)}
      />
    </>
  );
}
