// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PERMISSIONS } from '@hrms/shared';

/**
 * @mentions in the browser.
 *
 * The API tests pin what a tag may and may not do. These pin the half only a
 * browser has: that `@` opens the search, that what is sent is the ids of the
 * people PICKED - not names scraped from the text - that a tag deleted from the
 * box is dropped, that somebody who cannot open the case cannot be picked, and
 * that a mention on the dashboard opens the exact case.
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
      user: { id: 'user-me', fullName: 'Zohaib Saleem' },
      company: { currency: 'PKR' },
    }),
  };
});

import { CaseWorkPage } from './case-work-page';
import { MentionsCard } from './mentions-card';
import { MessageText, mentionTrigger, pruneMentions } from './case-mentions';
import { notificationLink } from '@/features/notifications/notification-center';

const DESK = [
  PERMISSIONS.CASE_READ_ALL,
  PERMISSIONS.CASE_ASSIGN,
  PERMISSIONS.CASE_UPDATE,
  PERMISSIONS.CASE_RESPOND,
  PERMISSIONS.CASE_NOTE_INTERNAL,
];

const CANDIDATES = [
  {
    userId: 'user-hina',
    name: 'Hina Raza',
    departmentName: 'HR',
    jobTitle: 'HR Officer',
    roleNames: ['HR Manager'],
    canAccess: true,
    reason: null,
  },
  {
    userId: 'user-asad',
    name: 'Asad Mirza',
    departmentName: 'Finance',
    jobTitle: 'Accountant',
    roleNames: ['Finance'],
    canAccess: false,
    reason:
      'Asad Mirza cannot open this case. Tagging does not give access - assign the case to them or route it to their department first.',
  },
];

const detail = (overrides: Record<string, unknown> = {}) => ({
  id: 'case-29',
  caseNumber: 'CASE-2026-000029',
  subject: 'Medical reimbursement',
  departmentId: 'dep-hr',
  departmentName: 'HR',
  categoryId: 'cat-medical',
  categoryName: 'Medical',
  subcategoryId: null,
  subcategoryName: null,
  priority: 'NORMAL',
  status: 'RESOLVED',
  requesterEmployeeId: 'emp-1',
  requesterName: 'Ayesha Khan',
  requesterEmployeeNumber: '1001',
  assignedUserId: null,
  assignedToName: null,
  assignedAt: null,
  messageCount: 0,
  attachmentCount: 0,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  lastMessageAt: null,
  resolvedAt: '2026-10-02T09:00:00.000Z',
  closedAt: null,
  canReply: false,
  canReopen: false,
  canAttach: false,
  description: 'Hospital bill.',
  requesterEmail: 'ayesha@example.com',
  requesterDepartmentName: 'IT',
  abilities: {
    canAssign: true,
    canUpdate: true,
    canRespond: true,
    canNote: true,
    canRoute: true,
    nextStatuses: ['CLOSED', 'REOPENED'],
  },
  messages: [],
  attachments: [],
  ...overrides,
});

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

let calls: Array<{ method: string; url: string; body: unknown }> = [];
let feed: unknown = { items: [], unread: 0 };
let caseDetail: unknown = detail();

function serve() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ method, url, body });
      const path = url.split('?')[0] ?? '';

      if (path.endsWith('/mention-candidates')) {
        const q = new URL(url, 'http://x').searchParams.get('q')?.toLowerCase() ?? '';
        return respond({
          data: CANDIDATES.filter((c) =>
            [c.name, c.jobTitle, c.departmentName, ...c.roleNames].some((f) => f.toLowerCase().includes(q)),
          ),
        });
      }
      if (path.endsWith('/cases/mentions')) return respond({ data: feed });
      if (path.endsWith('/cases/queue/agents')) return respond({ data: [] });
      if (/\/notifications\/[^/]+\/read$/.test(path)) return respond({ data: { ok: true } });
      if (/\/cases\/queue\/[^/]+\/messages$/.test(path)) {
        return respond({ data: { id: 'msg-new', internal: false } }, 201);
      }
      if (/\/cases\/queue\/[^/]+$/.test(path)) return respond({ data: caseDetail });
      return respond({ data: [] });
    }),
  );
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function renderAt(ui: React.ReactNode, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/case-queue/:id" element={<>{ui}<Where /></>} />
          <Route path="*" element={<>{ui}<Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const messagePost = () =>
  calls.filter((c) => c.method === 'POST' && c.url.includes('/messages')).at(-1);

beforeEach(() => {
  permissions = new Set(DESK);
  feed = { items: [], unread: 0 };
  caseDetail = detail();
  serve();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the trigger', () => {
  it('reads the @query before the caret, names with spaces included', () => {
    expect(mentionTrigger('Hi @Hin', 7)).toEqual({ start: 3, query: 'Hin' });
    expect(mentionTrigger('@Hina Ra', 8)).toEqual({ start: 0, query: 'Hina Ra' });
    // An email address is not a tag.
    expect(mentionTrigger('mail hina@example', 17)).toBeNull();
    expect(mentionTrigger('no tag here', 11)).toBeNull();
  });

  it('drops a tag whose name is no longer in the text', () => {
    const picked = [{ userId: 'user-hina', name: 'Hina Raza' }];
    expect(pruneMentions('@Hina Raza please', picked)).toEqual(picked);
    expect(pruneMentions('@Hina please', picked)).toEqual([]);
  });
});

describe('tagging in the composer', () => {
  it('typing @ opens the people search, and the request says which kind of message it is', async () => {
    const user = userEvent.setup();
    renderAt(<CaseWorkPage />, '/case-queue/case-29');

    const box = await screen.findByLabelText('Reply to the requester');
    await user.type(box, '@acc');

    const list = await screen.findByRole('listbox', { name: /people you can tag/i });
    expect(within(list).getByText('Asad Mirza')).toBeInTheDocument();
    const search = calls.filter((c) => c.url.includes('/mention-candidates')).at(-1);
    expect(search?.url).toMatch(/q=acc/);
    expect(search?.url).toMatch(/internal=false/);
  });

  it('picking somebody writes their name and sends their id - after resolution, with no status change', async () => {
    const user = userEvent.setup();
    renderAt(<CaseWorkPage />, '/case-queue/case-29');

    const box = await screen.findByLabelText('Reply to the requester');
    await user.type(box, '@hin');
    await user.click(await screen.findByRole('option', { name: /Hina Raza/ }));
    await user.type(box, 'please process the approved reimbursement.');

    expect(box).toHaveValue('@Hina Raza please process the approved reimbursement.');
    expect(screen.getByText(/Tagging does not assign the case or change its status/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /send reply/i }));
    await waitFor(() => expect(messagePost()).toBeTruthy());
    expect(messagePost()?.body).toEqual({
      message: '@Hina Raza please process the approved reimbursement.',
      internal: false,
      mentionUserIds: ['user-hina'],
    });
    // Nothing but the message was posted: no status change, no assignment.
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url.split('?')[0])).toEqual([
      '/api/v1/cases/queue/case-29/messages',
    ]);
  });

  it('selects with the keyboard', async () => {
    const user = userEvent.setup();
    renderAt(<CaseWorkPage />, '/case-queue/case-29');

    const box = await screen.findByLabelText('Reply to the requester');
    await user.type(box, '@hin');
    await screen.findByRole('option', { name: /Hina Raza/ });
    await user.keyboard('{Enter}');

    expect(box).toHaveValue('@Hina Raza ');
    expect(screen.getByRole('button', { name: 'Untag Hina Raza' })).toBeInTheDocument();
  });

  it('shows why somebody cannot be tagged, and does not let them be picked', async () => {
    const user = userEvent.setup();
    renderAt(<CaseWorkPage />, '/case-queue/case-29');

    const box = await screen.findByLabelText('Reply to the requester');
    await user.type(box, '@accountant');
    const option = await screen.findByRole('option', { name: /Asad Mirza/ });
    expect(option).toHaveAttribute('aria-disabled', 'true');
    expect(within(option).getByText(/cannot open this case/)).toBeInTheDocument();

    await user.click(option);
    expect(box).toHaveValue('@accountant');
    expect(screen.queryByRole('button', { name: 'Untag Asad Mirza' })).not.toBeInTheDocument();
  });

  it('a hand-typed @name is text: no id is sent', async () => {
    const user = userEvent.setup();
    renderAt(<CaseWorkPage />, '/case-queue/case-29');

    const box = await screen.findByLabelText('Reply to the requester');
    await user.type(box, 'Thanks {Escape}');
    await user.type(box, '@Hina Raza{Escape} done');
    await user.click(screen.getByRole('button', { name: /send reply/i }));

    await waitFor(() => expect(messagePost()).toBeTruthy());
    expect(messagePost()?.body).toMatchObject({ mentionUserIds: [] });
  });

  it('deleting a tag from the text drops it from what is sent', async () => {
    const user = userEvent.setup();
    renderAt(<CaseWorkPage />, '/case-queue/case-29');

    const box = await screen.findByLabelText('Reply to the requester');
    await user.type(box, '@hin');
    await user.click(await screen.findByRole('option', { name: /Hina Raza/ }));
    await user.clear(box);
    await user.type(box, 'Never mind.');
    await user.click(screen.getByRole('button', { name: /send reply/i }));

    await waitFor(() => expect(messagePost()).toBeTruthy());
    expect(messagePost()?.body).toMatchObject({ message: 'Never mind.', mentionUserIds: [] });
  });
});

describe('the conversation', () => {
  it('draws recorded tags as tags, and leaves other @text alone', () => {
    render(
      <MemoryRouter>
        <MessageText
          text="@Hina Raza please check with @Somebody Else."
          mentions={[{ userId: 'user-hina', name: 'Hina Raza', employeeId: 'emp-hina' }]}
          profileLinks
        />
      </MemoryRouter>,
    );

    const tag = screen.getByRole('link', { name: '@Hina Raza' });
    expect(tag).toHaveAttribute('href', '/people/emp-hina');
    expect(tag).toHaveAttribute('data-mention', 'user-hina');
    expect(document.querySelectorAll('[data-mention]')).toHaveLength(1);
    expect(screen.getByText(/please check with @Somebody Else\./)).toBeInTheDocument();
  });

  it('shows tags in the thread of a resolved case', async () => {
    caseDetail = detail({
      messages: [
        {
          id: 'm-1',
          senderUserId: 'user-me',
          senderName: 'Zohaib Saleem',
          fromRequester: false,
          message: '@Hina Raza Please process the approved reimbursement.',
          internal: true,
          attachments: [],
          mentions: [{ userId: 'user-hina', name: 'Hina Raza', employeeId: 'emp-hina' }],
          createdAt: '2026-10-03T09:00:00.000Z',
        },
      ],
    });
    renderAt(<CaseWorkPage />, '/case-queue/case-29');

    const tag = await screen.findByText('@Hina Raza');
    expect(tag).toHaveAttribute('data-mention', 'user-hina');
    // No employee grant: a tag, not a link to a profile the reader cannot open.
    expect(tag.tagName).toBe('SPAN');
  });
});

describe('Mentions & Follow-ups', () => {
  const ITEM = {
    id: 'men-1',
    caseId: 'case-29',
    caseNumber: 'CASE-2026-000029',
    caseStatus: 'RESOLVED',
    caseSubject: 'Medical reimbursement',
    mentionedByName: 'Zohaib Saleem',
    preview: '@Asad Mirza Please process the approved reimbursement.',
    createdAt: new Date().toISOString(),
    readAt: null,
    notificationId: 'n-7',
    link: '/case-queue/case-29',
  };

  it('lists who tagged me, where, and what they said - and opens the exact case, marking it read', async () => {
    feed = { items: [ITEM], unread: 1 };
    const user = userEvent.setup();
    renderAt(<MentionsCard />, '/');

    const row = await screen.findByRole('link', { name: /CASE-2026-000029/ });
    expect(row).toHaveAttribute('href', '/case-queue/case-29');
    expect(within(row).getByText('Medical reimbursement')).toBeInTheDocument();
    expect(within(row).getByText('Zohaib Saleem')).toBeInTheDocument();
    expect(within(row).getByText(/Please process the approved reimbursement/)).toBeInTheDocument();
    expect(within(row).getByLabelText('Unread')).toBeInTheDocument();
    expect(within(row).getByText('Resolved')).toBeInTheDocument();

    await user.click(row);
    expect(screen.getByTestId('where')).toHaveTextContent('/case-queue/case-29');
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/notifications/n-7/read'))).toBe(true),
    );
  });

  it('says nothing about a case the reader can no longer open', async () => {
    feed = { items: [{ ...ITEM, caseSubject: null, preview: null, link: null }], unread: 0 };
    renderAt(<MentionsCard />, '/');

    await screen.findByText('CASE-2026-000029');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText(/reimbursement/)).not.toBeInTheDocument();
    expect(screen.getByText(/can no\s+longer open/)).toBeInTheDocument();
  });

  it('renders away until somebody has tagged the reader', async () => {
    renderAt(<MentionsCard />, '/');
    await waitFor(() => expect(calls.some((c) => c.url.includes('/cases/mentions'))).toBe(true));
    expect(screen.queryByText(/Mentions/)).not.toBeInTheDocument();
  });

  it('the bell opens a mention on the exact case, desk or requester view', () => {
    expect(notificationLink({ entityType: 'CaseDesk', entityId: 'case-29' })?.to).toBe('/case-queue/case-29');
    expect(notificationLink({ entityType: 'Case', entityId: 'case-29' })?.to).toBe('/cases/case-29');
  });
});
