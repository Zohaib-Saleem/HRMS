import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Fingerprint, RefreshCw } from 'lucide-react';
import {
  PERMISSIONS,
  type DeviceRecord,
  type RawPunchRecord,
  type ReprocessResult,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { formatDate } from '@/lib/utils';
import { usePermissions } from '@/features/auth/session-context';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';

/**
 * Raw device punches.
 *
 * The evidence behind every device-sourced attendance record, kept exactly as
 * the terminal reported it. An unmapped punch appears here rather than
 * disappearing, which is the point: it can be attributed later and the day
 * recalculated.
 */

const INITIAL = { q: '', deviceId: '', unmappedOnly: '', page: 1, limit: 20 };

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function PunchesPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.DEVICE_MANAGE);
  const queryClient = useQueryClient();
  const [filters, setFilters] = React.useState(INITIAL);
  const debounced = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.getPage<DeviceRecord>('/attendance/devices', { query: { limit: 100 } }),
  });

  const query = useQuery({
    queryKey: ['punches', { ...filters, q: debounced }],
    queryFn: () =>
      api.getPage<RawPunchRecord>('/attendance/punches', {
        query: {
          page: filters.page,
          limit: filters.limit,
          q: debounced || undefined,
          deviceId: filters.deviceId || undefined,
          unmappedOnly: filters.unmappedOnly || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const reprocess = useMutation({
    mutationFn: () =>
      api.post<ReprocessResult>('/attendance/punches/reprocess', {
        deviceId: filters.deviceId || undefined,
      }),
    onSuccess: async (result) => {
      toast.success(
        result.daysRecalculated > 0
          ? `Recalculated ${result.daysRecalculated} day(s) from ${result.punchesConsidered} punch(es).`
          : 'Nothing to reprocess - every mapped punch has already been scored.',
      );
      await queryClient.invalidateQueries({ queryKey: ['punches'] });
      await queryClient.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const rows = query.data?.data ?? [];
  const hasFilters = filters.q !== '' || filters.deviceId !== '' || filters.unmappedOnly !== '';

  return (
    <>
      <PageHeader
        title="Device punches"
        description="Every transaction a terminal reported, exactly as it reported it. Attendance is calculated from these and never writes back to them."
        actions={
          canManage ? (
            <Button
              size="sm"
              variant="outline"
              loading={reprocess.isPending}
              onClick={() => reprocess.mutate()}
              title="Recalculate attendance for punches that have an employee but have not been scored"
            >
              <RefreshCw />
              Reprocess
            </Button>
          ) : null
        }
      />

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search device user ID"
          hasActiveFilters={hasFilters}
          onReset={() => setFilters(INITIAL)}
          filters={
            <>
              <NativeSelect
                value={filters.deviceId}
                onChange={(e) => update({ deviceId: e.target.value })}
                aria-label="Filter by device"
                className="w-48"
              >
                <option value="">All devices</option>
                {(devices.data?.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </NativeSelect>
              <NativeSelect
                value={filters.unmappedOnly}
                onChange={(e) => update({ unmappedOnly: e.target.value })}
                aria-label="Filter by mapping"
                className="w-44"
              >
                <option value="">All punches</option>
                <option value="true">Unmapped only</option>
              </NativeSelect>
            </>
          }
        />

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH className="w-36">Local day</TH>
                    <TH className="w-32">Device time</TH>
                    <TH className="w-28">Direction</TH>
                    <TH className="w-28">Device user</TH>
                    <TH>Employee</TH>
                    <TH className="w-40">Device</TH>
                    <TH className="w-28">Verified by</TH>
                    <TH className="w-24">Scored</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={6} columns={8} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={8} className="p-0">
                        <EmptyState
                          icon={Fingerprint}
                          title={hasFilters ? 'No punches match those filters' : 'No device punches yet'}
                          description="Punches appear here once a terminal has been added and synced."
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR key={row.id}>
                        <TD className="tabular text-[13px]">{formatDate(row.localDayKey)}</TD>
                        <TD
                          className="tabular text-[13px] text-muted-foreground"
                          title={`Device reported "${row.rawTimestamp}" in ${row.deviceTimeZone}; stored as ${row.punchedAt}`}
                        >
                          {row.rawTimestamp.slice(11)}
                        </TD>
                        <TD className="text-[12.5px]">
                          {row.punchState ? (
                            <Badge variant={row.punchState.includes('IN') ? 'success' : 'neutral'}>
                              {row.punchState}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">Not reported</span>
                          )}
                        </TD>
                        <TD className="tabular text-[13px]">{row.deviceUserId}</TD>
                        <TD className="text-[13px]">
                          {row.employeeName ?? (
                            <Badge variant="warning">Unmapped</Badge>
                          )}
                        </TD>
                        <TD className="text-[12.5px] text-muted-foreground">{row.deviceName}</TD>
                        <TD className="text-[12px] text-muted-foreground">{row.verifyMode ?? '--'}</TD>
                        <TD className="text-[12px] text-muted-foreground">
                          {row.processedAt ? time(row.processedAt) : '--'}
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>

            {query.data ? (
              <Pagination
                meta={query.data.meta}
                disabled={query.isFetching}
                onPageChange={(page) => update({ page })}
                onLimitChange={(limit) => update({ limit })}
              />
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
