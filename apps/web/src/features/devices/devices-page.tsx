import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Cpu,
  History,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  Users,
  XCircle,
} from 'lucide-react';
import {
  DEVICE_PROTOCOLS,
  DEVICE_PROTOCOL_LABELS,
  DEVICE_STATUS_LABELS,
  PERMISSIONS,
  PUNCH_PAIRINGS,
  PUNCH_PAIRING_LABELS,
  SYNC_STATUS_LABELS,
  deviceInputSchema,
  type DeviceInput,
  type DeviceRecord,
  type DeviceStatus,
  type DeviceSyncOutcome,
  type DeviceSyncRecord,
  type DeviceTestResult,
  type DeviceUserRecord,
  type SyncStatus,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { formatDate } from '@/lib/utils';
import { usePermissions } from '@/features/auth/session-context';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect } from '@/components/ui/field';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Attendance terminals.
 *
 * Status here always reflects something that actually happened: a device shows
 * as connected because a socket was opened and the terminal answered, never
 * because a row exists. "Never synced" is its own state for exactly that
 * reason.
 */

const STATUS_TONE: Record<DeviceStatus, 'success' | 'destructive' | 'warning' | 'neutral'> = {
  ONLINE: 'success',
  OFFLINE: 'destructive',
  ERROR: 'destructive',
  UNKNOWN: 'neutral',
};

const SYNC_TONE: Record<SyncStatus, 'success' | 'destructive' | 'warning' | 'neutral'> = {
  SUCCESS: 'success',
  PARTIAL: 'warning',
  FAILED: 'destructive',
  RUNNING: 'neutral',
};

/** A short, commonly used set. Any IANA zone is accepted by the server. */
const TIMEZONES = [
  'Asia/Karachi',
  'UTC',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
];

const when = (iso: string | null) =>
  iso ? `${formatDate(iso)} ${new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : 'Never';

export function DevicesPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.DEVICE_MANAGE);
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [editing, setEditing] = React.useState<DeviceRecord | 'new' | null>(null);
  const [historyFor, setHistoryFor] = React.useState<DeviceRecord | null>(null);
  const [usersFor, setUsersFor] = React.useState<DeviceRecord | null>(null);
  const [testResult, setTestResult] = React.useState<{ device: string; result: DeviceTestResult } | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const query = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.getPage<DeviceRecord>('/attendance/devices', { query: { limit: 100 } }),
    placeholderData: keepPreviousData,
    // A sync started elsewhere should appear without a manual refresh.
    refetchInterval: 30_000,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['devices'] });
    await queryClient.invalidateQueries({ queryKey: ['attendance'] });
    await queryClient.invalidateQueries({ queryKey: ['punches'] });
  };

  const test = useMutation({
    mutationFn: (device: DeviceRecord) =>
      api.post<DeviceTestResult>(`/attendance/devices/${device.id}/test`, {}).then((r) => ({ device, r })),
    onMutate: (device) => setBusyId(device.id),
    onSettled: () => setBusyId(null),
    onSuccess: async ({ device, r }) => {
      setTestResult({ device: device.name, result: r });
      if (r.reachable) toast.success(`${device.name} answered in ${r.latencyMs}ms.`);
      else toast.error(`${device.name} could not be reached.`);
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const sync = useMutation({
    mutationFn: (device: DeviceRecord) =>
      api.post<DeviceSyncOutcome>(`/attendance/devices/${device.id}/sync`, {}),
    onMutate: (device) => setBusyId(device.id),
    onSettled: () => setBusyId(null),
    onSuccess: async (outcome) => {
      if (outcome.status === 'FAILED') {
        toast.error(`Sync failed: ${outcome.error}`);
      } else {
        toast.success(
          `Fetched ${outcome.fetched}, imported ${outcome.inserted}, ${outcome.duplicates} duplicate${outcome.unmapped ? `, ${outcome.unmapped} unmapped` : ''}.`,
        );
      }
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const toggle = useMutation({
    mutationFn: (device: DeviceRecord) =>
      api.patch(`/attendance/devices/${device.id}`, {
        name: device.name,
        protocol: device.protocol,
        host: device.host,
        port: device.port,
        serialNumber: device.serialNumber,
        timeZone: device.timeZone,
        locationId: device.locationId,
        isEnabled: !device.isEnabled,
        syncIntervalMinutes: device.syncIntervalMinutes,
        punchPairing: device.punchPairing,
      }),
    onSuccess: async () => {
      toast.success('Device updated.');
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/attendance/devices/${id}`),
    onSuccess: async () => {
      toast.success('Device removed.');
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const rows = query.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Attendance devices"
        description="Biometric terminals that report punches to the HRMS. Punches are raw evidence; the attendance policy still decides what each day is worth."
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus />
              Add device
            </Button>
          ) : null
        }
      />

      <Card className="overflow-hidden">
        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <TableWrapper>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Device</TH>
                  <TH className="w-28">Status</TH>
                  <TH className="w-44">Address</TH>
                  <TH className="w-40">Protocol</TH>
                  <TH className="w-36">Location</TH>
                  <TH className="w-40">Last sync</TH>
                  <TH className="w-40">Last punch</TH>
                  <TH className="w-64 text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {query.isLoading ? (
                  <TableSkeleton rows={3} columns={8} />
                ) : rows.length === 0 ? (
                  <TR className="hover:bg-transparent">
                    <TD colSpan={8} className="p-0">
                      <EmptyState
                        icon={Cpu}
                        title="No attendance devices"
                        description="Add a terminal with its IP address and timezone, then use Test connection to confirm the HRMS can reach it."
                      />
                    </TD>
                  </TR>
                ) : (
                  rows.map((row) => (
                    <TR key={row.id}>
                      <TD className="text-[13px]">
                        <span className="font-medium">{row.name}</span>
                        {!row.isEnabled ? (
                          <Badge variant="neutral" className="ml-2">Disabled</Badge>
                        ) : null}
                        {row.isSyncing ? (
                          <Badge variant="warning" className="ml-2">Syncing</Badge>
                        ) : null}
                        {row.serialNumber ? (
                          <span className="tabular block text-[11.5px] text-muted-foreground">
                            {row.serialNumber}
                          </span>
                        ) : null}
                      </TD>
                      <TD>
                        <Badge variant={STATUS_TONE[row.status]}>
                          {DEVICE_STATUS_LABELS[row.status]}
                        </Badge>
                        {row.lastError ? (
                          <span
                            className="mt-1 block max-w-44 truncate text-[11px] text-destructive"
                            title={row.lastError}
                          >
                            {row.lastError}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="tabular text-[13px] text-muted-foreground">
                        {row.host}:{row.port}
                      </TD>
                      <TD className="text-[12.5px] text-muted-foreground">
                        {DEVICE_PROTOCOL_LABELS[row.protocol]}
                        <span className="block text-[11.5px]">{row.timeZone}</span>
                      </TD>
                      <TD className="text-[13px] text-muted-foreground">
                        {row.locationName ?? '--'}
                      </TD>
                      <TD className="tabular text-[12.5px] text-muted-foreground">
                        {when(row.lastSyncAt)}
                      </TD>
                      <TD className="tabular text-[12.5px] text-muted-foreground">
                        {when(row.lastPunchAt)}
                      </TD>
                      <TD>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Open a real connection to the device"
                            loading={test.isPending && busyId === row.id}
                            onClick={() => test.mutate(row)}
                          >
                            <Plug />
                            Test
                          </Button>
                          {canManage ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={sync.isPending && busyId === row.id}
                              disabled={!row.isEnabled}
                              title={row.isEnabled ? 'Pull new transactions now' : 'Enable the device first'}
                              onClick={() => sync.mutate(row)}
                            >
                              <RefreshCw />
                              Sync
                            </Button>
                          ) : null}
                          <Button variant="ghost" size="icon-sm" aria-label="Sync history" onClick={() => setHistoryFor(row)}>
                            <History />
                          </Button>
                          <Button variant="ghost" size="icon-sm" aria-label="Device users" onClick={() => setUsersFor(row)}>
                            <Users />
                          </Button>
                          {canManage ? (
                            <>
                              <Button variant="ghost" size="sm" onClick={() => setEditing(row)}>
                                Edit
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Delete ${row.name}`}
                                onClick={async () => {
                                  const ok = await confirm({
                                    title: `Remove "${row.name}"?`,
                                    description:
                                      'A device that has recorded punches cannot be removed - disable it instead, so the attendance evidence it produced is preserved.',
                                    confirmLabel: 'Remove',
                                    tone: 'destructive',
                                  });
                                  if (ok) remove.mutate(row.id);
                                }}
                              >
                                <Trash2 />
                              </Button>
                            </>
                          ) : null}
                        </div>
                        {canManage ? (
                          <div className="mt-1 flex justify-end">
                            <Button variant="ghost" size="sm" onClick={() => toggle.mutate(row)}>
                              {row.isEnabled ? 'Disable' : 'Enable'}
                            </Button>
                          </div>
                        ) : null}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </TableWrapper>
        )}
      </Card>

      <DeviceDrawer
        device={editing === 'new' ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />
      <SyncHistoryDrawer device={historyFor} onClose={() => setHistoryFor(null)} />
      <DeviceUsersDrawer device={usersFor} onClose={() => setUsersFor(null)} onSaved={refresh} />
      <TestResultDialog result={testResult} onClose={() => setTestResult(null)} />
    </>
  );
}

function TestResultDialog({
  result,
  onClose,
}: {
  result: { device: string; result: DeviceTestResult } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={result !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {result?.result.reachable ? (
              <CheckCircle2 className="size-4 text-success" aria-hidden />
            ) : (
              <XCircle className="size-4 text-destructive" aria-hidden />
            )}
            {result?.result.reachable ? 'Device answered' : 'Device unreachable'}
          </DialogTitle>
          <DialogDescription>{result?.device}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {result?.result.reachable ? (
            <dl className="tabular grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              <dt className="text-muted-foreground">Round trip</dt>
              <dd>{result.result.latencyMs}ms</dd>
              <dt className="text-muted-foreground">Serial number</dt>
              <dd>{result.result.serialNumber ?? '--'}</dd>
              <dt className="text-muted-foreground">Model</dt>
              <dd>{result.result.deviceName ?? '--'}</dd>
              <dt className="text-muted-foreground">Platform</dt>
              <dd>{result.result.platform ?? '--'}</dd>
              <dt className="text-muted-foreground">Enrolled users</dt>
              <dd>{result.result.userCount ?? '--'}</dd>
              <dt className="text-muted-foreground">Transactions held</dt>
              <dd>{result.result.transactionCount ?? '--'}</dd>
            </dl>
          ) : (
            <p className="text-[13px] text-muted-foreground">{result?.result.error}</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeviceDrawer({
  device,
  open,
  onClose,
  onSaved,
}: {
  device: DeviceRecord | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isEdit = device !== null;
  const { lookups } = useLookups();

  const { register, handleSubmit, formState, setError } = useForm<DeviceInput>({
    resolver: zodResolver(deviceInputSchema),
    values: device
      ? {
          name: device.name,
          protocol: device.protocol,
          host: device.host,
          port: device.port,
          serialNumber: device.serialNumber ?? '',
          timeZone: device.timeZone,
          locationId: device.locationId ?? '',
          isEnabled: device.isEnabled,
          syncIntervalMinutes: device.syncIntervalMinutes,
          punchPairing: device.punchPairing,
        }
      : {
          name: '',
          protocol: 'ZKTECO_TCP',
          host: '',
          port: 4370,
          serialNumber: '',
          timeZone: 'Asia/Karachi',
          locationId: '',
          isEnabled: true,
          syncIntervalMinutes: 15,
          punchPairing: 'FIRST_IN_LAST_OUT',
        },
  });

  const mutation = useMutation({
    mutationFn: (values: DeviceInput) => {
      const payload = {
        ...values,
        locationId: values.locationId || null,
        serialNumber: values.serialNumber || null,
        // An empty box means "leave the stored key alone", never "clear it".
        commKey: values.commKey ? values.commKey : undefined,
      };
      return isEdit
        ? api.patch(`/attendance/devices/${device.id}`, payload)
        : api.post('/attendance/devices', payload);
    },
    onSuccess: async () => {
      toast.success(isEdit ? 'Device updated.' : 'Device added.');
      await onSaved();
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof DeviceInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="md">
        <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="contents">
          <DialogHeader>
            <DialogTitle>{isEdit ? `Edit ${device.name}` : 'Add attendance device'}</DialogTitle>
            <DialogDescription>
              The timezone must match the clock on the terminal itself. Punches arrive as plain
              wall-clock readings, so an incorrect zone shifts every imported time.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <FormField label="Name" htmlFor="dev-name" error={formState.errors.name?.message} required className="sm:col-span-2">
              <Input {...register('name')} autoFocus placeholder="Main entrance" />
            </FormField>
            <FormField label="IP address or hostname" htmlFor="dev-host" error={formState.errors.host?.message} required>
              <Input {...register('host')} placeholder="192.168.1.201" className="tabular" />
            </FormField>
            <FormField label="Port" htmlFor="dev-port" error={formState.errors.port?.message} required hint="ZKTeco terminals default to 4370.">
              <Input type="number" {...register('port')} className="tabular" />
            </FormField>
            <FormField label="Protocol" htmlFor="dev-proto" error={formState.errors.protocol?.message} required>
              <NativeSelect {...register('protocol')}>
                {DEVICE_PROTOCOLS.map((p) => (
                  <option key={p} value={p}>{DEVICE_PROTOCOL_LABELS[p]}</option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Device timezone" htmlFor="dev-tz" error={formState.errors.timeZone?.message} required>
              <NativeSelect {...register('timeZone')}>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Serial number" htmlFor="dev-serial" error={formState.errors.serialNumber?.message} hint="Filled in automatically by Test connection.">
              <Input {...register('serialNumber')} className="tabular" />
            </FormField>
            <FormField label="Location" htmlFor="dev-loc" error={formState.errors.locationId?.message}>
              <NativeSelect {...register('locationId')}>
                <option value="">Not assigned</option>
                {lookups.locations?.map((l) => (
                  <option key={l.id} value={l.id}>{l.label}</option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Sync every (minutes)" htmlFor="dev-interval" error={formState.errors.syncIntervalMinutes?.message} required>
              <Input type="number" min={1} {...register('syncIntervalMinutes')} className="tabular" />
            </FormField>
            <FormField
              label="In / out detection"
              htmlFor="dev-pairing"
              error={formState.errors.punchPairing?.message}
              hint="Many terminals report no direction at all; first-in last-out is the safe default."
              className="sm:col-span-2"
            >
              <NativeSelect {...register('punchPairing')}>
                {PUNCH_PAIRINGS.map((p) => (
                  <option key={p} value={p}>{PUNCH_PAIRING_LABELS[p]}</option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField
              label="Comm key"
              htmlFor="dev-key"
              error={formState.errors.commKey?.message}
              hint={
                device?.hasCommKey
                  ? 'A key is stored. Leave blank to keep it; type a new one to replace it.'
                  : 'Only needed if the terminal has one set. Stored encrypted and never shown again.'
              }
              className="sm:col-span-2"
            >
              <Input type="password" {...register('commKey')} placeholder={device?.hasCommKey ? '••••••' : ''} />
            </FormField>
            <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px] sm:col-span-2">
              <input
                type="checkbox"
                {...register('isEnabled')}
                className="size-4 shrink-0 rounded border-input accent-[var(--primary)]"
              />
              Enabled — a disabled device is never contacted
            </label>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={mutation.isPending}>
              {isEdit ? 'Save device' : 'Add device'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SyncHistoryDrawer({ device, onClose }: { device: DeviceRecord | null; onClose: () => void }) {
  const query = useQuery({
    queryKey: ['devices', device?.id, 'sync-history'],
    queryFn: () =>
      api.getPage<DeviceSyncRecord>(`/attendance/devices/${device!.id}/sync-history`, {
        query: { limit: 50 },
      }),
    enabled: device !== null,
  });

  const rows = query.data?.data ?? [];

  return (
    <Dialog open={device !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="lg">
        <DialogHeader>
          <DialogTitle>Sync history</DialogTitle>
          <DialogDescription>{device?.name}</DialogDescription>
        </DialogHeader>
        <DialogBody className="p-0">
          {query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : (
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH className="w-44">Started</TH>
                    <TH className="w-28">Result</TH>
                    <TH className="w-20 text-right">Fetched</TH>
                    <TH className="w-20 text-right">New</TH>
                    <TH className="w-20 text-right">Dup</TH>
                    <TH className="w-24 text-right">Unmapped</TH>
                    <TH className="w-20 text-right">Failed</TH>
                    <TH className="w-24">Trigger</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={5} columns={8} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={8} className="p-0">
                        <EmptyState
                          icon={History}
                          title="Never synced"
                          description="Use Sync now on the device list, or wait for the scheduled interval."
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR key={row.id}>
                        <TD className="tabular text-[12.5px]">{when(row.startedAt)}</TD>
                        <TD>
                          <Badge variant={SYNC_TONE[row.status]}>{SYNC_STATUS_LABELS[row.status]}</Badge>
                          {row.error ? (
                            <span className="mt-1 block max-w-56 truncate text-[11px] text-destructive" title={row.error}>
                              {row.error}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="tabular text-right text-[13px]">{row.fetched}</TD>
                        <TD className="tabular text-right text-[13px]">{row.inserted}</TD>
                        <TD className="tabular text-right text-[13px] text-muted-foreground">{row.duplicates}</TD>
                        <TD className="tabular text-right text-[13px]">
                          {row.unmapped > 0 ? <span className="text-warning-foreground">{row.unmapped}</span> : 0}
                        </TD>
                        <TD className="tabular text-right text-[13px]">
                          {row.rejected > 0 ? <span className="text-destructive">{row.rejected}</span> : 0}
                        </TD>
                        <TD className="text-[12px] text-muted-foreground">{row.trigger}</TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeviceUsersDrawer({
  device,
  onClose,
  onSaved,
}: {
  device: DeviceRecord | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { lookups } = useLookups();
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.DEVICE_MANAGE);
  const queryClient = useQueryClient();
  const [pending, setPending] = React.useState<Record<string, string>>({});

  const query = useQuery({
    queryKey: ['devices', device?.id, 'users'],
    queryFn: () => api.get<DeviceUserRecord[]>(`/attendance/devices/${device!.id}/users`),
    enabled: device !== null,
    retry: false,
  });

  const map = useMutation({
    mutationFn: ({ deviceUserId, employeeId, name }: { deviceUserId: string; employeeId: string; name: string | null }) =>
      api.post<{ id: string; attributedPunches: number }>(
        `/attendance/devices/${device!.id}/mappings`,
        { deviceUserId, employeeId, deviceUserName: name },
      ),
    onSuccess: async (result) => {
      toast.success(
        result.attributedPunches > 0
          ? `Mapped, and ${result.attributedPunches} existing punch(es) attributed.`
          : 'Mapped.',
      );
      await queryClient.invalidateQueries({ queryKey: ['devices', device?.id, 'users'] });
      await onSaved();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const rows = query.data ?? [];

  return (
    <Dialog open={device !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="lg">
        <DialogHeader>
          <DialogTitle>Device users</DialogTitle>
          <DialogDescription>
            {device?.name} — who is enrolled on the terminal, and which employee each one is.
            Nothing here creates an employee; an unknown enrolment waits to be mapped.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="p-0">
          {query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : (
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH className="w-32">Device user</TH>
                    <TH className="w-44">Name on device</TH>
                    <TH>Employee</TH>
                    <TH className="w-28">State</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={4} columns={4} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={4} className="p-0">
                        <EmptyState
                          icon={Users}
                          title="No users read from the device"
                          description="The terminal may be unreachable, or no one is enrolled on it yet."
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR key={row.deviceUserId}>
                        <TD className="tabular text-[13px] font-medium">{row.deviceUserId}</TD>
                        <TD className="text-[13px] text-muted-foreground">{row.name ?? '--'}</TD>
                        <TD>
                          {canManage ? (
                            <NativeSelect
                              className="h-8 w-full max-w-56"
                              aria-label={`Employee for device user ${row.deviceUserId}`}
                              value={pending[row.deviceUserId] ?? row.employeeId ?? ''}
                              onChange={(e) => {
                                const employeeId = e.target.value;
                                setPending((prev) => ({ ...prev, [row.deviceUserId]: employeeId }));
                                if (employeeId) {
                                  map.mutate({ deviceUserId: row.deviceUserId, employeeId, name: row.name });
                                }
                              }}
                            >
                              <option value="">Not mapped</option>
                              {lookups.managers.map((o) => (
                                <option key={o.id} value={o.id}>{o.label}</option>
                              ))}
                            </NativeSelect>
                          ) : (
                            <span className="text-[13px]">{row.employeeName ?? 'Not mapped'}</span>
                          )}
                        </TD>
                        <TD>
                          {row.employeeInactive ? (
                            <Badge variant="destructive">Employee inactive</Badge>
                          ) : row.employeeId ? (
                            <Badge variant="success">Mapped</Badge>
                          ) : (
                            <Badge variant="warning">Unmapped</Badge>
                          )}
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
