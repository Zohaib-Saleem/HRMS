import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Ban, PackageCheck, XCircle } from 'lucide-react';
import {
  ASSET_CONDITIONS,
  ASSET_CONDITION_LABELS,
  ASSET_REQUEST_STATUS_DESCRIPTIONS,
  ASSET_REQUEST_STATUS_LABELS,
  type AssetRecord,
  type AssetRequestDetail,
  type AssetRequestItemRecord,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * One request, and what can be done about it.
 *
 * READ THE BUTTONS. There is no Approve here and there never will be: the
 * chain decides this request under Approvals, and what this screen offers is
 * the OTHER half - withdrawing it if you raised it, and issuing the kit if you
 * are the person who looks after it and the chain has already agreed.
 *
 * `canFulfil` comes from the server and is false while the request is still in
 * the chain, whatever grants the viewer holds. The endpoint refuses the call
 * on the same rule, so this is a signpost rather than the gate.
 */
export function AssetRequestDetailDialog({
  requestId,
  onClose,
}: {
  requestId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [fulfilling, setFulfilling] = React.useState<AssetRequestItemRecord | null>(null);

  const query = useQuery({
    queryKey: ['asset-requests', requestId],
    queryFn: () => api.get<AssetRequestDetail>(`/asset-requests/${requestId}`),
    enabled: requestId !== null,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['asset-requests'] });
    await queryClient.invalidateQueries({ queryKey: ['assets'] });
    setFulfilling(null);
  };

  const cancel = useMutation({
    mutationFn: () => api.post(`/asset-requests/${requestId}/cancel`, {}),
    onSuccess: async () => {
      toast.success('Request withdrawn.');
      await refresh();
      onClose();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const decline = useMutation({
    mutationFn: (input: { itemId: string; reason: string }) =>
      api.post(`/asset-requests/${requestId}/decline-item`, input),
    onSuccess: async () => {
      toast.success('Line answered.');
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const request = query.data;

  return (
    <Dialog open={requestId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Equipment request</DialogTitle>
          <DialogDescription>
            {request ? ASSET_REQUEST_STATUS_DESCRIPTIONS[request.status] : 'Loading...'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {query.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : request ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={request.status === 'FULFILLED' ? 'success' : 'neutral'}>
                  {ASSET_REQUEST_STATUS_LABELS[request.status]}
                </Badge>
                {request.currentStageLabel ? (
                  <span className="text-[12.5px] text-muted-foreground">
                    with {request.currentStageLabel}
                  </span>
                ) : null}
                {request.approvalRequestId ? (
                  <Link
                    to={`/approvals/${request.approvalRequestId}`}
                    className="text-[12.5px] text-primary underline-offset-2 hover:underline"
                  >
                    See the approval chain
                  </Link>
                ) : null}
              </div>

              <div>
                <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                  Raised by
                </p>
                <p className="text-[13.5px]">
                  {request.employeeName}
                  {request.teamName ? ` · ${request.teamName}` : ''}
                </p>
              </div>

              <div>
                <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                  Why
                </p>
                <p className="text-[13.5px]">{request.justification}</p>
              </div>

              <ul className="divide-y divide-border rounded-md border border-border">
                {request.items.map((item) => (
                  <li key={item.id} className="px-3 py-2.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-[13.5px] font-medium">
                        {item.quantity} x {item.categoryName}
                      </p>
                      <span className="tabular text-[12.5px] text-muted-foreground">
                        {item.fulfilledCount} of {item.quantity} issued
                      </span>
                    </div>
                    {item.issuedAssets.length > 0 ? (
                      <p className="text-[12.5px] text-muted-foreground">
                        {item.issuedAssets.map((asset) => `${asset.assetTag} ${asset.name}`).join(', ')}
                      </p>
                    ) : null}
                    {item.declineReason ? (
                      <p className="mt-1 flex items-start gap-1.5 text-[12.5px] text-muted-foreground">
                        <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        Declined: {item.declineReason}
                      </p>
                    ) : null}
                    {request.canFulfil && !item.isSettled ? (
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" onClick={() => setFulfilling(item)}>
                          <PackageCheck />
                          Issue one
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            const reason = window.prompt(
                              `Why can ${item.categoryName} not be supplied?`,
                            );
                            if (reason && reason.trim().length >= 5) {
                              decline.mutate({ itemId: item.id, reason: reason.trim() });
                            }
                          }}
                        >
                          Cannot supply
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>

              {fulfilling ? (
                <FulfilBlock
                  requestId={request.id}
                  item={fulfilling}
                  onDone={refresh}
                  onCancel={() => setFulfilling(null)}
                />
              ) : null}
            </>
          ) : null}
        </DialogBody>

        <DialogFooter>
          {request?.canCancel ? (
            <Button
              variant="ghost"
              className="text-destructive"
              loading={cancel.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Withdraw this request?',
                  description: 'It stops where it is and nobody else is asked.',
                  confirmLabel: 'Withdraw',
                  tone: 'destructive',
                });
                if (ok) cancel.mutate();
              }}
            >
              <Ban />
              Withdraw
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Choosing which machine to hand over.
 *
 * The list is the register's own AVAILABLE stock - an asset that is already
 * out with somebody is not offered, and the server refuses it anyway with the
 * same conditional update the ordinary assign path uses.
 */
function FulfilBlock({
  requestId,
  item,
  onDone,
  onCancel,
}: {
  requestId: string;
  item: AssetRequestItemRecord;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [assetId, setAssetId] = React.useState('');
  const [condition, setCondition] = React.useState<(typeof ASSET_CONDITIONS)[number]>('GOOD');
  const [assignedOn, setAssignedOn] = React.useState(() => new Date().toISOString().slice(0, 10));

  const assets = useQuery({
    queryKey: ['assets', 'available', item.categoryId],
    queryFn: () =>
      api.getPage<AssetRecord>('/assets', {
        query: { status: 'AVAILABLE', categoryId: item.categoryId, limit: 50, page: 1 },
      }),
  });

  const issue = useMutation({
    mutationFn: () =>
      api.post(`/asset-requests/${requestId}/fulfil`, {
        itemId: item.id,
        assetId,
        conditionAtAssignment: condition,
        assignedOn,
        accessories: [],
      }),
    onSuccess: async () => {
      toast.success('Issued, and the request updated.');
      await onDone();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const options = assets.data?.data ?? [];

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/40 p-3">
      <p className="text-[13px] font-medium">Issue a {item.categoryName}</p>
      <FormField label="Asset" htmlFor="fulfil-asset" required>
        <NativeSelect id="fulfil-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
          <option value="">
            {options.length === 0 ? 'Nothing available in this category' : 'Choose an asset'}
          </option>
          {options.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.assetTag} - {asset.name}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <div className="flex gap-2">
        <FormField label="Condition" htmlFor="fulfil-condition" className="flex-1">
          <NativeSelect
            id="fulfil-condition"
            value={condition}
            onChange={(e) => setCondition(e.target.value as (typeof ASSET_CONDITIONS)[number])}
          >
            {ASSET_CONDITIONS.map((value) => (
              <option key={value} value={value}>
                {ASSET_CONDITION_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField label="Issued on" htmlFor="fulfil-date" className="flex-1">
          <Input
            id="fulfil-date"
            type="date"
            value={assignedOn}
            onChange={(e) => setAssignedOn(e.target.value)}
          />
        </FormField>
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={assetId === ''} loading={issue.isPending} onClick={() => issue.mutate()}>
          Hand it over
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
