import * as React from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { KanbanSquare, Plus, Table2, UserPlus, Users } from 'lucide-react';
import {
  CANDIDATE_STAGES,
  CANDIDATE_STAGE_LABELS,
  PERMISSIONS,
  isCandidateTerminalStage,
  type CandidateRecord,
  type InterviewRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { useLookups } from '@/lib/lookups';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { ViewSwitcher } from '@/components/ui/view-switcher';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import { CANDIDATE_STAGE_TONE, interviewDay, interviewTime } from './recruitment-shared';
import { CandidateBoard } from './candidate-board';
import { CandidateFormDrawer } from './candidate-form-drawer';
import { useInterviewers, useJobOpeningOptions, useRecruitmentAccess } from './use-recruitment-data';

/**
 * Candidates: the list and the board, as two views of one screen.
 *
 * They are the same people and different questions. The list answers "find me
 * this person" and is therefore searchable, sortable, paginated and includes
 * everybody who ever applied; the board answers "what is moving" and is
 * therefore unpaginated, live-only and grouped by stage. Neither is a subset
 * of the other's controls, which is why the filters sit above both and the
 * switcher only changes what is drawn below them.
 *
 * The board's data comes from its own endpoint rather than from this page's
 * rows: a board built out of page one of a list would be a board of twenty
 * people.
 */

const INITIAL = {
  q: '',
  stage: '',
  jobOpeningId: '',
  departmentId: '',
  recruiterId: '',
  live: 'true',
  page: 1,
  limit: 20,
};

type View = 'list' | 'board';

export function CandidatesPage() {
  const { has } = usePermissions();
  const { canManageCandidates } = useRecruitmentAccess();
  const { lookups } = useLookups();
  const { interviewers } = useInterviewers();
  const { openings } = useJobOpeningOptions();

  const [view, setView] = React.useState<View>('list');
  const [filters, setFilters] = React.useState(INITIAL);
  const [adding, setAdding] = React.useState(false);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: ['recruitment', 'candidates', 'list', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<CandidateRecord>('/recruitment/candidates', {
        query: {
          q: debouncedQuery || undefined,
          stage: filters.stage || undefined,
          jobOpeningId: filters.jobOpeningId || undefined,
          departmentId: filters.departmentId || undefined,
          recruiterId: filters.recruiterId || undefined,
          live: filters.live === 'true' ? 'true' : undefined,
          page: filters.page,
          limit: filters.limit,
        },
      }),
    placeholderData: keepPreviousData,
    enabled: view === 'list',
  });

  const nextInterviews = useNextInterviews(view === 'list' && has(PERMISSIONS.INTERVIEW_READ));

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;
  const hasActiveFilters =
    filters.q !== '' ||
    filters.stage !== '' ||
    filters.jobOpeningId !== '' ||
    filters.departmentId !== '' ||
    filters.recruiterId !== '' ||
    filters.live !== INITIAL.live;

  const columns = 8;

  return (
    <>
      <PageHeader
        title="Candidates"
        description="Everybody who has applied, and how far each of them has got."
        actions={
          canManageCandidates ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus />
              Add candidate
            </Button>
          ) : null
        }
      />

      <div className="mb-4">
        <ViewSwitcher
          label="Candidate view"
          value={view}
          onChange={setView}
          options={[
            { key: 'list', label: 'List', icon: Table2 },
            { key: 'board', label: 'Pipeline', icon: KanbanSquare },
          ]}
        />
      </div>

      <Card className={view === 'board' ? 'mb-4' : undefined}>
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search by name, email, phone or reference"
          hasActiveFilters={hasActiveFilters}
          onReset={() => setFilters(INITIAL)}
          className={view === 'board' ? 'border-b-0' : undefined}
          filters={
            <>
              <NativeSelect
                aria-label="Job opening"
                value={filters.jobOpeningId}
                onChange={(event) => update({ jobOpeningId: event.target.value })}
                className="xl:w-52"
              >
                <option value="">All openings</option>
                {openings.map((opening) => (
                  <option key={opening.id} value={opening.id}>
                    {opening.title}
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

              {/* Stage is only a list filter: the board IS the stages. */}
              {view === 'list' ? (
                <NativeSelect
                  aria-label="Stage"
                  value={filters.stage}
                  onChange={(event) => update({ stage: event.target.value })}
                  className="xl:w-40"
                >
                  <option value="">All stages</option>
                  {CANDIDATE_STAGES.map((stage) => (
                    <option key={stage} value={stage}>
                      {CANDIDATE_STAGE_LABELS[stage]}
                    </option>
                  ))}
                </NativeSelect>
              ) : null}

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

              {/*
                A candidate's status IS their stage in this model - there is no
                second status column to filter on - so this control is the one
                thing the stage cannot say: whether to include the people whose
                process has ended.
              */}
              {view === 'list' ? (
                <NativeSelect
                  aria-label="Status"
                  value={filters.live}
                  onChange={(event) => update({ live: event.target.value })}
                  className="xl:w-40"
                >
                  <option value="true">In the pipeline</option>
                  <option value="">Everyone</option>
                </NativeSelect>
              ) : null}
            </>
          }
        />

        {view === 'list' ? (
          query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : (
            <>
              {/* Phones: one card per candidate. */}
              <ul className="divide-y divide-border md:hidden">
                {query.isLoading ? (
                  <li className="p-5">
                    <div className="space-y-3">
                      {Array.from({ length: 4 }).map((_, index) => (
                        <div key={index} className="h-12 animate-pulse rounded-md bg-muted" />
                      ))}
                    </div>
                  </li>
                ) : rows.length === 0 ? (
                  <li>
                    <EmptyRows
                      hasActiveFilters={hasActiveFilters}
                      canManage={canManageCandidates}
                      onAdd={() => setAdding(true)}
                    />
                  </li>
                ) : (
                  rows.map((candidate) => (
                    <li key={candidate.id}>
                      <Link
                        to={`/recruitment/candidates/${candidate.id}`}
                        className="block px-5 py-3.5 transition-colors hover:bg-accent/45"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-[14px] font-medium">{candidate.fullName}</p>
                            <p className="truncate text-[12px] text-muted-foreground">
                              {candidate.email}
                            </p>
                          </div>
                          <Badge variant={CANDIDATE_STAGE_TONE[candidate.stage]}>
                            {CANDIDATE_STAGE_LABELS[candidate.stage]}
                          </Badge>
                        </div>
                        <p className="mt-1.5 truncate text-[12.5px] text-muted-foreground">
                          {positionOf(candidate)}
                        </p>
                      </Link>
                    </li>
                  ))
                )}
              </ul>

              <div className="hidden md:block">
                <TableWrapper>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Candidate</TH>
                        <TH>Position</TH>
                        <TH>Department</TH>
                        <TH>Stage</TH>
                        <TH>Recruiter</TH>
                        <TH>Next interview</TH>
                        <TH>Created</TH>
                        <TH>Status</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {query.isLoading ? (
                        <TableSkeleton rows={6} columns={columns} />
                      ) : rows.length === 0 ? (
                        <TR className="hover:bg-transparent">
                          <TD colSpan={columns} className="p-0">
                            <EmptyRows
                              hasActiveFilters={hasActiveFilters}
                              canManage={canManageCandidates}
                              onAdd={() => setAdding(true)}
                            />
                          </TD>
                        </TR>
                      ) : (
                        rows.map((candidate) => {
                          const next = nextInterviews.get(candidate.id);
                          return (
                            <TR key={candidate.id}>
                              <TD className="max-w-xs">
                                <Link
                                  to={`/recruitment/candidates/${candidate.id}`}
                                  className="block truncate text-[13.5px] font-medium hover:underline"
                                >
                                  {candidate.fullName}
                                </Link>
                                <span className="block truncate text-[11.5px] text-muted-foreground">
                                  {candidate.email}
                                </span>
                              </TD>
                              <TD className="max-w-[14rem] truncate text-[13px]">
                                {positionOf(candidate)}
                              </TD>
                              <TD className="text-[13px]">
                                {candidate.applications[0]?.departmentName ?? (
                                  <span className="text-muted-foreground">--</span>
                                )}
                              </TD>
                              <TD>
                                <Badge variant={CANDIDATE_STAGE_TONE[candidate.stage]}>
                                  {CANDIDATE_STAGE_LABELS[candidate.stage]}
                                </Badge>
                              </TD>
                              <TD className="text-[13px]">
                                {candidate.recruiter?.fullName ?? (
                                  <span className="text-muted-foreground">--</span>
                                )}
                              </TD>
                              <TD className="whitespace-nowrap text-[13px]">
                                {next ? (
                                  <>
                                    {interviewDay(next.startsAt, next.timezone)}
                                    <span className="tabular block text-[11.5px] text-muted-foreground">
                                      {interviewTime(next.startsAt, next.timezone)}
                                    </span>
                                  </>
                                ) : (
                                  <span className="text-muted-foreground">--</span>
                                )}
                              </TD>
                              <TD className="whitespace-nowrap text-[13px] text-muted-foreground">
                                {formatDate(candidate.createdAt)}
                              </TD>
                              <TD>
                                <StatusCell candidate={candidate} />
                              </TD>
                            </TR>
                          );
                        })
                      )}
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
          )
        ) : null}
      </Card>

      {view === 'board' ? (
        <CandidateBoard
          filters={{
            jobOpeningId: filters.jobOpeningId,
            departmentId: filters.departmentId,
            recruiterId: filters.recruiterId,
          }}
        />
      ) : null}

      <CandidateFormDrawer open={adding} candidate={null} onClose={() => setAdding(false)} />
    </>
  );
}

/** The role they are in a process for, or the fact that there is not one yet. */
function positionOf(candidate: CandidateRecord): string {
  const [first, ...rest] = candidate.applications;
  if (!first) return 'No application yet';
  return rest.length > 0 ? `${first.jobTitle} +${rest.length}` : first.jobTitle;
}

/**
 * Where this person stands, as distinct from where they are in a process.
 *
 * Three answers and no more: they are being considered, they have been taken
 * on, or it ended. The stage column beside this says which stage; this column
 * says whether anybody is still working on them, which is the thing somebody
 * scanning a hundred rows is actually looking for.
 */
function StatusCell({ candidate }: { candidate: CandidateRecord }) {
  if (candidate.hiredEmployeeId) {
    return <Badge variant="success">Employee</Badge>;
  }
  if (candidate.stage === 'HIRED') {
    return <Badge variant="success">Hired</Badge>;
  }
  if (isCandidateTerminalStage(candidate.stage)) {
    return <Badge variant="neutral">Closed</Badge>;
  }
  return <Badge variant="outline">Active</Badge>;
}

function EmptyRows({
  hasActiveFilters,
  canManage,
  onAdd,
}: {
  hasActiveFilters: boolean;
  canManage: boolean;
  onAdd: () => void;
}) {
  return (
    <EmptyState
      icon={Users}
      title={hasActiveFilters ? 'Nothing matches those filters' : 'No candidates yet'}
      description={
        hasActiveFilters
          ? 'Clear the filters, or widen the status to include people whose process has ended.'
          : 'Add somebody, or attach an existing candidate to one of your openings.'
      }
      action={
        canManage && !hasActiveFilters ? (
          <Button size="sm" onClick={onAdd}>
            <UserPlus />
            Add candidate
          </Button>
        ) : null
      }
    />
  );
}

/**
 * The next interview for each candidate on screen.
 *
 * One request rather than one per row: the interviews list, from today
 * forwards, soonest first - so the first time a candidate id appears in it IS
 * their next interview. A candidate whose next appointment falls beyond the
 * hundred nearest interviews in the whole company shows no date rather than a
 * wrong one, which is the honest failure for a convenience column.
 *
 * Skipped entirely for a reader without `interview.read`: the column is not
 * theirs to see, and asking would be a 403 on every page load.
 */
function useNextInterviews(enabled: boolean): Map<string, InterviewRecord> {
  const query = useQuery({
    queryKey: ['recruitment', 'interviews', 'next-per-candidate'],
    queryFn: () =>
      api.getPage<InterviewRecord>('/recruitment/interviews', {
        query: {
          from: new Date().toISOString().slice(0, 10),
          order: 'asc',
          limit: 100,
        },
      }),
    enabled,
    staleTime: 60_000,
  });

  return React.useMemo(() => {
    const map = new Map<string, InterviewRecord>();
    for (const interview of query.data?.data ?? []) {
      if (interview.status === 'CANCELLED') continue;
      if (!map.has(interview.candidateId)) map.set(interview.candidateId, interview);
    }
    return map;
  }, [query.data]);
}
