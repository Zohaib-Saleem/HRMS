import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Ban, Check, History, X } from 'lucide-react';
import {
  APPROVAL_STATUS_LABELS,
  APPROVAL_SUBJECT_LABELS,
  type ApprovalDetail,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative, humanise } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { cn } from '@/lib/utils';
import { APPROVAL_STATUS_TONE } from './approvals-list-page';

export function ApprovalDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [comment, setComment] = React.useState('');

  const query = useQuery({
    queryKey: ['approvals', id],
    queryFn: () => api.get<ApprovalDetail>(`/approvals/${id}`),
    enabled: id !== '',
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['approvals'] });
    await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    setComment('');
  };

  const act = useMutation({
    mutationFn: (action: 'approve' | 'reject' | 'cancel') =>
      api.post(`/approvals/${id}/${action}`, action === 'cancel' ? { reason: comment } : { comment }),
    onSuccess: async (_data, action) => {
      toast.success(
        action === 'approve' ? 'Request approved.' : action === 'reject' ? 'Request rejected.' : 'Request cancelled.',
      );
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  if (query.isLoading) return <DetailSkeleton />;

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const approval = query.data;
  if (!approval) {
    return (
      <Card>
        <EmptyState title="Request not found" description="It may have been removed." />
      </Card>
    );
  }

  const decide = async (action: 'approve' | 'reject' | 'cancel') => {
    const labels = {
      approve: { title: 'Approve this request?', confirm: 'Approve', tone: 'default' as const },
      reject: { title: 'Reject this request?', confirm: 'Reject', tone: 'destructive' as const },
      cancel: { title: 'Cancel this request?', confirm: 'Cancel request', tone: 'destructive' as const },
    }[action];

    const ok = await confirm({
      title: labels.title,
      description:
        action === 'cancel'
          ? 'The request is withdrawn and the decision history is kept.'
          : 'This is recorded in the approval history and cannot be undone.',
      confirmLabel: labels.confirm,
      tone: labels.tone,
    });
    if (ok) act.mutate(action);
  };

  return (
    <>
      <div className="mb-5">
        <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
          <Link to="/approvals">
            <ArrowLeft />
            Back to approvals
          </Link>
        </Button>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardContent className="py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold tracking-tight">{approval.title}</h2>
                    <Badge variant={APPROVAL_STATUS_TONE[approval.status]}>
                      {APPROVAL_STATUS_LABELS[approval.status]}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[13.5px] text-muted-foreground">
                    {APPROVAL_SUBJECT_LABELS[approval.subjectType]} · raised by{' '}
                    {approval.requesterName} · {formatRelative(approval.createdAt)}
                  </p>
                  {approval.summary ? (
                    <p className="mt-3 text-[13.5px]">{approval.summary}</p>
                  ) : null}
                </div>
              </div>
            </CardContent>
          </Card>

          {approval.canDecide || approval.canCancel ? (
            <Card>
              <CardHeader bordered>
                <CardTitle>Your decision</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  rows={3}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Add a comment (optional)"
                  aria-label="Decision comment"
                />
                <div className="flex flex-wrap gap-2">
                  {approval.canDecide ? (
                    <>
                      <Button loading={act.isPending} onClick={() => void decide('approve')}>
                        <Check />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        className="text-destructive"
                        loading={act.isPending}
                        onClick={() => void decide('reject')}
                      >
                        <X />
                        Reject
                      </Button>
                    </>
                  ) : null}
                  {approval.canCancel ? (
                    <Button
                      variant="ghost"
                      loading={act.isPending}
                      onClick={() => void decide('cancel')}
                    >
                      <Ban />
                      Cancel request
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader bordered>
              <CardTitle className="flex items-center gap-2">
                <History className="size-4 text-muted-foreground" aria-hidden />
                History
              </CardTitle>
            </CardHeader>
            {approval.events.length === 0 ? (
              <EmptyState title="No history yet" className="py-8" />
            ) : (
              <ul className="divide-y divide-border">
                {approval.events.map((event) => (
                  <li key={event.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-[13.5px] font-medium">{humanise(event.action)}</p>
                      <p className="text-[12px] text-muted-foreground">
                        {formatDateTime(event.createdAt)}
                      </p>
                    </div>
                    <p className="text-[12.5px] text-muted-foreground">
                      {event.actorName ?? 'System'}
                      {event.fromStatus ? ` · ${event.fromStatus} → ${event.toStatus}` : ` · ${event.toStatus}`}
                    </p>
                    {event.comment ? (
                      <p className="mt-1 text-[13px]">{event.comment}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader bordered>
            <CardTitle>Approval chain</CardTitle>
          </CardHeader>
          <ol className="divide-y divide-border">
            {approval.steps.map((step) => {
              const isCurrent = approval.status === 'PENDING' && step.stepOrder === approval.currentStep;
              return (
                <li
                  key={step.id}
                  className={cn('flex items-start gap-3 px-5 py-3', isCurrent && 'bg-primary-soft/25')}
                >
                  <span
                    className={cn(
                      'tabular mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
                      step.status === 'APPROVED'
                        ? 'bg-success-soft text-success'
                        : step.status === 'REJECTED'
                          ? 'bg-destructive-soft text-destructive'
                          : isCurrent
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground',
                    )}
                    aria-hidden
                  >
                    {step.stepOrder}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">
                      {step.approverName ?? 'Unassigned'}
                    </p>
                    <p className="text-[12px] text-muted-foreground">
                      {APPROVAL_STATUS_LABELS[step.status]}
                      {step.decidedAt ? ` · ${formatRelative(step.decidedAt)}` : ''}
                    </p>
                    {step.comment ? (
                      <p className="mt-1 text-[12.5px] text-muted-foreground">{step.comment}</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>
      </div>
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardContent className="space-y-2 py-5">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-4 w-80" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-3 py-5">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-4 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardContent className="space-y-3 py-5">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
