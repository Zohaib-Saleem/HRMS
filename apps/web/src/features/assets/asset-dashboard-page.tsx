import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Banknote,
  Boxes,
  CheckCircle2,
  FileSpreadsheet,
  HeartCrack,
  ShieldAlert,
  UserCheck,
  UserMinus,
  Wrench,
} from 'lucide-react';
import {
  ASSET_CLEARANCE_STATE_LABELS,
  ASSET_STATUS_LABELS,
  EMPTY_ASSET_DASHBOARD,
  type AssetAlertRow,
  type AssetBreakdownSlice,
  type AssetDashboard,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/field';
import { StatCard } from '@/components/ui/stat-card';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useSession } from '@/features/auth/session-context';
import { ASSET_STATUS_TONE, assetDate, assetMoney } from './assets-shared';
import { useAssetAccess } from './use-asset-data';

/**
 * The asset dashboard.
 *
 * ONE QUERY behind the whole screen, which is the server's decision and the
 * reason this file has a single `useQuery` in it: every figure here is a
 * question about the same rows asked at the same instant. Nine queries would
 * answer them at nine instants and produce a page whose tiles do not add up to
 * its own lists - and nothing on the screen would say so.
 *
 * THE ALERTS ARE THE POINT OF THE PAGE. The tiles above them are context; the
 * six alerts are the things that are somebody's problem today, and three of
 * them are links rather than lists. Under repair, lost and damaged are statuses
 * on the register, so the drill-down is the register with a filter applied
 * rather than a second copy of those rows kept in step here. The other three -
 * a warranty running out, an asset still out with somebody who has left, a
 * person on their way out still holding something - cannot be reached by
 * filtering a status, so they carry their rows.
 *
 * Nothing on this screen writes anything. It counts, it links, and the acting
 * is done on the asset's own page where the rules live.
 */

/** The windows somebody actually asks about. Days, echoed back by the server. */
const WARRANTY_WINDOWS = [30, 60, 90, 180] as const;

/** The most slices a breakdown shows before it stops being readable. */
const SLICE_LIMIT = 8;

/**
 * One row of a breakdown.
 *
 * The bar is proportional to the LARGEST slice rather than to the total, which
 * is the choice that keeps a long tail legible: against the total, six slices
 * of four percent are six invisible lines.
 */
function Slice({
  slice,
  max,
  currency,
}: {
  slice: AssetBreakdownSlice;
  max: number;
  currency: string;
}) {
  const width = max === 0 ? 0 : Math.max(2, Math.round((slice.count / max) * 100));

  return (
    <li className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[13px]">{slice.label}</span>
        <span className="tabular shrink-0 text-[13px] font-medium">{slice.count}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
        </div>
        <span className="tabular shrink-0 text-[11.5px] text-muted-foreground">
          {assetMoney(slice.currentValue, currency)}
        </span>
      </div>
    </li>
  );
}

function Breakdown({
  title,
  description,
  slices,
  currency,
}: {
  title: string;
  description: string;
  slices: AssetBreakdownSlice[];
  currency: string;
}) {
  const shown = slices.slice(0, SLICE_LIMIT);
  const max = shown.reduce((largest, slice) => Math.max(largest, slice.count), 0);
  const hidden = slices.length - shown.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">Nothing to show yet.</p>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {shown.map((slice) => (
                <Slice key={slice.key ?? '--'} slice={slice} max={max} currency={currency} />
              ))}
            </ul>
            {hidden > 0 ? (
              <p className="mt-3 text-[12px] text-muted-foreground">
                and {hidden} more — the register has the rest.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * How many days are left, in words a person reads.
 *
 * Computed by the SERVER against the company's calendar and only formatted
 * here. A browser in another timezone would otherwise say a warranty expires
 * tomorrow when the office's calendar says it expired yesterday.
 */
function daysLabel(days: number | null): { text: string; tone: 'warning' | 'destructive' | 'neutral' } {
  if (days === null) return { text: '--', tone: 'neutral' };
  if (days < 0) return { text: `${Math.abs(days)} days ago`, tone: 'destructive' };
  if (days === 0) return { text: 'Today', tone: 'destructive' };
  return { text: `in ${days} days`, tone: days <= 14 ? 'destructive' : 'warning' };
}

function AlertTable({
  rows,
  dateHeading,
  emptyTitle,
  emptyDescription,
}: {
  rows: AssetAlertRow[];
  dateHeading: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (rows.length === 0) {
    return <EmptyState icon={CheckCircle2} title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <TableWrapper>
      <Table>
        <THead>
          <TR>
            <TH>Asset</TH>
            <TH>Category</TH>
            <TH>Holder</TH>
            <TH>Status</TH>
            <TH>{dateHeading}</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => {
            const days = daysLabel(row.days);
            return (
              <TR key={row.id}>
                <TD className="text-[13.5px] font-medium">
                  <Link to={`/assets/${row.id}`} className="hover:underline">
                    {row.name}
                  </Link>
                  <span className="block font-mono text-[11.5px] font-normal text-muted-foreground">
                    {row.assetTag}
                  </span>
                </TD>
                <TD className="text-[13px]">
                  {row.categoryName ?? <span className="text-muted-foreground">--</span>}
                </TD>
                <TD className="text-[13px]">
                  {row.holderName ?? <span className="text-muted-foreground">Nobody</span>}
                </TD>
                <TD>
                  <Badge variant={ASSET_STATUS_TONE[row.status]}>
                    {ASSET_STATUS_LABELS[row.status]}
                  </Badge>
                </TD>
                <TD className="tabular whitespace-nowrap text-[13px]">
                  {assetDate(row.date)}
                  <span
                    className={
                      days.tone === 'destructive'
                        ? 'block text-[11.5px] text-destructive'
                        : 'block text-[11.5px] text-muted-foreground'
                    }
                  >
                    {days.text}
                  </span>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </TableWrapper>
  );
}

export function AssetDashboardPage() {
  const { session } = useSession();
  const currency = session?.company.currency ?? 'USD';
  const { canReport } = useAssetAccess();

  const [warrantyDays, setWarrantyDays] = React.useState<number>(30);

  const query = useQuery({
    queryKey: ['assets', 'dashboard', warrantyDays],
    queryFn: () =>
      api.get<AssetDashboard>('/assets/dashboard', { query: { warrantyDays } }),
  });

  const data = query.data ?? EMPTY_ASSET_DASHBOARD;
  const alerts = data.alerts;
  const loading = query.isLoading;

  return (
    <>
      <PageHeader
        title="Asset dashboard"
        description={
          data.asOf
            ? `What the company owns and what needs attention, as at ${assetDate(data.asOf)}.`
            : 'What the company owns and what needs attention.'
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {canReport ? (
              <Button variant="outline" size="sm" asChild>
                <Link to="/assets/reports">
                  <FileSpreadsheet className="size-4" aria-hidden /> Reports
                </Link>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" asChild>
              <Link to="/assets">
                <Boxes className="size-4" aria-hidden /> Register
              </Link>
            </Button>
          </div>
        }
      />

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total assets" value={data.total} icon={Boxes} loading={loading} />
            <StatCard
              label="Available"
              value={data.byStatus.AVAILABLE}
              icon={CheckCircle2}
              tone="success"
              hint="In stock and ready to hand out"
              loading={loading}
            />
            <StatCard
              label="Assigned"
              value={data.byStatus.ASSIGNED}
              icon={UserCheck}
              tone="primary"
              hint="Out with somebody"
              loading={loading}
            />
            <StatCard
              label="Current value"
              value={assetMoney(data.totalCurrentValue, currency)}
              icon={Banknote}
              hint={`${assetMoney(data.totalPurchaseValue, currency)} purchased`}
              loading={loading}
            />
          </div>

          {/*
              The six alerts. Three link to the register with a filter applied -
              they ARE a status, so a second copy of those rows here would be a
              second thing to keep in step. Three carry their rows below,
              because no status filter can reach them.
          */}
          <h2 className="mb-3 text-[15px] font-semibold">Needs attention</h2>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <StatCard
              label="Warranty expiring"
              value={alerts.warrantyExpiring}
              icon={ShieldAlert}
              tone={alerts.warrantyExpiring > 0 ? 'warning' : undefined}
              hint={`Within ${data.warrantyDays} days`}
              loading={loading}
            />
            <StatCard
              label="Under repair"
              value={alerts.underRepair}
              icon={Wrench}
              tone={alerts.underRepair > 0 ? 'warning' : undefined}
              hint="Away being fixed"
              to="/assets?status=UNDER_REPAIR"
              loading={loading}
            />
            <StatCard
              label="Damaged"
              value={alerts.damaged}
              icon={HeartCrack}
              tone={alerts.damaged > 0 ? 'warning' : undefined}
              hint="Reported broken"
              to="/assets?status=DAMAGED"
              loading={loading}
            />
            <StatCard
              label="Lost"
              value={alerts.lost}
              icon={AlertTriangle}
              tone={alerts.lost > 0 ? 'destructive' : undefined}
              hint="Unaccounted for"
              to="/assets?status=LOST"
              loading={loading}
            />
            <StatCard
              label="Not returned"
              value={alerts.notReturned}
              icon={UserMinus}
              tone={alerts.notReturned > 0 ? 'destructive' : undefined}
              hint="Still out with somebody who has left"
              loading={loading}
            />
            <StatCard
              label="Pending clearance"
              value={alerts.employeesPendingClearance}
              icon={UserMinus}
              tone={alerts.employeesPendingClearance > 0 ? 'warning' : undefined}
              hint="People leaving with something outstanding"
              loading={loading}
            />
          </div>

          <div className="mb-6 grid gap-4 xl:grid-cols-2">
            <Breakdown
              title="By category"
              description="Counts and what they are reckoned to be worth."
              slices={data.byCategory}
              currency={currency}
            />
            <Breakdown
              title="By department"
              description="Where the company’s equipment is booked."
              slices={data.byDepartment}
              currency={currency}
            />
          </div>

          <Card className="mb-6">
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>Warranties running out</CardTitle>
                <CardDescription>
                  Cover ending within the window, on assets that are still in service.
                </CardDescription>
              </div>
              <NativeSelect
                aria-label="Warranty window"
                value={String(warrantyDays)}
                onChange={(event) => setWarrantyDays(Number(event.target.value))}
                className="w-36"
              >
                {WARRANTY_WINDOWS.map((days) => (
                  <option key={days} value={days}>
                    Next {days} days
                  </option>
                ))}
              </NativeSelect>
            </CardHeader>
            <AlertTable
              rows={alerts.warrantyExpiringRows}
              dateHeading="Warranty ends"
              emptyTitle="Nothing expiring"
              emptyDescription={`No cover ends in the next ${data.warrantyDays} days.`}
            />
            {alerts.warrantyExpiring > alerts.warrantyExpiringRows.length ? (
              <p className="px-5 py-3 text-[12px] text-muted-foreground">
                Showing {alerts.warrantyExpiringRows.length} of {alerts.warrantyExpiring}. Narrow
                the window, or filter the register by warranty.
              </p>
            ) : null}
          </Card>

          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Still out with somebody who has left</CardTitle>
              <CardDescription>
                Assets whose holder has resigned or been terminated. Recording the return is done
                on the asset.
              </CardDescription>
            </CardHeader>
            <AlertTable
              rows={alerts.notReturnedRows}
              dateHeading="Handed over"
              emptyTitle="Nothing outstanding"
              emptyDescription="Everybody who has left has handed their equipment back."
            />
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>People pending clearance</CardTitle>
              <CardDescription>
                On their way out with at least one handover still open. Counts only — nothing here
                marks an asset returned.
              </CardDescription>
            </CardHeader>
            {alerts.pendingClearanceRows.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="Nobody pending"
                description="No leaver is still holding company equipment."
              />
            ) : (
              <TableWrapper>
                <Table>
                  <THead>
                    <TR>
                      <TH>Employee</TH>
                      <TH>Department</TH>
                      <TH className="text-right">Outstanding</TH>
                      <TH className="text-right">Returned</TH>
                      <TH>Clearance</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {alerts.pendingClearanceRows.map((row) => (
                      <TR key={row.employeeId}>
                        <TD className="text-[13.5px] font-medium">
                          <Link to={`/people/${row.employeeId}`} className="hover:underline">
                            {row.fullName}
                          </Link>
                          {row.employeeNumber ? (
                            <span className="block font-mono text-[11.5px] font-normal text-muted-foreground">
                              {row.employeeNumber}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="text-[13px]">
                          {row.departmentName ?? <span className="text-muted-foreground">--</span>}
                        </TD>
                        <TD className="tabular text-right text-[13px] font-medium">{row.pending}</TD>
                        <TD className="tabular text-right text-[13px]">{row.returned}</TD>
                        <TD>
                          <Badge
                            variant={row.state === 'PENDING' ? 'destructive' : 'warning'}
                          >
                            {ASSET_CLEARANCE_STATE_LABELS[row.state]}
                          </Badge>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrapper>
            )}
          </Card>
        </>
      )}
    </>
  );
}
