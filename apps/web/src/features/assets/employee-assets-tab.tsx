import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Boxes, CheckCircle2, XCircle } from 'lucide-react';
import {
  ASSET_ACKNOWLEDGEMENT_STATUS_LABELS,
  ASSET_ASSIGNMENT_STATUS_LABELS,
  ASSET_CONDITION_LABELS,
  ASSET_STATUS_LABELS,
  type EmployeeAssetRow,
  type EmployeeAssetsRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useSession } from '@/features/auth/session-context';
import { ASSET_CONDITION_TONE, ASSET_STATUS_TONE, assetDate, assetMoney } from './assets-shared';

/**
 * The Assets tab on an employee's profile.
 *
 * Three blocks, in the order somebody actually asks about them: what has this
 * person got, what is it worth, and what have they had before. The clearance
 * block appears only for somebody on their way out, because for everybody else
 * it is a question nobody is asking.
 *
 * WHO CAN OPEN IT is not this component's decision. `GET /employees/:id/assets`
 * is gated on `asset.read` and narrowed by the caller's existing DATA SCOPE, so
 * an employee on an OWN scope reaches exactly their own record and is refused
 * every other - the same machinery every other employee-shaped endpoint uses.
 * A 403 here renders as an error state rather than as an empty list, which is
 * the honest difference between "you may not see this" and "there is nothing".
 */

function AssetRows({ rows, history }: { rows: EmployeeAssetRow[]; history: boolean }) {
  return (
    <TableWrapper>
      <Table>
        <THead>
          <TR>
            <TH>Asset</TH>
            <TH>Serial</TH>
            <TH>Assigned</TH>
            {history ? <TH>Returned</TH> : null}
            <TH>Condition</TH>
            {history ? <TH>Outcome</TH> : <TH>Acknowledged</TH>}
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => (
            <TR key={row.assignmentId}>
              <TD className="text-[13px]">
                <Link to={`/assets/${row.assetId}`} className="font-medium hover:underline">
                  {row.name}
                </Link>
                <span className="block font-mono text-[11.5px] text-muted-foreground">
                  {row.assetTag}
                  {row.categoryName ? ` · ${row.categoryName}` : ''}
                </span>
              </TD>
              <TD className="font-mono text-[12px]">
                {row.serialNumber ?? <span className="font-sans text-muted-foreground">--</span>}
              </TD>
              <TD className="tabular whitespace-nowrap text-[13px]">
                {assetDate(row.assignedAt.slice(0, 10))}
              </TD>
              {history ? (
                <TD className="tabular whitespace-nowrap text-[13px]">
                  {row.returnedAt ? assetDate(row.returnedAt.slice(0, 10)) : '--'}
                </TD>
              ) : null}
              <TD>
                {row.conditionAtReturn ?? row.conditionAtAssignment ? (
                  <Badge
                    variant={
                      ASSET_CONDITION_TONE[
                        (row.conditionAtReturn ?? row.conditionAtAssignment)!
                      ]
                    }
                  >
                    {ASSET_CONDITION_LABELS[(row.conditionAtReturn ?? row.conditionAtAssignment)!]}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">--</span>
                )}
              </TD>
              <TD className="text-[12.5px]">
                {history ? (
                  <>
                    {ASSET_ASSIGNMENT_STATUS_LABELS[row.assignmentStatus]}
                    {row.accessoriesMissing.length > 0 ? (
                      <span className="block text-destructive">
                        Missing: {row.accessoriesMissing.join(', ')}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <Badge
                    variant={
                      row.acknowledgementStatus === 'ACKNOWLEDGED'
                        ? 'success'
                        : row.acknowledgementStatus === 'ISSUE_REPORTED'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {ASSET_ACKNOWLEDGEMENT_STATUS_LABELS[row.acknowledgementStatus]}
                  </Badge>
                )}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableWrapper>
  );
}

export function EmployeeAssetsTab({ employeeId }: { employeeId: string }) {
  const { session } = useSession();
  const currency = session?.company.currency ?? 'USD';

  const query = useQuery({
    queryKey: ['employees', employeeId, 'assets'],
    queryFn: () => api.get<EmployeeAssetsRecord>(`/employees/${employeeId}/assets`),
    enabled: employeeId !== '',
    retry: false,
  });

  if (query.isLoading) {
    return (
      <Card className="space-y-3 p-5">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-full" />
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const data = query.data;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Assets assigned" value={data.totalAssigned} icon={Boxes} tone="primary" />
        <StatCard
          label="Current asset value"
          value={assetMoney(data.totalCurrentValue, currency)}
          icon={Boxes}
        />
      </div>

      {/*
        Clearance, and only for somebody on their way out. Counts, never
        actions: nothing on this screen marks an asset returned, because a
        clearance screen that could tick its own boxes would be a screen that
        says the laptop came back when it did not. HR records the real return
        from the asset itself.
      */}
      {data.clearance.applies ? (
        <Card>
          <CardHeader>
            <CardTitle>Asset clearance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-4 text-[13px]">
              <span>
                Assigned <strong className="tabular">{data.clearance.assigned}</strong>
              </span>
              <span>
                Returned <strong className="tabular">{data.clearance.returned}</strong>
              </span>
              <span className={data.clearance.pending > 0 ? 'text-destructive' : undefined}>
                Pending <strong className="tabular">{data.clearance.pending}</strong>
              </span>
              <span>
                Damaged <strong className="tabular">{data.clearance.damaged}</strong>
              </span>
              <span>
                Lost <strong className="tabular">{data.clearance.lost}</strong>
              </span>
            </div>

            <ul className="space-y-1.5">
              {data.assigned.map((row) => (
                <li key={row.assignmentId} className="flex items-center gap-2 text-[13px]">
                  <XCircle className="size-4 shrink-0 text-destructive" aria-hidden />
                  <span>
                    {row.name} ({row.assetTag}) pending
                  </span>
                  <Badge variant={ASSET_STATUS_TONE[row.assetStatus]}>
                    {ASSET_STATUS_LABELS[row.assetStatus]}
                  </Badge>
                </li>
              ))}
              {data.history
                .filter((row) => row.assignmentStatus === 'RETURNED')
                .map((row) => (
                  <li key={row.assignmentId} className="flex items-center gap-2 text-[13px]">
                    <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
                    <span>
                      {row.name} ({row.assetTag}) returned
                    </span>
                  </li>
                ))}
            </ul>

            {data.clearance.cleared ? (
              <p className="text-[13px] text-success">
                Nothing outstanding. Asset clearance is complete.
              </p>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                HR records each return from the asset itself. Nothing here marks one returned.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Assigned assets</CardTitle>
        </CardHeader>
        {data.assigned.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title="Nothing issued"
            description="This person is not holding any company equipment."
          />
        ) : (
          <AssetRows rows={data.assigned} history={false} />
        )}
      </Card>

      {data.history.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Asset history</CardTitle>
          </CardHeader>
          <AssetRows rows={data.history} history />
        </Card>
      ) : null}
    </div>
  );
}
