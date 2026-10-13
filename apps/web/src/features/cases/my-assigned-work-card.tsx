import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Wrench } from 'lucide-react';
import {
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  CASE_STATUS_LABELS,
  PERMISSIONS,
  type AssetIssueQueueItem,
  type CaseQueueSummary,
  type CaseRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableWrapper, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import { CASE_PRIORITY_TONE, CASE_STATUS_TONE, caseDay } from './case-shared';
import { flattenCatalogue, useCaseCatalogue } from './use-case-catalogue';

/**
 * What the person reading the dashboard has to act on: the cases assigned to
 * them, and - for whoever works the asset register - the open asset issues.
 *
 * Every row comes from endpoints that already enforce who may see what: the
 * desk's `/cases/queue` narrowed to `assignee=me`, and `/assets/issues`, which
 * needs `asset.read.all`. Nothing is filtered in the browser. The card renders
 * itself away for anybody holding neither a desk read grant nor the asset
 * grants, which is almost everybody - and the API would refuse them anyway.
 *
 * Polled on the bell's interval, so an assignment made on somebody else's
 * screen arrives here without a reload.
 */

const STATUS_FILTERS = [
  { value: 'OUTSTANDING', label: 'Outstanding' },
  { value: 'OPEN', label: CASE_STATUS_LABELS.OPEN },
  { value: 'IN_PROGRESS', label: CASE_STATUS_LABELS.IN_PROGRESS },
  { value: 'PENDING', label: 'Pending response' },
  { value: 'RESOLVED', label: CASE_STATUS_LABELS.RESOLVED },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]['value'];

const POLL = 60_000;

export function MyAssignedWorkCard() {
  const { has } = usePermissions();
  const canCases = has(PERMISSIONS.CASE_READ_DEPARTMENT) || has(PERMISSIONS.CASE_READ_ALL);
  const canIssues = has(PERMISSIONS.ASSET_READ_ALL) && has(PERMISSIONS.ASSET_UPDATE);

  const [status, setStatus] = React.useState<StatusFilter>('OUTSTANDING');
  const [priority, setPriority] = React.useState('');
  const [categoryId, setCategoryId] = React.useState('');

  const { catalogue } = useCaseCatalogue(canCases && has(PERMISSIONS.CASE_READ_OWN));
  const categories = React.useMemo(() => flattenCatalogue(catalogue), [catalogue]);

  const summary = useQuery({
    queryKey: ['cases', 'queue', 'summary'],
    queryFn: () => api.get<CaseQueueSummary>('/cases/queue/summary'),
    enabled: canCases,
    refetchInterval: POLL,
    retry: false,
  });

  const cases = useQuery({
    queryKey: ['cases', 'queue', 'list', 'assigned-to-me', { status, priority, categoryId }],
    queryFn: () =>
      api.getPage<CaseRecord>('/cases/queue', {
        query: {
          assignee: 'me',
          live: status === 'OUTSTANDING' ? 'true' : undefined,
          status: status === 'OUTSTANDING' ? undefined : status,
          priority: priority || undefined,
          categoryId: categoryId || undefined,
          sort: 'updatedAt',
          order: 'desc',
          page: 1,
          limit: 10,
        },
      }),
    enabled: canCases,
    refetchInterval: POLL,
    retry: false,
  });

  const issues = useQuery({
    queryKey: ['assets', 'issues', 'OPEN'],
    queryFn: () => api.get<AssetIssueQueueItem[]>('/assets/issues', { query: { status: 'OPEN' } }),
    enabled: canIssues,
    refetchInterval: POLL,
    retry: false,
  });

  if (!canCases && !canIssues) return null;

  /*
   * Read defensively, as `MyCasesCard` does: this card sits among others on
   * the dashboard, and a payload in a shape nobody expected - an older build,
   * a proxy's error body - must cost one empty card, not the whole page.
   */
  const rows = Array.isArray(cases.data?.data) ? cases.data.data : [];
  const openIssues = Array.isArray(issues.data) ? issues.data : [];
  const mine = typeof summary.data?.mine === 'number' ? summary.data.mine : 0;
  const unassigned = typeof summary.data?.unassigned === 'number' ? summary.data.unassigned : 0;
  const outstanding = (canCases ? mine : 0) + (canIssues ? openIssues.length : 0);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="size-4" aria-hidden /> My Assigned Cases &amp; Issues
          <Badge variant={outstanding > 0 ? 'warning' : 'neutral'} aria-label={`${outstanding} outstanding`}>
            {outstanding}
          </Badge>
        </CardTitle>
        {canCases ? (
          <Button variant="ghost" size="sm" asChild>
            <Link to="/case-queue">Open the case queue</Link>
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-4">
        {canCases && unassigned > 0 ? (
          <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[12.5px] text-warning-foreground">
            {unassigned === 1
              ? 'One case in your queue has nobody assigned. '
              : `${unassigned} cases in your queue have nobody assigned. `}
            <Link className="font-medium underline" to="/case-queue?assignee=unassigned">
              Review unassigned
            </Link>
          </p>
        ) : null}

        {canCases ? (
          <section aria-label="Cases assigned to me" className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div role="group" aria-label="Status" className="flex flex-wrap gap-1">
                {STATUS_FILTERS.map((option) => (
                  <Button
                    key={option.value}
                    size="sm"
                    variant={status === option.value ? 'secondary' : 'ghost'}
                    aria-pressed={status === option.value}
                    onClick={() => setStatus(option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              <NativeSelect
                aria-label="Priority"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
                className="w-36"
              >
                <option value="">Any priority</option>
                {CASE_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {CASE_PRIORITY_LABELS[p]}
                  </option>
                ))}
              </NativeSelect>
              {categories.length > 0 ? (
                <NativeSelect
                  aria-label="Case type"
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.target.value)}
                  className="w-56"
                >
                  <option value="">Any case type</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </NativeSelect>
              ) : null}
            </div>

            {cases.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : cases.isError ? (
              <ErrorState error={cases.error} onRetry={() => void cases.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState
                className="px-0 py-2"
                icon={ClipboardList}
                title="Nothing assigned to you"
                description={
                  status === 'OUTSTANDING'
                    ? 'Cases handed to you will appear here.'
                    : 'No cases assigned to you match these filters.'
                }
              />
            ) : (
              <TableWrapper>
                <Table>
                  <THead>
                    <TR>
                      <TH>Case</TH>
                      <TH>Subject</TH>
                      <TH>Category</TH>
                      <TH>Department</TH>
                      <TH>Reported by</TH>
                      <TH>Priority</TH>
                      <TH>Status</TH>
                      <TH>Assigned</TH>
                      <TH>Updated</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((row) => (
                      <TR key={row.id}>
                        <TD className="whitespace-nowrap font-medium">
                          <Link className="text-primary hover:underline" to={`/case-queue/${row.id}`}>
                            {row.caseNumber}
                          </Link>
                        </TD>
                        <TD className="max-w-64 truncate">
                          <Link className="hover:underline" to={`/case-queue/${row.id}`}>
                            {row.subject}
                          </Link>
                        </TD>
                        <TD>
                          {row.categoryName}
                          {row.subcategoryName ? ` · ${row.subcategoryName}` : ''}
                        </TD>
                        <TD>{row.departmentName}</TD>
                        <TD>{row.requesterName}</TD>
                        <TD>
                          <Badge variant={CASE_PRIORITY_TONE[row.priority]}>
                            {CASE_PRIORITY_LABELS[row.priority]}
                          </Badge>
                        </TD>
                        <TD>
                          <Badge variant={CASE_STATUS_TONE[row.status]}>
                            {CASE_STATUS_LABELS[row.status]}
                          </Badge>
                        </TD>
                        <TD className="whitespace-nowrap">{caseDay(row.assignedAt)}</TD>
                        <TD className="whitespace-nowrap">{formatRelative(row.updatedAt)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrapper>
            )}
          </section>
        ) : null}

        {canIssues ? (
          <section aria-label="Open asset issues" className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-[13px] font-semibold">
                <Wrench className="size-4" aria-hidden /> Open asset issues
                <Badge variant={openIssues.length > 0 ? 'warning' : 'neutral'}>{openIssues.length}</Badge>
              </h3>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/assets/issues">Issue queue</Link>
              </Button>
            </div>
            {issues.isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : issues.isError ? (
              <ErrorState error={issues.error} onRetry={() => void issues.refetch()} />
            ) : openIssues.length === 0 ? (
              <p className="text-[12.5px] text-muted-foreground">No open asset issues.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {openIssues.slice(0, 5).map((issue) => (
                  <li key={issue.id}>
                    <Link
                      to={`/assets/issues?issue=${encodeURIComponent(issue.id)}`}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-2 text-[12.5px] hover:bg-accent/50"
                    >
                      <span className="min-w-0">
                        <span className="font-medium">{issue.asset.assetTag}</span>
                        <span className="text-muted-foreground"> · {issue.reason}</span>
                      </span>
                      <span className="text-muted-foreground">
                        {issue.reportedByEmployee?.fullName ?? issue.reportedBy?.fullName ?? '—'} ·{' '}
                        {formatRelative(issue.createdAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
