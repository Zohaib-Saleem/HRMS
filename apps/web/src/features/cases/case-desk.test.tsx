// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PERMISSIONS } from '@hrms/shared';

/**
 * The desk's screens.
 *
 * What is worth testing in a browser here is narrower than what the API tests
 * cover, and it is mostly one thing: the difference between a reply and an
 * internal note must be impossible to get wrong by accident. So these pin that
 * the choice is explicit, that the screen says who will read what is being
 * written, and that the flag actually travels with the request.
 *
 * Beyond that:
 *
 *   - the controls come from `abilities` on the record - the server's answer,
 *     status included - so moving those flags moves the buttons. A screen that
 *     started deciding from a permission list would fail these;
 *   - `nextStatuses` is the workflow, and the only statuses offered are the
 *     ones the server sent. The browser holds no second copy of that map;
 *   - the queue's filtering is the server's, exactly as the employee list's is.
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
      user: { id: 'user-me', fullName: 'Bilal Ahmed' },
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

import { CaseQueuePage } from './case-queue-page';
import { CaseWorkPage } from './case-work-page';

const DESK = [
  PERMISSIONS.CASE_READ_DEPARTMENT,
  PERMISSIONS.CASE_ASSIGN,
  PERMISSIONS.CASE_UPDATE,
  PERMISSIONS.CASE_RESPOND,
  PERMISSIONS.CASE_NOTE_INTERNAL,
];

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const CATALOGUE = [
  {
    departmentId: 'dep-fin',
    departmentName: 'Finance',
    categories: [
      {
        id: 'cat-salary',
        name: 'Salary',
        description: null,
        subcategories: [{ id: 'sub-amount', name: 'Incorrect amount', description: null }],
      },
    ],
  },
  {
    departmentId: 'dep-it',
    departmentName: 'IT',
    categories: [{ id: 'cat-email', name: 'Email', description: null, subcategories: [] }],
  },
];

const AGENTS = [
  { userId: 'user-me', name: 'Bilal Ahmed', departmentName: 'IT' },
  { userId: 'user-sana', name: 'Sana Iqbal', departmentName: 'IT' },
];

const queueRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'case-1',
  caseNumber: 'CASE-2026-000001',
  subject: 'Laptop will not start',
  departmentId: 'dep-it',
  departmentName: 'IT',
  categoryId: 'cat-email',
  categoryName: 'Email',
  subcategoryId: null,
  subcategoryName: null,
  priority: 'HIGH',
  status: 'OPEN',
  requesterEmployeeId: 'emp-1',
  requesterName: 'Ayesha Khan',
  requesterEmployeeNumber: '1001',
  assignedUserId: null,
  assignedToName: null,
  assignedAt: null,
  messageCount: 1,
  attachmentCount: 0,
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-09-01T09:00:00.000Z',
  lastMessageAt: null,
  resolvedAt: null,
  closedAt: null,
  canReply: false,
  canReopen: false,
  canAttach: false,
  ...overrides,
});

const ABILITIES = {
  canAssign: true,
  canUpdate: true,
  canRespond: true,
  canNote: true,
  canRoute: true,
  nextStatuses: ['IN_PROGRESS', 'PENDING', 'ON_HOLD', 'RESOLVED', 'CLOSED'],
};

const deskDetail = (overrides: Record<string, unknown> = {}) => ({
  ...queueRow(),
  description: 'Black screen after the login sound since this morning.',
  requesterEmail: 'ayesha@example.com',
  requesterDepartmentName: 'Finance',
  abilities: { ...ABILITIES },
  messages: [],
  attachments: [],
  ...overrides,
});

let fetchMock: ReturnType<typeof vi.fn>;
let calls: Array<{ method: string; url: string; body: unknown }> = [];

interface ServeOptions {
  rows?: unknown[];
  detail?: unknown;
  detailStatus?: number;
}

function serve(options: ServeOptions = {}) {
  calls = [];
  const rows = options.rows ?? [queueRow()];

  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });

    const path = url.split('?')[0] ?? '';

    if (path.endsWith('/cases/categories')) return respond({ data: CATALOGUE });
    if (path.endsWith('/cases/queue/agents')) return respond({ data: AGENTS });
    if (path.endsWith('/cases/queue/summary')) {
      return respond({
        data: {
          live: 6,
          unassigned: 2,
          mine: 3,
          urgent: 1,
          counts: {
            OPEN: 2,
            IN_PROGRESS: 2,
            PENDING: 1,
            ON_HOLD: 1,
            RESOLVED: 0,
            CLOSED: 0,
            REOPENED: 0,
          },
        },
      });
    }
    if (/\/cases\/queue\/[^/]+\/(messages|status|priority|assign|route)$/.test(path)) {
      return respond({ data: { id: 'msg-new', internal: false } }, 201);
    }
    if (/\/cases\/queue\/[^/]+$/.test(path)) {
      if (options.detailStatus && options.detailStatus >= 400) {
        return respond(
          { error: { code: 'NOT_FOUND', message: 'Case was not found.' } },
          options.detailStatus,
        );
      }
      return respond({ data: options.detail ?? deskDetail() });
    }
    if (path.endsWith('/cases/queue')) {
      return respond({
        data: rows,
        meta: { page: 1, limit: 20, total: rows.length, totalPages: 1 },
      });
    }
    return respond({ data: [] });
  });

  vi.stubGlobal('fetch', fetchMock);
}

function renderPage(ui: React.ReactNode, path = '/case-queue') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/case-queue" element={ui} />
          <Route path="/case-queue/:id" element={ui} />
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const queueCall = () =>
  calls.filter((call) => call.method === 'GET' && /\/cases\/queue\?/.test(call.url)).at(-1);

const posted = (suffix: string) =>
  calls.filter((call) => call.method === 'POST' && call.url.includes(suffix)).at(-1);

beforeEach(() => {
  permissions = new Set(DESK);
  serve();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the queue', () => {
  it('shows who raised each case, which the employee list has no column for', async () => {
    renderPage(<CaseQueuePage />);

    expect(await screen.findByText('CASE-2026-000001')).toBeInTheDocument();
    expect(screen.getByText('Ayesha Khan')).toBeInTheDocument();
    expect(screen.getByText('1001')).toBeInTheDocument();
    expect(screen.getByText('Nobody yet')).toBeInTheDocument();
  });

  it('opens on what is still live, and says so in the request', async () => {
    renderPage(<CaseQueuePage />);

    await waitFor(() => expect(queueCall()).toBeTruthy());
    expect(queueCall()?.url).toContain('live=true');
  });

  it('sends every filter to the server', async () => {
    const user = userEvent.setup();
    renderPage(<CaseQueuePage />);
    await screen.findByText('CASE-2026-000001');

    await user.selectOptions(screen.getByLabelText('Assigned to'), 'me');
    await waitFor(() => expect(queueCall()?.url).toContain('assignee=me'));

    await user.selectOptions(screen.getByLabelText('Priority'), 'URGENT');
    await waitFor(() => expect(queueCall()?.url).toContain('priority=URGENT'));

    await user.selectOptions(screen.getByLabelText('Show'), 'all');
    // "Everything" drops the clause rather than sending live=false.
    await waitFor(() => expect(queueCall()?.url).not.toContain('live='));
  });

  it('counts the queue from the summary endpoint, not from the page of rows', async () => {
    renderPage(<CaseQueuePage />);

    // One row on screen; six open in the caller's scope.
    expect(await screen.findByText('6')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('does not ask for the assignable people when it cannot assign', async () => {
    permissions = new Set([PERMISSIONS.CASE_READ_DEPARTMENT]);
    renderPage(<CaseQueuePage />);

    await screen.findByText('CASE-2026-000001');
    expect(calls.some((call) => call.url.includes('/cases/queue/agents'))).toBe(false);
  });
});

describe('working a case', () => {
  it('marks internal notes as internal, and says who cannot see them', async () => {
    serve({
      detail: deskDetail({
        messages: [
          {
            id: 'msg-1',
            senderUserId: 'user-emp',
            senderName: 'Ayesha Khan',
            fromRequester: true,
            message: 'It is still dead.',
            internal: false,
            attachments: [],
            createdAt: '2026-09-01T10:00:00.000Z',
          },
          {
            id: 'msg-2',
            senderUserId: 'user-me',
            senderName: 'Bilal Ahmed',
            fromRequester: false,
            message: 'Motherboard, by the look of it.',
            internal: true,
            attachments: [],
            createdAt: '2026-09-01T10:05:00.000Z',
          },
        ],
      }),
    });
    renderPage(<CaseWorkPage />, '/case-queue/case-1');

    expect(await screen.findByText('Motherboard, by the look of it.')).toBeInTheDocument();
    expect(screen.getByText('Internal')).toBeInTheDocument();
  });

  it('sends a reply as a reply and a note as a note', async () => {
    const user = userEvent.setup();
    renderPage(<CaseWorkPage />, '/case-queue/case-1');

    await screen.findByRole('tab', { name: /reply to requester/i });

    await user.type(screen.getByLabelText('Reply to the requester'), 'Bring it to the desk.');
    await user.click(screen.getByRole('button', { name: /send reply/i }));

    await waitFor(() => expect(posted('/messages')).toBeTruthy());
    expect(posted('/messages')?.body).toMatchObject({
      message: 'Bring it to the desk.',
      internal: false,
    });

    await user.click(screen.getByRole('tab', { name: /internal note/i }));
    await user.type(screen.getByLabelText('Internal note'), 'Third one this week.');
    await user.click(screen.getByRole('button', { name: /save internal note/i }));

    await waitFor(() =>
      expect(posted('/messages')?.body).toMatchObject({
        message: 'Third one this week.',
        internal: true,
      }),
    );
  });

  it('names the requester on both sides of that choice', async () => {
    const user = userEvent.setup();
    renderPage(<CaseWorkPage />, '/case-queue/case-1');

    await screen.findByRole('tab', { name: /internal note/i });
    expect(
      screen.getByText('Ayesha Khan sees this on their case and is notified.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /internal note/i }));
    expect(
      screen.getByText('Ayesha Khan will never see this, and is not notified about it.'),
    ).toBeInTheDocument();
  });

  it('offers only the transitions the server sent', async () => {
    serve({
      detail: deskDetail({
        status: 'RESOLVED',
        abilities: { ...ABILITIES, nextStatuses: ['CLOSED', 'REOPENED'] },
      }),
    });
    renderPage(<CaseWorkPage />, '/case-queue/case-1');

    const select = await screen.findByLabelText('Move this case to');
    const options = within(select).getAllByRole('option').map((option) => option.textContent);

    expect(options).toEqual(['Move it to...', 'Closed', 'Reopened']);
    // The workflow is the server's; the browser never re-derives it.
    expect(options).not.toContain('In progress');
  });

  it('asks why before moving a case, and sends the answer', async () => {
    const user = userEvent.setup();
    renderPage(<CaseWorkPage />, '/case-queue/case-1');

    await user.selectOptions(await screen.findByLabelText('Move this case to'), 'ON_HOLD');

    const note = await screen.findByLabelText(/say why/i);
    await user.type(note, 'Waiting on the replacement battery.');
    await user.click(screen.getByRole('button', { name: /move it/i }));

    await waitFor(() => expect(posted('/status')).toBeTruthy());
    expect(posted('/status')?.body).toMatchObject({
      status: 'ON_HOLD',
      note: 'Waiting on the replacement battery.',
      internal: false,
    });
  });

  it('takes a case for the person who clicked Take it', async () => {
    const user = userEvent.setup();
    renderPage(<CaseWorkPage />, '/case-queue/case-1');

    await user.click(await screen.findByRole('button', { name: /take it/i }));

    await waitFor(() => expect(posted('/assign')).toBeTruthy());
    expect(posted('/assign')?.body).toEqual({ assignedUserId: 'user-me' });
  });

  it('puts a case back when nobody is chosen', async () => {
    const user = userEvent.setup();
    serve({ detail: deskDetail({ assignedUserId: 'user-sana', assignedToName: 'Sana Iqbal' }) });
    renderPage(<CaseWorkPage />, '/case-queue/case-1');

    await user.selectOptions(await screen.findByLabelText('Assigned to'), '');

    await waitFor(() => expect(posted('/assign')?.body).toEqual({ assignedUserId: null }));
  });

  it('draws no controls for somebody who may only read', async () => {
    serve({
      detail: deskDetail({
        abilities: {
          canAssign: false,
          canUpdate: false,
          canRespond: false,
          canNote: false,
          canRoute: false,
          nextStatuses: [],
        },
      }),
    });
    renderPage(<CaseWorkPage />, '/case-queue/case-1');

    expect(await screen.findByText('Black screen after the login sound since this morning.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Move this case to')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /internal note/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /re-route/i })).not.toBeInTheDocument();
  });

  it('cannot write a note without the grant, and says nothing about one', async () => {
    serve({ detail: deskDetail({ abilities: { ...ABILITIES, canNote: false } }) });
    renderPage(<CaseWorkPage />, '/case-queue/case-1');

    const noteTab = await screen.findByRole('tab', { name: /internal note/i });
    expect(noteTab).toBeDisabled();
  });

  it('re-routes through the same catalogue the create form uses', async () => {
    const user = userEvent.setup();
    renderPage(<CaseWorkPage />, '/case-queue/case-1');

    await user.click(await screen.findByRole('button', { name: /re-route/i }));

    await user.selectOptions(await screen.findByLabelText(/department/i), 'dep-fin');
    await user.selectOptions(screen.getByLabelText(/^category/i), 'cat-salary');
    await user.click(screen.getByRole('button', { name: /re-route it/i }));

    await waitFor(() => expect(posted('/route')).toBeTruthy());
    expect(posted('/route')?.body).toMatchObject({
      departmentId: 'dep-fin',
      categoryId: 'cat-salary',
    });
  });

  it('shows the not-found state for a case outside the caller\'s queues', async () => {
    serve({ detailStatus: 404 });
    renderPage(<CaseWorkPage />, '/case-queue/case-somebody-elses');

    expect(await screen.findByText(/back to the queue/i)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /internal note/i })).not.toBeInTheDocument();
  });
});
