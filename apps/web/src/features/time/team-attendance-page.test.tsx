// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
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
  teams: [{ id: 'team-1', label: 'Platform', departmentId: 'dep-1' }],
  designations: [],
  locations: [],
  managers: [],
};

let teamRows: TeamAttendanceRow[] = [row()];

/** Every request the page makes, so the filter assertions can read them back. */
const seen: Array<{ path: string; query: Record<string, unknown> }> = [];

beforeEach(() => {
  window.localStorage.clear();
  seen.length = 0;
  teamRows = [row()];

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
    seen.push({ path, query: options?.query ?? {} });
    return Promise.resolve({
      data: teamRows,
      meta: { page: 1, limit: 20, total: teamRows.length, totalPages: 1 },
      totals: { ...TOTALS },
      range: { from: '2026-09-03', to: '2026-09-03' },
    } as never);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <TeamAttendancePage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
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
