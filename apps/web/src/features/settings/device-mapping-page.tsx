import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Fingerprint, History, Pencil, Plus, PowerOff } from 'lucide-react';
import {
  PERMISSIONS,
  type DeviceMappingHistoryEntry,
  type DeviceMappingRecord,
  type DeviceRecord,
  type EmployeeListItem,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { cn, formatDate } from '@/lib/utils';
import { usePermissions } from '@/features/auth/session-context';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/feedback/states';

/**
 * Settings -> Attendance -> Device User Mapping.
 *
 * One screen for the single most consequential setting in the attendance
 * module: which employee a terminal's PunchCode belongs to, and since when.
 *
 * Two things this screen is careful about, both enforced by the server and
 * both explained here rather than merely obeyed:
 *
 *   - The same PunchCode on the same device cannot belong to two people over
 *     the same dates. A takeover needs a start date and explicit consent, and
 *     closes the previous mapping the day before.
 *   - Nothing is deleted. Retiring a mapping deactivates it, so the punches it
 *     attributed still have something behind them explaining who they belong
 *     to and why.
 */

export function DeviceMappingPage() {
  const { has } = usePermissions();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const canManage = has(PERMISSIONS.DEVICE_MANAGE);

  const [search, setSearch] = React.useState('');
  const [deviceId, setDeviceId] = React.useState('');
  const [includeInactive, setIncludeInactive] = React.useState(false);
  const [editing, setEditing] = React.useState<DeviceMappingRecord | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [historyFor, setHistoryFor] = React.useState<DeviceMappingRecord | null>(null);

  const devices = useQuery({
    queryKey: ['devices', 'lookup'],
    queryFn: () => api.getPage<DeviceRecord>('/attendance/devices', { query: { limit: 100 } }),
    staleTime: 60_000,
  });

  const query = useQuery({
    queryKey: ['device-mappings', { deviceId, includeInactive }],
    queryFn: () =>
      api.get<{ data: DeviceMappingRecord[] }>('/attendance/mappings', {
        query: {
          deviceId: deviceId || undefined,
          includeInactive: includeInactive ? 'true' : undefined,
        },
      }),
  });

  const disable = useMutation({
    mutationFn: (mapping: DeviceMappingRecord) =>
      api.post(`/attendance/mappings/${mapping.id}/disable`, {}),
    onSuccess: async () => {
      toast.success('Mapping disabled', {
        description:
          'The punches it attributed keep the employee they had. Nothing was deleted and no attendance was recalculated.',
        duration: 7000,
      });
      await queryClient.invalidateQueries({ queryKey: ['device-mappings'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const term = search.trim().toLowerCase();
  const rows = (query.data?.data ?? []).filter((row) =>
    term === ''
      ? true
      : [row.deviceUserId, row.employeeName, row.employeeNumber, row.deviceName, row.deviceSerial]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term)),
  );

  return (
    <>
      <PageHeader
        title="Device user mapping"
        description="Which employee each terminal PunchCode belongs to, and over which dates."
      />

      <Card className="overflow-hidden">
        <ListToolbar
          search={search}
          onSearchChange={setSearch}
          placeholder="Search PunchCode, employee or device"
          hasActiveFilters={search !== '' || deviceId !== '' || includeInactive}
          onReset={() => {
            setSearch('');
            setDeviceId('');
            setIncludeInactive(false);
          }}
          filters={
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                aria-label="Device"
                className="xl:w-52"
              >
                <option value="">All devices</option>
                {(devices.data?.data ?? []).map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                  </option>
                ))}
              </NativeSelect>
              <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-[13px]">
                <input
                  type="checkbox"
                  className="size-4 rounded border-input accent-[var(--primary)]"
                  checked={includeInactive}
                  onChange={(e) => setIncludeInactive(e.target.checked)}
                />
                Show retired mappings
              </label>
            </div>
          }
          actions={
            canManage ? (
              <Button onClick={() => setCreating(true)}>
                <Plus className="size-4" aria-hidden />
                Add mapping
              </Button>
            ) : null
          }
        />

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <TableSkeleton rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Fingerprint}
            title="No mappings"
            description="A punch with no mapping has no employee, so it is never scored. Add one to attribute it."
          />
        ) : (
          <TableWrapper>
            <Table>
              <THead>
                <TR>
                  <TH>Device</TH>
                  <TH>Serial</TH>
                  <TH>PunchCode</TH>
                  <TH>Employee</TH>
                  <TH>Employee code</TH>
                  <TH>Effective from</TH>
                  <TH>Effective to</TH>
                  <TH>Punches</TH>
                  <TH>Status</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row.id}>
                    <TD className="font-medium">{row.deviceName}</TD>
                    <TD className="text-muted-foreground">{row.deviceSerial ?? '--'}</TD>
                    <TD className="font-mono text-[13px]">{row.deviceUserId}</TD>
                    <TD>{row.employeeName}</TD>
                    <TD className="text-muted-foreground">{row.employeeNumber}</TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {row.effectiveFrom ? formatDate(row.effectiveFrom) : 'From the beginning'}
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {row.effectiveTo ? formatDate(row.effectiveTo) : 'Still in force'}
                    </TD>
                    <TD className="tabular-nums">{row.punchCount}</TD>
                    <TD>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
                          !row.isActive
                            ? 'border-border text-muted-foreground'
                            : row.isCurrent
                              ? 'border-success/40 bg-success/10 text-success'
                              : 'border-border text-muted-foreground',
                        )}
                      >
                        {!row.isActive ? 'Retired' : row.isCurrent ? 'Active today' : 'Historical'}
                      </span>
                    </TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setHistoryFor(row)}
                          aria-label={`History for PunchCode ${row.deviceUserId}`}
                        >
                          <History className="size-4" aria-hidden />
                        </Button>
                        {canManage ? (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditing(row)}
                              aria-label={`Edit PunchCode ${row.deviceUserId}`}
                            >
                              <Pencil className="size-4" aria-hidden />
                            </Button>
                            {row.isActive ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Disable PunchCode ${row.deviceUserId}`}
                                onClick={async () => {
                                  const ok = await confirm({
                                    title: `Disable PunchCode ${row.deviceUserId}?`,
                                    confirmLabel: 'Disable mapping',
                                    description:
                                      'Punches from this PunchCode will stop being attributed to ' +
                                      `${row.employeeName}. The ${row.punchCount} punch(es) already attributed keep the ` +
                                      'employee they have, and nothing is deleted or recalculated.',
                                  });
                                  if (ok) disable.mutate(row);
                                }}
                              >
                                <PowerOff className="size-4" aria-hidden />
                              </Button>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrapper>
        )}
      </Card>

      <MappingDrawer
        open={creating || editing !== null}
        mapping={editing}
        devices={devices.data?.data ?? []}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />

      <HistoryDrawer mapping={historyFor} onClose={() => setHistoryFor(null)} />
    </>
  );
}

interface MappingForm {
  deviceId: string;
  deviceUserId: string;
  employeeId: string;
  deviceUserName: string;
  effectiveFrom: string;
  effectiveTo: string;
  notes: string;
  isActive: boolean;
}

function MappingDrawer({
  open,
  mapping,
  devices,
  onClose,
}: {
  open: boolean;
  mapping: DeviceMappingRecord | null;
  devices: DeviceRecord[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = mapping !== null;

  const [form, setForm] = React.useState<MappingForm>({
    deviceId: '',
    deviceUserId: '',
    employeeId: '',
    deviceUserName: '',
    effectiveFrom: '',
    effectiveTo: '',
    notes: '',
    isActive: true,
  });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  /** Set when the server names a conflict; consent is then explicit. */
  const [conflict, setConflict] = React.useState<string | null>(null);
  const [employeeSearch, setEmployeeSearch] = React.useState('');
  const debouncedEmployee = useDebounced(employeeSearch, 300);

  React.useEffect(() => {
    setErrors({});
    setConflict(null);
    setForm({
      deviceId: mapping?.deviceId ?? devices[0]?.id ?? '',
      deviceUserId: mapping?.deviceUserId ?? '',
      employeeId: mapping?.employeeId ?? '',
      deviceUserName: mapping?.deviceUserName ?? '',
      effectiveFrom: mapping?.effectiveFrom ?? '',
      effectiveTo: mapping?.effectiveTo ?? '',
      notes: mapping?.notes ?? '',
      isActive: mapping?.isActive ?? true,
    });
    setEmployeeSearch(mapping?.employeeName ?? '');
  }, [mapping, devices, open]);

  const employees = useQuery({
    queryKey: ['employees', 'mapping-picker', debouncedEmployee],
    queryFn: () =>
      // getPage, not get - see the note in the attendance reports picker.
      // `get` hands back the rows array, so `employees.data?.data` was always
      // undefined and this list was always empty.
      api.getPage<EmployeeListItem>('/employees', {
        query: { q: debouncedEmployee || undefined, limit: 20, status: 'ACTIVE' },
      }),
    enabled: open && !isEdit,
  });

  const save = useMutation({
    mutationFn: (closeConflicting: boolean) =>
      isEdit
        ? api.patch(`/attendance/mappings/${mapping.id}`, {
            isActive: form.isActive,
            effectiveFrom: form.effectiveFrom || null,
            effectiveTo: form.effectiveTo || null,
            deviceUserName: form.deviceUserName || null,
            notes: form.notes || null,
          })
        : api.post<{
            reattributedPunches: number;
            affectedDays: number;
            closedMappingId: string | null;
          }>('/attendance/mappings', {
            deviceId: form.deviceId,
            deviceUserId: form.deviceUserId,
            employeeId: form.employeeId,
            deviceUserName: form.deviceUserName || null,
            effectiveFrom: form.effectiveFrom || null,
            effectiveTo: form.effectiveTo || null,
            notes: form.notes || null,
            isActive: form.isActive,
            closeConflicting,
          }),
    onSuccess: async (result) => {
      const moved =
        result && typeof result === 'object' && 'reattributedPunches' in result
          ? (result as { reattributedPunches: number; affectedDays: number })
          : null;
      toast.success(isEdit ? 'Mapping updated.' : 'Mapping saved.', {
        description: moved && moved.reattributedPunches > 0
          ? `${moved.reattributedPunches} punch(es) over ${moved.affectedDays} day(s) now belong to this employee. Those days have not been rescored - reprocess them from the Device punches screen when you are ready.`
          : undefined,
        duration: 9000,
      });
      await queryClient.invalidateQueries({ queryKey: ['device-mappings'] });
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        setErrors(
          Object.fromEntries(
            Object.entries(error.details).map(([field, messages]) => [field, messages[0] ?? '']),
          ),
        );
        return;
      }
      // A 409 is the duplicate-PunchCode guard. It names who holds the code and
      // since when, so it is shown in full rather than reduced to "conflict".
      if (error instanceof ApiError && error.status === 409) {
        setConflict(error.message);
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  const canTakeOver = conflict !== null && form.effectiveFrom !== '';

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `PunchCode ${mapping.deviceUserId}` : 'Add device user mapping'}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'The PunchCode and the employee are fixed here. Moving a code to somebody else is a new mapping with its own start date, which is what keeps the old punches theirs.'
              : 'Attribute a terminal PunchCode to an employee.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="grid gap-4">
          {!isEdit ? (
            <>
              <FormField label="Device" htmlFor="mapping-device" required error={errors.deviceId}>
                <NativeSelect
                  value={form.deviceId}
                  onChange={(e) => setForm({ ...form, deviceId: e.target.value })}
                >
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name}
                      {device.serialNumber ? ` (${device.serialNumber})` : ''}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField
                label="PunchCode"
                htmlFor="mapping-code"
                required
                hint="The device user ID or PIN as the terminal reports it."
                error={errors.deviceUserId}
              >
                <Input
                  value={form.deviceUserId}
                  onChange={(e) => setForm({ ...form, deviceUserId: e.target.value })}
                />
              </FormField>

              <FormField
                label="Employee"
                htmlFor="mapping-employee-search"
                required
                error={errors.employeeId}
              >
                <Input
                  value={employeeSearch}
                  onChange={(e) => setEmployeeSearch(e.target.value)}
                  placeholder="Search by name or code"
                />
              </FormField>

              <div className="max-h-52 overflow-y-auto rounded-lg border border-border">
                {(employees.data?.data ?? []).map((employee) => (
                  <button
                    key={employee.id}
                    type="button"
                    onClick={() => setForm({ ...form, employeeId: employee.id })}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent/40',
                      form.employeeId === employee.id && 'bg-accent/60 font-medium',
                    )}
                  >
                    <span>{employee.fullName}</span>
                    <span className="text-xs text-muted-foreground">{employee.employeeNumber}</span>
                  </button>
                ))}
                {(employees.data?.data ?? []).length === 0 ? (
                  <p className="px-3 py-4 text-[13px] text-muted-foreground">
                    No matching employees.
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-border p-3 text-[13px]">
              <p>
                <span className="text-muted-foreground">Device</span>{' '}
                <span className="font-medium">{mapping.deviceName}</span>
              </p>
              <p>
                <span className="text-muted-foreground">Employee</span>{' '}
                <span className="font-medium">
                  {mapping.employeeName} ({mapping.employeeNumber})
                </span>
              </p>
              <p>
                <span className="text-muted-foreground">Punches attributed</span>{' '}
                <span className="font-medium tabular-nums">{mapping.punchCount}</span>
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Effective from"
              htmlFor="mapping-from"
              hint="Blank covers everything this code ever recorded."
              error={errors.effectiveFrom}
            >
              <Input
                type="date"
                value={form.effectiveFrom}
                onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
              />
            </FormField>
            <FormField
              label="Effective to"
              htmlFor="mapping-to"
              hint="Blank means still in force."
              error={errors.effectiveTo}
            >
              <Input
                type="date"
                value={form.effectiveTo}
                onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })}
              />
            </FormField>
          </div>

          <FormField label="Name on the device" htmlFor="mapping-name" error={errors.deviceUserName}>
            <Input
              value={form.deviceUserName}
              onChange={(e) => setForm({ ...form, deviceUserName: e.target.value })}
            />
          </FormField>

          <FormField label="Notes" htmlFor="mapping-notes" error={errors.notes}>
            <Input
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </FormField>

          <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
            <input
              type="checkbox"
              className="size-4 rounded border-input accent-[var(--primary)]"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            />
            Active
          </label>

          {conflict ? (
            <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-[13px]">
              <p>{conflict}</p>
              {canTakeOver ? (
                <p className="text-muted-foreground">
                  Confirming will close the other mapping the day before {form.effectiveFrom}.
                  Punches before that date keep the employee they have.
                </p>
              ) : null}
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {canTakeOver ? (
            <Button type="button" loading={save.isPending} onClick={() => save.mutate(true)}>
              Take the PunchCode over
            </Button>
          ) : (
            <Button type="button" loading={save.isPending} onClick={() => save.mutate(false)}>
              {isEdit ? 'Save changes' : 'Save mapping'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDrawer({
  mapping,
  onClose,
}: {
  mapping: DeviceMappingRecord | null;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ['device-mappings', 'history', mapping?.id],
    queryFn: () =>
      api.get<{ data: DeviceMappingHistoryEntry[] }>('/attendance/mappings/history', {
        query: { deviceId: mapping!.deviceId, deviceUserId: mapping!.deviceUserId },
      }),
    enabled: mapping !== null,
  });

  return (
    <Dialog open={mapping !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="md">
        <DialogHeader>
          <DialogTitle>
            {mapping ? `History for PunchCode ${mapping.deviceUserId}` : 'History'}
          </DialogTitle>
          <DialogDescription>
            Every change to this PunchCode on {mapping?.deviceName}, from the audit log.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : query.isLoading ? (
            <TableSkeleton rows={4} />
          ) : (query.data?.data ?? []).length === 0 ? (
            <EmptyState
              icon={History}
              title="No recorded changes"
              description="This mapping has not been changed since the audit trail began."
            />
          ) : (
            <ul className="space-y-2">
              {(query.data?.data ?? []).map((entry) => (
                <li key={entry.id} className="rounded-lg border border-border p-3 text-[13px]">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{entry.actorName ?? 'System'}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{entry.summary ?? entry.action}</p>
                  {entry.before || entry.after ? (
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                      {Object.keys({ ...entry.before, ...entry.after }).map((key) => (
                        <React.Fragment key={key}>
                          <dt className="text-muted-foreground">{key}</dt>
                          <dd>
                            {String(entry.before?.[key] ?? '--')} &rarr;{' '}
                            {String(entry.after?.[key] ?? '--')}
                          </dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
