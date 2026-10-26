import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  APPROVAL_STATUS_LABELS,
  APPROVAL_SUBJECT_LABELS,
  ASSET_ISSUE_STATUS_LABELS,
  CASE_PRIORITY_LABELS,
  CASE_STATUS_LABELS,
  LOAN_KIND_LABELS,
  PERMISSIONS,
  type ApprovalListItem,
  type AssetIssueQueueItem,
  type CaseRecord,
  type LeaveRequestRecord,
  type ApprovalStatus,
  type LoanRecord,
  type Permission,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import { CASE_PRIORITY_TONE, CASE_STATUS_TONE } from '@/features/cases/case-shared';
import { LOAN_STATUS_TONE, isoMonth, money } from '@/features/employment/employment-shared';

/**
 * The company dashboard's "what is moving" tables: the latest cases, leave
 * requests, loans and advances, asset issues, and the approvals waiting on the
 * reader.
 *
 * Every table reads the same list endpoint its own screen reads, first page
 * only, so a figure here can never disagree with the screen behind "View all".
 * Each is drawn only for a reader holding the grant that screen's route needs,
 * and the endpoint narrows the rows by the reader's data scope regardless -
 * hiding a table removes a signpost, never a right.
 */

const ROWS = 5;

/** The approvals screen's tones, restated rather than imported with its page. */
const APPROVAL_STATUS_TONE: Record<ApprovalStatus, 'warning' | 'success' | 'destructive' | 'neutral'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'destructive',
  CANCELLED: 'neutral',
};

/** Short "12 Oct" / "12 Oct – 14 Oct" for leave dates, read as calendar days. */
function dayMonth(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

function dateSpan(start: string, end: string): string {
  return start.slice(0, 10) === end.slice(0, 10)
    ? dayMonth(start)
    : `${dayMonth(start)} – ${dayMonth(end)}`;
}

function initialsOf(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''))
    .toUpperCase();
}

/** A stable hue per name, so the same person keeps the same chip colour. */
const AVATAR_COLOURS = [
  'var(--chart-leave)',
  'var(--chart-half-day)',
  'var(--chart-present)',
  'var(--chart-late)',
  'var(--chart-absent)',
  'var(--primary)',
];

function Person({ name }: { name: string | null | undefined }) {
  const key = [...(name ?? '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const colour = AVATAR_COLOURS[key % AVATAR_COLOURS.length];
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className="grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white"
        style={{ backgroundColor: colour }}
        aria-hidden
      >
        {initialsOf(name)}
      </span>
      <span className="truncate">{name ?? '—'}</span>
    </span>
  );
}

// ------------------------------------------------------------------ shell

function TableCard({
  title,
  to,
  loading,
  error,
  onRetry,
  empty,
  head,
  children,
}: {
  title: string;
  to: string;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  empty: string;
  head: string[];
  children: React.ReactNode;
}) {
  const count = React.Children.count(children);
  return (
    <section
      aria-label={title}
      className="flex h-full min-w-0 flex-col rounded-2xl border border-border bg-card shadow-xs"
    >
      <header className="flex items-center justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
        <h2 className="truncate text-[16px] font-semibold tracking-tight">{title}</h2>
        <Button asChild variant="outline" size="sm">
          <Link to={to}>View all</Link>
        </Button>
      </header>
      <div className="min-w-0 flex-1 overflow-x-auto px-2 pb-3 sm:px-3">
        {error ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : (
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="bg-surface-muted text-left text-[11.5px] font-semibold text-muted-foreground">
                {head.map((h, i) => (
                  <th
                    key={h}
                    scope="col"
                    className={`whitespace-nowrap px-2 py-2 ${i === 0 ? 'rounded-l-lg' : ''} ${
                      i === head.length - 1 ? 'rounded-r-lg' : ''
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading
                ? Array.from({ length: 4 }, (_, r) => (
                    <tr key={r}>
                      {head.map((h) => (
                        <td key={h} className="px-2.5 py-3">
                          <Skeleton className="h-4 w-full max-w-24" />
                        </td>
                      ))}
                    </tr>
                  ))
                : children}
              {!loading && count === 0 ? (
                <tr>
                  <td colSpan={head.length} className="px-2.5 py-8 text-center text-muted-foreground">
                    {empty}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

/** A row that opens its record. Keyboard reachable through the first cell's link. */
function Row({ to, children }: { to: string; children: React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <tr
      className="cursor-pointer transition-colors hover:bg-accent/60"
      onClick={(e) => {
        // The cell link handles its own click; this covers the rest of the row.
        if ((e.target as HTMLElement).closest('a')) return;
        navigate(to);
      }}
    >
      {children}
    </tr>
  );
}

const td = 'px-2 py-2.5 align-middle';

// ------------------------------------------------------------------ tables

function RecentCases() {
  const query = useQuery({
    queryKey: ['dashboard', 'cases'],
    queryFn: () => api.getPage<CaseRecord>('/cases/queue', { query: { page: 1, limit: ROWS } }),
  });
  const rows = query.data?.data ?? [];
  return (
    <TableCard
      title="Recent cases"
      to="/case-queue"
      loading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      empty="No cases yet."
      head={['#', 'Title', 'Category', 'Employee', 'Status', 'Priority', 'Updated']}
    >
      {rows.map((c) => (
        <Row key={c.id} to={`/case-queue/${c.id}`}>
          <td className={`${td} whitespace-nowrap font-medium`}>
            <Link to={`/case-queue/${c.id}`} className="hover:underline">
              {c.caseNumber}
            </Link>
          </td>
          <td className={`${td} max-w-48 truncate`}>{c.subject}</td>
          <td className={`${td} max-w-36 truncate text-muted-foreground`}>
            {c.subcategoryName ?? c.categoryName}
          </td>
          <td className={`${td} max-w-40`}>
            <Person name={c.requesterName} />
          </td>
          <td className={td}>
            <Badge variant={CASE_STATUS_TONE[c.status]}>{CASE_STATUS_LABELS[c.status]}</Badge>
          </td>
          <td className={td}>
            <Badge variant={CASE_PRIORITY_TONE[c.priority]}>{CASE_PRIORITY_LABELS[c.priority]}</Badge>
          </td>
          <td className={`${td} whitespace-nowrap text-muted-foreground`}>
            {formatRelative(c.updatedAt)}
          </td>
        </Row>
      ))}
    </TableCard>
  );
}

function LeaveRequests() {
  const query = useQuery({
    queryKey: ['dashboard', 'leave'],
    queryFn: () =>
      api.getPage<LeaveRequestRecord>('/leave/requests', {
        query: { page: 1, limit: ROWS, view: 'all' },
      }),
  });
  const rows = query.data?.data ?? [];
  return (
    <TableCard
      title="Leave requests"
      to="/leave/requests"
      loading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      empty="No leave requests yet."
      head={['Employee', 'Leave type', 'Dates', 'Status']}
    >
      {rows.map((r) => (
        <Row key={r.id} to="/leave/requests">
          <td className={`${td} max-w-40`}>
            <Person name={r.employeeName} />
          </td>
          <td className={`${td} max-w-32 truncate text-muted-foreground`}>{r.leaveTypeName}</td>
          <td className={`${td} whitespace-nowrap`}>{dateSpan(r.startDate, r.endDate)}</td>
          <td className={td}>
            <Badge variant={APPROVAL_STATUS_TONE[r.status]}>{APPROVAL_STATUS_LABELS[r.status]}</Badge>
          </td>
        </Row>
      ))}
    </TableCard>
  );
}

function LoansAndAdvances() {
  const query = useQuery({
    queryKey: ['dashboard', 'loans'],
    queryFn: () =>
      api.getPage<LoanRecord>('/loans', { query: { page: 1, limit: ROWS, view: 'all' } }),
  });
  const rows = query.data?.data ?? [];
  return (
    <TableCard
      title="Loans & salary advances"
      to="/loans"
      loading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      empty="No loans or advances yet."
      head={['Employee', 'Amount', 'Status', 'Next deduction']}
    >
      {rows.map((l) => (
        <Row key={l.id} to="/loans">
          <td className={`${td} max-w-40`}>
            <Person name={l.employeeName} />
            <span className="mt-0.5 block pl-8 text-[11px] text-muted-foreground">
              {LOAN_KIND_LABELS[l.kind]}
            </span>
          </td>
          <td className={`${td} whitespace-nowrap tabular`}>{money(l.principalAmount, l.currency)}</td>
          <td className={td}>
            {/* The server's label, so this reads exactly as the loan screens do. */}
            <Badge variant={LOAN_STATUS_TONE[l.status]}>{l.statusLabel}</Badge>
          </td>
          <td className={`${td} whitespace-nowrap text-muted-foreground`}>
            {l.nextDueMonth ? isoMonth(l.nextDueMonth) : '—'}
          </td>
        </Row>
      ))}
    </TableCard>
  );
}

function AssetIssues() {
  const query = useQuery({
    queryKey: ['dashboard', 'asset-issues'],
    // ALL is newest first; OPEN is oldest first, which is the work order for
    // the issues screen but not "what just happened".
    queryFn: () => api.get<AssetIssueQueueItem[]>('/assets/issues', { query: { status: 'ALL' } }),
  });
  const rows = (query.data ?? []).slice(0, ROWS);
  return (
    <TableCard
      title="Asset issues"
      to="/assets/issues"
      loading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      empty="No asset issues reported."
      head={['Asset', 'Issue', 'Employee', 'Status']}
    >
      {rows.map((i) => {
        const to = `/assets/issues?issue=${encodeURIComponent(i.id)}`;
        return (
          <Row key={i.id} to={to}>
            <td className={`${td} max-w-36`}>
              <Link to={to} className="block truncate font-medium hover:underline">
                {i.asset.name}
              </Link>
              <span className="block truncate text-[11px] text-muted-foreground">
                {i.asset.assetTag}
              </span>
            </td>
            <td className={`${td} max-w-32 truncate text-muted-foreground`}>{i.reason}</td>
            <td className={`${td} max-w-32`}>
              <Person name={i.reportedByEmployee?.fullName ?? i.reportedBy?.fullName} />
            </td>
            <td className={td}>
              <Badge variant={i.status === 'OPEN' ? 'warning' : 'success'}>
                {ASSET_ISSUE_STATUS_LABELS[i.status]}
              </Badge>
            </td>
          </Row>
        );
      })}
    </TableCard>
  );
}

function PendingApprovals() {
  const query = useQuery({
    queryKey: ['dashboard', 'approvals'],
    queryFn: () =>
      api.getPage<ApprovalListItem>('/approvals', {
        query: { page: 1, limit: ROWS, view: 'inbox', status: 'PENDING' },
      }),
  });
  const rows = query.data?.data ?? [];
  return (
    <TableCard
      title="Pending approvals"
      to="/approvals"
      loading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      empty="Nothing is waiting on you."
      head={['Type', 'Employee', 'Details', 'Received']}
    >
      {rows.map((a) => (
        <Row key={a.id} to={`/approvals/${a.id}`}>
          <td className={`${td} whitespace-nowrap font-medium`}>
            <Link to={`/approvals/${a.id}`} className="hover:underline">
              {APPROVAL_SUBJECT_LABELS[a.subjectType] ?? a.title}
            </Link>
          </td>
          <td className={`${td} max-w-36`}>
            <Person name={a.requesterName} />
          </td>
          <td className={`${td} max-w-40 truncate text-muted-foreground`}>{a.summary ?? a.title}</td>
          <td className={`${td} whitespace-nowrap text-muted-foreground`}>
            {formatRelative(a.createdAt)}
          </td>
        </Row>
      ))}
    </TableCard>
  );
}

// ------------------------------------------------------------------ layout

/** Each table with the grant(s) its own screen's route requires (ANY of). */
const TABLES: Array<{ key: string; permission: Permission[]; render: () => React.ReactNode }> = [
  {
    key: 'cases',
    permission: [PERMISSIONS.CASE_READ_DEPARTMENT, PERMISSIONS.CASE_READ_ALL],
    render: () => <RecentCases />,
  },
  { key: 'leave', permission: [PERMISSIONS.LEAVE_READ], render: () => <LeaveRequests /> },
  {
    key: 'loans',
    permission: [PERMISSIONS.LOAN_MANAGE, PERMISSIONS.LOAN_APPROVE],
    render: () => <LoansAndAdvances />,
  },
  { key: 'asset-issues', permission: [PERMISSIONS.ASSET_READ_ALL], render: () => <AssetIssues /> },
  { key: 'approvals', permission: [PERMISSIONS.APPROVAL_READ], render: () => <PendingApprovals /> },
];

export function DashboardActivity() {
  const { has } = usePermissions();
  const visible = TABLES.filter((t) => t.permission.some((p) => has(p)));
  if (visible.length === 0) return null;

  // Reference layout: the two widest tables share the first row, the rest
  // share the second. Whatever is missing, the rows close up.
  const [first, ...rest] = visible;
  const wide = first?.key === 'cases';
  const top = wide ? visible.slice(0, 2) : [];
  const bottom = wide ? visible.slice(2) : [first!, ...rest];

  return (
    <div className="space-y-4">
      {top.length > 0 ? (
        <div
          className={top.length === 2 ? 'grid gap-4 min-[1800px]:grid-cols-[1.35fr_1fr]' : 'grid gap-4'}
        >
          {top.map((t) => (
            <React.Fragment key={t.key}>{t.render()}</React.Fragment>
          ))}
        </div>
      ) : null}
      {bottom.length > 0 ? (
        /*
         * Three across only where three fit without clipping a column; below
         * that two across, and an odd table out takes the full row rather
         * than leaving a hole beside it.
         */
        <div
          className={
            bottom.length >= 3
              ? 'grid gap-4 lg:grid-cols-2 min-[1800px]:grid-cols-3'
              : bottom.length === 2
                ? 'grid gap-4 lg:grid-cols-2'
                : 'grid gap-4'
          }
        >
          {bottom.map((t, index) => (
            <div
              key={t.key}
              className={
                bottom.length % 2 === 1 && index === bottom.length - 1 && bottom.length > 1
                  ? 'min-w-0 lg:col-span-2 min-[1800px]:col-span-1'
                  : 'min-w-0'
              }
            >
              {t.render()}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
