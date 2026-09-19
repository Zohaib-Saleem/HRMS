import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import {
  CalendarClock,
  CalendarX,
  CheckCircle2,
  ClipboardList,
  FileSignature,
  FileText,
  History,
  Mail,
  MessageSquare,
  MoveRight,
  UserPlus,
  Send,
} from 'lucide-react';
import type { CandidateTimelineEntry } from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ListSkeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';

/**
 * Everything that has happened to one candidate, in order.
 *
 * A READ layer, exactly like the employee timeline: every entry here is a row
 * some other table already owns - an application, an interview, an evaluation,
 * an offer, a document - normalised by the API and sorted. There is no
 * candidate-timeline table and nothing writes one, so this can never disagree
 * with the records it describes, and it cannot be edited to say something that
 * did not happen.
 *
 * What it carries is what happened, never what it was worth: no offer salary,
 * no evaluation score, no HR note. A reader who may not see those on the
 * records themselves does not get them here by the back door.
 */

const ICONS: Record<CandidateTimelineEntry['kind'], LucideIcon> = {
  CANDIDATE_CREATED: UserPlus,
  APPLIED: FileText,
  STAGE_CHANGED: MoveRight,
  INTERVIEW_SCHEDULED: CalendarClock,
  INTERVIEW_RESCHEDULED: History,
  INTERVIEW_COMPLETED: CheckCircle2,
  INTERVIEW_CANCELLED: CalendarX,
  EVALUATION_SUBMITTED: ClipboardList,
  OFFER_CREATED: FileSignature,
  OFFER_SENT: Send,
  OFFER_ANSWERED: Mail,
  DOCUMENT_UPLOADED: FileText,
  CONVERTED_TO_EMPLOYEE: UserPlus,
};

export function CandidateTimeline({ candidateId }: { candidateId: string }) {
  const query = useQuery({
    queryKey: ['recruitment', 'candidates', candidateId, 'timeline'],
    queryFn: () =>
      api.get<CandidateTimelineEntry[]>(`/recruitment/candidates/${candidateId}/timeline`),
  });

  const entries = query.data ?? [];

  return (
    <Card>
      <CardHeader bordered>
        <CardTitle>Activity</CardTitle>
        <CardDescription>
          Read back from the records themselves - applications, interviews, feedback, offers and
          files. Nothing here is written separately.
        </CardDescription>
      </CardHeader>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <ListSkeleton rows={4} />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="Nothing has happened yet"
          description="Applications, interviews and offers appear here as they are recorded."
        />
      ) : (
        <ol className="px-5 py-4">
          {entries.map((entry, index) => {
            const Icon = ICONS[entry.kind] ?? MessageSquare;
            const last = index === entries.length - 1;

            return (
              <li key={`${entry.at}-${index}`} className="relative flex gap-3 pb-5 last:pb-0">
                {/* The rail, drawn per item rather than behind the list, so it
                    stops at the last entry instead of trailing into space. */}
                {last ? null : (
                  <span
                    className="absolute left-[15px] top-8 h-[calc(100%-2rem)] w-px bg-border"
                    aria-hidden
                  />
                )}
                <span
                  className="z-10 grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
                  aria-hidden
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1 pt-1">
                  <p className="text-[13.5px] font-medium">{entry.title}</p>
                  {entry.detail ? (
                    <p className="mt-0.5 text-[13px] text-muted-foreground">{entry.detail}</p>
                  ) : null}
                  <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                    {formatDateTime(entry.at)}
                    {entry.actorName ? ` · ${entry.actorName}` : ''}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
