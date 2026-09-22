// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom';
import type { AttendanceDay, TeamAttendanceRow } from '@hrms/shared';

/**
 * Team attendance: a list of people, and nothing else.
 *
 * This page briefly carried a Table / Calendar / Bars switcher. It was the
 * wrong home for it - the question this screen answers is "who is in today",
 * across many people, and a calendar or a chart of many people at once answers
 * a different one. The views belong to a single employee and now live on the
 * employee page; see employee-attendance-views.test.tsx.
 *
 * So the first thing asserted here is an ABSENCE: no view switcher, on a page
 * that is otherwise unchanged. The rest is the list's own behaviour and the
 * awkward data - a row with no days, an empty page - that must not take it
 * down.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/features/auth/session-context', () => ({
  usePermissions: () => ({ has: () => true, hasAny: () => true, hasAll: () => true }),
}));

import { api } from '@/lib/api';
import { TeamAttendancePage } from './team-attendance-page';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), getEnvelope: vi.fn(), getPage: vi.fn(), post: vi.fn() },
  };
});

const day = (over: Partial<AttendanceDay> = {}): AttendanceDay =>
  ({
    date: '2026-09-03',
    status: 'PRESENT',
    flags: [],
    checkInAt: '2026-09-03T09:00:00.000Z',
    checkOutAt: '2026-09-03T18:00:00.000Z',
    workedMinutes: 480,
    expectedMinutes: 480,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    irregular: false,
    mode: 'OFFICE',
    shiftId: 'shift-1',
    shiftName: 'General',
    notes: null,
    leaveTypeName: null,
    holidayName: null,
    ...over,
  }) as AttendanceDay;

const TOTALS = {
  present: 1, halfDay: 0, absent: 0, onLeave: 0, holiday: 0, weekend: 0,
  upcoming: 0, offDay: 0, workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0,
};

const row = (over: Partial<TeamAttendanceRow> = {}): TeamAttendanceRow =>
  ({
    employeeId: 'emp-1',
    employeeName: 'Ada Lovelace',
    employeeNumber: 'E-001',
    departmentName: 'Engineering',
    teamId: 'team-1',
    teamName: 'Platform',
    shiftName: 'General',
    days: [day()],
    totals: { ...TOTALS },
    ...over,
  }) as TeamAttendanceRow;

const LOOKUPS = {
  departments: [{ id: 'dep-1', label: 'Engineering' }],
  teams: [{ id: 'team-1', label: 'Platform' }],
  designations: [],
  locations: [],
  managers: [],
};

let teamRows: TeamAttendanceRow[] = [row()];
/** What the server says is in the whole filtered set, when it differs from the page. */
let teamTotal: number | null = null;

/** `n` distinct people, so a page can be counted by the links it draws. */
const people = (n: number): TeamAttendanceRow[] =>
  Array.from({ length: n }, (_, i) =>
    row({
      employeeId: `emp-${i}`,
      employeeName: `Person ${String(i).padStart(3, '0')}`,
      employeeNumber: `E-${String(i).padStart(3, '0')}`,
    }),
  );

/** The employee rows actually on screen. */
const renderedRows = () => screen.queryAllByRole('link', { name: /^Person \d{3}/ });

/** Every request the page makes, so the filter assertions can read them back. */
const seen: Array<{ path: string; query: Record<string, unknown> }> = [];

beforeEach(() => {
  window.localStorage.clear();
  seen.length = 0;
  teamRows = [row()];
  teamTotal = null;

  vi.mocked(api.get).mockImplementation((path: string, options?: { query?: Record<string, unknown> }) => {
    seen.push({ path, query: options?.query ?? {} });
    if (path === '/departments/lookups') return Promise.resolve(LOOKUPS as never);
    return Promise.resolve(null as never);
  });
  vi.mocked(api.getEnvelope).mockImplementation((path: string, options?: { query?: Record<string, unknown> }) => {
    seen.push({ path, query: options?.query ?? {} });
    // The team-summary envelope: `range` and `truncated` beside `data`.
    return Promise.resolve({
      data: [],
      range: { from: '2026-09-03', to: '2026-09-03' },
      truncated: false,
    } as never);
  });
  vi.mocked(api.getPage).mockImplementation((path: string, options?: { query?: Record<string, unknown> }) => {
    const query = options?.query ?? {};
    seen.push({ path, query });
    // Answers with the page it was asked for. The whole point of the fix is
    // that `meta` and `data` describe one set, so the double cannot be allowed
    // to paper over a disagreement between them.
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 20);
    const total = teamTotal ?? teamRows.length;
    return Promise.resolve({
      data: teamRows,
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      totals: { ...TOTALS },
      range: { from: '2026-09-03', to: '2026-09-03' },
    } as never);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(url = '/attendance/team') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>
        <TeamAttendancePage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/**
 * The page on a router that can go back and forward.
 *
 * MemoryRouter cannot be navigated from the outside, and the filters now live
 * in the URL - so browser history IS the filter history, and it has to be
 * driven the way a browser drives it.
 */
function renderRouted(url = '/attendance/team') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: '/attendance/team',
        element: (
          <QueryClientProvider client={client}>
            <TeamAttendancePage />
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: [url] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const lastTeamQuery = () => [...seen].reverse().find((r) => r.path === '/attendance/team')?.query;

describe('the team attendance listing has no view switcher', () => {
  it('offers no Table / Calendar / Bars control', async () => {
    renderPage();
    await screen.findByText('Ada Lovelace');

    expect(screen.queryByRole('group', { name: /attendance view/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Bars$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Calendar$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Table$/ })).not.toBeInTheDocument();
  });

  it('draws no chart and no month grid', async () => {
    renderPage();
    await screen.findByText('Ada Lovelace');

    expect(screen.queryByRole('list', { name: /worked hours/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('grid', { name: /attendance calendar/i })).not.toBeInTheDocument();
  });

  it('ignores a stored view preference left behind by the old build', async () => {
    // Somebody who used the switcher while it was here has 'bars' in their
    // browser. It must not resurrect anything.
    window.localStorage.setItem('hrms.team-attendance.view', 'bars');
    renderPage();
    await screen.findByText('Ada Lovelace');

    expect(screen.queryByRole('group', { name: /attendance view/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /worked hours/i })).not.toBeInTheDocument();
  });
});

describe('the listing itself still works', () => {
  it('lists the team with its figures', async () => {
    renderPage();
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    // By row, not by text: "Platform" is also a filter option, and a bare text
    // query cannot tell the cell from the <option>.
    const row = screen.getByRole('link', { name: /Ada Lovelace/ }).closest('tr')!;
    expect(within(row).getByText('Platform')).toBeInTheDocument();
    expect(within(row).getByText('Engineering')).toBeInTheDocument();
  });

  it('links each person to their own attendance page', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: /Ada Lovelace/ });
    expect(link).toHaveAttribute('href', '/attendance/team/emp-1');
  });

  it('sends department, team, status and range to the API', async () => {
    renderPage();
    await screen.findByText('Ada Lovelace');

    await userEvent.selectOptions(screen.getByLabelText('Filter by department'), 'dep-1');
    await waitFor(() => expect(lastTeamQuery()?.departmentId).toBe('dep-1'));

    await userEvent.selectOptions(screen.getByLabelText('Filter by status'), 'ABSENT');
    await waitFor(() => expect(lastTeamQuery()?.status).toBe('ABSENT'));

    const query = lastTeamQuery();
    expect(query?.from).toBeTruthy();
    expect(query?.to).toBeTruthy();
  });

  it('says so plainly when nothing matches', async () => {
    teamRows = [];
    renderPage();
    expect(await screen.findByText(/No one in your team yet/i)).toBeInTheDocument();
  });

  it('survives a row that arrives with no days at all', async () => {
    // A joiner who starts next week: the row is real, the array is not there.
    teamRows = [row({ days: undefined as never })];
    renderPage();
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('survives a row whose days array is empty', async () => {
    teamRows = [row({ days: [] })];
    renderPage();
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  });
});

/**
 * Rows, and the sentence under them.
 *
 * The screen used to say "Showing 1 to 20 of 80" over eight rows. The cause was
 * on the server - see team-attendance.routes.test.ts - but the page is where it
 * was read, so these assert the two together: every row the API hands over is
 * drawn, and nothing about the container hides the twentieth one.
 */
describe('the table draws every row the page contains', () => {
  it('draws 20 rows when Rows is 20', async () => {
    teamRows = people(20);
    teamTotal = 80;
    renderPage();

    await screen.findByText('Person 000');
    expect(renderedRows()).toHaveLength(20);
    expect(screen.getByText('Person 019')).toBeInTheDocument();
  });

  it('says it is showing exactly the rows it drew', async () => {
    teamRows = people(20);
    teamTotal = 80;
    renderPage();
    await screen.findByText('Person 000');

    // "Showing 1 to 20 of 80", split across elements for the emphasis.
    const footer = screen.getByText(/Showing/).textContent?.replace(/\s+/g, ' ');
    expect(footer).toBe('Showing 1 to 20 of 80');
    expect(renderedRows()).toHaveLength(20);
  });

  it('draws 50 rows when Rows is set to 50', async () => {
    teamRows = people(20);
    teamTotal = 80;
    renderPage();
    await screen.findByText('Person 000');

    teamRows = people(50);
    await userEvent.selectOptions(screen.getByLabelText('Rows'), '50');

    await waitFor(() => expect(lastTeamQuery()?.limit).toBe(50));
    await waitFor(() => expect(renderedRows()).toHaveLength(50));
    expect(screen.getByText('Person 049')).toBeInTheDocument();
  });

  it('draws 100 rows when Rows is set to 100', async () => {
    teamRows = people(20);
    teamTotal = 250;
    renderPage();
    await screen.findByText('Person 000');

    teamRows = people(100);
    await userEvent.selectOptions(screen.getByLabelText('Rows'), '100');

    await waitFor(() => expect(lastTeamQuery()?.limit).toBe(100));
    await waitFor(() => expect(renderedRows()).toHaveLength(100));
  });

  it('keeps paging working, and carries the page in the URL', async () => {
    teamRows = people(20);
    teamTotal = 80;
    const router = renderRouted();
    await screen.findByText('Person 000');

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => expect(lastTeamQuery()?.page).toBe(2));
    expect(router.state.location.search).toContain('page=2');
    await waitFor(() => expect(renderedRows()).toHaveLength(20));
  });

  it('returns to page one when the filter changes under it', async () => {
    teamRows = people(20);
    teamTotal = 80;
    const router = renderRouted('/attendance/team?page=3');
    await screen.findByText('Person 000');
    expect(lastTeamQuery()?.page).toBe(3);

    await userEvent.selectOptions(screen.getByLabelText('Filter by status'), 'ABSENT');

    await waitFor(() => expect(lastTeamQuery()?.status).toBe('ABSENT'));
    expect(lastTeamQuery()?.page).toBe(1);
    expect(router.state.location.search).not.toContain('page=');
  });
});

/**
 * The URL is the filter.
 *
 * Which is what makes the dashboard's drill-down possible at all: a figure
 * there is a link to this address. So the address has to be read on arrival,
 * survive a reload, and move with the back button.
 */
describe('team attendance initialises from the URL', () => {
  it('applies a status and a date it was opened with', async () => {
    renderPage('/attendance/team?status=ABSENT&from=2026-09-15&to=2026-09-15');
    await screen.findByText('Ada Lovelace');

    expect(screen.getByLabelText('Filter by status')).toHaveValue('ABSENT');
    expect(screen.getByLabelText('From date')).toHaveValue('2026-09-15');
    expect(screen.getByLabelText('To date')).toHaveValue('2026-09-15');

    const query = lastTeamQuery();
    expect(query?.status).toBe('ABSENT');
    expect(query?.from).toBe('2026-09-15');
    expect(query?.to).toBe('2026-09-15');
    // Nothing the link did not ask for.
    expect(query?.q).toBeUndefined();
    expect(query?.departmentId).toBeUndefined();
  });

  it('sends Late as a flag, because late is not a status', async () => {
    renderPage('/attendance/team?status=LATE&from=2026-09-15&to=2026-09-15');
    await screen.findByText('Ada Lovelace');

    const query = lastTeamQuery();
    expect(query?.flag).toBe('LATE');
    expect(query?.status).toBeUndefined();
    expect(screen.getByLabelText('Filter by status')).toHaveValue('LATE');
  });

  it('sends Overtime as a flag too', async () => {
    renderPage('/attendance/team?status=OVERTIME&from=2026-09-15&to=2026-09-15');
    await screen.findByText('Ada Lovelace');

    expect(lastTeamQuery()?.flag).toBe('OVERTIME');
    expect(lastTeamQuery()?.status).toBeUndefined();
  });

  it('carries department and team through, without inventing a search', async () => {
    renderPage('/attendance/team?status=PRESENT&departmentId=dep-1&teamId=team-1');
    await screen.findByText('Ada Lovelace');

    const query = lastTeamQuery();
    expect(query?.departmentId).toBe('dep-1');
    expect(query?.teamId).toBe('team-1');
    expect(query?.q).toBeUndefined();
    expect(screen.getByLabelText('Search name or employee number')).toHaveValue('');
  });

  it('keeps the filter across a reload', async () => {
    const url = '/attendance/team?status=HALF_DAY&from=2026-09-15&to=2026-09-15';
    renderPage(url);
    await screen.findByText('Ada Lovelace');
    cleanup();

    // A refresh is the same address, mounted again from nothing.
    seen.length = 0;
    renderPage(url);
    await screen.findByText('Ada Lovelace');

    expect(screen.getByLabelText('Filter by status')).toHaveValue('HALF_DAY');
    expect(lastTeamQuery()?.status).toBe('HALF_DAY');
    expect(lastTeamQuery()?.from).toBe('2026-09-15');
  });

  it('puts a chosen filter in the URL, and takes the back button back out of it', async () => {
    const router = renderRouted('/attendance/team?from=2026-09-15&to=2026-09-15');
    await screen.findByText('Ada Lovelace');

    await userEvent.selectOptions(screen.getByLabelText('Filter by status'), 'ABSENT');
    await waitFor(() => expect(router.state.location.search).toContain('status=ABSENT'));

    await router.navigate(-1);
    await waitFor(() =>
      expect(screen.getByLabelText('Filter by status')).toHaveValue(''),
    );
    await waitFor(() => expect(lastTeamQuery()?.status).toBeUndefined());

    await router.navigate(1);
    await waitFor(() =>
      expect(screen.getByLabelText('Filter by status')).toHaveValue('ABSENT'),
    );
  });

  it('ignores a rows-per-page the API would not honour', async () => {
    renderPage('/attendance/team?limit=5000');
    await screen.findByText('Ada Lovelace');

    expect(lastTeamQuery()?.limit).toBe(20);
  });

  it('clears the whole URL when the filters are reset', async () => {
    const router = renderRouted('/attendance/team?status=ABSENT&departmentId=dep-1');
    await screen.findByText('Ada Lovelace');

    await userEvent.click(screen.getByRole('button', { name: /Reset/i }));

    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.getByLabelText('Filter by status')).toHaveValue('');
  });
});
