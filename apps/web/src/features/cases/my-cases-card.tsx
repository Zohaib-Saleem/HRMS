import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LifeBuoy } from 'lucide-react';
import {
  CASE_STATUS_LABELS,
  EMPTY_CASE_COUNTS,
  PERMISSIONS,
  type CaseStatus,
  type CaseSummary,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { usePermissions, useSession } from '@/features/auth/session-context';
import { CASE_STATUS_TONE } from './case-shared';
import { CaseCreateDialog } from './case-create-dialog';

/**
 * The employee's own cases, on their dashboard.
 *
 * Four numbers and a link, because that is the whole of what somebody wants
 * from a dashboard here: is anything of mine still open, and is anything
 * waiting on ME. The list, the conversation and the history are one click away
 * on /cases, and putting any of them here would make the card a second case
 * screen rather than a glance at one.
 *
 * Every figure comes from `/cases/summary`, which counts in the database and is
 * pinned to the caller's own employee record on the server. Nothing is counted
 * in the browser: a card that fetched a page of cases and tallied it would be
 * wrong the moment somebody had more than a page of them, and would be wrong
 * quietly.
 *
 * The card renders itself away without `case.read.own`, so a role that does not
 * hold it gets a shorter dashboard rather than a broken one.
 */

/** The four the card shows. The rest are history and live on the list screen. */
const HEADLINE: readonly CaseStatus[] = ['OPEN', 'IN_PROGRESS', 'PENDING', 'RESOLVED'];

export function MyCasesCard() {
  const { has } = usePermissions();
  const { session } = useSession();
  const [creating, setCreating] = React.useState(false);

  const canRead = has(PERMISSIONS.CASE_READ_OWN);
  // Raising a case needs an employee record to raise it against, which the
  // server enforces; hiding the button spares somebody a refusal they cannot
  // act on.
  const canCreate = has(PERMISSIONS.CASE_CREATE) && (session?.employeeLinked ?? false);

  const query = useQuery({
    queryKey: ['cases', 'summary'],
    queryFn: () => api.get<CaseSummary>('/cases/summary'),
    enabled: canRead,
    retry: false,
  });

  if (!canRead) return null;

  /*
   * Read defensively, and deliberately so.
   *
   * This card sits among half a dozen others on the dashboard, and an exception
   * thrown while rendering it takes the whole page down with it - the person
   * loses their attendance, their leave and their holidays because a helpdesk
   * summary came back in a shape nobody expected. A payload missing `counts`
   * is not something the current API can produce, but an older deployed build,
   * a proxy returning an error body with a 200, or a future change to the
   * endpoint all can, and none of those is worth a blank dashboard. Merging
   * over the zeroed record means the worst case is a card that says "no cases".
   */
  const summary = query.data ?? null;
  const counts: Record<CaseStatus, number> = { ...EMPTY_CASE_COUNTS, ...(summary?.counts ?? {}) };
  const total =
    typeof summary?.total === 'number'
      ? summary.total
      : Object.values(counts).reduce((sum, n) => sum + n, 0);

  return (
    /* A column filling the height its dashboard row gives it - see
       `DashboardGrid`. The two header buttons wrap onto a second line on a
       narrow column, which is why this card was taller than its neighbours;
       stretching the row makes that difference cost nothing. */
    <Card className="flex h-full flex-col">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <LifeBuoy className="size-4" aria-hidden /> My cases
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          {canCreate ? (
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              Raise a case
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" asChild>
            <Link to="/cases">View my cases</Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col justify-center">
        {query.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : total === 0 ? (
          <EmptyState
            className="px-0 py-2"
            icon={LifeBuoy}
            title="No cases"
            // The same sentence /cases opens with. It ran three examples long
            // here - a wrong payslip, a laptop that will not start, an office
            // repair - which wrapped to four lines in a card a third of the
            // dashboard wide and made this the tallest card in its row, so the
            // two short cards beside it were stretched to match a list of
            // examples. The examples were never the point; the tracking is.
            description="Raise one when something needs sorting out and you want it tracked."
            action={
              canCreate ? (
                <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                  Raise a case
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Two by two, at every width. Four across was a viewport breakpoint
                reading a card that is a THIRD of the viewport wide: from `md`
                up the counts sat in ~70px columns and "In progress" wrapped
                under its own number. */}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              {HEADLINE.map((status) => (
                <div key={status}>
                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {CASE_STATUS_LABELS[status]}
                  </dt>
                  <dd
                    className={`tabular text-[20px] font-semibold ${
                      counts[status] > 0 && CASE_STATUS_TONE[status] === 'warning'
                        ? 'text-warning-foreground'
                        : ''
                    }`}
                  >
                    {counts[status]}
                  </dd>
                </div>
              ))}
            </dl>

            {/*
              The one sentence worth adding to four numbers. PENDING means the
              case is waiting on the person reading this and nothing will move
              until they reply - which is the only thing on this card they can
              act on right now.
            */}
            {counts.PENDING > 0 ? (
              <p className="mt-3 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[12.5px] text-warning-foreground">
                {counts.PENDING === 1
                  ? 'One case is waiting on your reply.'
                  : `${counts.PENDING} cases are waiting on your reply.`}
              </p>
            ) : null}
          </>
        )}
      </CardContent>

      <CaseCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        // Raised from the dashboard, so the person stays on the dashboard. The
        // toast carries the case number and the card refreshes behind it.
        openOnCreate={false}
      />
    </Card>
  );
}
