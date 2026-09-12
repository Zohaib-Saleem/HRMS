import * as React from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarClock, CircleAlert, PencilLine } from 'lucide-react';
import {
  APPROVAL_STATUS_LABELS,
  ATTENDANCE_CORRECTION_ISSUE_LABELS,
  ATTENDANCE_STATUS_LABELS,
  DERIVED_ATTENDANCE_STATUS_LABELS,
  type ApprovalStatus,
  type AttendanceDay,
  type AttendanceTotals,
  type Paginated,
  type RegularizationRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/utils';
import { useAuthenticatedSession } from '@/features/auth/session-context';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { MonthNav } from './attendance-calendar';
import { CorrectionRequestDialog } from './correction-request-dialog';
import { LATE_TEXT, STATUS_BADGE, minutesLabel, timeLabel } from './attendance-ui';

/**
 * The employee's own corrections: their month, and what they have asked to
 * have changed about it.
 *
 * Both halves read endpoints that are already scoped to the caller by the
 * server - `/attendance/summary` and `/attendance/regularizations?view=mine` -
 * so this screen shows nothing an employee was not already entitled to see,
 * and a manager opening it sees their own month rather than their team's.
 *
 * The action lives on the ROW rather than only in the header. "Request a
 * correction" from a page header means retyping the date of the day you are
 * already looking at, and a date retyped from memory is a correction filed
 * against the wrong day.
 */

const APPROVAL_TONE: Record<ApprovalStatus, 'neutral' | 'success' | 'warning' | 'destructive'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'destructive',
  CANCELLED: 'neutral',
};

interface SummaryResponse {
  days: AttendanceDay[];
  totals: AttendanceTotals;
}

const monthLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

const weekdayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });

/**
 * Which days may be corrected.
 *
 * A day that has not happened cannot have gone wrong, and the endpoint refuses
 * one anyway - this only decides whether to offer the button. Weekends and
 * holidays stay eligible on purpose: working a holiday and having no punch for
 * it is exactly the case somebody needs to raise.
 */
export function isCorrectable(day: AttendanceDay, today: string): boolean {
  return day.status !== 'UPCOMING' && day.date <= today;
}

/** The employee's own correction requests. Reused on the dashboard. */
export function MyCorrectionRequests({
  limit = 20,
  paginated = true,
  onRequest,
}: {
  limit?: number;
  paginated?: boolean;
  /** Shown as an empty-state action when the employee has never raised one. */
  onRequest?: () => void;
}) {
  const [page, setPage] = React.useState(1);

  const query = useQuery({
    queryKey: ['attendance', 'regularizations', 'mine', page, limit],
    queryFn: () =>
      api.getPage<RegularizationRecord>('/attendance/regularizations', {
        query: { view: 'mine', page, limit },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];

  return (
    <Card className="overflow-hidden">
      <CardHeader bordered className="flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <PencilLine className="size-4" aria-hidden /> Your correction requests
        </CardTitle>
        {onRequest ? (
          <Button size="sm" variant="outline" onClick={onRequest}>
            Request a correction
          </Button>
        ) : null}
      </CardHeader>

      {query.isError ? (
        <CardContent>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </CardContent>
      ) : (
        <CardContent className="p-0">
          <TableWrapper>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH className="w-32">Attendance date</TH>
                  <TH className="w-40">Issue</TH>
                  <TH className="w-28">Check in</TH>
                  <TH className="w-28">Check out</TH>
                  <TH>Reason</TH>
                  <TH className="w-28">Status</TH>
                  <TH className="w-56">Decision</TH>
                  <TH className="w-32">Requested</TH>
                </TR>
              </THead>
              <TBody>
                {query.isLoading ? (
                  <TableSkeleton rows={4} columns={8} />
                ) : rows.length === 0 ? (
                  <TR className="hover:bg-transparent">
                    <TD colSpan={8} className="p-0">
                      <EmptyState
                        icon={PencilLine}
                        title="No corrections requested"
                        description="If a day is wrong - a missing punch, the wrong time - ask for it to be corrected and it goes to your manager for approval."
                        action={
                          onRequest ? (
                            <Button size="sm" variant="outline" onClick={onRequest}>
                              Request a correction
                            </Button>
                          ) : undefined
                        }
                      />
                    </TD>
                  </TR>
                ) : (
                  rows.map((row) => (
                    <TR key={row.id}>
                      <TD className="tabular text-[13px]">{formatDate(row.attendanceDate)}</TD>
                      <TD className="text-[12.5px]">
                        {row.issueType
                          ? ATTENDANCE_CORRECTION_ISSUE_LABELS[row.issueType]
                          : <span className="text-muted-foreground">--</span>}
                        {row.requestedStatus ? (
                          <span className="block text-[11.5px] text-muted-foreground">
                            Asking for {ATTENDANCE_STATUS_LABELS[row.requestedStatus]}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="tabular text-[13px] text-muted-foreground">
                        {timeLabel(row.requestedCheckInAt)}
                      </TD>
                      <TD className="tabular text-[13px] text-muted-foreground">
                        {timeLabel(row.requestedCheckOutAt)}
                      </TD>
                      <TD className="text-[12.5px]">{row.reason}</TD>
                      <TD>
                        <Badge variant={APPROVAL_TONE[row.status]}>
                          {APPROVAL_STATUS_LABELS[row.status]}
                        </Badge>
                      </TD>
                      <TD className="text-[12px] text-muted-foreground">
                        {row.decidedAt ? (
                          <>
                            <span className="block text-foreground">
                              {row.reviewerName ?? 'Reviewed'}
                            </span>
                            <span className="block">{formatDateTime(row.decidedAt)}</span>
                            {row.reviewerComment ? (
                              <span className="mt-0.5 block italic">"{row.reviewerComment}"</span>
                            ) : null}
                          </>
                        ) : (
                          'Waiting for a decision'
                        )}
                      </TD>
                      <TD className="text-[12px] text-muted-foreground">
                        {formatDate(row.createdAt)}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </TableWrapper>

          {paginated && query.data ? (
            <Pagination
              meta={(query.data as Paginated<RegularizationRecord>).meta}
              disabled={query.isFetching}
              onPageChange={setPage}
            />
          ) : null}
        </CardContent>
      )}
    </Card>
  );
}

/** The employee's own month, with a correction action on every eligible day. */
function MyAttendanceMonth({ onRequest }: { onRequest: (date: string) => void }) {
  const [month, setMonth] = React.useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });

  const from = month.toISOString().slice(0, 10);
  const to = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  // No employeeId: the endpoint answers for the caller, which is the whole
  // point of a self-service screen.
  const query = useQuery({
    queryKey: ['attendance', 'summary', 'me', from, to],
    queryFn: () => api.get<SummaryResponse>('/attendance/summary', { query: { from, to } }),
  });

  const days = query.data?.days ?? [];

  return (
    <Card className="mb-4 overflow-hidden">
      <CardHeader
        bordered
        className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="size-4" aria-hidden /> {monthLabel(month)}
        </CardTitle>
        <MonthNav
          className="self-start sm:self-auto"
          onShift={(delta) =>
            setMonth(
              (prev) => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + delta, 1)),
            )
          }
        />
      </CardHeader>

      {query.isError ? (
        <CardContent>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </CardContent>
      ) : (
        <CardContent className="p-0">
          <TableWrapper>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH className="w-28">Date</TH>
                  <TH className="w-16">Day</TH>
                  <TH className="w-24">Check in</TH>
                  <TH className="w-24">Check out</TH>
                  <TH className="w-24 text-right">Worked</TH>
                  <TH className="w-20 text-right">Late</TH>
                  <TH className="w-28">Status</TH>
                  <TH className="w-40 text-right">Correction</TH>
                </TR>
              </THead>
              <TBody>
                {query.isLoading ? (
                  <TableSkeleton rows={8} columns={8} />
                ) : days.length === 0 ? (
                  <TR className="hover:bg-transparent">
                    <TD colSpan={8} className="p-0">
                      <EmptyState
                        icon={CalendarClock}
                        title="Nothing in this month"
                        description="Step to another month with the arrows above."
                      />
                    </TD>
                  </TR>
                ) : (
                  days.map((day) => (
                    <TR key={day.date}>
                      <TD className="tabular text-[13px]">{day.date}</TD>
                      <TD className="text-[12.5px] text-muted-foreground">
                        {weekdayLabel(day.date)}
                      </TD>
                      <TD className="tabular text-[13px] text-muted-foreground">
                        {timeLabel(day.checkInAt)}
                      </TD>
                      <TD className="tabular text-[13px] text-muted-foreground">
                        {day.checkOutAt ? (
                          timeLabel(day.checkOutAt)
                        ) : (day.flags ?? []).includes('MISSING_PUNCH') ? (
                          <span className={LATE_TEXT}>Missing</span>
                        ) : (
                          '--'
                        )}
                      </TD>
                      <TD className="tabular text-right text-[13px]">
                        {minutesLabel(day.workedMinutes)}
                      </TD>
                      <TD className="tabular text-right text-[13px]">
                        {day.lateMinutes ? (
                          <span className={LATE_TEXT}>{day.lateMinutes}m</span>
                        ) : (
                          <span className="text-muted-foreground">--</span>
                        )}
                      </TD>
                      <TD>
                        <span className={STATUS_BADGE[day.status]}>
                          {DERIVED_ATTENDANCE_STATUS_LABELS[day.status] ?? day.status}
                        </span>
                      </TD>
                      <TD className="text-right">
                        {isCorrectable(day, today) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onRequest(day.date)}
                            aria-label={`Request correction for ${day.date}`}
                          >
                            <PencilLine className="size-3.5" aria-hidden />
                            Request correction
                          </Button>
                        ) : (
                          <span className="text-[12px] text-muted-foreground">--</span>
                        )}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </TableWrapper>
        </CardContent>
      )}
    </Card>
  );
}

/**
 * Gate in front of the page: a login with no employee record has no attendance
 * of its own and nothing to correct. Checked outside the page body so the
 * page's hooks are never conditionally skipped.
 */
export function MyCorrectionsPage() {
  const session = useAuthenticatedSession();

  if (!session.employeeLinked) {
    return (
      <>
        <PageHeader title="Attendance corrections" />
        <Card>
          <EmptyState
            icon={CircleAlert}
            title="Employee profile not configured"
            description="Your login is not linked to an employee record, so there is no attendance to correct. Ask an administrator to link your account."
            action={
              <Button variant="outline" size="sm" asChild>
                <Link to="/">Back to dashboard</Link>
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  return <MyCorrectionsPageInner />;
}

function MyCorrectionsPageInner() {
  const [requesting, setRequesting] = React.useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Attendance corrections"
        description="Your own attendance, and anything you have asked to have corrected. Nothing is changed until your manager approves it."
        actions={
          <Button size="sm" onClick={() => setRequesting('')}>
            <PencilLine className="size-4" aria-hidden />
            Request a correction
          </Button>
        }
      />

      <MyAttendanceMonth onRequest={setRequesting} />
      <MyCorrectionRequests onRequest={() => setRequesting('')} />

      <CorrectionRequestDialog
        open={requesting !== null}
        date={requesting || undefined}
        onClose={() => setRequesting(null)}
      />
    </>
  );
}
