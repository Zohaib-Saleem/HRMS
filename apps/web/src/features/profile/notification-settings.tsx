import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellRing, BellOff, Monitor, Send } from 'lucide-react';
import {
  PUSH_CATEGORIES,
  PUSH_CATEGORY_LABELS,
  type PushCategory,
  type PushDeviceRecord,
  type PushSettingsRecord,
  type PushTestResult,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import {
  currentPushSubscription,
  disablePushHere,
  enablePush,
  pushPermission,
  pushSupport,
} from '@/lib/push';
import { formatRelative } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const SETTINGS_KEY = ['me', 'push'] as const;

/**
 * My Profile -> Notification Settings.
 *
 * Browser notifications are an extra, per-browser channel. Turning them off,
 * muting a category, or the browser refusing permission changes what appears
 * on this device's screen - never what appears in the bell, which keeps every
 * notification regardless.
 *
 * The permission prompt is raised only by the Enable button. A person who has
 * blocked it is shown how to undo that in the browser instead of being asked
 * again, because the page cannot ask again: only the browser's site settings
 * can.
 */
export function NotificationSettings() {
  const queryClient = useQueryClient();
  const support = React.useMemo(() => pushSupport(), []);
  const [permission, setPermission] = React.useState(() => pushPermission());
  const [endpoint, setEndpoint] = React.useState<string | null>(null);
  const [endpointKnown, setEndpointKnown] = React.useState(support !== 'supported');

  const readEndpoint = React.useCallback(async () => {
    try {
      const subscription = await currentPushSubscription();
      setEndpoint(subscription?.endpoint ?? null);
    } catch {
      setEndpoint(null);
    } finally {
      setEndpointKnown(true);
    }
  }, []);

  React.useEffect(() => {
    if (support === 'supported') void readEndpoint();
  }, [support, readEndpoint]);

  const settings = useQuery({
    queryKey: [...SETTINGS_KEY, endpoint],
    queryFn: () =>
      api.get<PushSettingsRecord>('/notifications/push', {
        query: endpoint ? { endpoint } : undefined,
      }),
    enabled: endpointKnown,
  });

  const refresh = async () => {
    setPermission(pushPermission());
    await readEndpoint();
    await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
  };

  /*
   * Not a mutation: Safari and Firefox show the permission prompt only while
   * the click is still the current user gesture, and a mutation runs its
   * function after awaits of its own. `enablePush` asks for permission before
   * it awaits anything, so it is called straight from the handler.
   */
  const [enabling, setEnabling] = React.useState(false);
  const handleEnable = () => {
    const key = settings.data?.publicKey;
    if (!key) return;
    setEnabling(true);
    enablePush(key)
      .then((result) => {
        if (result === 'granted') toast.success('Browser notifications are on for this browser.');
        else if (result === 'denied') toast.error('Notifications were blocked for this site.');
        else toast.message('No change - the browser prompt was dismissed.');
      })
      .catch((error: unknown) => toast.error(errorMessage(error)))
      .finally(() => {
        setEnabling(false);
        void refresh();
      });
  };

  const disable = useMutation({
    mutationFn: disablePushHere,
    onSuccess: async () => {
      toast.success('Browser notifications are off for this browser.');
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const test = useMutation({
    mutationFn: () => api.post<PushTestResult>('/notifications/push/test'),
    onSuccess: async (result) => {
      toast.success(
        `Test sent to ${result.queued} browser${result.queued === 1 ? '' : 's'}. It should appear within a few seconds.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      // Give the worker a moment, then show what the push service said.
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }), 4000);
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const disableDevice = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/push/devices/${encodeURIComponent(id)}/disable`),
    onSuccess: async () => {
      toast.success('That browser will no longer receive notifications.');
      await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const preferences = useMutation({
    mutationFn: (mutedCategories: PushCategory[]) =>
      api.put('/notifications/push/preferences', { mutedCategories }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }),
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const data = settings.data;
  const thisDevice = data?.devices.find((d) => d.isCurrent) ?? null;
  const enabledHere =
    permission === 'granted' && Boolean(endpoint) && thisDevice?.status === 'ACTIVE';
  const otherDevices = (data?.devices ?? []).filter((d) => !d.isCurrent);
  const anyActive = (data?.devices ?? []).some((d) => d.status === 'ACTIVE');
  const muted = new Set(data?.mutedCategories ?? []);

  const toggleCategory = (category: PushCategory, on: boolean) => {
    const next = new Set(muted);
    if (on) next.delete(category);
    else next.add(category);
    preferences.mutate(PUSH_CATEGORIES.filter((c) => next.has(c)));
  };

  const blocker = blockerMessage({ support, permission, configured: data?.configured ?? true });

  return (
    <Card>
      <CardHeader bordered>
        <CardTitle>Notification settings</CardTitle>
        <CardDescription>
          Get a notification on this computer or phone when something needs you - an approval, a
          case assigned to you, an asset issue - even when HRMS is not the tab you are looking at.
          Everything still appears in the bell either way.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        <dl className="grid gap-2 text-[13px] sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">Browser notifications</dt>
            <dd className="sm:mt-1">
              {enabledHere ? (
                <Badge variant="success">Enabled on this browser</Badge>
              ) : (
                <Badge>Disabled on this browser</Badge>
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">Permission</dt>
            <dd className="sm:mt-1">
              <PermissionBadge support={support} permission={permission} />
            </dd>
          </div>
          {thisDevice ? (
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Last delivery to this browser</dt>
              <dd className="mt-1">{deliveryLine(thisDevice)}</dd>
            </div>
          ) : null}
        </dl>

        {blocker ? (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[12.5px] text-muted-foreground">
            {blocker}
          </p>
        ) : null}

        {thisDevice?.status === 'EXPIRED' && permission === 'granted' ? (
          <p className="rounded-lg border border-border bg-warning-soft/40 px-3 py-2.5 text-[12.5px]">
            This browser&apos;s registration stopped working. Press Enable notifications to
            register it again.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {enabledHere ? (
            <Button
              variant="outline"
              size="sm"
              loading={disable.isPending}
              onClick={() => disable.mutate()}
            >
              <BellOff />
              Turn off on this browser
            </Button>
          ) : (
            <Button
              size="sm"
              loading={enabling}
              disabled={Boolean(blocker) || !data?.publicKey}
              onClick={handleEnable}
            >
              <BellRing />
              Enable notifications
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            loading={test.isPending}
            disabled={!anyActive || !data?.configured}
            onClick={() => test.mutate()}
          >
            <Send />
            Send test notification
          </Button>
        </div>

        <fieldset className="space-y-2 border-t border-border pt-4" disabled={preferences.isPending}>
          <legend className="mb-2 text-[13px] font-medium">Send browser notifications for</legend>
          {PUSH_CATEGORIES.map((category) => (
            <label key={category} className="flex items-center gap-2.5 text-[13px]">
              <input
                type="checkbox"
                className="size-4 rounded border-input accent-[var(--primary)]"
                checked={!muted.has(category)}
                onChange={(event) => toggleCategory(category, event.target.checked)}
              />
              {PUSH_CATEGORY_LABELS[category]}
            </label>
          ))}
          <p className="text-[12px] text-muted-foreground">
            Applies to every browser you have turned on. Unticking a category only stops the
            browser notification; it still appears in the bell.
          </p>
        </fieldset>
      </CardContent>

      {otherDevices.length > 0 ? (
        <CardFooter className="block p-0">
          <p className="px-5 pt-3 text-[12.5px] font-medium text-muted-foreground">Other browsers</p>
          <ul className="divide-y divide-border">
            {otherDevices.map((device) => (
              <li key={device.id} className="flex items-start gap-3 px-5 py-3">
                <Monitor className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[13px] font-medium">{device.label}</p>
                    <DeviceStatus status={device.status} />
                  </div>
                  <p className="truncate text-[12px] text-muted-foreground">{deliveryLine(device)}</p>
                </div>
                {device.status === 'ACTIVE' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={disableDevice.isPending && disableDevice.variables === device.id}
                    onClick={() => disableDevice.mutate(device.id)}
                  >
                    Turn off
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** Why the Enable button cannot work here, in words a person can act on. */
export function blockerMessage(input: {
  support: ReturnType<typeof pushSupport>;
  permission: NotificationPermission | null;
  configured: boolean;
}): string | null {
  if (!input.configured) {
    return 'Browser notifications have not been set up on this server yet. You will still see everything in the bell.';
  }
  switch (input.support) {
    case 'insecure':
      return 'Browser notifications need a secure (https) connection. Open HRMS at its https address to turn them on.';
    case 'ios-needs-install':
      return 'On iPhone and iPad, notifications work only from the Home Screen app: open HRMS in Safari, tap Share, then Add to Home Screen, and open it from there (iOS 16.4 or later).';
    case 'unsupported':
      return 'This browser does not support web notifications. Use a current Chrome, Edge, Firefox or Safari - or keep an eye on the bell.';
    default:
      break;
  }
  if (input.permission === 'denied') {
    return 'Notifications are blocked for this site in your browser. To allow them, click the icon to the left of the address bar, open site settings, set Notifications to Allow, then reload this page.';
  }
  return null;
}

function PermissionBadge({
  support,
  permission,
}: {
  support: ReturnType<typeof pushSupport>;
  permission: NotificationPermission | null;
}) {
  if (support !== 'supported' || permission === null) return <Badge>Not available</Badge>;
  if (permission === 'granted') return <Badge variant="success">Allowed</Badge>;
  if (permission === 'denied') return <Badge variant="destructive">Blocked</Badge>;
  return <Badge>Not asked yet</Badge>;
}

function DeviceStatus({ status }: { status: PushDeviceRecord['status'] }) {
  if (status === 'ACTIVE') return <Badge variant="success">On</Badge>;
  if (status === 'EXPIRED') return <Badge variant="warning">Expired</Badge>;
  return <Badge>Off</Badge>;
}

/** "Delivered 3 minutes ago" or "Failed 1 hour ago (410)". */
function deliveryLine(device: PushDeviceRecord): string {
  const success = device.lastSuccessAt ? new Date(device.lastSuccessAt).getTime() : 0;
  const failure = device.lastFailureAt ? new Date(device.lastFailureAt).getTime() : 0;
  if (!success && !failure) return `Registered ${formatRelative(device.createdAt)}; nothing sent yet.`;
  if (success >= failure) return `Accepted by the push service ${formatRelative(device.lastSuccessAt!)}.`;
  return `Last attempt failed ${formatRelative(device.lastFailureAt!)}${device.lastErrorCode ? ` (${device.lastErrorCode})` : ''}.`;
}
