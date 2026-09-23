import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ASSET_CONDITION_LABELS,
  EMPTY_MY_ASSETS,
  PERMISSIONS,
  type EmployeeAssetRow,
  type MyAssetsRecord,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField, Input, Textarea } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/features/auth/session-context';
import { assetDate } from './assets-shared';

/**
 * The employee's own assets, on their dashboard.
 *
 * Two questions and nothing else: what have I got, and is anything waiting on
 * me. The second is the whole reason this card exists - section 7 asks that
 * somebody issued a laptop be TOLD, and a notification they may never open is
 * not being told. An unacknowledged handover puts a block at the top of their
 * dashboard with the asset, its serial, its condition, what came with it, and
 * two buttons.
 *
 * Everything it can send is two sentences: "I have it", and "something is wrong
 * with it". Neither touches the asset - the endpoints behind them write to the
 * assignment row and to an incident record, and nothing in an employee's grant
 * reaches the `assets` table at all.
 *
 * The card renders itself away without `asset.read`, so a role that does not
 * hold it gets a shorter dashboard rather than a broken one.
 */

/**
 * How many issued items the card lists before it hands over to /assets.
 *
 * A dashboard card is a glance, and this one shares a row with lunch and cases:
 * an employee holding eight pieces of kit would otherwise set the height of
 * that whole row and push everything below it down the page. Three is what fits
 * beside a case card with its counts in it. The rest are not hidden - the
 * count in the header is the real total and the link goes to the full list,
 * which the server scopes to the reader's own assets.
 */
const LISTED = 3;

export function MyAssetsCard() {
  const { has } = usePermissions();
  const canRead = has(PERMISSIONS.ASSET_READ);
  const canAcknowledge = has(PERMISSIONS.ASSET_ACKNOWLEDGE);

  const [reporting, setReporting] = React.useState<EmployeeAssetRow | null>(null);

  const query = useQuery({
    queryKey: ['assets', 'mine'],
    queryFn: () => api.get<MyAssetsRecord>('/assets/my'),
    enabled: canRead,
    retry: false,
  });

  const queryClient = useQueryClient();

  const acknowledge = useMutation({
    mutationFn: (row: EmployeeAssetRow) =>
      api.post<unknown>(`/assets/assignments/${row.assignmentId}/acknowledge`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      toast.success('Thanks - that is recorded.');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (!canRead) return null;

  /*
   * Normalised rather than trusted. This card sits on a dashboard beside eight
   * others, and a dashboard that throws because one endpoint answered a shape
   * it did not expect takes every other card down with it. Each field falls
   * back to its empty value independently, so a partial answer renders as far
   * as it goes.
   */
  const answer = query.data;
  const data: MyAssetsRecord = {
    assigned: answer?.assigned ?? EMPTY_MY_ASSETS.assigned,
    awaitingAcknowledgement:
      answer?.awaitingAcknowledgement ?? EMPTY_MY_ASSETS.awaitingAcknowledgement,
    totalAssigned: answer?.totalAssigned ?? EMPTY_MY_ASSETS.totalAssigned,
  };

  /*
   * Listed, and what is left over. Sliced for DISPLAY only: `totalAssigned` in
   * the header is the server's own figure and is untouched by this.
   */
  const listed = data.assigned.slice(0, LISTED);
  const beyond = data.assigned.length - listed.length;

  return (
    <>
      {/* A column filling the height its dashboard row gives it - see
          `DashboardGrid`. */}
      <Card className="flex h-full flex-col">
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle>My assets</CardTitle>
          {data.totalAssigned > 0 ? (
            <Badge variant="neutral">{data.totalAssigned}</Badge>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-3">
          {query.isLoading ? (
            <>
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-36" />
            </>
          ) : query.isError ? (
            <p className="text-[13px] text-muted-foreground">
              Your assets could not be loaded just now.
            </p>
          ) : data.assigned.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              You have not been issued any company equipment.
            </p>
          ) : (
            <>
              {/* The prompt. Anything needing the employee's answer comes first
                  and looks different, because it is the only part of this card
                  that is asking rather than telling. */}
              {data.awaitingAcknowledgement.map((row) => (
                <div
                  key={row.assignmentId}
                  className="rounded-md border border-primary/40 bg-primary-soft px-3 py-3"
                >
                  <p className="text-[13.5px] font-medium text-primary">
                    You have received a company asset.
                  </p>
                  <p className="mt-1 text-[13px]">
                    {row.name} ({row.assetTag})
                  </p>
                  <dl className="mt-1 space-y-0.5 text-[12.5px] text-muted-foreground">
                    <div>Serial: {row.serialNumber ?? 'none'}</div>
                    <div>
                      Condition:{' '}
                      {row.conditionAtAssignment
                        ? ASSET_CONDITION_LABELS[row.conditionAtAssignment]
                        : 'not recorded'}
                    </div>
                    <div>
                      Accessories:{' '}
                      {row.accessoriesIssued.length > 0
                        ? row.accessoriesIssued.join(', ')
                        : 'none'}
                    </div>
                    <div>Assigned: {assetDate(row.assignedAt.slice(0, 10))}</div>
                  </dl>
                  {canAcknowledge ? (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={acknowledge.isPending}
                        onClick={() => acknowledge.mutate(row)}
                      >
                        Acknowledge
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setReporting(row)}>
                        Report issue
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}

              <ul className="space-y-2">
                {listed.map((row) => (
                  <li key={row.assignmentId} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-medium">{row.name}</p>
                      <p className="font-mono text-[11.5px] text-muted-foreground">
                        {row.assetTag}
                        {row.serialNumber ? ` · ${row.serialNumber}` : ''}
                      </p>
                      <p className="text-[12px] text-muted-foreground">
                        Assigned {assetDate(row.assignedAt.slice(0, 10))}
                        {row.conditionAtAssignment
                          ? ` · ${ASSET_CONDITION_LABELS[row.conditionAtAssignment]}`
                          : ''}
                      </p>
                    </div>
                    {row.acknowledgementStatus === 'ISSUE_REPORTED' ? (
                      <Badge variant="warning">Issue reported</Badge>
                    ) : row.acknowledgementStatus === 'ACKNOWLEDGED' ? (
                      <Badge variant="success">Confirmed</Badge>
                    ) : null}
                  </li>
                ))}
              </ul>

              {beyond > 0 ? (
                <Button variant="ghost" size="sm" className="-mx-2 self-start" asChild>
                  <Link to="/assets">View all {data.assigned.length} assets</Link>
                </Button>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <ReportIssueDialog row={reporting} onClose={() => setReporting(null)} />
    </>
  );
}

/**
 * "Something is wrong with it."
 *
 * Carries a heading and a description and nothing about the asset - no
 * condition, no status, no value. The employee reports what they see; somebody
 * holding `asset.update` decides what the register says.
 */
function ReportIssueDialog({
  row,
  onClose,
}: {
  row: EmployeeAssetRow | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!row) return;
    setReason('');
    setDescription('');
    setErrors({});
    setFormError(null);
  }, [row]);

  const report = useMutation({
    mutationFn: () =>
      api.post<unknown>(`/assets/assignments/${row?.assignmentId}/report-issue`, {
        reason: reason.trim(),
        description: description.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      toast.success('Reported. Somebody will look at it.');
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        setErrors(
          Object.fromEntries(
            Object.entries(error.details).map(([field, messages]) => [field, messages[0] ?? '']),
          ),
        );
        return;
      }
      setFormError(errorMessage(error));
    },
  });

  return (
    <Dialog open={row !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Report a problem</DialogTitle>
          <DialogDescription>
            {row ? `${row.name} (${row.assetTag})` : ''} — tell HR what is wrong. Nothing you write
            here changes the asset record.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {formError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-[13px] text-destructive">
              {formError}
            </p>
          ) : null}

          <FormField label="What is wrong" htmlFor="issue-reason" error={errors.reason} required>
            <Input
              id="issue-reason"
              value={reason}
              maxLength={200}
              placeholder="Charger does not work"
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>

          <FormField label="Details" htmlFor="issue-description" error={errors.description}>
            <Textarea
              id="issue-description"
              rows={3}
              value={description}
              maxLength={2000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </FormField>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={report.isPending}>
            Cancel
          </Button>
          <Button onClick={() => report.mutate()} disabled={report.isPending}>
            {report.isPending ? 'Sending...' : 'Report it'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
