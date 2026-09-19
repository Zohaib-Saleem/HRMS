import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MoveRight, Users } from 'lucide-react';
import {
  CANDIDATE_PIPELINE_STAGES,
  CANDIDATE_STAGE_LABELS,
  type CandidateApplicationRecord,
  type CandidateRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StageChangeDialog } from './stage-change-dialog';
import { useRecruitmentAccess } from './use-recruitment-data';

/**
 * The pipeline, as a board.
 *
 * Seven columns - the live stages - and the two terminal ones are deliberately
 * NOT columns. A board with a "Rejected" column grows until it is mostly
 * rejections, and the one question a board answers is "what is moving"; the
 * people who stopped moving are on the list next door, which is paginated and
 * filterable and is the right shape for a history. The endpoint agrees: it
 * excludes the terminal stages in its WHERE clause rather than returning them
 * for the client to hide.
 *
 * MOVING somebody is a button rather than a drag, and that is a decision
 * rather than a shortcut. A card here is a PERSON, but a stage belongs to an
 * APPLICATION - somebody can be shortlisted for one role and rejected for
 * another - so a drag from one column to another has no answer to "which
 * application did you mean" when there are two. The button asks. It is also
 * the only version of this that works on a phone, which is where half of these
 * screens are read.
 *
 * Nothing on this board writes a stage by itself: every move goes through the
 * same dialog, the same endpoint and the same transition check as everywhere
 * else, and a move the server refuses stays refused.
 */
export function CandidateBoard({
  filters,
}: {
  filters: { jobOpeningId?: string; departmentId?: string; recruiterId?: string };
}) {
  const { canManageCandidates } = useRecruitmentAccess();
  const [moving, setMoving] = React.useState<CandidateRecord | null>(null);
  const [application, setApplication] = React.useState<CandidateApplicationRecord | null>(null);

  const query = useQuery({
    queryKey: ['recruitment', 'candidates', 'board', filters],
    queryFn: () =>
      api.get<CandidateRecord[]>('/recruitment/candidates/board', {
        query: {
          jobOpeningId: filters.jobOpeningId || undefined,
          departmentId: filters.departmentId || undefined,
          recruiterId: filters.recruiterId || undefined,
        },
      }),
  });

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  if (query.isLoading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2">
        {CANDIDATE_PIPELINE_STAGES.map((stage) => (
          <div key={stage} className="w-64 shrink-0 space-y-2">
            <Skeleton className="h-8" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ))}
      </div>
    );
  }

  const candidates = query.data ?? [];

  if (candidates.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Users}
          title="Nobody in the pipeline"
          description="Candidates appear here until they are hired, rejected or withdrawn."
        />
      </Card>
    );
  }

  const byStage = new Map(CANDIDATE_PIPELINE_STAGES.map((stage) => [stage, [] as CandidateRecord[]]));
  for (const candidate of candidates) {
    byStage.get(candidate.stage)?.push(candidate);
  }

  /**
   * Which application is being moved.
   *
   * One application: no question to ask, so none is asked. Several: the picker
   * below. None at all: there is no stage to move, because the stage lives on
   * the application - that candidate is a filed CV and needs attaching to a
   * vacancy first, which is on their profile.
   */
  const startMove = (candidate: CandidateRecord) => {
    const live = candidate.applications;
    if (live.length === 1) {
      setApplication(live[0] ?? null);
      setMoving(candidate);
      return;
    }
    setApplication(null);
    setMoving(candidate);
  };

  return (
    <>
      {/*
        One horizontally scrolling row on every screen size. Seven columns do
        not reflow into a phone, and a board that stacks into a single column
        is a list - which is the other view of this screen.
      */}
      <div className="flex gap-3 overflow-x-auto pb-3">
        {CANDIDATE_PIPELINE_STAGES.map((stage) => {
          const column = byStage.get(stage) ?? [];
          return (
            <section
              key={stage}
              aria-label={CANDIDATE_STAGE_LABELS[stage]}
              className="flex w-72 shrink-0 flex-col rounded-xl border border-border bg-surface-muted/50"
            >
              <header className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
                <h3 className="text-[13px] font-semibold">{CANDIDATE_STAGE_LABELS[stage]}</h3>
                <span className="tabular rounded-md bg-muted px-1.5 py-0.5 text-[11.5px] text-muted-foreground">
                  {column.length}
                </span>
              </header>

              <div className="flex min-h-24 flex-col gap-2 p-2.5">
                {column.length === 0 ? (
                  <p className="px-1 py-3 text-center text-[12px] text-muted-foreground">Empty</p>
                ) : (
                  column.map((candidate) => (
                    <article
                      key={candidate.id}
                      className="rounded-lg border border-border bg-card p-3 shadow-xs"
                    >
                      <Link
                        to={`/recruitment/candidates/${candidate.id}`}
                        className="block truncate text-[13.5px] font-medium hover:underline"
                      >
                        {candidate.fullName}
                      </Link>
                      <p className="truncate text-[11.5px] text-muted-foreground">
                        {candidate.applications[0]?.jobTitle ?? 'No application yet'}
                      </p>
                      {candidate.applications.length > 1 ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {candidate.applications.length} applications
                        </p>
                      ) : null}

                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="truncate text-[11.5px] text-muted-foreground">
                          {candidate.recruiter?.fullName ?? 'No recruiter'}
                        </span>
                        {canManageCandidates && candidate.applications.length > 0 ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-[12px]"
                            onClick={() => startMove(candidate)}
                          >
                            Move
                            <MoveRight />
                          </Button>
                        ) : null}
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>

      {/* Which application, when somebody is in more than one process. */}
      <Dialog
        open={moving !== null && application === null}
        onOpenChange={(next) => (next ? null : setMoving(null))}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Which application?</DialogTitle>
            <DialogDescription>
              {moving?.fullName} is in more than one process, and a stage belongs to one of them.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ul className="space-y-2">
              {(moving?.applications ?? []).map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => setApplication(entry)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-border px-3.5 py-3 text-left transition-colors hover:bg-accent/45"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-medium">
                        {entry.jobTitle}
                      </span>
                      <span className="block font-mono text-[11.5px] text-muted-foreground">
                        {entry.jobReference}
                      </span>
                    </span>
                    <Badge variant="neutral">{CANDIDATE_STAGE_LABELS[entry.stage]}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <StageChangeDialog
        open={moving !== null && application !== null}
        candidateName={moving?.fullName ?? ''}
        application={application}
        onClose={() => {
          setApplication(null);
          setMoving(null);
        }}
      />
    </>
  );
}
