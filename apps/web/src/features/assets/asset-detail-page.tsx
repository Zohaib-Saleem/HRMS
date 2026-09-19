import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Boxes } from 'lucide-react';
import {
  ASSET_ACKNOWLEDGEMENT_STATUS_LABELS,
  ASSET_ASSIGNMENT_STATUS_LABELS,
  ASSET_CONDITION_LABELS,
  ASSET_DISPOSAL_METHOD_LABELS,
  ASSET_INCIDENT_KIND_LABELS,
  ASSET_REPAIR_STATUS_LABELS,
  ASSET_STATUS_DESCRIPTIONS,
  ASSET_STATUS_LABELS,
  type AssetDetailRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useSession } from '@/features/auth/session-context';
import {
  ASSET_CONDITION_TONE,
  ASSET_STATUS_TONE,
  assetDate,
  assetMoney,
} from './assets-shared';
import { AssetFormDrawer } from './asset-form-drawer';
import { AssetDocuments } from './asset-documents';
import { AssetActivity } from './asset-activity';
import {
  AssignAssetDialog,
  CompleteRepairDialog,
  DisposeAssetDialog,
  ReportIncidentDialog,
  ReturnAssetDialog,
  RetireAssetDialog,
  SendForRepairDialog,
  TransferAssetDialog,
} from './asset-action-dialogs';

/**
 * One asset, and everything that has happened to it.
 *
 * WHICH BUTTONS APPEAR IS NOT THIS PAGE'S DECISION. `detail.can` comes from the
 * server, computed from the caller's grants and the asset's state together, so
 * a control is offered only when pressing it would work - no "Assign" on a
 * disposed laptop, no "Retire" on one somebody is holding. The browser never
 * reasons about statuses here: two copies of that rule eventually disagree, and
 * the copy a person sees is the wrong one.
 *
 * The tabs are the four bodies of history section 12 asks for, plus the
 * overview. They are tabs rather than one long page because they answer
 * different questions - "what is this thing" vs "who has had it" vs "what has
 * it cost us" - and somebody opening this page has exactly one of those in
 * mind.
 */

const TABS = ['Overview', 'Assignment history', 'Repairs', 'Documents', 'Activity'] as const;
type Tab = (typeof TABS)[number];

export function AssetDetailPage() {
  const { id = '' } = useParams();
  const { session } = useSession();
  const currency = session?.company.currency ?? 'USD';

  const [tab, setTab] = React.useState<Tab>('Overview');
  const [dialog, setDialog] = React.useState<
    | null
    | { kind: 'assign' | 'return' | 'transfer' | 'repair' | 'retire' | 'dispose' }
    | { kind: 'incident'; incidentKind: 'LOST' | 'DAMAGED' }
    | { kind: 'complete-repair'; repairId: string }
    | { kind: 'edit' }
  >(null);

  const query = useQuery({
    queryKey: ['assets', 'detail', id],
    queryFn: () => api.get<AssetDetailRecord>(`/assets/${id}`),
    enabled: id !== '',
  });

  if (query.isLoading) {
    return (
      <>
        <PageHeader title="Asset" description="Loading." />
        <Card className="p-6">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="mt-3 h-4 w-80" />
        </Card>
      </>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const asset = query.data;
  const can = asset.can;
  const openRepair = asset.repairs.find((repair) => repair.status === 'IN_PROGRESS') ?? null;

  return (
    <>
      <PageHeader
        title={asset.name}
        description={`${asset.assetTag}${asset.category ? ` · ${asset.category.name}` : ''}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/assets">
                <ArrowLeft />
                Assets
              </Link>
            </Button>
            {can.assign ? (
              <Button size="sm" onClick={() => setDialog({ kind: 'assign' })}>
                Assign
              </Button>
            ) : null}
            {can.returnToStock ? (
              <Button size="sm" onClick={() => setDialog({ kind: 'return' })}>
                Return
              </Button>
            ) : null}
            {can.transfer ? (
              <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'transfer' })}>
                Transfer
              </Button>
            ) : null}
            {can.repair && !openRepair ? (
              <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'repair' })}>
                Send for repair
              </Button>
            ) : null}
            {openRepair ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialog({ kind: 'complete-repair', repairId: openRepair.id })}
              >
                Record repair
              </Button>
            ) : null}
            {can.update ? (
              <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'edit' })}>
                Edit
              </Button>
            ) : null}
            {can.markLostOrDamaged ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDialog({ kind: 'incident', incidentKind: 'DAMAGED' })}
                >
                  Damaged
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDialog({ kind: 'incident', incidentKind: 'LOST' })}
                >
                  Lost
                </Button>
              </>
            ) : null}
            {can.retire ? (
              <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'retire' })}>
                Retire
              </Button>
            ) : null}
            {can.dispose ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => setDialog({ kind: 'dispose' })}
              >
                Dispose
              </Button>
            ) : null}
          </div>
        }
      />

      {/* Who has it, first and large. It is the question this page is opened to
          answer, and burying it in a field list would make somebody hunt. */}
      <Card className="mb-5">
        <CardContent className="flex flex-wrap items-start justify-between gap-4 py-4">
          <div className="min-w-0">
            <p className="text-[12.5px] font-medium uppercase tracking-wide text-muted-foreground">
              Currently assigned to
            </p>
            {asset.holder ? (
              <>
                <p className="mt-1 text-lg font-semibold">{asset.holder.fullName}</p>
                <p className="text-[13px] text-muted-foreground">
                  {asset.holder.employeeNumber ?? 'No employee number'}
                  {asset.holder.departmentName ? ` · ${asset.holder.departmentName}` : ''}
                </p>
                <p className="text-[13px] text-muted-foreground">
                  Assigned {assetDate(asset.holder.assignedAt.slice(0, 10))}
                </p>
              </>
            ) : (
              <p className="mt-1 text-lg font-semibold text-muted-foreground">Nobody</p>
            )}
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="flex gap-2">
              <Badge variant={ASSET_STATUS_TONE[asset.status]}>
                {ASSET_STATUS_LABELS[asset.status]}
              </Badge>
              <Badge variant={ASSET_CONDITION_TONE[asset.condition]}>
                {ASSET_CONDITION_LABELS[asset.condition]}
              </Badge>
            </div>
            <p className="max-w-xs text-right text-[12.5px] text-muted-foreground">
              {ASSET_STATUS_DESCRIPTIONS[asset.status]}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="mb-5 overflow-x-auto border-b border-border">
        <nav className="flex min-w-max gap-1" aria-label="Asset sections">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={
                tab === item
                  ? 'border-b-2 border-primary px-3 py-2.5 text-[13.5px] font-medium text-primary'
                  : 'border-b-2 border-transparent px-3 py-2.5 text-[13.5px] font-medium text-muted-foreground transition-colors hover:text-foreground'
              }
            >
              {item}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'Overview' ? <OverviewTab asset={asset} currency={currency} /> : null}
      {tab === 'Assignment history' ? <AssignmentsTab asset={asset} /> : null}
      {tab === 'Repairs' ? <RepairsTab asset={asset} currency={currency} /> : null}
      {tab === 'Documents' ? (
        <AssetDocuments assetId={asset.id} canManage={can.manageDocuments} />
      ) : null}
      {tab === 'Activity' ? <AssetActivity assetId={asset.id} /> : null}

      {/* One dialog is mounted at a time, keyed off the requested action. Each
          resets its own fields on open, so reopening never shows the last go. */}
      <AssignAssetDialog
        open={dialog?.kind === 'assign'}
        asset={asset}
        onClose={() => setDialog(null)}
      />
      <ReturnAssetDialog
        open={dialog?.kind === 'return'}
        asset={asset}
        onClose={() => setDialog(null)}
      />
      <TransferAssetDialog
        open={dialog?.kind === 'transfer'}
        asset={asset}
        onClose={() => setDialog(null)}
      />
      <SendForRepairDialog
        open={dialog?.kind === 'repair'}
        asset={asset}
        onClose={() => setDialog(null)}
      />
      {dialog?.kind === 'complete-repair' ? (
        <CompleteRepairDialog
          open
          asset={asset}
          repairId={dialog.repairId}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'incident' ? (
        <ReportIncidentDialog
          open
          asset={asset}
          kind={dialog.incidentKind}
          onClose={() => setDialog(null)}
        />
      ) : null}
      <RetireAssetDialog
        open={dialog?.kind === 'retire'}
        asset={asset}
        onClose={() => setDialog(null)}
      />
      <DisposeAssetDialog
        open={dialog?.kind === 'dispose'}
        asset={asset}
        onClose={() => setDialog(null)}
      />
      <AssetFormDrawer
        open={dialog?.kind === 'edit'}
        asset={asset}
        onClose={() => setDialog(null)}
      />
    </>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="text-[13.5px]">{value ?? <span className="text-muted-foreground">--</span>}</dd>
    </div>
  );
}

function OverviewTab({ asset, currency }: { asset: AssetDetailRecord; currency: string }) {
  const warranty =
    asset.warrantyStart || asset.warrantyEnd
      ? `${assetDate(asset.warrantyStart)} - ${assetDate(asset.warrantyEnd)}`
      : null;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>What it is</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label="Asset tag" value={<span className="font-mono">{asset.assetTag}</span>} />
            <Field label="Asset name" value={asset.name} />
            <Field
              label="Category"
              value={
                asset.category
                  ? `${asset.category.parentName ? `${asset.category.parentName} › ` : ''}${asset.category.name}`
                  : null
              }
            />
            <Field label="Brand" value={asset.brand} />
            <Field label="Model" value={asset.model} />
            <Field
              label="Serial number"
              value={
                asset.serialNumber ? <span className="font-mono">{asset.serialNumber}</span> : null
              }
            />
            <Field label="Status" value={ASSET_STATUS_LABELS[asset.status]} />
            <Field label="Condition" value={ASSET_CONDITION_LABELS[asset.condition]} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What it cost and where it is</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label="Purchase date" value={assetDate(asset.purchaseDate)} />
            <Field label="Purchase price" value={assetMoney(asset.purchasePrice, currency)} />
            <Field label="Current value" value={assetMoney(asset.currentValue, currency)} />
            <Field label="Vendor" value={asset.vendor} />
            <Field label="Warranty" value={warranty} />
            <Field label="Office" value={asset.site?.name ?? null} />
            <Field label="Location" value={asset.location} />
            <Field label="Department" value={asset.department?.name ?? null} />
          </dl>
        </CardContent>
      </Card>

      {asset.notes ? (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-[13.5px]">{asset.notes}</p>
          </CardContent>
        </Card>
      ) : null}

      {asset.retiredOn || asset.disposal ? (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>End of life</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              {asset.retiredOn ? (
                <>
                  <Field label="Retired on" value={assetDate(asset.retiredOn)} />
                  <Field label="Reason" value={asset.retiredReason} />
                </>
              ) : null}
              {asset.disposal ? (
                <>
                  <Field label="Disposed on" value={assetDate(asset.disposal.disposedOn)} />
                  <Field
                    label="Method"
                    value={ASSET_DISPOSAL_METHOD_LABELS[asset.disposal.method]}
                  />
                  <Field label="Reason" value={asset.disposal.reason} />
                  <Field
                    label="Final value"
                    value={assetMoney(asset.disposal.finalValue, currency)}
                  />
                  <Field label="Approved by" value={asset.disposal.approvedBy?.fullName ?? null} />
                  <Field label="Notes" value={asset.disposal.notes} />
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      ) : null}

      {asset.incidents.length > 0 ? (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Reported problems</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {asset.incidents.map((incident) => (
              <div key={incident.id} className="border-l-2 border-border pl-3">
                <p className="text-[13.5px] font-medium">
                  {ASSET_INCIDENT_KIND_LABELS[incident.kind]} · {incident.reason}
                </p>
                <p className="text-[12.5px] text-muted-foreground">
                  {assetDate(incident.occurredOn)}
                  {incident.reportedByEmployee
                    ? ` · reported by ${incident.reportedByEmployee.fullName}`
                    : incident.reportedBy
                      ? ` · recorded by ${incident.reportedBy.fullName}`
                      : ''}
                </p>
                {incident.description ? (
                  <p className="mt-1 whitespace-pre-wrap text-[13px]">{incident.description}</p>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function AssignmentsTab({ asset }: { asset: AssetDetailRecord }) {
  if (asset.assignments.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Boxes}
          title="Never issued"
          description="Nobody has been given this asset yet."
        />
      </Card>
    );
  }

  return (
    <Card>
      <TableWrapper>
        <Table>
          <THead>
            <TR>
              <TH>Employee</TH>
              <TH>From</TH>
              <TH>To</TH>
              <TH>Condition out / back</TH>
              <TH>Accessories</TH>
              <TH>Acknowledged</TH>
              <TH>Outcome</TH>
            </TR>
          </THead>
          <TBody>
            {asset.assignments.map((row) => (
              <TR key={row.id}>
                <TD className="text-[13px]">
                  {row.employee?.fullName ?? <span className="text-muted-foreground">--</span>}
                  {row.employee?.employeeNumber ? (
                    <span className="block text-[11.5px] text-muted-foreground">
                      {row.employee.employeeNumber}
                    </span>
                  ) : null}
                </TD>
                <TD className="tabular whitespace-nowrap text-[13px]">
                  {assetDate(row.assignedAt.slice(0, 10))}
                </TD>
                <TD className="tabular whitespace-nowrap text-[13px]">
                  {row.returnedAt ? (
                    assetDate(row.returnedAt.slice(0, 10))
                  ) : (
                    <span className="text-muted-foreground">Still out</span>
                  )}
                </TD>
                <TD className="text-[13px]">
                  {row.conditionAtAssignment
                    ? ASSET_CONDITION_LABELS[row.conditionAtAssignment]
                    : '--'}
                  {' / '}
                  {row.conditionAtReturn ? ASSET_CONDITION_LABELS[row.conditionAtReturn] : '--'}
                  {row.damageDescription ? (
                    <span className="block text-[11.5px] text-warning-foreground">
                      {row.damageDescription}
                    </span>
                  ) : null}
                </TD>
                <TD className="text-[12.5px]">
                  {row.accessoriesIssued.length > 0 ? (
                    <span>{row.accessoriesIssued.join(', ')}</span>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                  {row.accessoriesMissing.length > 0 ? (
                    <span className="block text-destructive">
                      Missing: {row.accessoriesMissing.join(', ')}
                    </span>
                  ) : null}
                </TD>
                <TD className="text-[12.5px]">
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
                </TD>
                <TD className="text-[12.5px]">
                  {ASSET_ASSIGNMENT_STATUS_LABELS[row.status]}
                  {row.reason ? (
                    <span className="block text-[11.5px] text-muted-foreground">{row.reason}</span>
                  ) : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrapper>
    </Card>
  );
}

function RepairsTab({ asset, currency }: { asset: AssetDetailRecord; currency: string }) {
  if (asset.repairs.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Boxes}
          title="Never repaired"
          description="This asset has not been sent away to be fixed."
        />
      </Card>
    );
  }

  return (
    <Card>
      <TableWrapper>
        <Table>
          <THead>
            <TR>
              <TH>Problem</TH>
              <TH>Vendor</TH>
              <TH>Sent</TH>
              <TH>Expected</TH>
              <TH>Back</TH>
              <TH className="text-right">Estimate</TH>
              <TH className="text-right">Actual</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {asset.repairs.map((repair) => (
              <TR key={repair.id}>
                <TD className="max-w-xs text-[13px]">
                  {repair.problem}
                  {repair.completionNotes ? (
                    <span className="block text-[11.5px] text-muted-foreground">
                      {repair.completionNotes}
                    </span>
                  ) : null}
                </TD>
                <TD className="text-[13px]">
                  {repair.vendor ?? <span className="text-muted-foreground">--</span>}
                </TD>
                <TD className="tabular whitespace-nowrap text-[13px]">
                  {assetDate(repair.sentOn)}
                </TD>
                <TD className="tabular whitespace-nowrap text-[13px]">
                  {assetDate(repair.expectedReturnOn)}
                </TD>
                <TD className="tabular whitespace-nowrap text-[13px]">
                  {assetDate(repair.returnedOn)}
                </TD>
                <TD className="tabular whitespace-nowrap text-right text-[13px]">
                  {assetMoney(repair.estimatedCost, currency)}
                </TD>
                <TD className="tabular whitespace-nowrap text-right text-[13px]">
                  {assetMoney(repair.actualCost, currency)}
                </TD>
                <TD>
                  <Badge variant={repair.status === 'IN_PROGRESS' ? 'warning' : 'neutral'}>
                    {ASSET_REPAIR_STATUS_LABELS[repair.status]}
                  </Badge>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrapper>
    </Card>
  );
}
