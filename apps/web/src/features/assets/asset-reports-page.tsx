import * as React from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Boxes, Download, FileSpreadsheet, LayoutDashboard, Users } from 'lucide-react';
import {
  ASSET_ACKNOWLEDGEMENT_STATUS_LABELS,
  ASSET_CONDITIONS,
  ASSET_CONDITION_LABELS,
  ASSET_REPORT_COLUMNS,
  ASSET_REGISTER_SCOPES,
  ASSET_REGISTER_SCOPE_LABELS,
  ASSET_STATUSES,
  ASSET_STATUS_LABELS,
  ASSET_WARRANTY_FILTERS,
  ASSET_WARRANTY_FILTER_LABELS,
  EMPLOYEE_ASSET_REGISTER_COLUMNS,
  EMPTY_ASSET_REPORT_TOTALS,
  type AssetRegisterScope,
  type AssetReportRow,
  type AssetReportTotals,
  type EmployeeAssetRegisterRow,
  type PaginationMeta,
  type ReportColumn,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { useLookups } from '@/lib/lookups';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { StatCard } from '@/components/ui/stat-card';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useSession } from '@/features/auth/session-context';
import { ASSET_CONDITION_TONE, ASSET_STATUS_TONE, assetDate, assetMoney, categoryOptions } from './assets-shared';
import { useAssetAccess, useAssetCategories } from './use-asset-data';

/**
 * The two asset reports.
 *
 * ONE SCREEN, TWO GRAINS, and the switcher at the top is the honest way to say
 * so. The asset report is one row per ASSET - eighty laptops are eighty rows -
 * and answers "what do we own and what is it worth". The employee register is
 * one row per HANDOVER - a person with a laptop, a monitor and an access card
 * is three rows - and answers "what is this person holding", which is the
 * question asked at an audit, a transfer, a resignation and a termination.
 *
 * They share this screen because they share their filters, and they share the
 * filters because the person asking moves between the two questions inside one
 * sitting. What they do not share is a table: flattening the second into the
 * first would force one row per asset with a person's name on it, which
 * silently drops everybody who has handed something back.
 *
 * THE FOOTER TOTALS EVERY MATCHING ROW, not the page. The server computes it
 * from the same WHERE the page came from, so pressing next does not change it.
 *
 * The export is a plain link to the CSV endpoint carrying the SAME query the
 * table was built from. Not a client-side dump of the rows on screen: an export
 * that shipped the visible twenty would be a spreadsheet with the wrong rows in
 * it, emailed to somebody who has no way of telling.
 */

type ReportKey = 'assets' | 'employees';

const EMPTY_FILTERS = {
  q: '',
  categoryId: '',
  status: '',
  condition: '',
  departmentId: '',
  teamId: '',
  locationId: '',
  warranty: '',
  purchasedFrom: '',
  purchasedTo: '',
  assignedFrom: '',
  assignedTo: '',
  scope: 'CURRENT' as AssetRegisterScope,
};

type Filters = typeof EMPTY_FILTERS;

interface ReportEnvelope<Row> {
  data: Row[];
  meta: PaginationMeta;
  totals: AssetReportTotals;
  asOf: string;
}

/**
 * The filters as query parameters, with the empties dropped.
 *
 * One function, used by the table's query AND by the export's href, so the file
 * somebody downloads cannot be narrowed differently from the screen they
 * downloaded it from. `scope` is sent only for the employee register, where it
 * is the only filter that means anything - the asset report has no handover
 * grain for "every handover ever" to apply to.
 */
function toQuery(report: ReportKey, filters: Filters, q: string): Record<string, string> {
  const params: Record<string, string> = {};
  const put = (key: string, value: string) => {
    if (value) params[key] = value;
  };

  put('q', q);
  put('categoryId', filters.categoryId);
  put('status', filters.status);
  put('condition', filters.condition);
  put('departmentId', filters.departmentId);
  put('teamId', filters.teamId);
  put('locationId', filters.locationId);
  put('warranty', filters.warranty);
  put('purchasedFrom', filters.purchasedFrom);
  put('purchasedTo', filters.purchasedTo);
  put('assignedFrom', filters.assignedFrom);
  put('assignedTo', filters.assignedTo);
  if (report === 'employees') params.scope = filters.scope;

  return params;
}

function isFiltered(filters: Filters, q: string): boolean {
  return Object.keys(toQuery('assets', filters, q)).length > 0;
}

/** A `yyyy-MM-dd` date input, labelled for a screen reader. */
function DateFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <Input
      type="date"
      aria-label={label}
      title={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="xl:w-40"
    />
  );
}

/** One cell of the asset report, by column key. */
function assetCell(row: AssetReportRow, key: string, currency: string): React.ReactNode {
  const muted = <span className="text-muted-foreground">--</span>;

  switch (key) {
    case 'employeeName':
      return row.employeeId ? (
        <Link to={`/people/${row.employeeId}`} className="hover:underline">
          {row.employeeName}
        </Link>
      ) : (
        <span className="text-muted-foreground">Nobody</span>
      );
    case 'employeeNumber':
      return row.employeeNumber ?? muted;
    case 'departmentName':
      return row.departmentName ?? muted;
    case 'assetTag':
      return <span className="font-mono text-[12.5px]">{row.assetTag}</span>;
    case 'assetName':
      return (
        <Link to={`/assets/${row.assetId}`} className="font-medium hover:underline">
          {row.assetName}
        </Link>
      );
    case 'categoryName':
      return row.categoryName ?? muted;
    case 'brand':
      return row.brand ?? muted;
    case 'model':
      return row.model ?? muted;
    case 'serialNumber':
      return row.serialNumber ? (
        <span className="font-mono text-[12px]">{row.serialNumber}</span>
      ) : (
        muted
      );
    case 'purchaseDate':
      return assetDate(row.purchaseDate);
    case 'purchasePrice':
      return assetMoney(row.purchasePrice, currency);
    case 'currentValue':
      return assetMoney(row.currentValue, currency);
    case 'assignedAt':
      return row.assignedAt ? assetDate(row.assignedAt.slice(0, 10)) : muted;
    case 'condition':
      return (
        <Badge variant={ASSET_CONDITION_TONE[row.condition]}>
          {ASSET_CONDITION_LABELS[row.condition]}
        </Badge>
      );
    case 'status':
      return (
        <Badge variant={ASSET_STATUS_TONE[row.status]}>{ASSET_STATUS_LABELS[row.status]}</Badge>
      );
    case 'warrantyEnd':
      return assetDate(row.warrantyEnd);
    case 'locationName':
      return row.locationName ?? muted;
    default:
      return muted;
  }
}

/** One cell of the employee register, by column key. */
function registerCell(
  row: EmployeeAssetRegisterRow,
  key: string,
  currency: string,
): React.ReactNode {
  const muted = <span className="text-muted-foreground">--</span>;

  switch (key) {
    case 'employeeName':
      return (
        <Link to={`/people/${row.employeeId}`} className="font-medium hover:underline">
          {row.employeeName}
        </Link>
      );
    case 'employeeNumber':
      return row.employeeNumber ?? muted;
    case 'departmentName':
      return row.departmentName ?? muted;
    case 'teamName':
      return row.teamName ?? muted;
    case 'assetName':
      return (
        <Link to={`/assets/${row.assetId}`} className="hover:underline">
          {row.assetName}
        </Link>
      );
    case 'assetTag':
      return <span className="font-mono text-[12.5px]">{row.assetTag}</span>;
    case 'categoryName':
      return row.categoryName ?? muted;
    case 'serialNumber':
      return row.serialNumber ? (
        <span className="font-mono text-[12px]">{row.serialNumber}</span>
      ) : (
        muted
      );
    case 'assignedAt':
      return assetDate(row.assignedAt.slice(0, 10));
    case 'returnedAt':
      return row.returnedAt ? assetDate(row.returnedAt.slice(0, 10)) : muted;
    case 'condition':
      return row.condition ? (
        <Badge variant={ASSET_CONDITION_TONE[row.condition]}>
          {ASSET_CONDITION_LABELS[row.condition]}
        </Badge>
      ) : (
        muted
      );
    case 'status':
      return (
        <Badge variant={ASSET_STATUS_TONE[row.assetStatus]}>
          {ASSET_STATUS_LABELS[row.assetStatus]}
        </Badge>
      );
    case 'acknowledgement':
      return ASSET_ACKNOWLEDGEMENT_STATUS_LABELS[row.acknowledgementStatus];
    case 'currentValue':
      return assetMoney(row.currentValue, currency);
    default:
      return muted;
  }
}

/** Columns whose figures line up on the right, the way money and dates should. */
const NUMERIC = new Set(['purchasePrice', 'currentValue']);

export function AssetReportsPage() {
  const { session } = useSession();
  const currency = session?.company.currency ?? 'USD';
  const { canSeeDashboard } = useAssetAccess();
  const { categories } = useAssetCategories();
  const { lookups } = useLookups();

  const [report, setReport] = React.useState<ReportKey>('assets');
  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = React.useState(1);
  const [limit, setLimit] = React.useState(20);
  const debouncedQuery = useDebounced(filters.q, 350);

  const update = React.useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  }, []);

  const categoryChoices = React.useMemo(() => categoryOptions(categories), [categories]);
  const columns: readonly ReportColumn[] =
    report === 'assets' ? ASSET_REPORT_COLUMNS : EMPLOYEE_ASSET_REGISTER_COLUMNS;

  const params = toQuery(report, filters, debouncedQuery);

  const query = useQuery({
    queryKey: ['assets', 'report', report, params, page, limit],
    queryFn: () =>
      api.getEnvelope<ReportEnvelope<AssetReportRow | EmployeeAssetRegisterRow>>(
        `/assets/reports/${report}`,
        { query: { ...params, page, limit } },
      ),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;
  const totals = query.data?.totals ?? EMPTY_ASSET_REPORT_TOTALS;

  /*
   * The export carries the same filters and the same column list the table is
   * drawn from. A link rather than a fetch: the server sets the filename and
   * the browser saves the file, and nothing has to hold a spreadsheet in
   * memory on the way past.
   */
  const exportHref = `/api/v1/assets/reports/${report}.csv?${new URLSearchParams({
    ...params,
    columns: columns.map((column) => column.key).join(','),
  }).toString()}`;

  const filtered = isFiltered(filters, debouncedQuery);

  return (
    <>
      <PageHeader
        title="Asset reports"
        description="The register as a sheet, and everything anybody is holding. Filters apply to both."
        actions={
          <div className="flex flex-wrap gap-2">
            {canSeeDashboard ? (
              <Button variant="outline" size="sm" asChild>
                <Link to="/assets/dashboard">
                  <LayoutDashboard className="size-4" aria-hidden /> Dashboard
                </Link>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" asChild>
              <a href={exportHref}>
                <Download className="size-4" aria-hidden /> Export CSV
              </a>
            </Button>
          </div>
        }
      />

      {/*
          Not a dropdown. The two reports answer different questions and the
          reader has to be able to see which one is live and that the other
          exists without opening anything.
      */}
      <div className="mb-5 grid w-full gap-1 rounded-xl border border-border bg-surface-muted p-1 sm:inline-flex sm:w-auto sm:grid-cols-2">
        {(
          [
            { key: 'assets', label: 'Asset report', icon: Boxes },
            { key: 'employees', label: 'Employee register', icon: Users },
          ] as const
        ).map((option) => {
          const selected = report === option.key;
          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setReport(option.key);
                setPage(1);
              }}
              className={
                selected
                  ? 'inline-flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-primary px-4 text-[13.5px] font-medium text-primary-foreground sm:min-h-9'
                  : 'inline-flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-4 text-[13.5px] font-medium text-muted-foreground transition-colors hover:text-foreground sm:min-h-9'
              }
            >
              <option.icon className="size-4" aria-hidden />
              {option.label}
            </button>
          );
        })}
      </div>

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard
          label={report === 'assets' ? 'Assets' : 'Handovers'}
          value={totals.rows}
          icon={report === 'assets' ? Boxes : FileSpreadsheet}
          hint="Every row the filters match"
          loading={query.isLoading}
        />
        <StatCard
          label="Purchase value"
          value={assetMoney(totals.purchaseValue, currency)}
          icon={FileSpreadsheet}
          loading={query.isLoading}
        />
        <StatCard
          label="Current value"
          value={assetMoney(totals.currentValue, currency)}
          icon={FileSpreadsheet}
          tone="primary"
          loading={query.isLoading}
        />
      </div>

      <Card>
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search by tag, serial, asset or employee"
          hasActiveFilters={filtered}
          onReset={() => {
            setFilters(EMPTY_FILTERS);
            setPage(1);
          }}
          filters={
            <>
              {report === 'employees' ? (
                <NativeSelect
                  aria-label="Handovers"
                  value={filters.scope}
                  onChange={(event) =>
                    update({ scope: event.target.value as AssetRegisterScope })
                  }
                  className="xl:w-44"
                >
                  {ASSET_REGISTER_SCOPES.map((scope) => (
                    <option key={scope} value={scope}>
                      {ASSET_REGISTER_SCOPE_LABELS[scope]}
                    </option>
                  ))}
                </NativeSelect>
              ) : null}

              <NativeSelect
                aria-label="Category"
                value={filters.categoryId}
                onChange={(event) => update({ categoryId: event.target.value })}
                className="xl:w-48"
              >
                <option value="">All categories</option>
                {categoryChoices.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>

              <NativeSelect
                aria-label="Department"
                value={filters.departmentId}
                onChange={(event) => update({ departmentId: event.target.value, teamId: '' })}
                className="xl:w-44"
              >
                <option value="">All departments</option>
                {lookups.departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.label}
                  </option>
                ))}
              </NativeSelect>

              <NativeSelect
                aria-label="Team"
                value={filters.teamId}
                onChange={(event) => update({ teamId: event.target.value })}
                className="xl:w-40"
              >
                <option value="">All teams</option>
                {lookups.teams
                  .filter(
                    (team) => !filters.departmentId || team.departmentId === filters.departmentId,
                  )
                  .map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.label}
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

              <NativeSelect
                aria-label="Location"
                value={filters.locationId}
                onChange={(event) => update({ locationId: event.target.value })}
                className="xl:w-40"
              >
                <option value="">All locations</option>
                {lookups.locations.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.label}
                  </option>
                ))}
              </NativeSelect>

              <NativeSelect
                aria-label="Warranty"
                value={filters.warranty}
                onChange={(event) => update({ warranty: event.target.value })}
                className="xl:w-44"
              >
                <option value="">Any warranty</option>
                {ASSET_WARRANTY_FILTERS.map((warranty) => (
                  <option key={warranty} value={warranty}>
                    {ASSET_WARRANTY_FILTER_LABELS[warranty]}
                  </option>
                ))}
              </NativeSelect>

              <DateFilter
                label="Purchased from"
                value={filters.purchasedFrom}
                onChange={(purchasedFrom) => update({ purchasedFrom })}
              />
              <DateFilter
                label="Purchased to"
                value={filters.purchasedTo}
                onChange={(purchasedTo) => update({ purchasedTo })}
              />
              <DateFilter
                label="Handed over from"
                value={filters.assignedFrom}
                onChange={(assignedFrom) => update({ assignedFrom })}
              />
              <DateFilter
                label="Handed over to"
                value={filters.assignedTo}
                onChange={(assignedTo) => update({ assignedTo })}
              />
            </>
          }
        />

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <TableWrapper>
            <Table>
              <TBody>
                <TableSkeleton rows={6} columns={Math.min(columns.length, 8)} />
              </TBody>
            </Table>
          </TableWrapper>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={FileSpreadsheet}
            title={filtered ? 'Nothing matches those filters' : 'Nothing to report yet'}
            description={
              filtered
                ? 'Clear the filters to see everything you can open.'
                : report === 'assets'
                  ? 'Put the company’s equipment on the register and it will appear here.'
                  : 'Hand an asset to somebody and the handover will appear here.'
            }
          />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    {columns.map((column) => (
                      <TH
                        key={column.key}
                        className={NUMERIC.has(column.key) ? 'text-right' : undefined}
                      >
                        {column.label}
                      </TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => {
                    const id =
                      report === 'assets'
                        ? (row as AssetReportRow).assetId
                        : (row as EmployeeAssetRegisterRow).assignmentId;
                    return (
                      <TR key={id}>
                        {columns.map((column) => (
                          <TD
                            key={column.key}
                            className={
                              NUMERIC.has(column.key)
                                ? 'tabular whitespace-nowrap text-right text-[13px]'
                                : 'whitespace-nowrap text-[13px]'
                            }
                          >
                            {report === 'assets'
                              ? assetCell(row as AssetReportRow, column.key, currency)
                              : registerCell(row as EmployeeAssetRegisterRow, column.key, currency)}
                          </TD>
                        ))}
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </TableWrapper>

            {/*
                The footer totals EVERY matching row, not the page. It comes
                from the server alongside the rows, computed from the same
                WHERE, so it does not change when somebody presses next.
            */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-[13px]">
              <span className="text-muted-foreground">
                {totals.rows.toLocaleString()}{' '}
                {report === 'assets' ? 'assets' : 'handovers'} matched
              </span>
              <span className="tabular">
                Purchase {assetMoney(totals.purchaseValue, currency)} · Current{' '}
                <span className="font-medium">{assetMoney(totals.currentValue, currency)}</span>
              </span>
            </div>

            {meta ? (
              <Pagination
                meta={meta}
                onPageChange={setPage}
                onLimitChange={(next) => {
                  setLimit(next);
                  setPage(1);
                }}
              />
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
