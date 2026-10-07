import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  APPROVAL_STATUS_LABELS,
  type LeaveConflictCancellationResult,
  type LeaveRequestRecord,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { useSession } from '@/features/auth/session-context';
import { formatDate } from '@/lib/utils';
import { LEAVE_STATUS_TONE } from './my-leave-page';

const days = (n: number) => `${n % 1 === 0 ? n : n.toFixed(1)}`;

/** `09:05 AM` on the company's clock. */
function clock(iso: string, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

type StatusRow = Pick<
  LeaveRequestRecord,
  'status' | 'cancelledBySystem' | 'cancellationReason' | 'reversedDays' | 'reversals'
> &
  Partial<
    Pick<
      LeaveRequestRecord,
      | 'id'
      | 'employeeName'
      | 'leaveTypeName'
      | 'startDate'
      | 'endDate'
      | 'attendanceConflicts'
      | 'canResolveConflict'
    >
  >;

/**
 * A leave request's status, and why it changed when it was changed for the
 * employee rather than by them.
 *
 * Attendance reconciliation gives back approved leave on days the person was
 * at work; a Super Admin can do the same by hand. When every day is given back
 * the request is cancelled, and it must not read like a withdrawal the
 * employee made: the badge says who did it and the reason sits under it. When
 * only some days are given back, the request stays approved and says which.
 *
 * An APPROVED request with attendance still on one of its days says so, and
 * offers a Super Admin "Cancel leave".
 */
export function LeaveStatusCell({ row }: { row: StatusRow }) {
  const reversals = row.reversals ?? [];
  const conflicts = row.attendanceConflicts ?? [];
  const partial = row.status === 'APPROVED' && reversals.length > 0;
  const allManual = reversals.length > 0 && reversals.every((r) => r.manual);
  const cancelledByAdmin =
    row.status === 'CANCELLED' && !row.cancelledBySystem && allManual && Boolean(row.cancellationReason);
  const { session } = useSession();
  const timeZone = session?.company.timezone;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={LEAVE_STATUS_TONE[row.status]}>{APPROVAL_STATUS_LABELS[row.status]}</Badge>
        {row.cancelledBySystem ? <Badge variant="primary">Automatic</Badge> : null}
        {cancelledByAdmin ? <Badge variant="primary">Super Admin</Badge> : null}
      </div>
      {(row.cancelledBySystem || cancelledByAdmin) && row.cancellationReason ? (
        <p className="max-w-[28ch] text-[12px] leading-snug text-muted-foreground">
          {row.cancellationReason}
        </p>
      ) : null}
      {partial ? (
        <p className="max-w-[28ch] text-[12px] leading-snug text-muted-foreground">
          {days(row.reversedDays)} day{row.reversedDays === 1 ? '' : 's'} returned
          {allManual ? ' by a Super Admin' : reversals.some((r) => r.manual) ? '' : ' automatically'}:
          attendance was recorded on {reversals.map((r) => formatDate(r.date)).join(', ')}.
        </p>
      ) : null}
      {row.status === 'APPROVED' && conflicts.length > 0 ? (
        <p className="max-w-[30ch] text-[12px] font-medium leading-snug text-warning-foreground">
          Attendance recorded on leave:{' '}
          {conflicts
            .map((c) => `${formatDate(c.date)} check-in ${clock(c.checkInAt, timeZone)}`)
            .join(', ')}
        </p>
      ) : null}
      {row.canResolveConflict && row.id ? (
        <CancelForAttendanceButton row={row as Required<StatusRow>} timeZone={timeZone} />
      ) : null}
    </div>
  );
}

/**
 * "Cancel this approved leave because the employee has attended work?"
 *
 * Shown only when the server says the caller may (`canResolveConflict`, which
 * needs `leave.conflict.resolve`), and the endpoint checks that grant again.
 * Confirming gives the attended days back; the request and the attendance are
 * both kept. Clicking it twice restores nothing twice - the server answers
 * `alreadyResolved`.
 */
function CancelForAttendanceButton({
  row,
  timeZone,
}: {
  row: Required<StatusRow>;
  timeZone: string | undefined;
}) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const cancel = useMutation({
    mutationFn: () =>
      api.post<LeaveConflictCancellationResult>(`/leave-requests/${row.id}/cancel-for-attendance`, {}),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['leave'] });
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      toast.success(
        result.alreadyResolved
          ? 'Already resolved - nothing was restored twice.'
          : `Leave cancelled. ${days(result.restoredDays)} day${result.restoredDays === 1 ? '' : 's'} restored to the balance.`,
      );
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const ask = async () => {
    const ok = await confirm({
      title: 'Cancel this approved leave because the employee has attended work?',
      description: (
        <span className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[13px] text-foreground">
          <span className="text-muted-foreground">Employee</span>
          <span>{row.employeeName}</span>
          <span className="text-muted-foreground">Leave type</span>
          <span>{row.leaveTypeName}</span>
          <span className="text-muted-foreground">Leave date</span>
          <span>
            {formatDate(row.startDate)}
            {row.endDate !== row.startDate ? ` – ${formatDate(row.endDate)}` : ''}
          </span>
          <span className="text-muted-foreground">Attendance</span>
          <span>
            {row.attendanceConflicts
              .map(
                (c) =>
                  `${formatDate(c.date)}: in ${clock(c.checkInAt, timeZone)}${
                    c.checkOutAt ? `, out ${clock(c.checkOutAt, timeZone)}` : ''
                  }`,
              )
              .join('; ')}
          </span>
        </span>
      ),
      confirmLabel: 'Cancel Leave',
      cancelLabel: 'Keep Leave',
      tone: 'destructive',
    });
    if (ok) cancel.mutate();
  };

  return (
    <Button
      size="sm"
      variant="outline"
      className="mt-1 text-destructive"
      loading={cancel.isPending}
      onClick={() => void ask()}
    >
      Cancel Leave
    </Button>
  );
}
