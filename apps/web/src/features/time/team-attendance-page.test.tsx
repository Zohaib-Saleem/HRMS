// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { AttendanceDay, TeamAttendanceRow } from '@hrms/shared';

/**
 * Team attendance: the view switcher, and the bars behind it.
 *
 * The switcher did not exist here at all - not hidden, not styled away, simply
 * absent from the source - so the first thing asserted is that it is on the
 * page and that pressing a segment changes what is RENDERED, not just which
 * button looks pressed.
 *
 * The bar assertions are about honesty rather than pixels: height comes from
 * `workedMinutes` and nothing else, the overtime portion is carved out of that
 * height rather than added to it, and colour follows the status the attendance
 * engine already assigned. The rest is the awkward data - no team, no shift, no
 * check-out, no rows at all - which must not take the page down.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/features/auth/session-context', () => ({
  usePermissions: () => ({ has: () => true, hasAny: () => true, hasAll: () => true }),
}));

import { api } from '@/lib/api';
import { TeamAttendancePage } from './team-attendance-page';
import { __testing } from './team-attendance-bars';
import { teamCalendarCells } from './team-attendance-calendar';

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

const switcher = () => screen.getByRole('group', { name: 'Team attendance view' });
const viewButton = (name: RegExp) => screen.getByRole('button', { name });
const chart = () => screen.queryByRole('list', { name: 'Worked hours per employee per day' });
const lastTeamQuery = () => [...seen].reverse().find((r) => r.path === '/attendance/team')?.query;

/**
 * The value of one labelled figure in the detail panel.
 *
 * By label rather than by text, because several values legitimately repeat -
 * "Late" is both the status and a figure's name, "Unassigned" is both the shift
 * and the team - and a bare text query cannot tell which one it found.
 */
function figure(panel: HTMLElement, label: string): string {
  const dt = within(panel)
    .getAllByText(label)
    .find((el) => el.tagName === 'DT');
  if (!dt) throw new Error(`No figure labelled "${label}" in the panel.`);
  return (dt.nextElementSibling as HTMLElement).textContent ?? '';
}

describe('the team attendance view switcher', () => {
  it('is on the page, offering the calendar and the bars', async () => {
    renderPage();

    const buttons = within(switcher()).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Table', 'Calendar', 'Bars']);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('says which view is live', async () => {
    renderPage();
    expect(viewButton(/^Table$/)).toHaveAttribute('aria-pressed', 'true');
    expect(viewButton(/^Bars$/)).toHaveAttribute('aria-pressed', 'false');
  });

  it('swaps the rendered view, not just the pressed button', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ada Lovelace');
    expect(chart()).not.toBeInTheDocument();

    await user.click(viewButton(/^Bars$/));
    await waitFor(() => expect(chart()).toBeInTheDocument());
    expect(screen.queryByRole('grid', { name: 'Attendance calendar' })).not.toBeInTheDocument();

    await user.click(viewButton(/^Calendar$/));
    expect(await screen.findByRole('grid', { name: 'Attendance calendar' })).toBeInTheDocument();
    expect(chart()).not.toBeInTheDocument();

    await user.click(viewButton(/^Table$/));
    await waitFor(() => expect(chart()).not.toBeInTheDocument());
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('remembers the chosen view for the next visit', async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await user.click(viewButton(/^Bars$/));
    await waitFor(() => expect(chart()).toBeInTheDocument());
    first.unmount();

    renderPage();
    await waitFor(() => expect(chart()).toBeInTheDocument());
    expect(viewButton(/^Bars$/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('falls back to the table when the stored view is not one we offer', async () => {
    window.localStorage.setItem('hrms.team-attendance.view', 'gantt');
    renderPage();
    expect(viewButton(/^Table$/)).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the bars themselves', () => {
  const showBars = async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ada Lovelace');
    await user.click(viewButton(/^Bars$/));
    await waitFor(() => expect(chart()).toBeInTheDocument());
    return user;
  };

  it('draws one bar per employee per day', async () => {
    teamRows = [
      row(),
      row({ employeeId: 'emp-2', employeeName: 'Grace Hopper', days: [day(), day({ date: '2026-09-04' })] }),
    ];
    await showBars();

    expect(within(chart()!).getAllByRole('listitem')).toHaveLength(3);
  });

  it('takes its height from worked minutes and nothing else', async () => {
    // 480 worked against a 480-minute axis top is the full plot; 240 is half.
    teamRows = [
      row({ days: [day({ workedMinutes: 480 })] }),
      row({ employeeId: 'emp-2', employeeName: 'Grace Hopper', days: [day({ workedMinutes: 240 })] }),
    ];
    await showBars();

    const items = within(chart()!).getAllByRole('listitem');
    const heightOf = (item: HTMLElement) =>
      (item.querySelector('div[style*="height"]') as HTMLElement).style.height;

    expect(heightOf(items[0]!)).toBe('100%');
    expect(heightOf(items[1]!)).toBe('50%');
  });

  it('carves overtime out of the bar rather than stacking it on top', async () => {
    teamRows = [row({ days: [day({ workedMinutes: 480, overtimeMinutes: 120 })] })];
    await showBars();

    const segments = within(chart()!)
      .getAllByRole('listitem')[0]!
      .querySelectorAll('div[style*="height"]');

    // 360 ordinary + 120 overtime = the 480 that were worked, not 600.
    expect((segments[0] as HTMLElement).style.height).toBe('75%');
    expect((segments[1] as HTMLElement).style.height).toBe('25%');
    expect((segments[1] as HTMLElement).style.backgroundColor).toContain('att-overtime-border');
  });

  it('never draws a bar taller than the plot, whatever the hours', () => {
    for (const minutes of [270, 480, 510, 540, 570, 600, 660, 1440]) {
      const ticks = __testing.axisTicks(minutes);
      const top = ticks[ticks.length - 1]! * 60;
      expect(top).toBeGreaterThanOrEqual(minutes);
    }
  });

  it('colours a bar by the status the engine assigned', () => {
    const { barColor } = __testing;
    expect(barColor(day({ status: 'PRESENT' }))).toContain('att-present-border');
    expect(barColor(day({ status: 'PRESENT', flags: ['LATE'] }))).toContain('att-half-day-border');
    expect(barColor(day({ status: 'HALF_DAY' }))).toContain('att-half-day-border');
    expect(barColor(day({ status: 'ABSENT' }))).toContain('att-absent-border');
    expect(barColor(day({ status: 'ON_LEAVE' }))).toContain('att-leave-border');
    expect(barColor(day({ status: 'HOLIDAY' }))).toContain('att-holiday-border');
    expect(barColor(day({ status: 'WEEKEND' }))).toContain('att-weekend-border');
    expect(barColor(day({ status: 'OFF_DAY' }))).toContain('att-weekend-border');
  });

  it('calls a late present day late, not merely present', () => {
    expect(__testing.barMeaning(day({ status: 'PRESENT', flags: ['LATE'] }))).toBe('Late');
    expect(__testing.barMeaning(day({ status: 'PRESENT' }))).toBe('Present');
    expect(__testing.barMeaning(day({ status: 'ON_LEAVE' }))).toBe('On leave');
  });

  it('shows the whole day in the detail panel when a bar is chosen', async () => {
    teamRows = [
      row({
        days: [day({ workedMinutes: 500, lateMinutes: 12, earlyLeaveMinutes: 4, overtimeMinutes: 20, flags: ['LATE'] })],
      }),
    ];
    const user = await showBars();

    await user.click(within(chart()!).getAllByRole('button')[0]!);

    const panel = await screen.findByRole('status');
    expect(within(panel).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(panel).getByText('E-001')).toBeInTheDocument();
    expect(figure(panel, 'Status')).toBe('Late');
    expect(figure(panel, 'Shift')).toBe('General');
    expect(figure(panel, 'Check in')).not.toBe('--');
    expect(figure(panel, 'Check out')).not.toBe('--');
    expect(figure(panel, 'Worked')).toBe('8h 20m');
    expect(figure(panel, 'Late')).toBe('0h 12m');
    expect(figure(panel, 'Early leave')).toBe('0h 04m');
    expect(figure(panel, 'Overtime')).toBe('0h 20m');
    expect(figure(panel, 'Team')).toBe('Platform');
  });

  it('keeps working for an employee with no team, no shift and no check-out', async () => {
    teamRows = [
      row({
        teamId: null,
        teamName: null,
        shiftName: null,
        days: [day({ shiftName: null, checkOutAt: null, workedMinutes: null, overtimeMinutes: null })],
      }),
    ];
    const user = await showBars();
    await user.click(within(chart()!).getAllByRole('button')[0]!);

    const panel = await screen.findByRole('status');
    expect(figure(panel, 'Shift')).toBe('Unassigned');
    expect(figure(panel, 'Team')).toBe('Unassigned');
    expect(figure(panel, 'Check out')).toBe('--');
    expect(figure(panel, 'Worked')).toBe('--');
    expect(figure(panel, 'Overtime')).toBe('--');
    expect(chart()).toBeInTheDocument();
  });

  it('says so plainly when the filters match nothing', async () => {
    teamRows = [];
    const user = userEvent.setup();
    renderPage();
    await user.click(viewButton(/^Bars$/));

    expect(await screen.findByText('Nothing to chart')).toBeInTheDocument();
  });

  it('survives a row that arrives with no days at all', async () => {
    teamRows = [row({ days: undefined as unknown as AttendanceDay[] })];
    const user = userEvent.setup();
    renderPage();
    await user.click(viewButton(/^Bars$/));

    expect(await screen.findByText('Nothing to chart')).toBeInTheDocument();
  });

  /**
   * `flags` is declared non-optional, so nothing in the type system stops a day
   * arriving without it - an older cached response, a hand-built fixture, a
   * field an endpoint stops sending. A tint is not worth a blank screen.
   */
  it('draws a day whose flags array never arrived, rather than crashing', async () => {
    const naked = day({ flags: undefined as unknown as AttendanceDay['flags'] });
    teamRows = [row({ days: [naked] })];
    const user = userEvent.setup();
    renderPage();
    await user.click(viewButton(/^Bars$/));

    const chart = await screen.findByRole('list', {
      name: 'Worked hours per employee per day',
    });
    expect(within(chart).getAllByRole('listitem')).toHaveLength(1);
    // Present, not "Late": a missing flag list is no flags, never an assumption.
    expect(__testing.barMeaning(naked)).toBe('Present');
    expect(__testing.barColor(naked)).toBe('var(--att-present-border)');
  });
});

describe('the filters reach every view', () => {
  it('sends department, team, status and range from the bars view', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ada Lovelace');
    await user.click(viewButton(/^Bars$/));

    await screen.findByRole('option', { name: 'Engineering' });
    await user.selectOptions(screen.getByLabelText('Filter by department'), 'dep-1');
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'ABSENT');

    await waitFor(() =>
      expect(lastTeamQuery()).toMatchObject({ departmentId: 'dep-1', status: 'ABSENT' }),
    );
    // Still the bars, with the narrowed data.
    expect(viewButton(/^Bars$/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('widens a single day to the whole month on request', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ada Lovelace');
    await user.click(viewButton(/^Calendar$/));

    await user.click(await screen.findByRole('button', { name: 'Show the whole month' }));

    await waitFor(() => {
      const q = lastTeamQuery();
      expect(String(q?.from)).toMatch(/^\d{4}-\d{2}-01$/);
      expect(String(q?.to)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(q?.from).not.toBe(q?.to);
    });
  });
});

describe('the team calendar tally', () => {
  it('prints a headcount for a mixed day rather than claiming one status', () => {
    const cells = teamCalendarCells([
      row({ days: [day({ status: 'PRESENT' })] }),
      row({ employeeId: 'e2', days: [day({ status: 'ABSENT', workedMinutes: null })] }),
    ]);

    expect(cells).toHaveLength(1);
    expect(cells[0]!.label).toBe('1/2 in');
    expect(cells[0]!.status).toBe('ABSENT');
  });

  it('only calls a date a weekend when it was one for everybody', () => {
    const mixed = teamCalendarCells([
      row({ days: [day({ status: 'WEEKEND' })] }),
      row({ employeeId: 'e2', days: [day({ status: 'PRESENT' })] }),
    ]);
    expect(mixed[0]!.status).not.toBe('WEEKEND');

    const all = teamCalendarCells([
      row({ days: [day({ status: 'WEEKEND' })] }),
      row({ employeeId: 'e2', days: [day({ status: 'WEEKEND' })] }),
    ]);
    expect(all[0]!.status).toBe('WEEKEND');
    expect(all[0]!.label).toBe('Weekend');
  });

  it('handles rows with no days, and no rows at all', () => {
    expect(teamCalendarCells([])).toEqual([]);
    expect(teamCalendarCells([row({ days: undefined as unknown as AttendanceDay[] })])).toEqual([]);
  });

  it('tolerates null minute fields when totalling a date', () => {
    const cells = teamCalendarCells([
      row({ days: [day({ workedMinutes: null, lateMinutes: null, overtimeMinutes: null })] }),
    ]);
    expect(cells[0]!.detail).not.toContain('NaN');
  });
});
