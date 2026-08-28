import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarClock, Fingerprint } from 'lucide-react';
import {
  ATTENDANCE_POLICY_SCOPE_LABELS,
  ATTENDANCE_STATUS_LABELS,
  PERMISSIONS,
  type AttendanceRecordItem,
  type EffectivePolicyView,
  type EmployeeDetail,
  type RawPunchRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import { AttendanceCalendar } from './attendance-calendar';
import { STATUS_TONE, minutesLabel, timeLabel } from './attendance-ui';

/**
 * One employee's attendance, reached from the team view.
 *
 * Everything here is scope-checked on the server: the calendar, the history and
 * the effective policy all refuse an employee the caller may not see, so the
 * route being guessable gives nothing away.
 */
export function TeamAttendanceDetailPage() {
  const { employeeId = '' } = useParams<{ employeeId: string }>();
  const { has } = usePermissions();
  const canSeePunches = has(PERMISSIONS.DEVICE_READ);

  const employee = useQuery({
    queryKey: ['employees', employeeId],
    queryFn: () => api.get<EmployeeDetail>(`/employees/${employeeId}`),
    enabled: Boolean(employeeId),
  });

  const policy = useQuery({
    queryKey: ['attendance-policies', 'effective', employeeId],
    queryFn: () =>
      api.get<EffectivePolicyView>('/attendance-policies/effective', {
        query: { employeeId },
      }),
    enabled: Boolean(employeeId),
    // A missing policy view must not blank the page; the rest still works.
    retry: false,
  });

  const history = useQuery({
    queryKey: ['attendance', 'detail', employeeId],
    queryFn: () =>
      api.getPage<AttendanceRecordItem>('/attendance', {
        query: { employeeId, limit: 30 },
      }),
    enabled: Boolean(employeeId),
  });

  /**
   * The raw evidence behind the calculated days above.
   *
   * Only fetched for people who may read device data; an ordinary attendance
   * viewer sees the calculation without the terminal log behind it.
   */
  const punches = useQuery({
    queryKey: ['punches', 'employee', employeeId],
    queryFn: () =>
      api.getPage<RawPunchRecord>('/attendance/punches', {
        query: { employeeId, limit: 50 },
      }),
    enabled: Boolean(employeeId) && canSeePunches,
    retry: false,
  });

  if (employee.isError) {
    return <ErrorState error={employee.error} onRetry={() => void employee.refetch()} />;
  }

  const name = employee.data
    ? (employee.data.displayName ?? `${employee.data.firstName} ${employee.data.lastName}`)
    : '';
  const rows = history.data?.data ?? [];

  return (
    <>
      <PageHeader
        title={employee.isLoading ? 'Attendance' : name}
        description="Attendance for one person, with the policy that decides how their days are scored."
        actions={
          <Button size="sm" variant="outline" asChild>
            <Link to="/attendance/team">
              <ArrowLeft />
              Back to team
            </Link>
          </Button>
        }
      />

      <Card className="mb-6">
        <CardHeader bordered>
          <CardTitle>Policy in force today</CardTitle>
        </CardHeader>
        <CardContent className="py-4">
          {policy.isLoading ? (
            <Skeleton className="h-5 w-72" />
          ) : policy.isError || !policy.data ? (
            <p className="text-[13px] text-muted-foreground">
              The effective policy could not be loaded.
            </p>
          ) : (
            <div className="tabular flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted-foreground">
              <Badge variant={policy.data.policyName ? 'primary' : 'neutral'}>
                {policy.data.policyName ?? 'Company baseline'}
              </Badge>
              {policy.data.scope ? (
                <span>applied at {ATTENDANCE_POLICY_SCOPE_LABELS[policy.data.scope].toLowerCase()} level</span>
              ) : (
                <span>no override applies</span>
              )}
              <span>
                grace <span className="font-medium text-foreground">{policy.data.graceMinutes}m</span>
              </span>
              <span>
                half day from{' '}
                <span className="font-medium text-foreground">{policy.data.halfDayMinutes}m</span>
              </span>
              <span>
                full day from{' '}
                <span className="font-medium text-foreground">{policy.data.fullDayMinutes}m</span>
              </span>
              <span>
                overtime{' '}
                <span className="font-medium text-foreground">
                  {policy.data.overtimeEnabled ? `after ${policy.data.overtimeAfterMinutes}m` : 'off'}
                </span>
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <AttendanceCalendar employeeId={employeeId} />

      <Card className="overflow-hidden">
        <CardHeader bordered>
          <CardTitle>Recorded days</CardTitle>
        </CardHeader>
        {history.isError ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} />
        ) : (
          <TableWrapper>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH className="w-36">Date</TH>
                  <TH className="w-28">Check in</TH>
                  <TH className="w-28">Check out</TH>
                  <TH className="w-28 text-right">Worked</TH>
                  <TH className="w-28 text-right">Overtime</TH>
                  <TH className="w-32">Late / early</TH>
                  <TH className="w-28">Status</TH>
                  <TH className="w-24">Source</TH>
                </TR>
              </THead>
              <TBody>
                {history.isLoading ? (
                  <TableSkeleton rows={6} columns={8} />
                ) : rows.length === 0 ? (
                  <TR className="hover:bg-transparent">
                    <TD colSpan={8} className="p-0">
                      <EmptyState
                        icon={CalendarClock}
                        title="Nothing recorded yet"
                        description="Days with no record still appear in the calendar above, classified as weekend, holiday, leave or absent."
                      />
                    </TD>
                  </TR>
                ) : (
                  rows.map((row) => (
                    <TR key={row.id}>
                      <TD className="tabular text-[13px]">{formatDate(row.date)}</TD>
                      <TD className="tabular text-[13px] text-muted-foreground">
                        {timeLabel(row.checkInAt)}
                      </TD>
                      <TD className="tabular text-[13px] text-muted-foreground">
                        {timeLabel(row.checkOutAt)}
                      </TD>
                      <TD className="tabular text-right text-[13px]">
                        {minutesLabel(row.workedMinutes)}
                      </TD>
                      <TD className="tabular text-right text-[13px]">
                        {row.overtimeMinutes ? (
                          <span className="text-success">{minutesLabel(row.overtimeMinutes)}</span>
                        ) : (
                          <span className="text-muted-foreground">--</span>
                        )}
                      </TD>
                      <TD className="tabular text-[12.5px]">
                        {row.lateMinutes || row.earlyLeaveMinutes ? (
                          <span className="text-warning-foreground">
                            {row.lateMinutes ? `${row.lateMinutes}m late` : ''}
                            {row.lateMinutes && row.earlyLeaveMinutes ? ' · ' : ''}
                            {row.earlyLeaveMinutes ? `${row.earlyLeaveMinutes}m early` : ''}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            {row.checkInAt ? 'On time' : '--'}
                          </span>
                        )}
                      </TD>
                      <TD>
                        <Badge variant={STATUS_TONE[row.status]}>
                          {ATTENDANCE_STATUS_LABELS[row.status]}
                        </Badge>
                      </TD>
                      <TD className="text-[12px] text-muted-foreground">{row.source}</TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </TableWrapper>
        )}
      </Card>

      {canSeePunches ? (
        <Card className="mt-6 overflow-hidden">
          <CardHeader bordered>
            <CardTitle>Raw device punches</CardTitle>
          </CardHeader>
          {punches.isError ? (
            <ErrorState error={punches.error} onRetry={() => void punches.refetch()} />
          ) : (
            <TableWrapper>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH className="w-36">Day</TH>
                    <TH className="w-32">Device time</TH>
                    <TH className="w-28">Direction</TH>
                    <TH>Device</TH>
                    <TH className="w-28">Verified by</TH>
                  </TR>
                </THead>
                <TBody>
                  {punches.isLoading ? (
                    <TableSkeleton rows={4} columns={5} />
                  ) : (punches.data?.data ?? []).length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={5} className="p-0">
                        <EmptyState
                          icon={Fingerprint}
                          title="No device punches"
                          description="This person's attendance has not come from a terminal. Manual check-ins and corrections are shown in the table above."
                        />
                      </TD>
                    </TR>
                  ) : (
                    (punches.data?.data ?? []).map((row) => (
                      <TR key={row.id}>
                        <TD className="tabular text-[13px]">{formatDate(row.localDayKey)}</TD>
                        <TD
                          className="tabular text-[13px] text-muted-foreground"
                          title={`Reported "${row.rawTimestamp}" in ${row.deviceTimeZone}`}
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
                        <TD className="text-[13px] text-muted-foreground">{row.deviceName}</TD>
                        <TD className="text-[12px] text-muted-foreground">{row.verifyMode ?? '--'}</TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>
          )}
        </Card>
      ) : null}
    </>
  );
}
