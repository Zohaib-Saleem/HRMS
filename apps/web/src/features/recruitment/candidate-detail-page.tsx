import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarClock,
  ClipboardList,
  FilePlus2,
  Mail,
  MapPin,
  MoveRight,
  Pencil,
  Phone,
  UserCheck,
} from 'lucide-react';
import {
  CANDIDATE_STAGE_LABELS,
  EVALUATION_CRITERIA,
  EVALUATION_SCORE_MAX,
  INTERVIEW_RECOMMENDATION_LABELS,
  INTERVIEW_ROUND_LABELS,
  INTERVIEW_STATUS_LABELS,
  INTERVIEW_TYPE_LABELS,
  PERMISSIONS,
  type CandidateApplicationRecord,
  type CandidateRecord,
  type EvaluationRecord,
  type InterviewRecord,
  type InterviewType,
  type InterviewRound,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDate, formatDateTime, cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ListSkeleton, Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import {
  CANDIDATE_STAGE_TONE,
  INTERVIEW_STATUS_TONE,
  RECOMMENDATION_TONE,
  experience,
  interviewDay,
  interviewRange,
  money,
} from './recruitment-shared';
import { CandidateDocuments } from './candidate-documents';
import { CandidateOffers } from './candidate-offers';
import { CandidateTimeline } from './candidate-timeline';
import { CandidateFormDrawer } from './candidate-form-drawer';
import { ApplicationDialog } from './application-dialog';
import { StageChangeDialog } from './stage-change-dialog';
import { InterviewScheduleDialog } from './interview-schedule-dialog';
import { ConvertToEmployeeDialog } from './convert-to-employee-dialog';
import { useRecruitmentAccess } from './use-recruitment-data';

/**
 * One candidate, and everything recorded about them.
 *
 * The same composition the employee 360 uses: each tab owns its own endpoint
 * and only the selected one is mounted, so opening a profile costs the
 * candidate record rather than six modules' queries at once.
 *
 * What is deliberately NOT here is anything that would make a candidate look
 * like an employee. There is no attendance, no leave balance, no payroll, no
 * org chart position and no login - because none of those exists for somebody
 * who does not work here. The single bridge to that world is Convert to
 * Employee, which is permissioned separately, reviewed by a person, and
 * refuses to create a second record for somebody already on the roster.
 *
 * The restricted block - what they earn now, what they are asking for, the HR
 * notes - is OMITTED by the server for a reader without `candidate.manage`
 * rather than nulled, so this page tests for its presence rather than for
 * empty values. An interviewer opening the person they are meeting finds no
 * salary section at all, not a row of blanks that invites a guess.
 */

const TABS = [
  'Overview',
  'Applications',
  'Interviews',
  'Evaluations',
  'Offers',
  'Documents',
  'Activity',
] as const;
type Tab = (typeof TABS)[number];

export function CandidateDetailPage() {
  const { id = '' } = useParams();
  const { has } = usePermissions();
  const { canManageCandidates, canManageInterviews, canConvert } = useRecruitmentAccess();

  const [tab, setTab] = React.useState<Tab>('Overview');
  const [editing, setEditing] = React.useState(false);
  const [applying, setApplying] = React.useState(false);
  const [scheduling, setScheduling] = React.useState(false);
  const [converting, setConverting] = React.useState(false);
  const [movingApplication, setMovingApplication] =
    React.useState<CandidateApplicationRecord | null>(null);

  const query = useQuery({
    queryKey: ['recruitment', 'candidates', id],
    queryFn: () => api.get<CandidateRecord>(`/recruitment/candidates/${id}`),
    enabled: id !== '',
  });

  if (query.isLoading) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-4">
          <Skeleton className="size-12 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
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

  const candidate = query.data;
  if (!candidate) {
    return (
      <Card>
        <EmptyState
          title="Candidate not found"
          description="They may have been removed, or this is not a record you can open."
          action={
            <Button variant="outline" size="sm" asChild>
              <Link to="/recruitment/candidates">Back to candidates</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  const primary = candidate.applications[0] ?? null;
  /*
   * Converting is offered from the point it means something - somebody who has
   * been selected, offered or marked hired - rather than at every stage. The
   * server does not police the stage, and that is on purpose: HR sometimes
   * hires somebody who never went through a formal offer. What the server does
   * police is the thing that matters, which is that nobody is converted twice.
   */
  const convertible =
    canConvert &&
    !candidate.hiredEmployeeId &&
    ['SELECTED', 'OFFER', 'HIRED'].includes(candidate.stage);

  const visibleTabs = TABS.filter((item) => {
    if (item === 'Interviews' || item === 'Evaluations') return has(PERMISSIONS.INTERVIEW_READ);
    if (item === 'Offers') return has(PERMISSIONS.RECRUITMENT_READ);
    return true;
  });

  return (
    <>
      <div className="mb-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/recruitment/candidates">
            <ArrowLeft />
            Candidates
          </Link>
        </Button>
      </div>

      <Card className="mb-5 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <Avatar name={candidate.fullName} colorKey={candidate.id} size="lg" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight">
                  {candidate.fullName}
                </h1>
                <Badge variant={CANDIDATE_STAGE_TONE[candidate.stage]}>
                  {CANDIDATE_STAGE_LABELS[candidate.stage]}
                </Badge>
                {candidate.hiredEmployeeId ? (
                  <Badge variant="success">On the roster</Badge>
                ) : null}
              </div>

              <p className="mt-0.5 font-mono text-[12px] text-muted-foreground">
                {candidate.reference}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="size-3.5" aria-hidden />
                  <a href={`mailto:${candidate.email}`} className="hover:underline">
                    {candidate.email}
                  </a>
                </span>
                {candidate.phone ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Phone className="size-3.5" aria-hidden />
                    {candidate.phone}
                  </span>
                ) : null}
                {candidate.currentLocation ? (
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="size-3.5" aria-hidden />
                    {candidate.currentLocation}
                  </span>
                ) : null}
              </div>

              <p className="mt-2 text-[13.5px]">
                {primary ? (
                  <>
                    Applied for{' '}
                    <Link
                      to={`/recruitment/job-openings/${primary.jobOpeningId}`}
                      className="text-primary hover:underline"
                    >
                      {primary.jobTitle}
                    </Link>
                    {candidate.applications.length > 1
                      ? ` and ${candidate.applications.length - 1} other${candidate.applications.length > 2 ? 's' : ''}`
                      : ''}
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    Not against any opening yet - a filed CV.
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {canManageCandidates ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <Pencil />
                  Edit
                </Button>
                <Button variant="outline" size="sm" onClick={() => setApplying(true)}>
                  <FilePlus2 />
                  Apply to opening
                </Button>
                {primary ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setMovingApplication(primary)}
                  >
                    <MoveRight />
                    Move stage
                  </Button>
                ) : null}
              </>
            ) : null}
            {canManageInterviews ? (
              <Button size="sm" onClick={() => setScheduling(true)}>
                <CalendarClock />
                Schedule interview
              </Button>
            ) : null}
            {convertible ? (
              <Button size="sm" onClick={() => setConverting(true)}>
                <UserCheck />
                Convert to employee
              </Button>
            ) : null}
            {candidate.hiredEmployeeId ? (
              <Button variant="outline" size="sm" asChild>
                <Link to={`/people/${candidate.hiredEmployeeId}`}>
                  <UserCheck />
                  Employee record
                </Link>
              </Button>
            ) : null}
          </div>
        </div>
      </Card>

      <div className="mb-5 overflow-x-auto border-b border-border">
        <nav className="flex min-w-max gap-1" aria-label="Candidate sections">
          {visibleTabs.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={cn(
                'border-b-2 px-3 py-2.5 text-[13.5px] font-medium transition-colors',
                tab === item
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {item}
              {item === 'Applications' && candidate.applications.length > 0 ? (
                <span className="tabular ml-1.5 text-[12px] text-muted-foreground">
                  {candidate.applications.length}
                </span>
              ) : null}
              {item === 'Documents' && candidate.documentCount > 0 ? (
                <span className="tabular ml-1.5 text-[12px] text-muted-foreground">
                  {candidate.documentCount}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'Overview' ? <OverviewTab candidate={candidate} /> : null}
      {tab === 'Applications' ? (
        <ApplicationsTab
          candidate={candidate}
          canManage={canManageCandidates}
          onMove={setMovingApplication}
        />
      ) : null}
      {tab === 'Interviews' ? <InterviewsTab candidateId={candidate.id} /> : null}
      {tab === 'Evaluations' ? <EvaluationsTab candidateId={candidate.id} /> : null}
      {tab === 'Offers' ? (
        <CandidateOffers
          candidateId={candidate.id}
          candidateName={candidate.fullName}
          applications={candidate.applications}
        />
      ) : null}
      {tab === 'Documents' ? <CandidateDocuments candidateId={candidate.id} /> : null}
      {tab === 'Activity' ? <CandidateTimeline candidateId={candidate.id} /> : null}

      {canManageCandidates ? (
        <>
          <CandidateFormDrawer
            open={editing}
            candidate={candidate}
            onClose={() => setEditing(false)}
          />
          <ApplicationDialog
            open={applying}
            candidate={candidate}
            onClose={() => setApplying(false)}
          />
          <StageChangeDialog
            open={movingApplication !== null}
            candidateName={candidate.fullName}
            application={movingApplication}
            onClose={() => setMovingApplication(null)}
          />
        </>
      ) : null}

      {canManageInterviews ? (
        <InterviewScheduleDialog
          open={scheduling}
          candidateId={candidate.id}
          candidateName={candidate.fullName}
          applications={candidate.applications}
          onClose={() => setScheduling(false)}
        />
      ) : null}

      {convertible ? (
        <ConvertToEmployeeDialog
          open={converting}
          candidate={candidate}
          onClose={() => setConverting(false)}
        />
      ) : null}
    </>
  );
}

function OverviewTab({ candidate }: { candidate: CandidateRecord }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader bordered>
          <CardTitle>Background</CardTitle>
        </CardHeader>
        <dl className="grid gap-x-6 gap-y-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="Current company" value={candidate.currentCompany} />
          <Detail label="Current title" value={candidate.currentTitle} />
          <Detail label="Experience" value={experience(candidate.experienceYears)} />
          <Detail
            label="Notice period"
            value={
              candidate.noticePeriodDays === null
                ? null
                : `${candidate.noticePeriodDays} day${candidate.noticePeriodDays === 1 ? '' : 's'}`
            }
          />
          <Detail label="Source" value={candidate.source} />
          <Detail label="Recruiter" value={candidate.recruiter?.fullName} />
          <Detail label="Added" value={formatDate(candidate.createdAt)} />
          <Detail
            label="LinkedIn"
            value={candidate.linkedinUrl}
            href={candidate.linkedinUrl ?? undefined}
          />
          <Detail
            label="Portfolio"
            value={candidate.portfolioUrl}
            href={candidate.portfolioUrl ?? undefined}
          />
        </dl>

        {candidate.skills ? (
          <div className="border-t border-border px-5 py-4">
            <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
              Skills
            </p>
            <p className="mt-1 text-[13.5px]">{candidate.skills}</p>
          </div>
        ) : null}
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader bordered>
            <CardTitle>Progress</CardTitle>
          </CardHeader>
          <dl className="grid grid-cols-2 gap-px bg-border">
            <Figure label="Applications" value={candidate.applications.length} />
            <Figure label="Interviews" value={candidate.interviewCount} />
            <Figure label="Documents" value={candidate.documentCount} />
            <Figure
              label="Stage"
              text={CANDIDATE_STAGE_LABELS[candidate.stage]}
            />
          </dl>
        </Card>

        {/*
          Present only when the server sent it. Its ABSENCE is the permission
          check made visible: a reader without `candidate.manage` gets no
          `restricted` key at all, so there is no card here rather than a card
          full of dashes.
        */}
        {candidate.restricted ? (
          <Card>
            <CardHeader bordered>
              <CardTitle>Confidential</CardTitle>
              <CardDescription>
                Visible to readers who can manage candidates. Never on an interview screen.
              </CardDescription>
            </CardHeader>
            <dl className="space-y-3 p-5">
              <Pair
                label="Current salary"
                value={money(candidate.restricted.currentSalary, candidate.restricted.salaryCurrency)}
              />
              <Pair
                label="Expected salary"
                value={money(
                  candidate.restricted.expectedSalary,
                  candidate.restricted.salaryCurrency,
                )}
              />
              {candidate.restricted.notes ? (
                <div>
                  <dt className="text-[12px] uppercase tracking-wide text-muted-foreground">
                    Notes
                  </dt>
                  <dd className="mt-1 whitespace-pre-wrap text-[13.5px]">
                    {candidate.restricted.notes}
                  </dd>
                </div>
              ) : null}
            </dl>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function ApplicationsTab({
  candidate,
  canManage,
  onMove,
}: {
  candidate: CandidateRecord;
  canManage: boolean;
  onMove: (application: CandidateApplicationRecord) => void;
}) {
  if (candidate.applications.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No applications"
          description="This candidate is a filed CV. Apply them to an opening to start a process."
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader bordered>
        <CardTitle>Applications</CardTitle>
        <CardDescription>
          One per vacancy, each with its own stage. That is why somebody can be shortlisted for one
          role and rejected for another.
        </CardDescription>
      </CardHeader>
      <ul className="divide-y divide-border">
        {candidate.applications.map((application) => (
          <li
            key={application.id}
            className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <Link
                to={`/recruitment/job-openings/${application.jobOpeningId}`}
                className="text-[13.5px] font-medium hover:underline"
              >
                {application.jobTitle}
              </Link>
              <p className="font-mono text-[11.5px] text-muted-foreground">
                {application.jobReference}
                {application.departmentName ? ` · ${application.departmentName}` : ''}
              </p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                Applied {formatDate(application.appliedAt)} · at this stage since{' '}
                {formatDate(application.stageChangedAt)}
              </p>
              {application.outcomeReason ? (
                <p className="mt-1 text-[13px]">{application.outcomeReason}</p>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={CANDIDATE_STAGE_TONE[application.stage]}>
                {CANDIDATE_STAGE_LABELS[application.stage]}
              </Badge>
              {canManage ? (
                <Button variant="outline" size="sm" onClick={() => onMove(application)}>
                  Move
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function InterviewsTab({ candidateId }: { candidateId: string }) {
  const query = useQuery({
    queryKey: ['recruitment', 'interviews', 'by-candidate', candidateId],
    queryFn: () =>
      api.getPage<InterviewRecord>('/recruitment/interviews', {
        query: { candidateId, limit: 50, order: 'desc' },
      }),
  });

  const interviews = query.data?.data ?? [];

  return (
    <Card>
      <CardHeader bordered>
        <CardTitle>Interviews</CardTitle>
        <CardDescription>
          Every round, newest first. Times are in each interview's own zone.
        </CardDescription>
      </CardHeader>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <ListSkeleton rows={3} />
      ) : interviews.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No interviews"
          description="Nothing has been booked with this candidate that you can see."
        />
      ) : (
        <ul className="divide-y divide-border">
          {interviews.map((interview) => (
            <li key={interview.id}>
              <Link
                to={`/recruitment/interviews/${interview.id}`}
                className="flex flex-col gap-2 px-5 py-3.5 transition-colors hover:bg-accent/45 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-[13.5px] font-medium">
                    {INTERVIEW_TYPE_LABELS[interview.type]} ·{' '}
                    {INTERVIEW_ROUND_LABELS[interview.round]}
                  </p>
                  <p className="tabular text-[12px] text-muted-foreground">
                    {interviewDay(interview.startsAt, interview.timezone)},{' '}
                    {interviewRange(interview.startsAt, interview.endsAt, interview.timezone)}
                  </p>
                  <p className="truncate text-[12px] text-muted-foreground">
                    {interview.interviewers.map((person) => person.fullName).join(', ')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {interview.evaluationsPending > 0 ? (
                    <span className="text-[11.5px] text-warning-foreground">
                      {interview.evaluationsPending} feedback pending
                    </span>
                  ) : null}
                  <Badge variant={INTERVIEW_STATUS_TONE[interview.status]}>
                    {INTERVIEW_STATUS_LABELS[interview.status]}
                  </Badge>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** An evaluation as it arrives from the by-candidate endpoint. */
interface CandidateEvaluation extends EvaluationRecord {
  interviewType: InterviewType;
  interviewRound: InterviewRound;
  interviewStartsAt: string;
}

function EvaluationsTab({ candidateId }: { candidateId: string }) {
  const query = useQuery({
    queryKey: ['recruitment', 'candidates', candidateId, 'evaluations'],
    queryFn: () =>
      api.get<CandidateEvaluation[]>(`/recruitment/interviews/by-candidate/${candidateId}`),
  });

  const evaluations = query.data ?? [];

  return (
    <Card>
      <CardHeader bordered>
        <CardTitle>Evaluations</CardTitle>
        <CardDescription>
          What each interviewer thought, as separate opinions. Nothing here is averaged, and no
          decision follows from it automatically.
        </CardDescription>
      </CardHeader>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <ListSkeleton rows={3} />
      ) : evaluations.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No feedback yet"
          description="Interviewers file their assessments once an interview has been completed."
        />
      ) : (
        <div className="divide-y divide-border">
          {evaluations.map((evaluation) => (
            <article key={evaluation.id} className="px-5 py-4">
              <header className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[13.5px] font-medium">
                    {evaluation.interviewerName}
                    {evaluation.isMine ? (
                      <span className="text-muted-foreground"> (you)</span>
                    ) : null}
                  </p>
                  <p className="text-[11.5px] text-muted-foreground">
                    {INTERVIEW_TYPE_LABELS[evaluation.interviewType]} ·{' '}
                    {INTERVIEW_ROUND_LABELS[evaluation.interviewRound]} ·{' '}
                    {formatDateTime(evaluation.submittedAt)}
                  </p>
                </div>
                <Badge variant={RECOMMENDATION_TONE[evaluation.recommendation]}>
                  {INTERVIEW_RECOMMENDATION_LABELS[evaluation.recommendation]}
                </Badge>
              </header>

              <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {EVALUATION_CRITERIA.map((criterion) => (
                  <div key={criterion.key} className="flex items-center justify-between gap-2">
                    <dt className="text-[12.5px] text-muted-foreground">{criterion.label}</dt>
                    <dd className="tabular text-[13px] font-medium">
                      {evaluation[criterion.key] === null ? (
                        <span className="text-[12px] font-normal text-muted-foreground">
                          Not assessed
                        </span>
                      ) : (
                        `${evaluation[criterion.key]} / ${EVALUATION_SCORE_MAX}`
                      )}
                    </dd>
                  </div>
                ))}
              </dl>

              {evaluation.comments ? (
                <p className="mt-3 whitespace-pre-wrap rounded-md bg-surface-muted px-3 py-2.5 text-[13px] leading-relaxed">
                  {evaluation.comments}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}

function Detail({
  label,
  value,
  href,
}: {
  label: string;
  value: string | null | undefined;
  href?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-[13.5px]">
        {value ? (
          href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary hover:underline"
            >
              {value}
            </a>
          ) : (
            value
          )
        ) : (
          <span className="text-muted-foreground">--</span>
        )}
      </dd>
    </div>
  );
}

function Figure({ label, value, text }: { label: string; value?: number; text?: string }) {
  return (
    <div className="bg-card px-5 py-3.5">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className={text ? 'text-[15px] font-semibold' : 'tabular text-xl font-semibold'}>
        {text ?? value}
      </dd>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="tabular text-[13.5px] font-medium">{value}</dd>
    </div>
  );
}
