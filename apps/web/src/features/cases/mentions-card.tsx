import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Lock } from 'lucide-react';
import { CASE_STATUS_LABELS, PERMISSIONS, type CaseMentionFeed } from '@hrms/shared';
import { api } from '@/lib/api';
import { cn, formatRelative } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import { CASE_STATUS_TONE } from './case-shared';

/**
 * Mentions & follow-ups: the case messages somebody tagged the reader in.
 *
 * A tag is a request for the reader's attention, not an assignment, so this
 * lives beside "My Assigned Cases" rather than inside it - and a resolved case
 * stays listed, because "please process the approved reimbursement" is written
 * precisely after the case has been settled.
 *
 * A row opens the case through the link the server worked out from what the
 * reader can open NOW, and marks its notification read on the way, as the bell
 * does. A row the reader can no longer open keeps its reference and loses its
 * subject, preview and link.
 *
 * Renders itself away until the reader has been tagged at least once, so the
 * dashboards of the many people nobody has tagged do not grow an empty card.
 */
const POLL = 60_000;

export function MentionsCard() {
  const { has } = usePermissions();
  const queryClient = useQueryClient();
  const allowed =
    has(PERMISSIONS.CASE_READ_OWN) ||
    has(PERMISSIONS.CASE_READ_DEPARTMENT) ||
    has(PERMISSIONS.CASE_READ_ALL);

  const feed = useQuery({
    queryKey: ['cases', 'mentions'],
    queryFn: () => api.get<CaseMentionFeed>('/cases/mentions', { query: { limit: 8 } }),
    enabled: allowed,
    refetchInterval: POLL,
    retry: false,
  });

  if (!allowed) return null;
  if (feed.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Mentions &amp; Follow-ups</CardTitle>
        </CardHeader>
        <ErrorState error={feed.error} onRetry={() => void feed.refetch()} />
      </Card>
    );
  }

  const items = Array.isArray(feed.data?.items) ? feed.data.items : [];
  if (items.length === 0) return null;
  const unread = typeof feed.data?.unread === 'number' ? feed.data.unread : 0;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <AtSign className="size-4" aria-hidden /> Mentions &amp; Follow-ups
          <Badge variant={unread > 0 ? 'warning' : 'neutral'} aria-label={`${unread} unread`}>
            {unread}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border rounded-md border border-border" aria-label="Mentions">
          {items.map((item) => {
            const unreadRow = item.readAt === null;
            const markRead = () => {
              if (!unreadRow || !item.notificationId) return;
              void api
                .post(`/notifications/${encodeURIComponent(item.notificationId)}/read`)
                .then(() => queryClient.invalidateQueries({ queryKey: ['notifications'] }))
                .then(() => queryClient.invalidateQueries({ queryKey: ['cases', 'mentions'] }))
                .catch(() => undefined);
            };
            const body = (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="flex min-w-0 items-center gap-2">
                    {unreadRow ? (
                      <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />
                    ) : null}
                    <span className="font-medium">{item.caseNumber}</span>
                    {item.caseSubject ? (
                      <span className="truncate text-muted-foreground">{item.caseSubject}</span>
                    ) : null}
                    <Badge variant={CASE_STATUS_TONE[item.caseStatus]}>
                      {CASE_STATUS_LABELS[item.caseStatus]}
                    </Badge>
                  </span>
                  <span className="whitespace-nowrap text-muted-foreground">
                    {formatRelative(item.createdAt)}
                  </span>
                </div>
                <p className="mt-0.5 text-muted-foreground">
                  <span className="text-foreground">{item.mentionedByName ?? 'Somebody'}</span>{' '}
                  {item.preview ? (
                    <>mentioned you: “{item.preview}”</>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <Lock className="size-3" aria-hidden /> mentioned you on a case you can no
                      longer open.
                    </span>
                  )}
                </p>
              </>
            );
            return (
              <li key={item.id} className={cn('text-[12.5px]', unreadRow && 'bg-primary-soft/30')}>
                {item.link ? (
                  <Link to={item.link} onClick={markRead} className="block px-3 py-2 hover:bg-accent/50">
                    {body}
                  </Link>
                ) : (
                  <div className="px-3 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
