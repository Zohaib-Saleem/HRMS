import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  History,
  Link2,
  MapPin,
  Pencil,
  XCircle,
} from 'lucide-react';
import {
  INTERVIEW_ROUND_LABELS,
  INTERVIEW_STATUS_LABELS,
  INTERVIEW_TYPE_LABELS,
  canRescheduleInterview,
  type InterviewRecord,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useSession } from '@/features/auth/session-context';
import {
  INTERVIEW_STATUS_TONE,
  interviewLongDay,
  interviewRange,
  zoneLabel,
} from './recruitment-shared';
import { InterviewEvaluations } from './interview-evaluations';
import { InterviewRescheduleDialog } from './interview-reschedule-dialog';
import { InterviewStatusDialog } from './interview-status-dialog';
import { InterviewPanelDialog } from './interview-panel-dialog';
import { useRecruitmentAccess } from './use-recruitment-data';

/**
 * One interview.
 *
 * Four kinds of reader open this screen and it is the same screen for all of
 * them, narrowed by what the server will answer:
 *
 *   - a COORDINATOR (`interview.manage`) moves it, cancels it, completes it
 *     and changes the panel;
 *   - a PANELLIST (`interview.read` on their own seat) confirms they will be
 *     there and files their own feedback, and may not touch the booking;
 *   - HR reading somebody else's interview sees all of it and acts on none of
 *     it unless they hold the grant;
 *   - anybody else gets a 404 rather than a 403, because a 403 would confirm
 *     that this interview exists.
 *
 * The schedule history is on the page rather than behind a toggle. "This has
 * been moved twice" is context for the person about to move it a third time.
 */
export function InterviewDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const { session } = useSession();
  const { canManageInterviews } = useRecruitmentAccess();

  const [rescheduling, setRescheduling] = React.useState(false);
  const [statusTarget, setStatusTarget] = React.useState<'COMPLETED' | 'CANCELLED' | null>(null);
  const [editingPanel, setEditingPanel] = React.useState(false);

  const query = useQuery({
    queryKey: ['recruitment', 'interviews', id],
    queryFn: () => api.get<InterviewRecord>(`/recruitment/interviews/${id}`),
    enabled: id !== '',
  });

  const ownEmployeeId = session?.user.employee?.id ?? null;

  const confirm = useMutation({
    mutationFn: () => api.post<InterviewRecord>(`/recruitment/interviews/${id}/confirm`),
    onSuccess: async () => {
      toast.success('Thanks - your attendance is confirmed.');
      await queryClient.invalidateQueries({ queryKey: ['recruitment'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  if (query.isLoading) {
    return (
      <Card className="p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="mt-3 h-4 w-48" />
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

  const interview = query.data;
  if (!interview) {
    return (
      <Card>
        <EmptyState
          title="Interview not found"
          description="It may have been removed, or it is not one you are on."
          action={
            <Button variant="outline" size="sm" asChild>
              <Link to="/recruitment/interviews">Back to the calendar</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  const mySeat = interview.interviewers.find((person) => person.employeeId === ownEmployeeId);
  const canReschedule = canManageInterviews && canRescheduleInterview(interview.status);
  const isLive = interview.status !== 'CANCELLED' && interview.status !== 'COMPLETED';

  return (
    <>
      <div className="mb-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/recruitment/interviews">
            <ArrowLeft />
            Calendar
          </Link>
        </Button>
      </div>

      <PageHeader
        title={`${INTERVIEW_TYPE_LABELS[interview.type]} with ${interview.candidateName}`}
        description={`${INTERVIEW_ROUND_LABELS[interview.round]}${interview.jobTitle ? ` · ${interview.jobTitle}` : ''}`}
        actions={
          <>
            {/* The one write a plain panellist may perform, and it reaches
                exactly one row: their own seat. */}
            {mySeat && !mySeat.confirmedAt && isLive ? (
              <Button size="sm" loading={confirm.isPending} onClick={() => confirm.mutate()}>
                <CheckCircle2 />
                Confirm attendance
              </Button>
            ) : null}
            {canReschedule ? (
              <Button variant="outline" size="sm" onClick={() => setRescheduling(true)}>
                <CalendarClock />
                Reschedule
              </Button>
            ) : null}
            {canManageInterviews && isLive ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setStatusTarget('COMPLETED')}
                >
                  <CheckCircle2 />
                  Mark completed
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setStatusTarget('CANCELLED')}
                >
                  <XCircle />
                  Cancel
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader bordered className="flex-row items-center justify-between gap-3">
            <CardTitle>Details</CardTitle>
            <Badge variant={INTERVIEW_STATUS_TONE[interview.status]}>
              {INTERVIEW_STATUS_LABELS[interview.status]}
            </Badge>
          </CardHeader>

          <div className="border-b border-border px-5 py-4">
            <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
              When
            </p>
            <p className="mt-1 text-[15px] font-semibold">
              {interviewLongDay(interview.startsAt, interview.timezone)}
            </p>
            <p className="tabular text-[13.5px]">
              {interviewRange(interview.startsAt, interview.endsAt, interview.timezone)}{' '}
              <span className="text-muted-foreground">
                {zoneLabel(interview.startsAt, interview.timezone)} ({interview.timezone})
              </span>
            </p>
          </div>

          <dl className="grid gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2">
            <Detail label="Candidate">
              <Link
                to={`/recruitment/candidates/${interview.candidateId}`}
                className="text-primary hover:underline"
              >
                {interview.candidateName}
              </Link>
              <span className="block font-mono text-[11.5px] text-muted-foreground">
                {interview.candidateReference}
              </span>
            </Detail>

            <Detail label="Job opening">
              {interview.jobOpeningId ? (
                <Link
                  to={`/recruitment/job-openings/${interview.jobOpeningId}`}
                  className="text-primary hover:underline"
                >
                  {interview.jobTitle}
                </Link>
              ) : (
                <span className="text-muted-foreground">Exploratory - no opening</span>
              )}
              {interview.departmentName ? (
                <span className="block text-[11.5px] text-muted-foreground">
                  {interview.departmentName}
                </span>
              ) : null}
            </Detail>

            <Detail label="Type">{INTERVIEW_TYPE_LABELS[interview.type]}</Detail>
            <Detail label="Round">{INTERVIEW_ROUND_LABELS[interview.round]}</Detail>

            <Detail label="Location">
              {interview.location ? (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="size-3.5 text-muted-foreground" aria-hidden />
                  {interview.location}
                </span>
              ) : (
                <span className="text-muted-foreground">Not stated</span>
              )}
            </Detail>

            <Detail label="Meeting link">
              {interview.meetingLink ? (
                <a
                  href={interview.meetingLink}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 text-primary hover:underline"
                >
                  <Link2 className="size-3.5" aria-hidden />
                  Join
                </a>
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            </Detail>
          </dl>

          {interview.notes ? (
            <div className="border-t border-border px-5 py-4">
              <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                Notes for the panel
              </p>
              <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-relaxed">
                {interview.notes}
              </p>
            </div>
          ) : null}

          {interview.cancelledReason ? (
            <div className="border-t border-border px-5 py-4">
              <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                Why it was cancelled
              </p>
              <p className="mt-1.5 whitespace-pre-wrap text-[13.5px]">
                {interview.cancelledReason}
              </p>
            </div>
          ) : null}
        </Card>

        <Card className="h-fit">
          <CardHeader bordered className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>Panel</CardTitle>
              <CardDescription>
                {interview.evaluationsPending > 0
                  ? `${interview.evaluationsPending} still to give feedback`
                  : 'Everybody has given feedback'}
              </CardDescription>
            </div>
            {canManageInterviews && isLive ? (
              <Button variant="ghost" size="icon-sm" aria-label="Edit panel" onClick={() => setEditingPanel(true)}>
                <Pencil />
              </Button>
            ) : null}
          </CardHeader>

          <ul className="divide-y divide-border">
            {interview.interviewers.map((person) => (
              <li key={person.employeeId} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px]">
                    {person.fullName}
                    {person.isLead ? (
                      <span className="ml-1.5 text-[11px] text-muted-foreground">Lead</span>
                    ) : null}
                  </p>
                  <p className="truncate text-[11.5px] text-muted-foreground">
                    {person.jobTitle ?? 'No title'}
                  </p>
                </div>
                {/* Two different facts, deliberately not merged: confirming is
                    "I will be there", an evaluation is "here is what I
                    thought". A panellist can do the second without the first. */}
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge variant={person.confirmedAt ? 'success' : 'neutral'}>
                    {person.confirmedAt ? 'Confirmed' : 'Not confirmed'}
                  </Badge>
                  {person.hasEvaluation ? (
                    <span className="text-[11px] text-success">Feedback in</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <InterviewEvaluations interview={interview} ownEmployeeId={ownEmployeeId} />
        </div>

        {(interview.scheduleChanges ?? []).length > 0 ? (
          <Card className="h-fit">
            <CardHeader bordered>
              <CardTitle className="flex items-center gap-2">
                <History className="size-4 text-muted-foreground" aria-hidden />
                Moved {interview.scheduleChanges?.length}{' '}
                {interview.scheduleChanges?.length === 1 ? 'time' : 'times'}
              </CardTitle>
              <CardDescription>Every move, with the reason given for it.</CardDescription>
            </CardHeader>
            <ol className="divide-y divide-border">
              {(interview.scheduleChanges ?? []).map((change) => (
                <li key={change.id} className="px-5 py-3.5">
                  <p className="text-[13px]">
                    <span className="text-muted-foreground line-through">
                      {interviewRange(
                        change.previousStartsAt,
                        change.previousEndsAt,
                        change.previousTimezone,
                      )}
                    </span>{' '}
                    →{' '}
                    {interviewRange(change.newStartsAt, change.newEndsAt, change.newTimezone)}
                  </p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    {interviewLongDay(change.newStartsAt, change.newTimezone)} ·{' '}
                    {formatDateTime(change.createdAt)}
                  </p>
                  <p className="mt-1 text-[13px]">{change.reason}</p>
                </li>
              ))}
            </ol>
          </Card>
        ) : null}
      </div>

      {canManageInterviews ? (
        <>
          <InterviewRescheduleDialog
            open={rescheduling}
            interview={interview}
            onClose={() => setRescheduling(false)}
          />
          <InterviewStatusDialog
            open={statusTarget !== null}
            interview={interview}
            target={statusTarget ?? undefined}
            onClose={() => setStatusTarget(null)}
          />
          <InterviewPanelDialog
            open={editingPanel}
            interview={interview}
            onClose={() => setEditingPanel(false)}
          />
        </>
      ) : null}
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-[13.5px]">{children}</dd>
    </div>
  );
}
