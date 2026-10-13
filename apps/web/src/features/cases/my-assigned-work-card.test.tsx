// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { PERMISSIONS } from '@hrms/shared';

/**
 * "My Assigned Cases & Issues", and the two doors into the desk's view of a
 * case that the notifications use.
 *
 *   - the card is for people who work a desk or the asset register, and is
 *     absent - without a single request - for everybody else;
 *   - its rows are the server's `assignee=me` answer, filtered by the server,
 *     and each opens the desk's view of exactly that case;
 *   - unassigned cases in the caller's queue are called out with a way in;
 *   - an old "assigned to you" link to `/cases/:id` 404s for an assignee who
 *     is not the requester, and is sent on to the desk's view.
 */

let permissions = new Set<string>();

vi.mock('@/features/auth/session-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth/session-context')>();
  return {
    ...actual,
    usePermissions: () => ({
      has: (p: string) => permissions.has(p),
      hasAny: (list: string[]) => list.some((p) => permissions.has(p)),
      hasAll: (list: string[]) => list.every((p) => permissions.has(p)),
    }),
    useAuthenticatedSession: () => ({
      user: { id: 'user-me', fullName: 'Aziz Qadir' },
      company: { currency: 'PKR' },
    }),
    useSession: () => ({
      session: { user: { id: 'user-me' }, company: { currency: 'PKR' } },
      permissions,
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => Promise.resolve(),
      clear: () => {},
    }),
  };
});

import { MyAssignedWorkCard } from './my-assigned-work-card';
import { CaseDetailPage } from './case-detail-page';
import { CaseQueuePage } from './case-queue-page';

const DESK = [
  PERMISSIONS.CASE_READ_OWN,
  PERMISSIONS.CASE_READ_DEPARTMENT,
  PERMISSIONS.CASE_UPDATE,
  PERMISSIONS.CASE_RESPOND,
];
const ASSETS = [PERMISSIONS.ASSET_READ_ALL, PERMISSIONS.ASSET_UPDATE];

const ROW = {
  id: 'case-21',
  caseNumber: 'CASE-2026-000021',
  subject: 'Laptop screen flickers',
  departmentId: 'dep-it',
  departmentName: 'IT',
  categoryId: 'cat-laptop',
  categoryName: 'Laptop',
  subcategoryId: 'sub-screen',
  subcategoryName: 'Screen',
  priority: 'HIGH',
  status: 'IN_PROGRESS',
  requesterEmployeeId: 'emp-1',
  requesterName: 'Ayesha Khan',
  requesterEmployeeNumber: '1001',
  assignedUserId: 'user-me',
  assignedToName: 'Aziz Qadir',
  assignedAt: '2026-10-09T06:41:31.000Z',
  messageCount: 2,
  attachmentCount: 0,
  createdAt: '2026-10-09T06:00:00.000Z',
  updatedAt: '2026-10-10T08:00:00.000Z',
  lastMessageAt: null,
  resolvedAt: null,
  closedAt: null,
  canReply: false,
  canReopen: false,
  canAttach: false,
};

const ISSUE = {
  id: 'incident-9',
  assetId: 'asset-1',
  assignmentId: null,
  kind: 'ISSUE_REPORTED',
  occurredOn: '2026-10-07',
  reason: 'Charger does not work',
  description: null,
  notes: null,
  reportedBy: null,
  reportedByEmployee: { id: 'emp-2', fullName: 'Ahmed Khan' },
  resolvedAt: null,
  resolutionNotes: null,
  createdAt: '2026-10-07T05:00:00.000Z',
  status: 'OPEN',
  asset: { id: 'asset-1', assetTag: 'IT-LAP-0042', name: 'Dell Latitude' },
  resolvedBy: null,
};

let calls: string[] = [];

function serve(options: { unassigned?: number; detailStatus?: number } = {}) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const path = url.split('?')[0] ?? '';
      const json = (body: unknown, status = 200) =>
        Promise.resolve({
          ok: status < 400,
          status,
          text: () => Promise.resolve(JSON.stringify(body)),
        } as Response);

      if (path.endsWith('/cases/queue/summary')) {
        return json({
          data: {
            live: 4,
            unassigned: options.unassigned ?? 0,
            mine: 1,
            urgent: 1,
            counts: { OPEN: 0, IN_PROGRESS: 1, PENDING: 0, ON_HOLD: 0, RESOLVED: 0, CLOSED: 0, REOPENED: 0 },
          },
        });
      }
      if (path.endsWith('/cases/queue/agents')) return json({ data: [] });
      if (path.endsWith('/cases/queue')) {
        return json({ data: [ROW], meta: { page: 1, limit: 10, total: 1, totalPages: 1 } });
      }
      if (path.endsWith('/cases/categories')) {
        return json({
          data: [
            {
              departmentId: 'dep-it',
              departmentName: 'IT',
              categories: [{ id: 'cat-laptop', name: 'Laptop', description: null, subcategories: [] }],
            },
          ],
        });
      }
      if (path.endsWith('/assets/issues')) return json({ data: [ISSUE] });
      if (/\/cases\/[^/]+$/.test(path)) {
        return json(
          { error: { code: 'NOT_FOUND', message: 'Case not found.' } },
          options.detailStatus ?? 404,
        );
      }
      return json({ data: null });
    }),
  );
}

function renderAt(path: string, element: React.ReactElement, routePath = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element} />
          <Route path="/case-queue/:id" element={<DeskStub />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function DeskStub() {
  const { id } = useParams();
  return <p>Desk case {id}</p>;
}

const queueCalls = () => calls.filter((url) => url.split('?')[0]!.endsWith('/cases/queue'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  permissions = new Set();
});

describe('My Assigned Cases & Issues', () => {
  it('is absent, and asks nothing, for somebody who works no desk', () => {
    permissions = new Set([PERMISSIONS.CASE_READ_OWN, PERMISSIONS.CASE_CREATE]);
    serve();

    const { container } = renderAt('/', <MyAssignedWorkCard />);

    expect(container).toBeEmptyDOMElement();
    expect(calls).toEqual([]);
  });

  it('lists the cases assigned to the caller, each opening the desk view of that case', async () => {
    permissions = new Set(DESK);
    serve();
    renderAt('/', <MyAssignedWorkCard />);

    expect(await screen.findByText('My Assigned Cases & Issues')).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: 'CASE-2026-000021' });
    expect(link).toHaveAttribute('href', '/case-queue/case-21');

    const row = link.closest('tr')!;
    for (const text of ['Laptop screen flickers', 'Laptop · Screen', 'IT', 'Ayesha Khan', 'High', 'In progress']) {
      expect(within(row).getByText(text)).toBeInTheDocument();
    }
    // The outstanding count is the server's "live and mine".
    expect(screen.getByLabelText('1 outstanding')).toBeInTheDocument();

    // Asked of the server as "mine, still open" - not filtered here.
    const first = new URL(queueCalls()[0]!, 'http://localhost');
    expect(first.searchParams.get('assignee')).toBe('me');
    expect(first.searchParams.get('live')).toBe('true');
    // No asset grants, so no asset issue request.
    expect(calls.some((url) => url.includes('/assets/issues'))).toBe(false);
  });

  it('sends the status and priority filters to the server', async () => {
    permissions = new Set(DESK);
    serve();
    renderAt('/', <MyAssignedWorkCard />);
    await screen.findByRole('link', { name: 'CASE-2026-000021' });

    await userEvent.click(screen.getByRole('button', { name: 'Pending response' }));
    await waitFor(() => {
      const last = new URL(queueCalls().at(-1)!, 'http://localhost');
      expect(last.searchParams.get('status')).toBe('PENDING');
      expect(last.searchParams.get('live')).toBeNull();
    });

    await userEvent.selectOptions(screen.getByLabelText('Priority'), 'URGENT');
    await waitFor(() => {
      const last = new URL(queueCalls().at(-1)!, 'http://localhost');
      expect(last.searchParams.get('priority')).toBe('URGENT');
    });
  });

  it('calls out unassigned cases in the caller’s queue, with a way in', async () => {
    permissions = new Set(DESK);
    serve({ unassigned: 2 });
    renderAt('/', <MyAssignedWorkCard />);

    expect(await screen.findByText(/2 cases in your queue have nobody assigned/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review unassigned' })).toHaveAttribute(
      'href',
      '/case-queue?assignee=unassigned',
    );
  });

  it('shows open asset issues to whoever works the register', async () => {
    permissions = new Set(ASSETS);
    serve();
    renderAt('/', <MyAssignedWorkCard />);

    const link = await screen.findByRole('link', { name: /IT-LAP-0042/ });
    expect(link).toHaveAttribute('href', '/assets/issues?issue=incident-9');
    expect(screen.getByLabelText('1 outstanding')).toBeInTheDocument();
    // No desk grant: no case section and no case request.
    expect(screen.queryByRole('region', { name: 'Cases assigned to me' })).toBeNull();
    expect(calls.some((url) => url.includes('/cases/'))).toBe(false);
  });
});

describe('the doors into the desk view', () => {
  it('sends a desk member from an old /cases link on to the desk view of that case', async () => {
    permissions = new Set(DESK);
    serve({ detailStatus: 404 });
    renderAt('/cases/case-21', <CaseDetailPage />, '/cases/:id');

    expect(await screen.findByText('Desk case case-21')).toBeInTheDocument();
  });

  it('leaves an ordinary employee on the not-found state', async () => {
    permissions = new Set([PERMISSIONS.CASE_READ_OWN]);
    serve({ detailStatus: 404 });
    renderAt('/cases/case-21', <CaseDetailPage />, '/cases/:id');

    expect(await screen.findByRole('link', { name: 'Back to my cases' })).toBeInTheDocument();
    expect(screen.queryByText(/Desk case/)).toBeNull();
  });

  it('opens the queue on unassigned when the link says so', async () => {
    permissions = new Set(DESK);
    serve();
    renderAt('/case-queue?assignee=unassigned', <CaseQueuePage />, '/case-queue');

    await waitFor(() => expect(queueCalls().length).toBeGreaterThan(0));
    const first = new URL(queueCalls()[0]!, 'http://localhost');
    expect(first.searchParams.get('assignee')).toBe('unassigned');
  });
});
