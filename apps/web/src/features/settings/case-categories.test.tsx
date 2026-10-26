// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ConfirmProvider } from '@/components/feedback/confirm-dialog';
import { CaseCategoriesPage } from './case-categories-page';

/**
 * The catalogue screen.
 *
 * The rules being pinned are the ones an administrator would only discover by
 * losing something:
 *
 *   - retiring is the ordinary act. It is always offered, and it is what takes
 *     a queue off the create form while leaving the cases behind it intact;
 *   - deleting is offered ONLY for a row nothing has ever been filed under.
 *     The server refuses the rest, and a button that always fails is worse than
 *     no button;
 *   - a subcategory is created under its parent and inherits its department,
 *     so the request carries a parent and no department at all;
 *   - a department with no queues still appears, because otherwise there is
 *     nowhere to give it its first.
 */

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const CATALOGUE = [
  {
    departmentId: 'dep-it',
    departmentName: 'IT',
    departmentIsActive: true,
    categories: [
      {
        id: 'cat-email',
        departmentId: 'dep-it',
        departmentName: 'IT',
        parentCategoryId: null,
        name: 'Email',
        description: 'Mailboxes and mail that will not send.',
        sortOrder: 0,
        isActive: true,
        // Filed against, so this one cannot be deleted.
        caseCount: 4,
        children: [
          {
            id: 'sub-signin',
            departmentId: 'dep-it',
            departmentName: 'IT',
            parentCategoryId: 'cat-email',
            name: 'Cannot sign in',
            description: null,
            sortOrder: 0,
            isActive: true,
            caseCount: 0,
            children: [],
          },
        ],
      },
      {
        id: 'cat-fax',
        departmentId: 'dep-it',
        departmentName: 'IT',
        parentCategoryId: null,
        name: 'Fax',
        description: null,
        sortOrder: 9,
        isActive: false,
        caseCount: 0,
        children: [],
      },
    ],
  },
  {
    departmentId: 'dep-ops',
    departmentName: 'Operations',
    departmentIsActive: true,
    categories: [],
  },
];

/** IT's Email queue is routed; nothing else is. People are account ids, not names in code. */
const ROUTING = {
  rules: [
    {
      id: 'rule-email',
      departmentId: 'dep-it',
      departmentName: 'IT',
      categoryId: 'cat-email',
      categoryName: 'Email',
      parentCategoryName: null,
      responsible: { userId: 'u-it-manager', name: 'Aziz Qadir', eligible: true },
      backup: { userId: 'u-it-backup', name: 'Imran Khan', eligible: true },
      escalation: null,
      isActive: true,
      updatedAt: '2026-10-25T00:00:00.000Z',
    },
  ],
  candidates: [
    { userId: 'u-it-manager', name: 'Aziz Qadir', departmentName: 'IT' },
    { userId: 'u-it-backup', name: 'Imran Khan', departmentName: 'IT' },
    { userId: 'u-hr-manager', name: 'Hina Shah', departmentName: 'HR' },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
let calls: Array<{ method: string; url: string; body: unknown }> = [];

function serve() {
  calls = [];
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

    if (method === 'DELETE') return respond({ data: null }, 204);
    if (method === 'PUT') return respond({ data: { id: 'rule-new' } });
    if (method === 'POST' || method === 'PATCH') return respond({ data: { id: 'cat-new' } });
    if (url.includes('/cases/catalogue/routing')) return respond({ data: ROUTING });
    return respond({ data: CATALOGUE });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/settings/case-categories']}>
          <CaseCategoriesPage />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

const sent = (method: string) => calls.filter((call) => call.method === method).at(-1);

/** The card for one department, which is the scope every assertion needs. */
const departmentCard = (name: string) =>
  screen.getByRole('heading', { name }).closest('div[class*="rounded"]') as HTMLElement;

beforeEach(() => {
  serve();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the catalogue screen', () => {
  it('shows the tree, retired rows included', async () => {
    renderPage();

    expect(await screen.findByText('Email')).toBeInTheDocument();
    expect(screen.getByText('Cannot sign in')).toBeInTheDocument();
    expect(screen.getByText('Fax')).toBeInTheDocument();
    expect(screen.getByText('Retired')).toBeInTheDocument();
  });

  it('shows a department nobody has given a queue to', async () => {
    renderPage();

    expect(await screen.findByText('Operations')).toBeInTheDocument();
    expect(
      screen.getByText(/No queues yet, so nothing can be filed with Operations/),
    ).toBeInTheDocument();
  });

  it('says how many cases are behind each queue', async () => {
    renderPage();

    expect(await screen.findByText(/4 cases filed here/)).toBeInTheDocument();
    expect(screen.getAllByText(/No cases filed here/).length).toBeGreaterThan(0);
  });

  it('offers delete only where nothing has been filed', async () => {
    renderPage();

    await screen.findByText('Email');

    const emailRow = screen.getByText('Email').closest('div')?.parentElement as HTMLElement;
    expect(within(emailRow).queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    // Retiring is always available, which is the act that actually belongs here.
    expect(within(emailRow).getByRole('button', { name: /retire/i })).toBeInTheDocument();

    const faxRow = screen.getByText('Fax').closest('div')?.parentElement as HTMLElement;
    expect(within(faxRow).getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('retires a queue rather than deleting it', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Email');
    const emailRow = screen.getByText('Email').closest('div')?.parentElement as HTMLElement;
    await user.click(within(emailRow).getByRole('button', { name: /retire/i }));

    await waitFor(() => expect(sent('PATCH')).toBeTruthy());
    expect(sent('PATCH')?.url).toContain('/cases/catalogue/cat-email');
    expect(sent('PATCH')?.body).toEqual({ isActive: false });
  });

  it('restores a retired one', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Fax');
    const faxRow = screen.getByText('Fax').closest('div')?.parentElement as HTMLElement;
    await user.click(within(faxRow).getByRole('button', { name: /restore/i }));

    await waitFor(() => expect(sent('PATCH')?.body).toEqual({ isActive: true }));
  });

  it('creates a category against the department it was added from', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Operations');
    const operations = departmentCard('Operations');
    await user.click(within(operations).getByRole('button', { name: /add a category/i }));

    await user.type(await screen.findByLabelText(/^Name/), 'Facilities');
    await user.click(screen.getByRole('button', { name: /add it/i }));

    await waitFor(() => expect(sent('POST')).toBeTruthy());
    expect(sent('POST')?.body).toMatchObject({ name: 'Facilities', departmentId: 'dep-ops' });
  });

  it('creates a subcategory under its parent, with no department of its own', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Email');
    const emailRow = screen.getByText('Email').closest('div')?.parentElement as HTMLElement;
    await user.click(within(emailRow).getByRole('button', { name: /subcategory/i }));

    await user.type(await screen.findByLabelText(/^Name/), 'Mailbox full');
    await user.click(screen.getByRole('button', { name: /add it/i }));

    await waitFor(() => expect(sent('POST')).toBeTruthy());
    const body = sent('POST')?.body as Record<string, unknown>;
    expect(body).toMatchObject({ name: 'Mailbox full', parentCategoryId: 'cat-email' });
    // The department is the parent's, and is not the browser's to assert.
    expect(body).not.toHaveProperty('departmentId');
  });

  it('renames one through the edit form', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Email');
    const emailRow = screen.getByText('Email').closest('div')?.parentElement as HTMLElement;
    await user.click(within(emailRow).getByRole('button', { name: /edit/i }));

    const name = await screen.findByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, 'Email & mailboxes');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(sent('PATCH')).toBeTruthy());
    expect(sent('PATCH')?.body).toMatchObject({ name: 'Email & mailboxes' });
  });

  it('asks before deleting, and says the subcategories go too', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Fax');
    const faxRow = screen.getByText('Fax').closest('div')?.parentElement as HTMLElement;
    await user.click(within(faxRow).getByRole('button', { name: /delete/i }));

    expect(await screen.findByText('Delete Fax?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(sent('DELETE')).toBeTruthy());
    expect(sent('DELETE')?.url).toContain('/cases/catalogue/cat-fax');
  });
});

describe('routing a queue to its responsible person', () => {
  it('says who a routed queue goes to, and that an unrouted one stays unassigned', async () => {
    renderPage();
    expect(await screen.findByText(/New cases go to/)).toHaveTextContent(
      'New cases go to Aziz Qadir · backup Imran Khan',
    );
    expect(screen.getAllByText(/No department default/).length).toBeGreaterThan(0);
  });

  it('saves a department default with the chosen people', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Email');

    const card = departmentCard('IT');
    await user.click(within(card).getByRole('button', { name: /default routing/i }));
    await user.selectOptions(await screen.findByLabelText(/Responsible person/), 'u-hr-manager');
    await user.selectOptions(screen.getByLabelText(/Backup/), 'u-it-backup');
    await user.click(screen.getByRole('button', { name: /save routing/i }));

    await waitFor(() => expect(sent('PUT')).toBeTruthy());
    expect(sent('PUT')?.url).toContain('/cases/catalogue/routing');
    expect(sent('PUT')?.body).toEqual({
      departmentId: 'dep-it',
      categoryId: null,
      responsibleUserId: 'u-hr-manager',
      backupUserId: 'u-it-backup',
      escalationUserId: null,
      isActive: true,
    });
  });
});
