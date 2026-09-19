import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Briefcase,
  CalendarClock,
  CalendarDays,
  FileSignature,
  MessagesSquare,
  UserCheck,
  Users,
} from 'lucide-react';
import {
  INTERVIEW_ROUND_LABELS,
  INTERVIEW_STATUS_LABELS,
  INTERVIEW_TYPE_LABELS,
  PERMISSIONS,
  type MyInterviewSummary,
  type RecruitmentDashboard,
  type UpcomingInterview,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { ListSkeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Can } from '@/features/auth/session-context';
import { INTERVIEW_STATUS_TONE, interviewDay, interviewRange, zoneLabel } from './recruitment-shared';
import { useRecruitmentAccess } from './use-recruitment-data';

/**
 * The recruitment dashboard.
 *
 * Seven figures and a list, and the division between them is the point: the
 * figures say how hiring is going, the list says what is happening today. A
 * dashboard that only had the figures would be a report somebody reads once a
 * week; the upcoming panel is what makes it a screen worth opening at nine in
 * the morning.
 *
 * Every number here is COMPUTED BY THE SERVER, in the company's own time zone,
 * and none of them is derived from a list this page holds. "Interviews today"
 * is a question about the office's calendar - a browser in another country
 * answering it from a page of rows would disagree with the API by a day twice
 * a year and by five hours permanently. The same goes for "hired this month".
 *
 * What the page does NOT do is decide who may see it. An interviewer holds
 * `interview.read` and not `recruitment.read`, so this route is closed to them
 * and their way in is the calendar - which is also why the panel below is the
 * only part duplicated anywhere: their own version of it is on their screen,
 * narrowed by the server to their own seats.
 */
export function RecruitmentDashboardPage() {
  const { canManageInterviews, canReadCandidates } = useRecruitmentAccess();

  const dashboard = useQuery({
    queryKey: ['recruitment', 'dashboard'],
    queryFn: () => api.get<RecruitmentDashboard>('/recruitment/dashboard'),
  });

  const upcoming = useQuery({
    queryKey: ['recruitment', 'dashboard', 'upcoming'],
    queryFn: () =>
      api.get<UpcomingInterview[]>('/recruitment/dashboard/upcoming-interviews', {
        query: { days: 14, limit: 12 },
      }),
  });

  const data = dashboard.data;
  const loading = dashboard.isLoading;

  return (
    <>
      <PageHeader
        title="Recruitment"
        description={
          data
            ? `Hiring as it stands on ${interviewDay(`${data.today}T12:00:00Z`, data.timezone)}, in ${data.timezone}.`
            : 'Open positions, candidates, interviews and offers.'
        }
        actions={
          <Can permission={PERMISSIONS.INTERVIEW_READ}>
            <Button variant="outline" size="sm" asChild>
              <Link to="/recruitment/interviews">
                <CalendarDays />
                Calendar
              </Link>
            </Button>
          </Can>
        }
      />

      {dashboard.isError ? (
        <Card className="mb-4">
          <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
        </Card>
      ) : (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Open positions"
            value={data?.openPositions}
            icon={Briefcase}
            /* Seats rather than adverts: six openings for two people each is
               twelve people to hire, and a recruiter plans against the second
               number. */
            hint={
              data
                ? `${data.openVacancies} vacanc${data.openVacancies === 1 ? 'y' : 'ies'} to fill`
                : undefined
            }
            tone="primary"
            loading={loading}
          />
          <StatCard
            label="Candidates"
            value={data?.activeCandidates}
            icon={Users}
            hint="Still in the pipeline"
            loading={loading}
          />
          <StatCard
            label="Interviews today"
            value={data?.interviewsToday}
            icon={CalendarClock}
            hint="In the company's time zone"
            tone="warning"
            loading={loading}
          />
          <StatCard
            label="Upcoming interviews"
            value={data?.upcomingInterviews}
            icon={CalendarDays}
            hint="Booked from tomorrow"
            loading={loading}
          />
          <StatCard
            label="In interview"
            value={data?.candidatesInInterview}
            icon={MessagesSquare}
            hint="Candidates at the interview stage"
            loading={loading}
          />
          <StatCard
            label="Pending offers"
            value={data?.offersPending}
            icon={FileSignature}
            hint="Drafted or sent, not yet answered"
            tone="warning"
            loading={loading}
          />
          <StatCard
            label="Hired this month"
            value={data?.hiredThisMonth}
            icon={UserCheck}
            hint="Candidates marked hired"
            tone="success"
            loading={loading}
          />
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader bordered className="flex-row items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle>Upcoming interviews</CardTitle>
              <CardDescription>The next fortnight, soonest first.</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/recruitment/interviews">Open calendar</Link>
            </Button>
          </CardHeader>

          {upcoming.isError ? (
            <ErrorState error={upcoming.error} onRetry={() => void upcoming.refetch()} />
          ) : upcoming.isLoading ? (
            <ListSkeleton rows={4} />
          ) : (upcoming.data ?? []).length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title="Nothing booked"
              description="No interviews are scheduled in the next fortnight."
            />
          ) : (
            <ul className="divide-y divide-border">
              {(upcoming.data ?? []).map((interview) => (
                <UpcomingRow key={interview.id} interview={interview} />
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          <MyInterviewsCard />
          <Card>
            <CardHeader bordered>
              <CardTitle>Quick links</CardTitle>
            </CardHeader>
            <div className="flex flex-col gap-2 p-4">
              <Button variant="outline" className="justify-start" asChild>
                <Link to="/recruitment/job-openings">
                  <Briefcase />
                  Job openings
                </Link>
              </Button>
              {canReadCandidates ? (
                <Button variant="outline" className="justify-start" asChild>
                  <Link to="/recruitment/candidates">
                    <Users />
                    Candidates
                  </Link>
                </Button>
              ) : null}
              {canManageInterviews ? (
                <Button variant="outline" className="justify-start" asChild>
                  <Link to="/recruitment/interviews">
                    <CalendarDays />
                    Interview calendar
                  </Link>
                </Button>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * One line of the panel.
 *
 * The shape section 3 of the brief asks for - time, candidate, type, role,
 * interviewer - and the whole row is the link, because a reader scanning a
 * list of appointments is aiming at the line rather than at a word inside it.
 *
 * On a phone the row becomes two stacked blocks rather than a squeezed grid:
 * the time above, everything else below. A four-column layout at 375px puts
 * two characters in each column.
 */
function UpcomingRow({ interview }: { interview: UpcomingInterview }) {
  return (
    <li>
      <Link
        to={`/recruitment/interviews/${interview.id}`}
        className="flex flex-col gap-2 px-5 py-3.5 transition-colors hover:bg-accent/45 sm:flex-row sm:items-center sm:gap-4"
      >
        <div className="shrink-0 sm:w-40">
          <p className="tabular text-[13.5px] font-semibold">
            {interviewRange(interview.startsAt, interview.endsAt, interview.timezone)}
          </p>
          <p className="text-[11.5px] text-muted-foreground">
            {interview.when === 'TODAY'
              ? 'Today'
              : interviewDay(interview.startsAt, interview.timezone)}
            {' · '}
            {zoneLabel(interview.startsAt, interview.timezone)}
          </p>
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium">{interview.candidateName}</p>
          <p className="truncate text-[12px] text-muted-foreground">
            {INTERVIEW_TYPE_LABELS[interview.type]}
            {' · '}
            {INTERVIEW_ROUND_LABELS[interview.round]}
            {interview.jobTitle ? ` · ${interview.jobTitle}` : ''}
          </p>
        </div>

        <div className="flex items-center gap-2 sm:w-52 sm:justify-end">
          <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
            {interview.interviewerNames.length === 0
              ? 'No panel'
              : interview.interviewerNames.join(', ')}
          </span>
          <Badge variant={INTERVIEW_STATUS_TONE[interview.status]}>
            {INTERVIEW_STATUS_LABELS[interview.status]}
          </Badge>
        </div>
      </Link>
    </li>
  );
}

/**
 * The reader's own three figures, when they sit on panels themselves.
 *
 * Hidden entirely when the endpoint reports nothing at all - HR who has never
 * been on a panel does not need a card of zeroes. `awaitingEvaluation` is the
 * one that is worth a colour: it is the only number here that is a thing the
 * reader still has to do.
 */
function MyInterviewsCard() {
  const query = useQuery({
    queryKey: ['recruitment', 'interviews', 'my-summary'],
    queryFn: () => api.get<MyInterviewSummary>('/recruitment/interviews/my-summary'),
    // An interviewer is the reader this card is for, and they reach this page
    // only if they also hold recruitment.read; failing quietly is right.
    retry: false,
  });

  const summary = query.data;
  const empty =
    !summary ||
    (summary.today === 0 &&
      summary.upcoming === 0 &&
      summary.completed === 0 &&
      summary.awaitingEvaluation === 0);

  if (query.isError || empty) return null;

  return (
    <Card>
      <CardHeader bordered>
        <CardTitle>Your panel</CardTitle>
        <CardDescription>Interviews you are sitting on.</CardDescription>
      </CardHeader>
      <dl className="grid grid-cols-2 gap-px bg-border">
        <Figure label="Today" value={summary.today} />
        <Figure label="Upcoming" value={summary.upcoming} />
        <Figure label="Completed" value={summary.completed} />
        <Figure
          label="Feedback due"
          value={summary.awaitingEvaluation}
          tone={summary.awaitingEvaluation > 0 ? 'warning' : undefined}
        />
      </dl>
    </Card>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'warning';
}) {
  return (
    <div className="bg-card px-5 py-3.5">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd
        className={
          tone === 'warning'
            ? 'tabular text-xl font-semibold text-warning-foreground'
            : 'tabular text-xl font-semibold'
        }
      >
        {value}
      </dd>
    </div>
  );
}
