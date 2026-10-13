// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PERMISSIONS, caseAttachmentUrl } from '@hrms/shared';

/**
 * The cases screens.
 *
 * Three things are pinned here, and each is something a screen could plausibly
 * get wrong on its own:
 *
 *   - the filtering is the SERVER'S. Every control sends a query parameter and
 *     the page holds one page of rows; a screen that fetched everything and
 *     filtered in the browser would pass a naive render test and fail these.
 *   - the actions on a case are the server's answer too. `canReply`,
 *     `canReopen` and `canAttach` arrive on the record already resolved, and
 *     the tests move those flags and expect the controls to move with them - so
 *     a screen that started deciding for itself from a permission list would
 *     fail.
 *   - there is no "whose cases" control anywhere, because in phase 1 there is
 *     nothing to switch between: the endpoint returns the caller's own and no
 *     parameter widens it. A toggle here would be a promise the API does not
 *     keep.
 */

let permissions = new Set<string>();
let employeeLinked = true;

vi.mock('@/features/auth/session-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth/session-context')>();
  return {
    ...actual,
    usePermissions: () => ({
      has: (p: string) => permissions.has(p),
      hasAny: (list: string[]) => list.some((p) => permissions.has(p)),
      hasAll: (list: string[]) => list.every((p) => permissions.has(p)),
    }),
    useSession: () => ({
      session: { employeeLinked, user: {}, company: { currency: 'PKR' } },
      permissions,
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => Promise.resolve(),
      clear: () => {},
    }),
  };
});

import { CasesPage } from './cases-page';
import { CaseDetailPage } from './case-detail-page';
import { MyCasesCard } from './my-cases-card';

const EMPLOYEE = [
  PERMISSIONS.CASE_READ_OWN,
  PERMISSIONS.CASE_CREATE,
  PERMISSIONS.CASE_REPLY_OWN,
  PERMISSIONS.CASE_REOPEN_OWN,
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
        description: 'What was paid, and whether it was right.',
        subcategories: [{ id: 'sub-amount', name: 'Incorrect amount', description: null }],
      },
    ],
  },
  {
    departmentId: 'dep-it',
    departmentName: 'IT',
    categories: [
      {
        id: 'cat-email',
        name: 'Email',
        description: null,
        subcategories: [{ id: 'sub-signin', name: 'Cannot sign in', description: null }],
      },
      // No subcategories, so the form must not draw an empty control for it.
      { id: 'cat-misc', name: 'Something else', description: null, subcategories: [] },
      {
        id: 'cat-hardware',
        name: 'Hardware',
        description: 'Laptops, monitors, printers and the rest.',
        subcategories: [
          { id: 'sub-laptop', name: 'Laptop', description: null },
          { id: 'sub-printer', name: 'Printer', description: null },
        ],
      },
    ],
  },
];

const caseRecord = (overrides: Record<string, unknown> = {}) => ({
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
  messageCount: 0,
  attachmentCount: 0,
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-09-01T09:00:00.000Z',
  lastMessageAt: null,
  resolvedAt: null,
  closedAt: null,
  canReply: true,
  canReopen: false,
  canAttach: true,
  ...overrides,
});

const caseDetail = (overrides: Record<string, unknown> = {}) => ({
  ...caseRecord(),
  description: 'Black screen after the login sound since this morning.',
  messages: [],
  attachments: [],
  ...overrides,
});

let fetchMock: ReturnType<typeof vi.fn>;
/** Every URL the screens asked for, so a test can assert the query string. */
let calls: string[] = [];

interface ServeOptions {
  rows?: unknown[];
  total?: number;
  detail?: unknown;
  summary?: unknown;
  listStatus?: number;
  detailStatus?: number;
}

function serve(options: ServeOptions = {}) {
  calls = [];
  const rows = options.rows ?? [caseRecord()];

  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const path = url.split('?')[0] ?? '';

    if (path.endsWith('/cases/categories')) return respond({ data: CATALOGUE });
    if (path.endsWith('/cases/summary')) {
      return respond({
        data: options.summary ?? {
          counts: {
            OPEN: 2,
            IN_PROGRESS: 1,
            PENDING: 1,
            ON_HOLD: 0,
            RESOLVED: 4,
            CLOSED: 3,
            REOPENED: 0,
          },
          live: 4,
          total: 11,
        },
      });
    }
    if (/\/cases\/[^/]+\/messages$/.test(path)) return respond({ data: { id: 'msg-new' } });
    if (/\/cases\/[^/]+\/reopen$/.test(path)) {
      return respond({ data: caseRecord({ status: 'REOPENED' }) });
    }
    if (/\/cases\/[^/]+\/attachments$/.test(path)) return respond({ data: { id: 'att-new' } });
    if (/\/cases\/[^/]+$/.test(path) && !path.endsWith('/cases')) {
      if (options.detailStatus && options.detailStatus >= 400) {
        return respond({ error: { code: 'NOT_FOUND', message: 'Case was not found.' } }, options.detailStatus);
      }
      return respond({ data: options.detail ?? caseDetail() });
    }
    if (path.endsWith('/cases')) {
      if (init?.method === 'POST') return respond({ data: caseRecord({ id: 'case-new' }) });
      if (options.listStatus && options.listStatus >= 400) {
        return respond({ error: { code: 'FORBIDDEN', message: 'Not allowed.' } }, options.listStatus);
      }
      return respond({
        data: rows,
        meta: {
          page: 1,
          limit: 20,
          total: options.total ?? rows.length,
          totalPages: Math.max(1, Math.ceil((options.total ?? rows.length) / 20)),
        },
      });
    }
    return respond({ data: [] });
  });

  vi.stubGlobal('fetch', fetchMock);
}

function renderAt(ui: React.ReactNode, path = '/cases') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/cases" element={ui} />
          <Route path="/cases/:id" element={ui} />
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The list request, which is the one carrying the filters. */
const listCall = () => calls.filter((call) => /GET .*\/cases\?/.test(call)).at(-1) ?? '';

beforeEach(() => {
  permissions = new Set(EMPLOYEE);
  employeeLinked = true;
  serve();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// -----------------------------------------------------------------------------

describe('the case list', () => {
  it('shows the columns somebody scans a case list for', async () => {
    renderAt(<CasesPage />);

    await screen.findByText('CASE-2026-000001');

    for (const heading of [
      'Case #',
      'Subject',
      'Department',
      'Category',
      'Priority',
      'Status',
      'Created',
      'Updated',
    ]) {
      expect(screen.getByRole('columnheader', { name: heading })).toBeInTheDocument();
    }

    const row = screen.getByText('CASE-2026-000001').closest('tr');
    expect(within(row as HTMLElement).getByText('Laptop will not start')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('IT')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('High')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Open')).toBeInTheDocument();
  });

  it('links each case by its number, so it can be opened in a tab or copied', async () => {
    renderAt(<CasesPage />);

    const link = await screen.findByRole('link', { name: 'CASE-2026-000001' });
    expect(link).toHaveAttribute('href', '/cases/case-1');
  });

  it('offers no way to look at anybody else&apos;s cases', async () => {
    renderAt(<CasesPage />);
    await screen.findByText('CASE-2026-000001');

    // No "whose cases" toggle, no employee selector, no employee column. In
    // phase 1 the endpoint returns the caller's own and nothing widens it, so a
    // control here would be a promise the API does not keep.
    expect(screen.queryByLabelText(/whose/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/employee/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /employee/i })).not.toBeInTheDocument();
    expect(listCall()).not.toContain('employeeId');
    expect(listCall()).not.toContain('view=');
  });

  it('sends every filter to the server rather than filtering in the browser', async () => {
    const user = userEvent.setup();
    renderAt(<CasesPage />);
    await screen.findByText('CASE-2026-000001');

    await user.selectOptions(screen.getByLabelText('Status'), 'PENDING');
    await waitFor(() => expect(listCall()).toContain('status=PENDING'));

    await user.selectOptions(screen.getByLabelText('Priority'), 'URGENT');
    await waitFor(() => expect(listCall()).toContain('priority=URGENT'));

    await user.selectOptions(screen.getByLabelText('Department'), 'dep-it');
    await waitFor(() => expect(listCall()).toContain('departmentId=dep-it'));

    await user.selectOptions(screen.getByLabelText('Category'), 'cat-email');
    await waitFor(() => expect(listCall()).toContain('categoryId=cat-email'));
  });

  it('sends a date range as two days', async () => {
    const user = userEvent.setup();
    renderAt(<CasesPage />);
    await screen.findByText('CASE-2026-000001');

    await user.type(screen.getByLabelText('Raised from'), '2026-09-01');
    await user.type(screen.getByLabelText('Raised to'), '2026-09-30');

    await waitFor(() => {
      expect(listCall()).toContain('from=2026-09-01');
      expect(listCall()).toContain('to=2026-09-30');
    });
  });

  it('sends the search term to the server, debounced', async () => {
    const user = userEvent.setup();
    renderAt(<CasesPage />);
    await screen.findByText('CASE-2026-000001');

    await user.type(screen.getByLabelText('Search by case number or subject'), 'CASE-2026');

    await waitFor(() => expect(listCall()).toContain('q=CASE-2026'));
    // One request for the term, not one per keystroke.
    expect(calls.filter((call) => call.includes('q=CASE')).length).toBeLessThan(4);
  });

  it('pages rather than fetching everything', async () => {
    serve({ rows: [caseRecord()], total: 45 });
    const user = userEvent.setup();
    renderAt(<CasesPage />);
    await screen.findByText('CASE-2026-000001');

    expect(listCall()).toContain('page=1');
    expect(listCall()).toContain('limit=20');

    await user.click(screen.getByLabelText('Next page'));
    await waitFor(() => expect(listCall()).toContain('page=2'));
  });

  it('draws its department and category filters from the catalogue, not from a constant', async () => {
    renderAt(<CasesPage />);
    await screen.findByText('CASE-2026-000001');

    const departments = screen.getByLabelText('Department');
    await waitFor(() =>
      expect(within(departments).getByRole('option', { name: 'Finance' })).toBeInTheDocument(),
    );
    expect(within(departments).getByRole('option', { name: 'IT' })).toBeInTheDocument();

    // Subcategories are offered too, because filtering by one is a reasonable
    // thing to want and the endpoint matches either level.
    const categories = screen.getByLabelText('Category');
    expect(
      within(categories).getByRole('option', { name: 'IT · Email · Cannot sign in' }),
    ).toBeInTheDocument();
  });

  it('hides the raise button without case.create', async () => {
    permissions = new Set([PERMISSIONS.CASE_READ_OWN]);
    renderAt(<CasesPage />);
    await screen.findByText('CASE-2026-000001');

    expect(screen.queryByRole('button', { name: /raise a case/i })).not.toBeInTheDocument();
  });

  it('says so when there is nothing, and tells filters apart from an empty list', async () => {
    serve({ rows: [], total: 0 });
    const user = userEvent.setup();
    renderAt(<CasesPage />);

    expect(await screen.findByText('No cases yet')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Status'), 'PENDING');
    await waitFor(() =>
      expect(screen.getByText('No cases match those filters')).toBeInTheDocument(),
    );
  });
});

describe('raising a case', () => {
  /**
   * The dialog, scoped.
   *
   * The list screen behind it has its own Department and Category controls -
   * they are filters - so an unscoped query finds two of each. Scoping to the
   * dialog is not a workaround for that: the form and the filters are genuinely
   * two different things and a test that could not tell them apart would not be
   * testing the form.
   */
  async function openForm(user: ReturnType<typeof userEvent.setup>) {
    renderAt(<CasesPage />);
    await screen.findByText('CASE-2026-000001');
    await user.click(screen.getByRole('button', { name: /raise a case/i }));
    return within(await screen.findByRole('dialog'));
  }

  it('offers the company&apos;s own departments and nothing free-text', async () => {
    const user = userEvent.setup();
    const form = await openForm(user);

    const department = await form.findByLabelText(/Department/);
    expect(department.tagName).toBe('SELECT');
    expect(within(department).getByRole('option', { name: 'Finance' })).toBeInTheDocument();
    expect(within(department).getByRole('option', { name: 'IT' })).toBeInTheDocument();
    // No escape hatch. An employee cannot invent a department.
    expect(within(department).queryByRole('option', { name: /other/i })).not.toBeInTheDocument();
  });

  it('cascades category from department, and subcategory from category', async () => {
    const user = userEvent.setup();
    const form = await openForm(user);

    const category = await form.findByLabelText(/Category/);
    expect(category).toBeDisabled();

    await user.selectOptions(form.getByLabelText(/Department/), 'dep-it');
    expect(category).toBeEnabled();
    expect(within(category).getByRole('option', { name: 'Email' })).toBeInTheDocument();
    expect(within(category).queryByRole('option', { name: 'Salary' })).not.toBeInTheDocument();

    // A category with no children draws no subcategory control at all - an
    // empty one reads as something the user failed to fill in.
    await user.selectOptions(category, 'cat-misc');
    expect(form.queryByLabelText(/Subcategory/)).not.toBeInTheDocument();

    await user.selectOptions(category, 'cat-email');
    const subcategory = await form.findByLabelText(/Subcategory/);
    expect(within(subcategory).getByRole('option', { name: 'Cannot sign in' })).toBeInTheDocument();
  });

  it('posts ids, a subject, a description and a priority - and no employee id', async () => {
    const user = userEvent.setup();
    const form = await openForm(user);

    await user.selectOptions(await form.findByLabelText(/Department/), 'dep-fin');
    await user.selectOptions(form.getByLabelText(/Category/), 'cat-salary');
    await user.type(form.getByLabelText(/Subject/), 'Salary short by one day');
    await user.type(
      form.getByLabelText(/Description/),
      'August pay is one day short and the payslip does not explain it.',
    );
    await user.selectOptions(form.getByLabelText(/Priority/), 'HIGH');

    await user.click(form.getByRole('button', { name: 'Raise case' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = JSON.parse(String((post?.[1] as RequestInit).body)) as Record<string, unknown>;

    expect(body).toMatchObject({
      departmentId: 'dep-fin',
      categoryId: 'cat-salary',
      subject: 'Salary short by one day',
      priority: 'HIGH',
    });
    // The two fields that would raise a case as somebody else. Neither exists.
    expect(body).not.toHaveProperty('employeeId');
    expect(body).not.toHaveProperty('requesterEmployeeId');
  });

  /*
   * The production bug: choosing IT and then a category made "Raise case"
   * vanish. Nothing hid the button - the form wrapping the body and footer was
   * an ordinary box, so once the subcategory field appeared it grew past the
   * dialog's height cap and the footer was clipped off. jsdom does no layout,
   * so what is pinned is the cause (the form is `contents`, leaving body and
   * footer in the dialog's column, where only the body scrolls) and the
   * behaviour: the button is there and usable at every step, and submits.
   */
  it('keeps Raise case through IT, every category and every subcategory, and submits', async () => {
    const user = userEvent.setup();
    const form = await openForm(user);
    const button = () => form.getByRole('button', { name: 'Raise case' });

    expect(button().closest('form')).toHaveClass('contents');

    await user.selectOptions(await form.findByLabelText(/Department/), 'dep-it');
    expect(button()).toBeEnabled();

    for (const category of ['cat-email', 'cat-misc', 'cat-hardware']) {
      await user.selectOptions(form.getByLabelText(/^Category/), category);
      expect(button()).toBeVisible();
      expect(button()).toBeEnabled();
    }
    for (const sub of ['sub-laptop', 'sub-printer', '']) {
      await user.selectOptions(await form.findByLabelText(/Subcategory/), sub);
      expect(button()).toBeEnabled();
    }
    await user.selectOptions(form.getByLabelText(/Subcategory/), 'sub-printer');

    await user.type(form.getByLabelText(/Subject/), 'Printer jams on every page');
    await user.type(form.getByLabelText(/Description/), 'The second floor printer jams on every page since Monday.');
    await user.click(button());

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(true),
    );
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toMatchObject({
      departmentId: 'dep-it',
      categoryId: 'cat-hardware',
      subcategoryId: 'sub-printer',
    });
  });

  it('switching category clears a subcategory that no longer belongs to it', async () => {
    const user = userEvent.setup();
    const form = await openForm(user);

    await user.selectOptions(await form.findByLabelText(/Department/), 'dep-it');
    await user.selectOptions(form.getByLabelText(/^Category/), 'cat-hardware');
    await user.selectOptions(await form.findByLabelText(/Subcategory/), 'sub-laptop');
    await user.selectOptions(form.getByLabelText(/^Category/), 'cat-email');

    expect(await form.findByLabelText(/Subcategory/)).toHaveValue('');
    expect(form.getByRole('button', { name: 'Raise case' })).toBeEnabled();
  });

  it('defaults the priority to Normal', async () => {
    const user = userEvent.setup();
    const form = await openForm(user);

    expect(await form.findByLabelText(/Priority/)).toHaveValue('NORMAL');
  });
});

describe('one case', () => {
  it('shows the case, its details and its conversation', async () => {
    serve({
      detail: caseDetail({
        messages: [
          {
            id: 'm1',
            senderUserId: 'user-me',
            senderName: 'Ayesha Khan',
            fromRequester: true,
            message: 'Still broken this morning.',
            internal: false,
            attachments: [],
            createdAt: '2026-09-02T09:00:00.000Z',
          },
          {
            id: 'm2',
            senderUserId: 'user-agent',
            senderName: 'IT Desk',
            fromRequester: false,
            message: 'We have ordered a replacement battery.',
            internal: false,
            attachments: [],
            createdAt: '2026-09-02T11:00:00.000Z',
          },
        ],
      }),
    });

    renderAt(<CaseDetailPage />, '/cases/case-1');

    expect(await screen.findByText('Still broken this morning.')).toBeInTheDocument();
    expect(screen.getByText('We have ordered a replacement battery.')).toBeInTheDocument();
    // The requester's own words are labelled as theirs, from the server's flag.
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('IT Desk')).toBeInTheDocument();
    expect(screen.getByText('CASE-2026-000001')).toBeInTheDocument();
  });

  it('links an attachment through the API, never to a storage path', async () => {
    serve({
      detail: caseDetail({
        attachments: [
          {
            id: 'att-1',
            messageId: null,
            fileName: 'payslip.pdf',
            contentType: 'application/pdf',
            sizeBytes: 24_000,
            uploadedByName: 'Ayesha Khan',
            createdAt: '2026-09-01T09:00:00.000Z',
          },
        ],
      }),
    });

    renderAt(<CaseDetailPage />, '/cases/case-1');

    const link = await screen.findByRole('link', { name: /payslip\.pdf/ });
    // Built by the shared helper, so the case id always travels with the
    // attachment id - the endpoint checks both.
    expect(link).toHaveAttribute('href', caseAttachmentUrl('case-1', 'att-1'));
    expect(link.getAttribute('href')).not.toContain('case-attachments/');
  });

  it('sends a reply, and clears the box', async () => {
    const user = userEvent.setup();
    renderAt(<CaseDetailPage />, '/cases/case-1');

    const box = await screen.findByLabelText('Your reply');
    await user.type(box, 'It happened again today.');
    await user.click(screen.getByRole('button', { name: /send reply/i }));

    await waitFor(() => {
      const post = calls.find((call) => call.startsWith('POST') && call.includes('/messages'));
      expect(post).toBeTruthy();
    });
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('will not send an empty reply', async () => {
    renderAt(<CaseDetailPage />, '/cases/case-1');
    await screen.findByLabelText('Your reply');

    expect(screen.getByRole('button', { name: /send reply/i })).toBeDisabled();
  });

  it('takes its controls from the record, not from the permission list', async () => {
    // Every case grant held, and a server that says this case is finished with.
    serve({ detail: caseDetail({ status: 'CLOSED', canReply: false, canAttach: false, canReopen: true }) });
    renderAt(<CaseDetailPage />, '/cases/case-1');

    expect(await screen.findByText('This case is closed')).toBeInTheDocument();
    expect(screen.queryByLabelText('Your reply')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Reopen$/ })).toBeInTheDocument();
  });

  it('hides reopen when the server says the case cannot be reopened', async () => {
    serve({ detail: caseDetail({ status: 'OPEN', canReopen: false }) });
    renderAt(<CaseDetailPage />, '/cases/case-1');

    await screen.findByLabelText('Your reply');
    expect(screen.queryByRole('button', { name: /^Reopen$/ })).not.toBeInTheDocument();
  });

  it('asks for a reason before reopening, and sends it', async () => {
    serve({ detail: caseDetail({ status: 'RESOLVED', canReopen: true }) });
    const user = userEvent.setup();
    renderAt(<CaseDetailPage />, '/cases/case-1');

    await user.click(await screen.findByRole('button', { name: /^Reopen$/ }));

    const confirm = await screen.findByRole('button', { name: 'Reopen case' });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/What is still wrong/), 'It locked again overnight.');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([input, init]) =>
        String(input).includes('/reopen') && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
        reason: 'It locked again overnight.',
      });
    });
  });

  it('shows the not-found state for a case that is not the caller&apos;s', async () => {
    // The endpoint answers 404 for somebody else's id, so this is what changing
    // the id in the URL produces. It reveals nothing about whether it exists.
    serve({ detailStatus: 404 });
    renderAt(<CaseDetailPage />, '/cases/case-someone-else');

    expect(await screen.findByRole('link', { name: 'Back to my cases' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Your reply')).not.toBeInTheDocument();
  });
});

describe('the dashboard card', () => {
  it('shows the four figures the server counted', async () => {
    renderAt(<MyCasesCard />);

    // The heading renders while the request is still in flight, so waiting for
    // it proves nothing. Wait for a figure.
    await screen.findByText('In progress');

    for (const [label, value] of [
      ['Open', '2'],
      ['In progress', '1'],
      ['Pending', '1'],
      ['Resolved', '4'],
    ]) {
      const term = screen.getByText(label as string);
      expect(term.parentElement).toHaveTextContent(value as string);
    }

    // Counted by the database. A card that fetched a page of cases to tally
    // them would be wrong the moment somebody had more than a page.
    expect(calls.some((call) => call.includes('/cases/summary'))).toBe(true);
    expect(calls.some((call) => /GET .*\/cases\?/.test(call))).toBe(false);
  });

  it('says plainly when something is waiting on the person reading it', async () => {
    renderAt(<MyCasesCard />);
    expect(await screen.findByText('One case is waiting on your reply.')).toBeInTheDocument();

    cleanup();
    serve({
      summary: {
        counts: { OPEN: 1, IN_PROGRESS: 0, PENDING: 3, ON_HOLD: 0, RESOLVED: 0, CLOSED: 0, REOPENED: 0 },
        live: 4,
        total: 4,
      },
    });
    renderAt(<MyCasesCard />);
    expect(await screen.findByText('3 cases are waiting on your reply.')).toBeInTheDocument();
  });

  it('says nothing about waiting when nothing is', async () => {
    serve({
      summary: {
        counts: { OPEN: 1, IN_PROGRESS: 0, PENDING: 0, ON_HOLD: 0, RESOLVED: 2, CLOSED: 0, REOPENED: 0 },
        live: 1,
        total: 3,
      },
    });
    renderAt(<MyCasesCard />);

    await screen.findByText('In progress');
    expect(screen.queryByText(/waiting on your reply/)).not.toBeInTheDocument();
  });

  it('links to the full list', async () => {
    renderAt(<MyCasesCard />);
    expect(await screen.findByRole('link', { name: 'View my cases' })).toHaveAttribute(
      'href',
      '/cases',
    );
  });

  it('renders itself away without case.read.own', () => {
    permissions = new Set();
    const { container } = renderAt(<MyCasesCard />);

    // A narrow role gets a shorter dashboard, not a broken one.
    expect(container).toBeEmptyDOMElement();
  });

  it('hides the raise button for a login with no employee record', async () => {
    employeeLinked = false;
    renderAt(<MyCasesCard />);

    await screen.findByText('In progress');
    expect(screen.queryByRole('button', { name: 'Raise a case' })).not.toBeInTheDocument();
  });

  it('survives a summary that is not the shape it expected', async () => {
    /*
     * This card is one of several on the dashboard, and an exception thrown
     * while rendering it takes the whole page down - somebody loses their
     * attendance, leave and holidays over a helpdesk figure. So a payload with
     * no `counts` renders as "no cases" rather than as a blank dashboard.
     */
    serve({ summary: [] });
    renderAt(<MyCasesCard />);

    expect(await screen.findByText('No cases')).toBeInTheDocument();
  });

  it('invites a first case when there are none', async () => {
    serve({
      summary: {
        counts: { OPEN: 0, IN_PROGRESS: 0, PENDING: 0, ON_HOLD: 0, RESOLVED: 0, CLOSED: 0, REOPENED: 0 },
        live: 0,
        total: 0,
      },
    });
    renderAt(<MyCasesCard />);

    expect(await screen.findByText('No cases')).toBeInTheDocument();
  });
});
