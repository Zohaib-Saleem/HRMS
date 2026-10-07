import * as React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { TriangleAlert } from 'lucide-react';
import {
  ASSET_ISSUE_STATUS_LABELS,
  PERMISSIONS,
  type AssetIssueQueueItem,
  type AssetIssueStatus,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField, NativeSelect, Textarea } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';

/**
 * The asset issue queue: problems employees have reported with the kit they
 * hold, for whoever looks after the register.
 *
 * `?issue=<id>` is where an "Asset Issue Reported" notification lands. That
 * issue is shown first and highlighted whatever the filter says, so the link
 * opens the issue it was about even once somebody else has resolved it.
 */

type Filter = AssetIssueStatus | 'ALL';

const STATUS_TONE: Record<AssetIssueStatus, 'warning' | 'success'> = {
  OPEN: 'warning',
  RESOLVED: 'success',
};

export function AssetIssuesPage() {
  const { has } = usePermissions();
  const canResolve = has(PERMISSIONS.ASSET_UPDATE);
  const [params] = useSearchParams();
  const focusId = params.get('issue');
  const [filter, setFilter] = React.useState<Filter>('OPEN');
  const [resolving, setResolving] = React.useState<AssetIssueQueueItem | null>(null);

  const list = useQuery({
    queryKey: ['assets', 'issues', filter],
    queryFn: () =>
      api.get<AssetIssueQueueItem[]>('/assets/issues', { query: { status: filter } }),
  });

  // The linked issue, fetched on its own so a resolved one still opens from an
  // OPEN-filtered list.
  const focused = useQuery({
    queryKey: ['assets', 'issues', 'one', focusId],
    queryFn: () => api.get<AssetIssueQueueItem>(`/assets/issues/${encodeURIComponent(focusId!)}`),
    enabled: Boolean(focusId),
    retry: false,
  });

  const rows = React.useMemo(() => {
    const listed = list.data ?? [];
    const pinned = focused.data;
    if (!pinned) return listed;
    return [pinned, ...listed.filter((row) => row.id !== pinned.id)];
  }, [list.data, focused.data]);

  return (
    <>
      <PageHeader
        title="Asset issues"
        description="Problems employees have reported with the equipment they hold. Reporting one never changes the asset record; resolving it records what was done."
        actions={
          <NativeSelect
            aria-label="Show"
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
            className="w-40"
          >
            <option value="OPEN">Open</option>
            <option value="RESOLVED">Resolved</option>
            <option value="ALL">All</option>
          </NativeSelect>
        }
      />

      {focusId && focused.isError ? (
        <p className="mb-4 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-[13px]">
          {focused.error instanceof ApiError && focused.error.status === 404
            ? 'That issue could not be found. It may belong to another company or have been removed.'
            : errorMessage(focused.error)}
        </p>
      ) : null}

      <Card>
        {list.isLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={TriangleAlert}
            title={filter === 'OPEN' ? 'No open issues' : 'No issues'}
            description="When an employee reports a problem with their asset it appears here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li
                key={row.id}
                id={`issue-${row.id}`}
                className={cn(
                  'px-5 py-4',
                  row.id === focusId && 'bg-primary-soft/40 ring-1 ring-inset ring-primary/40',
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[14px] font-medium">{row.reason}</p>
                      <Badge variant={STATUS_TONE[row.status]}>
                        {ASSET_ISSUE_STATUS_LABELS[row.status]}
                      </Badge>
                    </div>
                    <p className="text-[13px] text-muted-foreground">
                      <Link
                        to={`/assets/${encodeURIComponent(row.asset.id)}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {row.asset.name}
                      </Link>{' '}
                      <span className="font-mono text-[12px]">{row.asset.assetTag}</span>
                    </p>
                    <p className="text-[12.5px] text-muted-foreground">
                      Reported by {row.reportedByEmployee?.fullName ?? row.reportedBy?.fullName ?? 'unknown'}{' '}
                      · {formatDateTime(row.createdAt)}
                    </p>
                    {row.description ? (
                      <p className="whitespace-pre-wrap text-[13px]">{row.description}</p>
                    ) : null}
                    {row.status === 'RESOLVED' ? (
                      <p className="text-[12.5px] text-muted-foreground">
                        Resolved{row.resolvedBy ? ` by ${row.resolvedBy.fullName}` : ''}
                        {row.resolvedAt ? ` · ${formatDateTime(row.resolvedAt)}` : ''}
                        {row.resolutionNotes ? ` — ${row.resolutionNotes}` : ''}
                      </p>
                    ) : null}
                  </div>
                  {canResolve && row.status === 'OPEN' ? (
                    <Button size="sm" variant="outline" onClick={() => setResolving(row)}>
                      Resolve
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ResolveDialog row={resolving} onClose={() => setResolving(null)} />
    </>
  );
}

function ResolveDialog({ row, onClose }: { row: AssetIssueQueueItem | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [notes, setNotes] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!row) return;
    setNotes('');
    setError(null);
  }, [row]);

  const resolve = useMutation({
    mutationFn: () =>
      api.post<AssetIssueQueueItem>(`/assets/issues/${row?.id}/resolve`, {
        resolutionNotes: notes.trim(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['assets', 'issues'] });
      toast.success('Issue resolved.');
      onClose();
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });

  return (
    <Dialog open={row !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resolve issue</DialogTitle>
          <DialogDescription>
            {row ? `${row.asset.name} (${row.asset.assetTag}) — ${row.reason}` : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
          <FormField label="What was done" htmlFor="issue-resolution" required>
            <Textarea
              id="issue-resolution"
              rows={3}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={resolve.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => resolve.mutate()}
            disabled={resolve.isPending || notes.trim().length === 0}
          >
            {resolve.isPending ? 'Saving...' : 'Resolve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
