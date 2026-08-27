import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Popover from '@radix-ui/react-popover';
import { Bell, CheckCheck, Inbox } from 'lucide-react';
import { toast } from 'sonner';
import type { NotificationRecord } from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { formatRelative } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/states';
import { cn } from '@/lib/utils';

const UNREAD_KEY = ['notifications', 'unread-count'] as const;
const LIST_KEY = ['notifications', 'list'] as const;

/**
 * Notification bell and dropdown.
 *
 * The unread count polls on a slow interval rather than opening a socket -
 * enough for a badge, and it costs one small query per minute.
 */
export function NotificationCenter() {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const unread = useQuery({
    queryKey: UNREAD_KEY,
    queryFn: () => api.get<{ count: number }>('/notifications/unread-count'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const list = useQuery({
    queryKey: LIST_KEY,
    queryFn: () =>
      api.getPage<NotificationRecord>('/notifications', { query: { page: 1, limit: 12 } }),
    // Only fetch the list once the panel is actually opened.
    enabled: open,
  });

  const refresh = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: UNREAD_KEY });
    await queryClient.invalidateQueries({ queryKey: LIST_KEY });
  }, [queryClient]);

  const markOne = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: refresh,
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const markAll = useMutation({
    mutationFn: () => api.post<{ updated: number }>('/notifications/read-all'),
    onSuccess: async (result) => {
      toast.success(
        result.updated > 0
          ? `Marked ${result.updated} notification${result.updated === 1 ? '' : 's'} as read.`
          : 'Nothing unread.',
      );
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const count = unread.data?.count ?? 0;
  const rows = list.data?.data ?? [];

  const openNotification = (item: NotificationRecord) => {
    if (!item.readAt) markOne.mutate(item.id);
    setOpen(false);
    if (item.entityType === 'ApprovalRequest' && item.entityId) {
      navigate(`/approvals/${item.entityId}`);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="relative grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
      >
        <Bell className="size-4.5" aria-hidden />
        {count > 0 ? (
          <span
            className="tabular absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground"
            aria-hidden
          >
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[22rem] rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-lg animate-in-fade"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <p className="text-[13.5px] font-semibold">Notifications</p>
            {count > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                loading={markAll.isPending}
                onClick={() => markAll.mutate()}
              >
                <CheckCheck />
                Mark all read
              </Button>
            ) : null}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {list.isLoading ? (
              <div className="space-y-3 p-4">
                {Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="space-y-1.5">
                    <Skeleton className="h-3.5 w-2/5" />
                    <Skeleton className="h-3 w-4/5" />
                  </div>
                ))}
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="Nothing yet"
                description="Approvals and system messages will appear here."
                className="py-10"
              />
            ) : (
              <ul className="divide-y divide-border">
                {rows.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => openNotification(item)}
                      className={cn(
                        'flex w-full gap-2.5 px-4 py-3 text-left transition-colors hover:bg-accent/50',
                        !item.readAt && 'bg-primary-soft/25',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-1.5 size-1.5 shrink-0 rounded-full',
                          item.readAt ? 'bg-transparent' : 'bg-primary',
                        )}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{item.title}</span>
                        <span className="block text-[12.5px] text-muted-foreground">
                          {item.message}
                        </span>
                        <span className="mt-0.5 block text-[11.5px] text-muted-foreground/80">
                          {formatRelative(item.createdAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-border p-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                setOpen(false);
                navigate('/approvals');
              }}
            >
              Go to approvals
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
