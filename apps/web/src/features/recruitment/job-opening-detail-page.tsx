import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Users, Workflow } from 'lucide-react';
import {
  CANDIDATE_STAGE_LABELS,
  EMPLOYMENT_STATUS_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  JOB_OPENING_STATUS_LABELS,
  type CandidateStage,
  type EmploymentStatus,
  type EmploymentType,
  type JobOpeningRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton, ListSkeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import {
  CANDIDATE_STAGE_TONE,
  JOB_OPENING_STATUS_TONE,
  experience,
  salaryRange,
} from './recruitment-shared';
import { JobOpeningFormDrawer } from './job-opening-form-drawer';
import { JobOpeningStatusDialog } from './job-opening-status-dialog';
import { useRecruitmentAccess } from './use-recruitment-data';

/**
 * One vacancy, and the people against it.
 *
 * The candidate list at the bottom comes from the opening's own PIPELINE
 * endpoint rather than from the candidates list filtered by job id, and the
 * difference is a permission: the pipeline is gated on `recruitment.read`, so
 * a hiring manager running this vacancy sees who is on it and how far they
 * have got without holding `candidate.read` - and still sees nothing of what
 * anybody on it is earning. Reusing the candidates endpoint here would have
 * made this whole section invisible to the person who owns the vacancy.
 */

/** One row of the pipeline: a candidate's application against this opening. */
interface PipelineEntry {
  applicationId: string;
  candidateId: string;
  candidateName: string;
  candidateReference: string;
  stage: CandidateStage;
  stageChangedAt: string;
  appliedAt: string;
  outcomeReason: string | null;
}

export function JobOpeningDetailPage() {
  const { id = '' } = useParams();
  const { canManageRecruitment, canReadCandidates } = useRecruitmentAccess();
  const [editing, setEditing] = React.useState(false);
  const [changingStatus, setChangingStatus] = React.useState(false);

  const query = useQuery({
    queryKey: ['recruitment', 'job-openings', id],
    queryFn: () => api.get<JobOpeningRecord>(`/recruitment/job-openings/${id}`),
    enabled: id !== '',
  });

  const pipeline = useQuery({
    queryKey: ['recruitment', 'job-openings', id, 'pipeline'],
    queryFn: () => api.get<PipelineEntry[]>(`/recruitment/job-openings/${id}/pipeline`),
    enabled: id !== '',
  });

  if (query.isLoading) {
    return (
      <Card className="p-6">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="mt-3 h-4 w-40" />
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-14" />
          ))}
        </div>
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const opening = query.data;
  if (!opening) {
    return (
      <Card>
        <EmptyState
          title="Opening not found"
          description="It may have been removed, or it is not one you can open."
          action={
            <Button variant="outline" size="sm" asChild>
              <Link to="/recruitment/job-openings">Back to openings</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  const entries = pipeline.data ?? [];

  return (
    <>
      <div className="mb-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/recruitment/job-openings">
            <ArrowLeft />
            Job openings
          </Link>
        </Button>
      </div>

      <PageHeader
        title={opening.title}
        description={`${opening.reference} · created ${formatDate(opening.createdAt)}`}
        actions={
          canManageRecruitment ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setChangingStatus(true)}>
                <Workflow />
                Change status
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
            </>
          ) : null
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader bordered className="flex-row items-center justify-between gap-3">
            <CardTitle>Details</CardTitle>
            <Badge variant={JOB_OPENING_STATUS_TONE[opening.status]}>
              {JOB_OPENING_STATUS_LABELS[opening.status]}
            </Badge>
          </CardHeader>

          <dl className="grid gap-x-6 gap-y-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
            <Detail label="Department" value={opening.department?.name} />
            <Detail label="Team" value={opening.team?.name} />
            <Detail label="Location" value={opening.location?.name} />
            <Detail label="Hiring manager" value={opening.hiringManager?.fullName} />
            <Detail label="Recruiter" value={opening.recruiter?.fullName} />
            <Detail
              label="Employment type"
              value={
                EMPLOYMENT_TYPE_LABELS[opening.employmentType as EmploymentType] ??
                opening.employmentType
              }
            />
            <Detail
              label="Employment status offered"
              value={
                opening.expectedEmploymentStatus
                  ? EMPLOYMENT_STATUS_LABELS[opening.expectedEmploymentStatus as EmploymentStatus]
                  : 'Not decided'
              }
            />
            <Detail label="Vacancies" value={String(opening.vacancies)} />
            <Detail label="Experience" value={experience(opening.minExperienceYears)} />
            <Detail
              label="Salary range"
              value={salaryRange(opening.salaryMin, opening.salaryMax, opening.salaryCurrency)}
            />
            <Detail label="Opens" value={opening.openingDate ? formatDate(opening.openingDate) : null} />
            <Detail
              label="Closes"
              value={opening.closingDate ? formatDate(opening.closingDate) : null}
            />
          </dl>

          {opening.closedReason ? (
            <div className="border-t border-border px-5 py-4">
              <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                Why it ended
              </p>
              <p className="mt-1 whitespace-pre-wrap text-[13.5px]">{opening.closedReason}</p>
            </div>
          ) : null}

          {opening.skills ? (
            <div className="border-t border-border px-5 py-4">
              <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                Skills
              </p>
              <p className="mt-1 text-[13.5px]">{opening.skills}</p>
            </div>
          ) : null}

          {opening.description ? (
            <Prose title="Description" body={opening.description} />
          ) : null}
          {opening.requirements ? (
            <Prose title="Requirements" body={opening.requirements} />
          ) : null}
        </Card>

        <Card className="h-fit">
          <CardHeader bordered>
            <CardTitle>Progress</CardTitle>
            <CardDescription>Against this opening.</CardDescription>
          </CardHeader>
          <dl className="grid grid-cols-2 gap-px bg-border">
            <Figure label="Candidates" value={opening.applicationCount} />
            <Figure label="Vacancies" value={opening.vacancies} />
            <Figure label="Hired" value={opening.hiredCount} />
            <Figure
              label="Still to fill"
              /* Never negative: over-hiring against an opening is a real thing
                 that happens, and "-1 to fill" reads as a bug. */
              value={Math.max(opening.vacancies - opening.hiredCount, 0)}
            />
          </dl>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader bordered>
          <CardTitle>Candidates</CardTitle>
          <CardDescription>
            Everybody who has applied for this opening, and where each one has got to.
          </CardDescription>
        </CardHeader>

        {pipeline.isError ? (
          <ErrorState error={pipeline.error} onRetry={() => void pipeline.refetch()} />
        ) : pipeline.isLoading ? (
          <ListSkeleton rows={3} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nobody has applied yet"
            description="Candidates attached to this opening appear here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((entry) => (
              <li
                key={entry.applicationId}
                className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  {/* A link only for a reader who may open a candidate. A
                      hiring manager sees the name and the stage here and is
                      not handed a link to a screen that would refuse them. */}
                  {canReadCandidates ? (
                    <Link
                      to={`/recruitment/candidates/${entry.candidateId}`}
                      className="truncate text-[13.5px] font-medium hover:underline"
                    >
                      {entry.candidateName}
                    </Link>
                  ) : (
                    <p className="truncate text-[13.5px] font-medium">{entry.candidateName}</p>
                  )}
                  <p className="font-mono text-[11.5px] text-muted-foreground">
                    {entry.candidateReference} · applied {formatDate(entry.appliedAt)}
                  </p>
                  {entry.outcomeReason ? (
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      {entry.outcomeReason}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[12px] text-muted-foreground">
                    since {formatDate(entry.stageChangedAt)}
                  </span>
                  <Badge variant={CANDIDATE_STAGE_TONE[entry.stage]}>
                    {CANDIDATE_STAGE_LABELS[entry.stage]}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <JobOpeningFormDrawer
        open={editing}
        opening={opening}
        onClose={() => setEditing(false)}
      />
      <JobOpeningStatusDialog
        open={changingStatus}
        opening={opening}
        onClose={() => setChangingStatus(false)}
      />
    </>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-[13.5px]">
        {value ?? <span className="text-muted-foreground">--</span>}
      </dd>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-card px-5 py-3.5">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="tabular text-xl font-semibold">{value}</dd>
    </div>
  );
}

/** Free text as typed, wrapped so a pasted job advert keeps its paragraphs. */
function Prose({ title, body }: { title: string; body: string }) {
  return (
    <div className="border-t border-border px-5 py-4">
      <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-relaxed">{body}</p>
    </div>
  );
}
