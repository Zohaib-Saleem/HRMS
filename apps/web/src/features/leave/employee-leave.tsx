import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarOff, ChevronLeft, ChevronRight, ExternalLink, Pencil } from 'lucide-react';
import {
  APPROVAL_STATUS_LABELS,
  LEAVE_DAY_PART_LABELS,
  PERMISSIONS,
  type LeaveBalanceRecord,
  type LeaveRequestRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { usePermissions } from '@/features/auth/session-context';
import { LEAVE_STATUS_TONE } from './my-leave-page';
import { LeaveStatusCell } from './leave-status-cell';
import { LeaveAdjustmentDialog } from './leave-adjustment-dialog';

/**
 * One employee's leave, for the Employee 360 profile.
 *
 * Two questions, answered from two existing endpoints and nothing else:
 * "what is this person entitled to and what is left?" from
 * `/leave/balances/employee/:id`, which is the same balance service every other
 * leave screen reads, and "when were they actually off?" from
 * `/leave/requests`.
 *
 * NO LEAVE DATE IS INVENTED HERE. The history lists the leave_requests rows
 * that exist and nothing more. Where a company's leave was tracked outside the
 * system before it was adopted - as a monthly count on a spreadsheet, say -
 * those months have no rows, and this table says so rather than reconstructing
 * dates that nobody recorded. The balance figures above it come from the leave
 * service; nothing on this screen adds up days of its own.
 *
 * The one thing HR can change here is the ADJUSTMENT column - the manual
 * correction the balance service already reads - behind `leave.manage`, which
 * Super Admin and HR Admin hold and nobody else does by default. Everything
 * else in the row is calculated and stays that way; the dialog says so.
 */
export function EmployeeLeave({
  employeeId,
  employeeName,
}: {
  employeeId: string;
  employeeName?: string;
}) {
  const { has } = usePermissions();
  const canRead = has(PERMISSIONS.LEAVE_READ);
  const canManage = has(PERMISSIONS.LEAVE_MANAGE);
  const [year, setYear] = React.useState(() => new Date().getUTCFullYear());
  const [adjusting, setAdjusting] = React.useState<LeaveBalanceRecord | null>(null);

  const balances = useQuery({
    queryKey: ['leave', 'balances', { employeeId, year }],
    queryFn: () =>
      api.get<LeaveBalanceRecord[]>(`/leave/balances/employee/${employeeId}`, {
        query: { year: String(year) },
      }),
    enabled: canRead && employeeId !== '',
  });

  // The whole history, not just the selected year: the year switcher above
  // belongs to the balances, which are kept per year. Leave taken is a list of
  // dates, and hiding last year's behind a control that looks like it filters
  // entitlement would make a request somebody remembers look deleted.
  const requests = useQuery({
    queryKey: ['leave', 'requests', { employeeId }],
    queryFn: () =>
      api.getPage<LeaveRequestRecord>('/leave/requests', {
        query: { employeeId, limit: 100 },
      }),
    enabled: canRead && employeeId !== '',
  });

  if (!canRead) return null;

  const rows = balances.data ?? [];
  const history = requests.data?.data ?? [];

  // Paid types only: leave without pay is an allowance, not an entitlement,
  // and adding it in made the totals read as paid leave the person did not have.
  const total = (pick: (b: LeaveBalanceRecord) => number) =>
    Math.round(rows.filter((b) => b.isPaid).reduce((sum, b) => sum + pick(b), 0) * 100) / 100;

  const counts = {
    APPROVED: history.filter((r) => r.status === 'APPROVED').length,
    PENDING: history.filter((r) => r.status === 'PENDING').length,
    REJECTED: history.filter((r) => r.status === 'REJECTED').length,
    CANCELLED: history.filter((r) => r.status === 'CANCELLED').length,
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          bordered
          className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <CardTitle className="text-base">Leave balance {year}</CardTitle>
          <div className="flex items-center gap-1 self-start sm:self-auto">
            {canManage && rows.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                className="mr-1"
                // Opens on the first paid type - Annual, in practice - with a
                // picker for the rest.
                onClick={() => setAdjusting(rows.find((r) => r.isPaid) ?? rows[0]!)}
              >
                <Pencil className="size-4" aria-hidden />
                Edit
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous year"
              onClick={() => setYear((y) => y - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next year"
              onClick={() => setYear((y) => y + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </CardHeader>

        {balances.isError ? (
          <ErrorState error={balances.error} onRetry={() => void balances.refetch()} />
        ) : balances.isLoading ? (
          <CardContent>
            <Skeleton className="h-32" />
          </CardContent>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={CalendarOff}
            title="No leave types configured"
            description="Entitlements appear here once leave types exist."
          />
        ) : (
          <CardContent className="p-0">
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Leave type</TH>
                    <TH className="text-right">Entitlement</TH>
                    <TH className="text-right">Opening</TH>
                    <TH className="text-right">Accrued</TH>
                    <TH className="text-right">Adjustment</TH>
                    <TH className="text-right">Used</TH>
                    <TH className="text-right">Pending</TH>
                    <TH className="text-right">Remaining</TH>
                    {canManage ? <TH className="w-px" /> : null}
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={row.leaveTypeId}>
                      <TD className="font-medium">
                        {row.leaveTypeName}
                        {row.isPaid ? null : (
                          <Badge variant="neutral" className="ml-2">
                            Unpaid
                          </Badge>
                        )}
                      </TD>
                      <TD
                        className="tabular text-right"
                        title={row.isPaid ? undefined : 'Unpaid: a cap on days of leave without pay, not paid entitlement'}
                      >
                        {days(row.annualEntitlementDays)}
                        {row.isPaid ? null : (
                          <span className="block text-[11px] font-normal text-muted-foreground">cap</span>
                        )}
                      </TD>
                      <TD className="tabular text-right text-muted-foreground">
                        {days(row.openingDays)}
                      </TD>
                      <TD className="tabular text-right text-muted-foreground">
                        {days(row.accruedDays)}
                      </TD>
                      {/* An administrative correction, positive or negative. Shown
                          in its own column rather than folded into the remaining
                          figure, so a balance nobody expects can be explained. */}
                      <TD
                        className="tabular text-right text-muted-foreground"
                        title={row.adjustmentNote ?? undefined}
                      >
                        {row.adjustmentDays === 0 ? '—' : signed(row.adjustmentDays)}
                        {row.adjustmentNote ? (
                          <span className="block max-w-[18ch] truncate text-[11px] font-normal">
                            {row.adjustmentNote}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="tabular text-right">{days(row.usedDays)}</TD>
                      <TD className="tabular text-right text-muted-foreground">
                        {days(row.pendingDays)}
                      </TD>
                      <TD className="tabular text-right font-medium">
                        {days(row.availableDays)}
                      </TD>
                      {canManage ? (
                        <TD className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Edit ${row.leaveTypeName} balance`}
                            onClick={() => setAdjusting(row)}
                          >
                            <Pencil className="size-4" aria-hidden />
                            Edit
                          </Button>
                        </TD>
                      ) : null}
                    </TR>
                  ))}
                  <TR className="bg-muted/40">
                    <TD className="font-medium">All paid types</TD>
                    <TD className="tabular text-right font-medium">
                      {days(total((b) => b.annualEntitlementDays))}
                    </TD>
                    <TD className="tabular text-right text-muted-foreground">
                      {days(total((b) => b.openingDays))}
                    </TD>
                    <TD className="tabular text-right text-muted-foreground">
                      {days(total((b) => b.accruedDays))}
                    </TD>
                    <TD className="tabular text-right text-muted-foreground">
                      {days(total((b) => b.adjustmentDays))}
                    </TD>
                    <TD className="tabular text-right font-medium">
                      {days(total((b) => b.usedDays))}
                    </TD>
                    <TD className="tabular text-right text-muted-foreground">
                      {days(total((b) => b.pendingDays))}
                    </TD>
                    <TD className="tabular text-right font-medium">
                      {days(total((b) => b.availableDays))}
                    </TD>
                    {canManage ? <TD /> : null}
                  </TR>
                </TBody>
              </Table>
            </TableWrapper>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader
          bordered
          className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between"
        >
          <CardTitle className="text-base">Leave requests</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            {(['APPROVED', 'PENDING', 'REJECTED', 'CANCELLED'] as const).map((status) =>
              counts[status] > 0 ? (
                <Badge key={status} variant={LEAVE_STATUS_TONE[status]}>
                  {counts[status]} {APPROVAL_STATUS_LABELS[status].toLowerCase()}
                </Badge>
              ) : null,
            )}
          </div>
        </CardHeader>

        {requests.isError ? (
          <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />
        ) : requests.isLoading ? (
          <CardContent>
            <Skeleton className="h-32" />
          </CardContent>
        ) : history.length === 0 ? (
          <EmptyState
            icon={CalendarOff}
            title="No leave requests on record"
            description="Only leave recorded in HRMS appears here. Leave taken before the system was in use, or tracked elsewhere, has no dates to show."
          />
        ) : (
          <CardContent className="p-0">
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Dates</TH>
                    <TH>Type</TH>
                    <TH className="text-right">Days</TH>
                    <TH>Part</TH>
                    <TH>Reason</TH>
                    <TH>Status</TH>
                    <TH>Decided</TH>
                    <TH>Document</TH>
                  </TR>
                </THead>
                <TBody>
                  {history.map((row) => (
                    <TR key={row.id}>
                      <TD className="whitespace-nowrap font-medium">
                        {row.startDate === row.endDate
                          ? formatDate(row.startDate)
                          : `${formatDate(row.startDate)} – ${formatDate(row.endDate)}`}
                      </TD>
                      <TD>
                        {row.leaveTypeName}
                        {row.isPaid ? null : (
                          <Badge variant="neutral" className="ml-2">
                            Unpaid
                          </Badge>
                        )}
                      </TD>
                      <TD className="tabular text-right">{days(row.totalDays)}</TD>
                      <TD className="text-muted-foreground">
                        {LEAVE_DAY_PART_LABELS[row.dayPart]}
                      </TD>
                      <TD className="max-w-[22ch] truncate" title={row.reason}>
                        {row.reason}
                      </TD>
                      <TD>
                        <LeaveStatusCell row={row} />
                      </TD>
                      <TD className="whitespace-nowrap text-muted-foreground">
                        {row.decidedAt ? formatDate(row.decidedAt) : '—'}
                      </TD>
                      <TD>
                        {row.documentUrl ? (
                          <a
                            href={row.documentUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                          >
                            {row.documentName ?? 'Open'}
                            <ExternalLink className="size-3.5" aria-hidden />
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrapper>
          </CardContent>
        )}
      </Card>

      {canManage ? (
        <LeaveAdjustmentDialog
          open={adjusting !== null}
          onClose={() => setAdjusting(null)}
          employeeId={employeeId}
          employeeName={employeeName}
          year={year}
          balance={adjusting}
          choices={rows}
          onChoose={setAdjusting}
        />
      ) : null}
    </div>
  );
}

const days = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');

const signed = (value: number) => (value > 0 ? `+${days(value)}` : days(value));
