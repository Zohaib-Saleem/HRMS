import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PencilLine } from 'lucide-react';
import {
  APPROVAL_STATUS_LABELS,
  ATTENDANCE_CORRECTION_ISSUE_LABELS,
  PERMISSIONS,
  type ApprovalStatus,
  type RegularizationRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { usePermissions, useSession } from '@/features/auth/session-context';
import { CorrectionRequestDialog } from './correction-request-dialog';

/**
 * "Is my attendance right, and did anyone act on what I raised?" - on the
 * dashboard, in one card.
 *
 * The full month and the full request history are on /attendance/my-corrections;
 * this is the few lines somebody actually checks on landing, plus the button
 * that starts a new request without going anywhere first.
 */

const TONE: Record<ApprovalStatus, 'neutral' | 'success' | 'warning' | 'destructive'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'destructive',
  CANCELLED: 'neutral',
};

export function MyCorrectionsCard() {
  const { has } = usePermissions();
  const { session } = useSession();
  const [requesting, setRequesting] = React.useState(false);

  const canRead = has(PERMISSIONS.ATTENDANCE_READ);
  const linked = Boolean(session?.user.employee);

  const query = useQuery({
    queryKey: ['attendance', 'regularizations', 'mine', 'dashboard'],
    queryFn: () =>
      api.getPage<RegularizationRecord>('/attendance/regularizations', {
        query: { view: 'mine', limit: 4 },
      }),
    enabled: canRead && linked,
    retry: false,
  });

  if (!canRead) return null;

  const rows = query.data?.data ?? [];

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <PencilLine className="size-4" aria-hidden /> Attendance corrections
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          {linked ? (
            <Button variant="outline" size="sm" onClick={() => setRequesting(true)}>
              Request a correction
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" asChild>
            <Link to="/attendance/my-corrections">Open</Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={PencilLine}
            title="Nothing to correct"
            description="If a day is wrong - a missing punch, the wrong time - ask for it to be corrected. It goes to your manager, and your attendance is unchanged until they approve it."
            action={
              linked ? (
                <Button variant="outline" size="sm" onClick={() => setRequesting(true)}>
                  Request a correction
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">
                    {formatDate(row.attendanceDate)}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {row.issueType
                        ? ATTENDANCE_CORRECTION_ISSUE_LABELS[row.issueType]
                        : 'Correction'}
                    </span>
                  </p>
                  <p className="truncate text-[12px] text-muted-foreground">
                    {row.decidedAt
                      ? (row.reviewerComment ?? `Decided by ${row.reviewerName ?? 'your manager'}`)
                      : row.reason}
                  </p>
                </div>
                <Badge variant={TONE[row.status]}>{APPROVAL_STATUS_LABELS[row.status]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <CorrectionRequestDialog open={requesting} onClose={() => setRequesting(false)} />
    </Card>
  );
}
