import * as React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Boxes, CheckCircle2, Plus, UserCheck, Wrench } from 'lucide-react';
import {
  ASSET_CONDITIONS,
  ASSET_CONDITION_LABELS,
  ASSET_STATUSES,
  ASSET_STATUS_LABELS,
  EMPTY_ASSET_SUMMARY,
  type AssetRecord,
  type AssetSummary,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { StatCard } from '@/components/ui/stat-card';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useSession } from '@/features/auth/session-context';
import {
  ASSET_CONDITION_TONE,
  ASSET_STATUS_TONE,
  assetDate,
  assetMoney,
  categoryOptions,
} from './assets-shared';
import { AssetFormDrawer } from './asset-form-drawer';
import { useAssetAccess, useAssetCategories } from './use-asset-data';

/**
 * The asset register.
 *
 * How much of this list a reader gets is NOT this screen's business, and there
 * is deliberately no control on it that widens the query. Somebody holding
 * `asset.read` alone is served the assets currently out with the people their
 * data scope reaches - for most people, their own - by a WHERE clause on the
 * server; HR holding `asset.read.all` is served the company's. The page renders
 * what it is given, which is why there is no "show everything" toggle: a control
 * that widens a query is a control that has to be checked, and the check already
 * happened somewhere that cannot be edited from a browser.
 *
 * The four tiles come from their own endpoint rather than from counting the
 * rows on screen. Counting the page would produce figures that change when
 * somebody clicks next, and tiles that disagree with the table beneath them.
 *
 * On a phone the table becomes a list of cards. A ten-column table at 375px is
 * a table nobody reads, and what survives the transition is what somebody
 * scans for: the tag, what the thing is, who has it and where it stands.
 */

const INITIAL = {
  q: '',
  status: '',
  condition: '',
  categoryId: '',
  page: 1,
  limit: 20,
};

export function AssetsPage() {
  const { session } = useSession();
  const currency = session?.company.currency ?? 'USD';
  const { canCreate, canUpdate } = useAssetAccess();
  const { categories } = useAssetCategories();
  const [search] = useSearchParams();

  /*
   * The URL SEEDS the screen, and then the screen owns the filters.
   *
   * This is what makes the dashboard's alert tiles real: "Lost: 3" links to
   * `/assets?status=LOST`, and the register opens already narrowed to the three
   * rows the tile was counting. Seeding rather than syncing is deliberate -
   * writing every keystroke back to the URL would put the search box in the
   * browser's history, so Back would step through half-typed words instead of
   * leaving the page.
   */
  const [filters, setFilters] = React.useState(() => ({
    ...INITIAL,
    q: search.get('q') ?? '',
    status: search.get('status') ?? '',
    condition: search.get('condition') ?? '',
    categoryId: search.get('categoryId') ?? '',
  }));
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<AssetRecord | null>(null);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const options = React.useMemo(() => categoryOptions(categories), [categories]);

  const summaryQuery = useQuery({
    queryKey: ['assets', 'summary'],
    queryFn: () => api.get<AssetSummary>('/assets/summary'),
  });

  const query = useQuery({
    queryKey: ['assets', 'list', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<AssetRecord>('/assets', {
        query: {
          q: debouncedQuery || undefined,
          status: filters.status || undefined,
          condition: filters.condition || undefined,
          categoryId: filters.categoryId || undefined,
          page: filters.page,
          limit: filters.limit,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;
  const summary = summaryQuery.data ?? EMPTY_ASSET_SUMMARY;
  const hasActiveFilters =
    filters.q !== '' ||
    filters.status !== '' ||
    filters.condition !== '' ||
    filters.categoryId !== '';

  const columns = canUpdate ? 10 : 9;

  return (
    <>
      <PageHeader
        title="Assets"
        description="What the company owns, who is holding it, and what state it is in."
        actions={
          canCreate ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              Add asset
            </Button>
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total assets"
          value={summary.total}
          icon={Boxes}
          loading={summaryQuery.isLoading}
        />
        <StatCard
          label="Available"
          value={summary.byStatus.AVAILABLE}
          icon={CheckCircle2}
          tone="success"
          hint="In stock and ready to hand out"
          loading={summaryQuery.isLoading}
        />
        <StatCard
          label="Assigned"
          value={summary.byStatus.ASSIGNED}
          icon={UserCheck}
          tone="primary"
          hint="Out with somebody"
          loading={summaryQuery.isLoading}
        />
        <StatCard
          label="Under repair"
          value={summary.byStatus.UNDER_REPAIR}
          icon={Wrench}
          tone="warning"
          hint="Away being fixed"
          loading={summaryQuery.isLoading}
        />
      </div>

      <Card>
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search by tag, name, brand, model or serial"
          hasActiveFilters={hasActiveFilters}
          onReset={() => setFilters(INITIAL)}
          filters={
            <>
              <NativeSelect
                aria-label="Category"
                value={filters.categoryId}
                onChange={(event) => update({ categoryId: event.target.value })}
                className="xl:w-52"
              >
                <option value="">All categories</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>

              <NativeSelect
                aria-label="Status"
                value={filters.status}
                onChange={(event) => update({ status: event.target.value })}
                className="xl:w-40"
              >
                <option value="">All statuses</option>
                {ASSET_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {ASSET_STATUS_LABELS[status]}
                  </option>
                ))}
              </NativeSelect>

              <NativeSelect
                aria-label="Condition"
                value={filters.condition}
                onChange={(event) => update({ condition: event.target.value })}
                className="xl:w-40"
              >
                <option value="">All conditions</option>
                {ASSET_CONDITIONS.map((condition) => (
                  <option key={condition} value={condition}>
                    {ASSET_CONDITION_LABELS[condition]}
                  </option>
                ))}
              </NativeSelect>
            </>
          }
        />

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <TableWrapper>
            <Table>
              <TBody>
                <TableSkeleton rows={5} columns={columns} />
              </TBody>
            </Table>
          </TableWrapper>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title={hasActiveFilters ? 'Nothing matches those filters' : 'No assets yet'}
            description={
              hasActiveFilters
                ? 'Clear the filters to see everything you can open.'
                : canCreate
                  ? 'Put the company’s equipment on the register to start tracking it.'
                  : 'You are shown the assets issued to you.'
            }
            action={
              canCreate && !hasActiveFilters ? (
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus />
                  Add asset
                </Button>
              ) : null
            }
          />
        ) : (
          <>
            {/* Phones: one card per asset. */}
            <ul className="divide-y divide-border md:hidden">
              {rows.map((asset) => (
                <li key={asset.id}>
                  <Link
                    to={`/assets/${asset.id}`}
                    className="block px-5 py-3.5 transition-colors hover:bg-accent/45"
                  >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-medium">{asset.name}</p>
                      <p className="font-mono text-[11.5px] text-muted-foreground">
                        {asset.assetTag}
                      </p>
                    </div>
                    <Badge variant={ASSET_STATUS_TONE[asset.status]}>
                      {ASSET_STATUS_LABELS[asset.status]}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-[12.5px] text-muted-foreground">
                    {asset.category?.name ?? 'No category'}
                    {asset.holder ? ` · ${asset.holder.fullName}` : ''}
                  </p>
                  <p className="tabular mt-1 text-[12.5px] text-muted-foreground">
                    {ASSET_CONDITION_LABELS[asset.condition]}
                    {asset.currentValue !== null
                      ? ` · ${assetMoney(asset.currentValue, currency)}`
                      : ''}
                  </p>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="hidden md:block">
              <TableWrapper>
                <Table>
                  <THead>
                    <TR>
                      <TH>Asset tag</TH>
                      <TH>Asset</TH>
                      <TH>Category</TH>
                      <TH>Brand / model</TH>
                      <TH>Serial number</TH>
                      <TH>Employee</TH>
                      <TH>Status</TH>
                      <TH>Condition</TH>
                      <TH>Purchased</TH>
                      <TH className="text-right">Value</TH>
                      {canUpdate ? <TH className="text-right">Actions</TH> : null}
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((asset) => (
                      <TR key={asset.id}>
                        <TD className="font-mono text-[12.5px]">{asset.assetTag}</TD>
                        <TD className="max-w-[14rem] truncate text-[13.5px] font-medium">
                          <Link to={`/assets/${asset.id}`} className="hover:underline">
                            {asset.name}
                          </Link>
                        </TD>
                        <TD className="text-[13px]">
                          {asset.category?.name ?? (
                            <span className="text-muted-foreground">--</span>
                          )}
                          {asset.category?.parentName ? (
                            <span className="block text-[11.5px] text-muted-foreground">
                              {asset.category.parentName}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="text-[13px]">
                          {asset.brand ?? <span className="text-muted-foreground">--</span>}
                          {asset.model ? (
                            <span className="block text-[11.5px] text-muted-foreground">
                              {asset.model}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="font-mono text-[12px]">
                          {asset.serialNumber ?? (
                            <span className="font-sans text-muted-foreground">--</span>
                          )}
                        </TD>
                        <TD className="text-[13px]">
                          {asset.holder ? (
                            <>
                              {asset.holder.fullName}
                              {asset.holder.departmentName ? (
                                <span className="block text-[11.5px] text-muted-foreground">
                                  {asset.holder.departmentName}
                                </span>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-muted-foreground">Nobody</span>
                          )}
                        </TD>
                        <TD>
                          <Badge variant={ASSET_STATUS_TONE[asset.status]}>
                            {ASSET_STATUS_LABELS[asset.status]}
                          </Badge>
                        </TD>
                        <TD>
                          <Badge variant={ASSET_CONDITION_TONE[asset.condition]}>
                            {ASSET_CONDITION_LABELS[asset.condition]}
                          </Badge>
                        </TD>
                        <TD className="tabular whitespace-nowrap text-[13px]">
                          {assetDate(asset.purchaseDate)}
                        </TD>
                        <TD className="tabular whitespace-nowrap text-right text-[13px]">
                          {assetMoney(asset.currentValue ?? asset.purchasePrice, currency)}
                        </TD>
                        {canUpdate ? (
                          <TD className="text-right">
                            <Button size="sm" variant="outline" onClick={() => setEditing(asset)}>
                              Edit
                            </Button>
                          </TD>
                        ) : null}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrapper>
            </div>

            {meta ? (
              <Pagination
                meta={meta}
                onPageChange={(page) => update({ page })}
                onLimitChange={(limit) => update({ limit })}
              />
            ) : null}
          </>
        )}
      </Card>

      <AssetFormDrawer
        open={creating || editing !== null}
        asset={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </>
  );
}
