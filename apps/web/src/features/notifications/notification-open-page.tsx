import * as React from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, Inbox } from 'lucide-react';
import type { NotificationRecord } from '@hrms/shared';
import { ApiError, api } from '@/lib/api';
import { formatRelative } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, FullPageLoader } from '@/components/feedback/states';
import { notificationLink } from './notification-center';

/**
 * Where a clicked browser push lands.
 *
 * The push carried only a notification id. This reads that notification back
 * from the signed-in person's own inbox - the server answers 404 for anybody
 * else's - and only then goes to the record it is about. The destination
 * screen does its own permission check as always, so a notification about
 * something the person can no longer open ends on that screen's no-access
 * state rather than on the record.
 *
 * Behind the sign-in like every other route: a click with no session goes to
 * the login page first and comes back here afterwards.
 */
export function NotificationOpenPage() {
  const { id = '' } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['notifications', 'one', id],
    queryFn: () => api.get<NotificationRecord>(`/notifications/${encodeURIComponent(id)}`),
    retry: false,
  });

  // Opening it is reading it, exactly as a click in the bell is.
  const record = query.data;
  React.useEffect(() => {
    if (!record || record.readAt) return;
    void api
      .post(`/notifications/${encodeURIComponent(record.id)}/read`)
      .then(() => queryClient.invalidateQueries({ queryKey: ['notifications'] }))
      .catch(() => undefined);
  }, [record, queryClient]);

  if (query.isLoading) return <FullPageLoader label="Opening notification" />;

  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <Card>
          <EmptyState
            icon={BellOff}
            title="This notification is not available"
            description="It may belong to a different account than the one signed in on this browser, or it no longer exists."
            action={
              <Button variant="outline" size="sm" asChild>
                <Link to="/">Back to dashboard</Link>
              </Button>
            }
          />
        </Card>
      );
    }
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  if (!record) return null;

  const link = notificationLink(record);
  if (link) return <Navigate to={link.to} replace />;

  // Nothing to open - show the notification itself.
  return (
    <Card>
      <EmptyState
        icon={Inbox}
        title={record.title}
        description={`${record.message} (${formatRelative(record.createdAt)})`}
        action={
          <Button variant="outline" size="sm" asChild>
            <Link to="/">Back to dashboard</Link>
          </Button>
        }
      />
    </Card>
  );
}
