import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Boxes, Plus, Trash2 } from 'lucide-react';
import {
  ASSET_REQUEST_STATUS_LABELS,
  PERMISSIONS,
  type AssetCategoryRecord,
  type AssetRequestListItem,
  type MyTeamContext,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import { formatRelative } from '@/lib/utils';
import { AssetRequestDetailDialog } from './asset-request-detail';

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'destructive'> = {
  PENDING: 'warning',
  APPROVED: 'neutral',
  REJECTED: 'destructive',
  CANCELLED: 'neutral',
  FULFILLED: 'success',
};

/**
 * Equipment requests.
 *
 * One screen with two audiences, separated by a permission rather than by a
 * route: everybody sees their own requests, and whoever may see the whole
 * company gets the QUEUE tab - the requests the chain has approved and the
 * storeroom has not yet answered.
 *
 * The queue is a fulfilment list, never an approval list. There is no approve
 * button anywhere on this screen; a request is decided under Approvals, by the
 * people the hierarchy resolved.
 */
export function AssetRequestsPage() {
  const { has } = usePermissions();
  const canSeeQueue = has(PERMISSIONS.ASSET_REQUEST_READ_ALL);
  const canRequest = has(PERMISSIONS.ASSET_REQUEST_CREATE);

  const [view, setView] = React.useState<'mine' | 'queue' | 'all'>(canSeeQueue ? 'queue' : 'mine');
  const [page, setPage] = React.useState(1);
  const [creating, setCreating] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);

  const query = useQuery({
    queryKey: ['asset-requests', { view, page }],
    queryFn: () =>
      api.getPage<AssetRequestListItem>('/asset-requests', {
        query: { view, page, limit: 20 },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];

  return (
    <>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex gap-1">
            {canSeeQueue ? (
              <TabButton active={view === 'queue'} onClick={() => { setView('queue'); setPage(1); }}>
                To fulfil
              </TabButton>
            ) : null}
            <TabButton active={view === 'mine'} onClick={() => { setView('mine'); setPage(1); }}>
              My requests
            </TabButton>
            <TabButton active={view === 'all'} onClick={() => { setView('all'); setPage(1); }}>
              All I can see
            </TabButton>
          </div>
          {canRequest ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              Request equipment
            </Button>
          ) : null}
        </div>

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>What was asked for</TH>
                    <TH>Who</TH>
                    <TH className="w-36">Stage</TH>
                    <TH className="w-28 text-right">Delivered</TH>
                    <TH className="w-32">Status</TH>
                    <TH className="w-28">Raised</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={5} columns={6} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={6} className="p-0">
                        <EmptyState
                          icon={Boxes}
                          title={view === 'queue' ? 'Nothing waiting to be issued' : 'No requests'}
                          description={
                            view === 'queue'
                              ? 'Approved requests appear here once the chain has finished with them.'
                              : 'Ask for a laptop, a monitor or anything else the company issues.'
                          }
                          action={
                            canRequest && view !== 'queue' ? (
                              <Button size="sm" onClick={() => setCreating(true)}>
                                <Plus />
                                Request equipment
                              </Button>
                            ) : null
                          }
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR
                        key={row.id}
                        className="cursor-pointer"
                        onClick={() => setOpenId(row.id)}
                      >
                        <TD>
                          <p className="text-[13.5px] font-medium">
                            {row.itemCount} item{row.itemCount === 1 ? '' : 's'}
                          </p>
                          <p className="truncate text-[12px] text-muted-foreground">
                            {row.justification}
                          </p>
                        </TD>
                        <TD className="text-[13px]">
                          {row.employeeName}
                          {row.teamName ? (
                            <span className="block text-[12px] text-muted-foreground">
                              {row.teamName}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="text-[13px]">
                          {row.currentStageLabel ?? '--'}
                          {row.awaitingMyDecision ? (
                            <Badge variant="warning" className="ml-1.5">
                              You
                            </Badge>
                          ) : null}
                        </TD>
                        <TD className="tabular text-right text-[13px]">
                          {row.fulfilledCount} / {row.requestedCount}
                        </TD>
                        <TD>
                          <Badge variant={STATUS_TONE[row.status] ?? 'neutral'}>
                            {ASSET_REQUEST_STATUS_LABELS[row.status]}
                          </Badge>
                        </TD>
                        <TD className="text-[12.5px] text-muted-foreground">
                          {formatRelative(row.createdAt)}
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>

            {query.data ? (
              <Pagination
                meta={query.data.meta}
                disabled={query.isFetching}
                onPageChange={setPage}
                onLimitChange={() => undefined}
              />
            ) : null}
          </>
        )}
      </Card>

      <NewRequestDialog open={creating} onClose={() => setCreating(false)} />
      <AssetRequestDetailDialog requestId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button variant={active ? 'secondary' : 'ghost'} size="sm" onClick={onClick}>
      {children}
    </Button>
  );
}

/**
 * Asking for something.
 *
 * The justification is compulsory and the form says why: three people are
 * going to read it, and "laptop" is not a thing anybody can decide.
 */
function NewRequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [justification, setJustification] = React.useState('');
  const [neededBy, setNeededBy] = React.useState('');
  const [items, setItems] = React.useState<Array<{ categoryId: string; quantity: number }>>([
    { categoryId: '', quantity: 1 },
  ]);

  const categories = useQuery({
    queryKey: ['asset-categories', 'flat'],
    queryFn: () => api.get<AssetCategoryRecord[]>('/assets/categories'),
    enabled: open,
  });

  /*
   * Who this request will actually go to.
   *
   * Named rather than described, because "your team manager" is not an answer
   * to "who is going to see this" when the person has three of them, or none.
   * Read from the same roster the chain resolves against, so the sentence
   * cannot drift from what the server will do.
   */
  const myTeam = useQuery({
    queryKey: ['my-team'],
    queryFn: () => api.get<MyTeamContext>('/organisation/my-team'),
    enabled: open,
  });

  const submit = useMutation({
    mutationFn: () =>
      api.post('/asset-requests', {
        justification,
        neededBy: neededBy || null,
        items: items.filter((item) => item.categoryId !== ''),
      }),
    onSuccess: async () => {
      toast.success('Request raised. It is with your team manager now.');
      setJustification('');
      setNeededBy('');
      setItems([{ categoryId: '', quantity: 1 }]);
      await queryClient.invalidateQueries({ queryKey: ['asset-requests'] });
      await queryClient.invalidateQueries({ queryKey: ['approvals'] });
      onClose();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  /** The catalogue, flattened - a request names a KIND of thing, not a tree. */
  const flat = React.useMemo(() => {
    const out: Array<{ id: string; name: string }> = [];
    const walk = (nodes: AssetCategoryRecord[], prefix: string) => {
      for (const node of nodes) {
        out.push({ id: node.id, name: prefix ? `${prefix} / ${node.name}` : node.name });
        if (node.children?.length) walk(node.children, prefix ? `${prefix} / ${node.name}` : node.name);
      }
    };
    walk(categories.data ?? [], '');
    return out;
  }, [categories.data]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent variant="drawer" size="md">
        <DialogHeader>
          <DialogTitle>Request equipment</DialogTitle>
          <DialogDescription>
            {myTeam.data && myTeam.data.myTeamManagers.length > 0
              ? `This goes to ${myTeam.data.myTeamManagers
                  .map((m) => m.name)
                  .join(' or ')} first - any one of them is enough - then HR, then the CEO.`
              : myTeam.data && myTeam.data.myTeamId === null
                ? 'You are not on a team, so this goes straight to HR and then the CEO.'
                : 'This goes to your team manager, then HR, then the CEO.'}{' '}
            Once it is approved the asset manager chooses the equipment and hands it over.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="space-y-2">
            {items.map((item, index) => (
              <div key={index} className="flex items-end gap-2">
                <FormField label={index === 0 ? 'What do you need?' : ''} htmlFor={`item-${index}`} className="flex-1">
                  <NativeSelect
                    id={`item-${index}`}
                    value={item.categoryId}
                    onChange={(event) =>
                      setItems(items.map((it, i) => (i === index ? { ...it, categoryId: event.target.value } : it)))
                    }
                  >
                    <option value="">Choose...</option>
                    {flat.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label={index === 0 ? 'How many' : ''} htmlFor={`qty-${index}`} className="w-24">
                  <Input
                    id={`qty-${index}`}
                    type="number"
                    min={1}
                    max={20}
                    value={item.quantity}
                    onChange={(event) =>
                      setItems(
                        items.map((it, i) =>
                          i === index ? { ...it, quantity: Number(event.target.value) } : it,
                        ),
                      )
                    }
                  />
                </FormField>
                {items.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove this line"
                    onClick={() => setItems(items.filter((_, i) => i !== index))}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setItems([...items, { categoryId: '', quantity: 1 }])}
            >
              <Plus />
              Add another item
            </Button>
          </div>

          <FormField
            label="Why do you need it?"
            htmlFor="request-justification"
            hint="The people approving this have only what you write here."
            required
          >
            <Textarea
              id="request-justification"
              rows={4}
              value={justification}
              onChange={(event) => setJustification(event.target.value)}
            />
          </FormField>

          <FormField label="Needed by (optional)" htmlFor="request-needed-by">
            <Input
              id="request-needed-by"
              type="date"
              value={neededBy}
              onChange={(event) => setNeededBy(event.target.value)}
            />
          </FormField>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={submit.isPending}
            disabled={justification.trim().length < 10 || items.every((i) => i.categoryId === '')}
            onClick={() => submit.mutate()}
          >
            Send for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
