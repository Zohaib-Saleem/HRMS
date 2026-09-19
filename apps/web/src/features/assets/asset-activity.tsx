import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { assetTimelineStep, type AssetActivityEvent, type AssetTimelineTone } from '@hrms/shared';
import { api } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';

/**
 * The asset's story, in order.
 *
 * Read back from the audit trail rather than from a history table of its own.
 * Every lifecycle action already writes one audit row with a summary written
 * for a person to read - "Assigned LAP-0021 to Hassan Raza in Good condition" -
 * so this renders those sentences rather than reconstructing them from columns.
 * A second history table would be a second thing to keep in step with the
 * first, and the one that drifted would be the one on screen.
 *
 * What this file adds on top of those sentences is a HEADING and a COLOUR per
 * event, both from the shared step map. The colour is the badge vocabulary the
 * register uses, so an event that means something went wrong looks the same
 * here as it does on the list - a reader scanning a long timeline finds the two
 * rows that matter without reading twenty sentences.
 *
 * An action the map does not know still renders. It falls back to the audit
 * summary alone, which is a sentence written for a person, so a lifecycle step
 * added in a later release appears here the day it ships rather than the day
 * somebody remembers to update a lookup table.
 */

/**
 * The dot, in the tone the step carries.
 *
 * Explicit class strings rather than an interpolated `bg-${tone}`: Tailwind
 * reads the source for class names, and a constructed one is a class that is
 * never generated and a dot that is never coloured.
 */
const DOT: Record<AssetTimelineTone, string> = {
  neutral: 'bg-muted-foreground',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning-foreground',
  destructive: 'bg-destructive',
};

/** A day, as the timeline reads it: "15 Sep 2026". */
function day(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '--';
  return parsed.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function AssetActivity({ assetId }: { assetId: string }) {
  const query = useQuery({
    queryKey: ['assets', 'activity', assetId],
    queryFn: () => api.get<AssetActivityEvent[]>(`/assets/${assetId}/activity`),
  });

  if (query.isLoading) {
    return (
      <Card className="space-y-3 p-5">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-80" />
        <Skeleton className="h-4 w-72" />
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

  const events = query.data ?? [];

  if (events.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={History}
          title="Nothing has happened yet"
          description="Every assignment, repair and change to this asset will appear here."
        />
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <ol className="space-y-4">
        {events.map((event) => {
          const step = assetTimelineStep(event.action);
          // The fallback carries the action itself, which is a database string
          // and not a heading. When that is all there is, the summary stands
          // alone - it was written for a person and the action was not.
          const heading = step.label === event.action ? null : step.label;

          return (
            <li key={event.id} className="flex gap-4">
              <div className="w-28 shrink-0 pt-0.5">
                <p className="tabular text-[12.5px] font-medium text-muted-foreground">
                  {day(event.at)}
                </p>
              </div>
              <div
                className="relative flex-1 border-l border-border pb-1 pl-4"
                // The dot sits on the rule, which is what makes a list of dates
                // read as a sequence rather than as a table with one column.
              >
                <span
                  className={`absolute -left-[4.5px] top-1.5 size-2 rounded-full ${DOT[step.tone]}`}
                />
                {heading ? (
                  <p className="text-[13.5px] font-medium">{heading}</p>
                ) : null}
                <p className={heading ? 'text-[13px] text-muted-foreground' : 'text-[13.5px]'}>
                  {event.summary}
                </p>
                {event.actorName ? (
                  <p className="text-[12px] text-muted-foreground">{event.actorName}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
