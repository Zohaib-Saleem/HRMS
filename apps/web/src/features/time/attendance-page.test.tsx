// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { AttendanceDailyTotal } from '@hrms/shared';

/**
 * The Attendance page's view switcher.
 *
 * The bug this covers is not a rendering detail: the toggle existed but was
 * tucked into the page header's action row, where readers did not find it, and
 * choosing a view threw away the month and the filters that had been set. So
 * the things asserted here are the ones that failed in use - the control is on
 * the page and says which view is live, the bar chart is what a reader lands
 * on, each choice actually swaps the rendered view, and the month, the filters
 * and the chosen view survive each other.
 */

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), getPage: vi.fn() } };
});

vi.mock('@/features/auth/session-context', () => ({
  useAuthenticatedSession: () => ({ employeeLinked: true }),
}));

import { api } from '@/lib/api';
import { AttendancePage } from './attendance-page';

function day(over: Partial<AttendanceDailyTotal> = {}): AttendanceDailyTotal {
  return {
    date: '2026-09-01',
    employeeCount: 2,
    present: 2,
    halfDay: 0,
    absent: 0,
    onLeave: 0,
    holiday: 0,
    weekend: 0,
    offDay: 0,
    upcoming: 0,
    workedMinutes: 900,
    expectedMinutes: 960,
    lateMinutes: 12,
    earlyLeaveMinutes: 5,
    lateCount: 1,
    overtimeCount: 1,
    onTimeMinutes: 480,
    lateWorkedMinutes: 360,
    overtimeMinutes: 60,
    firstCheckInAt: '2026-09-01T09:05:00.000Z',
    lastCheckOutAt: '2026-09-01T18:10:00.000Z',
    dayState: 'WORKING',
    holidayName: null,
    ...over,
  };
}

/** Every request the page makes, answered by path. Records what it was asked. */
const seen: Array<{ path: string; query: Record<string, unknown> }> = [];

function route(path: string, options?: { query?: Record<string, unknown> }): unknown {
  seen.push({ path, query: options?.query ?? {} });

  if (path === '/departments/lookups') {
    return {
      departments: [{ id: 'dep-1', label: 'Engineering' }],
      teams: [{ id: 'team-1', label: 'Platform' }],
      designations: [],
      locations: [],
      managers: [{ id: 'emp-1', label: 'Ada Lovelace' }],
    };
  }
  if (path === '/attendance/analytics/daily') {
    return {
      days: [day(), day({ date: '2026-09-02' })],
      summary: {
        totalEmployees: 2,
        present: 4,
        absent: 0,
        halfDay: 0,
        onLeave: 0,
        holiday: 0,
        weekend: 0,
        offDay: 0,
        upcoming: 0,
        workedMinutes: 1800,
        overtimeMinutes: 120,
        lateMinutes: 24,
        earlyLeaveMinutes: 10,
        averageWorkedMinutes: 450,
      },
      range: { from: '2026-09-01', to: '2026-09-30' },
      truncated: false,
    };
  }
  if (path === '/attendance/reports/monthly') return { rows: [] };
  // Today's check-in strip has nothing to say in these tests.
  return null;
}

beforeEach(() => {
  seen.length = 0;
  vi.mocked(api.get).mockImplementation((path, options) =>
    Promise.resolve(route(path, options) as never),
  );
  vi.mocked(api.getPage).mockImplementation((path, options) => {
    seen.push({ path, query: options?.query ?? {} });
    return Promise.resolve({
      data: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
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
        <AttendancePage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const switcher = () => screen.getByRole('group', { name: 'Attendance view' });
const viewButton = (name: RegExp) => screen.getByRole('button', { name });

/** The last request made to the aggregated-days endpoint. */
const lastAnalyticsQuery = () =>
  [...seen].reverse().find((r) => r.path === '/attendance/analytics/daily')?.query;

describe('the attendance view switcher', () => {
  it('is on the page itself, offering all three views', () => {
    renderPage();

    const buttons = within(switcher()).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Bar chart', 'Calendar', 'Table']);
  });

  it('lands on the bar chart, and says so', async () => {
    renderPage();

    expect(viewButton(/^Bar chart$/)).toHaveAttribute('aria-pressed', 'true');
    expect(viewButton(/^Calendar$/)).toHaveAttribute('aria-pressed', 'false');
    expect(viewButton(/^Table$/)).toHaveAttribute('aria-pressed', 'false');

    // Not merely selected - actually rendered.
    expect(await screen.findByRole('list', { name: 'Worked hours per day' })).toBeInTheDocument();
  });

  it('swaps the rendered view, not just the pressed button', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole('list', { name: 'Worked hours per day' })).toBeInTheDocument();

    await user.click(viewButton(/^Calendar$/));
    expect(await screen.findByRole('grid', { name: 'Attendance calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Worked hours per day' })).not.toBeInTheDocument();

    await user.click(viewButton(/^Table$/));
    expect(await screen.findByLabelText('Search employee or notes')).toBeInTheDocument();
    expect(screen.queryByRole('grid', { name: 'Attendance calendar' })).not.toBeInTheDocument();

    await user.click(viewButton(/^Bar chart$/));
    expect(await screen.findByRole('list', { name: 'Worked hours per day' })).toBeInTheDocument();
  });

  it('keeps the chosen view while the reader pages through months', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(viewButton(/^Calendar$/));
    expect(await screen.findByRole('grid', { name: 'Attendance calendar' })).toBeInTheDocument();

    const before = lastAnalyticsQuery()?.month;
    await user.click(screen.getByRole('button', { name: 'Previous month' }));

    await waitFor(() => expect(lastAnalyticsQuery()?.month).not.toBe(before));
    expect(viewButton(/^Calendar$/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('grid', { name: 'Attendance calendar' })).toBeInTheDocument();
  });
});

describe('filters are the page’s, not each view’s', () => {
  it('carries the department filter into every view', async () => {
    const user = userEvent.setup();
    renderPage();

    // The department list arrives with the lookups request, not with the page.
    await screen.findByRole('option', { name: 'Engineering' });
    await user.selectOptions(screen.getByLabelText('Filter by department'), 'dep-1');
    await waitFor(() => expect(lastAnalyticsQuery()?.departmentId).toBe('dep-1'));

    await user.click(viewButton(/^Calendar$/));
    await waitFor(() => expect(lastAnalyticsQuery()?.departmentId).toBe('dep-1'));
    expect(screen.getByLabelText('Filter by department')).toHaveValue('dep-1');

    await user.click(viewButton(/^Table$/));
    await waitFor(() => {
      const list = [...seen].reverse().find((r) => r.path === '/attendance');
      expect(list?.query.departmentId).toBe('dep-1');
    });
    expect(screen.getByLabelText('Filter by department')).toHaveValue('dep-1');
  });

  it('scopes the table to the month the rest of the page is showing', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(viewButton(/^Table$/));

    await waitFor(() => {
      const list = [...seen].reverse().find((r) => r.path === '/attendance');
      expect(list?.query.from).toMatch(/^\d{4}-\d{2}-01$/);
      expect(list?.query.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  /*
   * Department and team are INDEPENDENT filters. This used to clear the team
   * whenever the department changed, because a team sat inside a department
   * and the cleared one was no longer offered. Neither is true now: the two
   * combine as AND, and clearing somebody's team filter behind their back
   * would answer a different question from the one they asked.
   */
  it('keeps the team when the department filter changes', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('option', { name: 'Engineering' });
    await user.selectOptions(screen.getByLabelText('Filter by department'), 'dep-1');
    await user.selectOptions(screen.getByLabelText('Filter by team'), 'team-1');
    await waitFor(() => expect(lastAnalyticsQuery()?.teamId).toBe('team-1'));

    await user.selectOptions(screen.getByLabelText('Filter by department'), '');
    await waitFor(() => expect(lastAnalyticsQuery()?.departmentId).toBeUndefined());
    expect(lastAnalyticsQuery()?.teamId).toBe('team-1');
  });

  it('offers every team whatever department is chosen', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('option', { name: 'Engineering' });
    await user.selectOptions(screen.getByLabelText('Filter by department'), 'dep-1');

    // 'Platform' is not filed under 'Engineering' any more - it is not filed
    // under anything - and it is still on offer.
    expect(screen.getByRole('option', { name: 'Platform' })).toBeInTheDocument();
  });
});
