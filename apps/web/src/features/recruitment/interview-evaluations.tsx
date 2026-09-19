import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Pencil } from 'lucide-react';
import {
  EVALUATION_CRITERIA,
  EVALUATION_SCORE_MAX,
  INTERVIEW_RECOMMENDATION_LABELS,
  canEvaluateInterview,
  type EvaluationRecord,
  type InterviewEvaluationSummary,
  type InterviewRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ListSkeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { RECOMMENDATION_TONE } from './recruitment-shared';
import { EvaluationDialog } from './evaluation-dialog';
import { useRecruitmentAccess } from './use-recruitment-data';

/**
 * The panel's feedback, as a panel rather than as an average.
 *
 * Three interviewers produce three cards. There is no total, no mean, no
 * ranking and no traffic light computed from the numbers, and their absence is
 * the point: an evaluation is advice to a person who decides, and a score that
 * decided things by itself would be a hiring decision made by arithmetic.
 *
 * WHO HAS NOT FILED is shown as loudly as who has. "HR Manager: pending" is a
 * real state and a real prompt; leaving them off the list would let a reader
 * conclude the panel agreed when two of three have said nothing.
 */
export function InterviewEvaluations({
  interview,
  ownEmployeeId,
}: {
  interview: InterviewRecord;
  /** The reader's own employee id, when their login has one. */
  ownEmployeeId: string | null;
}) {
  const { canEvaluate } = useRecruitmentAccess();
  const [editing, setEditing] = React.useState(false);

  const query = useQuery({
    queryKey: ['recruitment', 'interviews', interview.id, 'evaluations'],
    queryFn: () =>
      api.get<InterviewEvaluationSummary>(`/recruitment/interviews/${interview.id}/evaluations`),
  });

  const summary = query.data;
  const mine = summary?.evaluations.find((entry) => entry.isMine) ?? null;
  const onPanel =
    ownEmployeeId !== null &&
    interview.interviewers.some((person) => person.employeeId === ownEmployeeId);
  const canFile = canEvaluate && onPanel && canEvaluateInterview(interview.status);

  return (
    <>
      <Card>
        <CardHeader bordered className="flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Feedback</CardTitle>
            <CardDescription>
              One assessment per interviewer. Nobody's replaces anybody else's.
            </CardDescription>
          </div>
          {canFile ? (
            <Button size="sm" variant={mine ? 'outline' : 'primary'} onClick={() => setEditing(true)}>
              {mine ? <Pencil /> : <ClipboardList />}
              {mine ? 'Revise yours' : 'Submit feedback'}
            </Button>
          ) : null}
        </CardHeader>

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <ListSkeleton rows={2} />
        ) : !summary || (summary.evaluations.length === 0 && summary.pending.length === 0) ? (
          <EmptyState
            icon={ClipboardList}
            title="No feedback yet"
            description={
              canEvaluateInterview(interview.status)
                ? 'Nobody on the panel has filed their assessment.'
                : 'Feedback can be filed once the interview has been marked complete.'
            }
          />
        ) : (
          <div className="divide-y divide-border">
            {summary.evaluations.map((evaluation) => (
              <EvaluationCard key={evaluation.id} evaluation={evaluation} />
            ))}

            {summary.pending.map((person) => (
              <div
                key={person.employeeId}
                className="flex items-center justify-between gap-3 px-5 py-3.5"
              >
                <p className="text-[13.5px]">
                  {person.fullName}
                  {person.employeeId === ownEmployeeId ? (
                    <span className="text-muted-foreground"> (you)</span>
                  ) : null}
                </p>
                <Badge variant="warning">Pending</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>

      {canFile ? (
        <EvaluationDialog
          open={editing}
          interview={interview}
          existing={mine}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

function EvaluationCard({ evaluation }: { evaluation: EvaluationRecord }) {
  const scores = EVALUATION_CRITERIA.map((criterion) => ({
    label: criterion.label,
    value: evaluation[criterion.key],
  }));

  return (
    <article className="px-5 py-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium">
            {evaluation.interviewerName}
            {evaluation.isMine ? <span className="text-muted-foreground"> (you)</span> : null}
          </p>
          <p className="text-[11.5px] text-muted-foreground">
            {formatDateTime(evaluation.submittedAt)}
          </p>
        </div>
        <Badge variant={RECOMMENDATION_TONE[evaluation.recommendation]}>
          {INTERVIEW_RECOMMENDATION_LABELS[evaluation.recommendation]}
        </Badge>
      </header>

      <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {scores.map((score) => (
          <div key={score.label} className="flex items-center justify-between gap-2">
            <dt className="text-[12.5px] text-muted-foreground">{score.label}</dt>
            <dd className="tabular text-[13px] font-medium">
              {/* "Not assessed" rather than a dash or a zero: an HR interviewer
                  who did not score technical skill has not given it nothing out
                  of ten. */}
              {score.value === null ? (
                <span className="text-[12px] font-normal text-muted-foreground">Not assessed</span>
              ) : (
                `${score.value} / ${EVALUATION_SCORE_MAX}`
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
  );
}
