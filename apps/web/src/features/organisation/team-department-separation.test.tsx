// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PERMISSIONS } from '@hrms/shared';
import { ConfirmProvider } from '@/components/feedback/confirm-dialog';
import { TeamsPage } from './teams-page';

/**
 * THE TEAM FORM HAS NO DEPARTMENT ON IT.
 *
 * Teams are not sub-departments - an employee is in Development AND on Team
 * Alpha - and the form is where the old model was most visible: it said "every
 * team belongs to exactly one department", it required one, and somebody who
 * needed a team that belonged under none created a department to hold it.
 *
 * What this pins is the screen, because the shape of the form is the part a
 * reader of the code cannot check: no Department field, no Department column,
 * no department filter, and a POST body carrying only what a team now is.
 */

const permissions = new Set<string>([PERMISSIONS.TEAM_READ, PERMISSIONS.TEAM_MANAGE]);

vi.mock('@/features/auth/session-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth/session-context')>();
  return {
    ...actual,
    usePermissions: () => ({
      has: (p: string) => permissions.has(p),
      hasAny: (...list: string[]) => list.some((p) => permissions.has(p)),
      hasAll: (...list: string[]) => list.every((p) => permissions.has(p)),
    }),
  };
});

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const TEAMS = [
  {
    id: 'team-alpha',
    name: 'Team Alpha',
    description: 'The clan team',
    isActive: true,
    managerCount: 2,
    managerNames: ['Abdul Aziz', 'Muhammad Ahmed'],
    employeeCount: 3,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
];

const LOOKUPS = {
  departments: [{ id: 'dept-development', label: 'Development' }],
  teams: [{ id: 'team-alpha', label: 'Team Alpha' }],
  designations: [],
  locations: [],
  managers: [],
  teamManagers: [{ id: 'emp-1', label: 'Abdul Aziz', secondaryLabel: 'Team Alpha' }],
};

let calls: Array<{ method: string; url: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ method, url, body });

      if (url.includes('/departments/lookups')) return respond({ data: LOOKUPS });
      if (method === 'POST') return respond({ data: { ...TEAMS[0], id: 'team-new' } }, 201);
      return respond({ data: TEAMS, meta: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/organisation/teams']}>
          <TeamsPage />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

describe('the Teams screen', () => {
  it('lists a team by its managers and its people, with no department column', async () => {
    renderPage();

    expect(await screen.findByText('Team Alpha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Abdul Aziz, Muhammad Ahmed/ })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Department' })).not.toBeInTheDocument();
  });

  it('sends the people count through to the People list filtered by team', async () => {
    renderPage();

    await screen.findByText('Team Alpha');
    // Not a member list on this screen: an employee's team is set on the
    // employee, beside their department, and only there.
    expect(screen.getByRole('link', { name: '3' })).toHaveAttribute(
      'href',
      '/people?teamId=team-alpha',
    );
  });

  it('offers no department filter', async () => {
    renderPage();

    await screen.findByText('Team Alpha');
    expect(screen.queryByLabelText('Filter by department')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Filter by status')).toBeInTheDocument();
    // And does not ask the server to narrow by one either.
    expect(calls.find((c) => c.url.includes('/teams'))?.url).not.toContain('departmentId');
  });

  it('creates a team from a name, a description and a status alone', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Team Alpha');
    await user.click(screen.getByRole('button', { name: 'New team' }));

    const dialog = await screen.findByRole('dialog');
    expect(fieldsOf(dialog)).toEqual(['Name', 'Description', 'Active']);

    await user.type(screen.getByLabelText(/Name/), 'Team Beta');
    await user.click(screen.getByRole('button', { name: 'Create team' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const sent = calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;
    expect(sent).toEqual({ name: 'Team Beta', description: null, isActive: true });
    expect(sent).not.toHaveProperty('departmentId');
  });
});

/** Every field the drawer puts in front of somebody, in order. */
function fieldsOf(dialog: HTMLElement): string[] {
  return Array.from(dialog.querySelectorAll('label')).map((l) =>
    (l.textContent ?? '').replace('*', '').trim(),
  );
}
