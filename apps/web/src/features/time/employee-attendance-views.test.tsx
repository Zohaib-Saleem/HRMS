// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { AttendanceDay } from '@hrms/shared';

/**
 * One employee's attendance in three shapes.
 *
 * The switcher is asserted to be PRESENT and to change what is rendered, not
 * merely which button looks pressed - the previous attempt at this feature
 * shipped a control that existed in the source and on the wrong page, which is
 * the failure these tests are here to prevent recurring.
 *
 * The bar assertions are about honesty rather than pixels: height comes from
 * `workedMinutes` and nothing else, the overtime portion is carved out of that
 * height rather than added on top, and colour follows the status the attendance
 * engine already assigned. Nothing in the chart may re-derive a status from
 * times or thresholds, so the fixtures below deliberately set a status that
 * disagrees with what the raw times would suggest, and the chart must follow
 * the engine.
 *
 * The rest is the awkward data - no shift, no check-out, a null everywhere
 * optional, an empty month - which must not take the page down.
 */

vi.mock('@/features/auth/session-context', () => ({
  usePermissions: () => ({ has: () => true, hasAny: () => true, hasAll: () => true }),
}));

import { api } from '@/lib/api';
import { EmployeeAttendanceViews } from './employee-attendance-views';
import { axisTicks, barColor, barMeaning } from './employee-attendance-bars';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

const day = (over: Partial<AttendanceDay> = {}): AttendanceDay =>
  ({
    date: '2026-09-03',
    status: 'PRESENT',
    flags: [],
    checkInAt: '2026-09-03T09:00:00.000Z',
    checkOutAt: '2026-09-03T17:00:00.000Z',
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
    source: 'DEVICE',
    recordId: 'rec-1',
    hasRecord: true,
    ...over,
  }) as AttendanceDay;

const TOTALS = {
  present: 1, halfDay: 0, absent: 0, onLeave: 0, holiday: 0, weekend: 0,
  upcoming: 0, offDay: 0, workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0,
};

let days: AttendanceDay[] = [day()];

/** Every request, so the month assertions can read the range back. */
const seen: Array<{ path: string; query: Record<string, unknown> }> = [];

beforeEach(() => {
  window.localStorage.clear();
  seen.length = 0;
  days = [day()];

  vi.mocked(api.get).mockImplementation((path: string, options?: { query?: Record<string, unknown> }) => {
    seen.push({ path, query: options?.query ?? {} });
    return Promise.resolve({ days, totals: { ...TOTALS } } as never);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderViews() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <EmployeeAttendanceViews employeeId="emp-1" employeeName="Abdul Rehman" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const switcher = () => screen.getByRole('group', { name: 'Attendance view' });
const seg = (name: RegExp) => within(switcher()).getByRole('button', { name });
const chart = () => screen.queryByRole('list', { name: /Worked hours per day for Abdul Rehman/ });
const grid = () => screen.queryByRole('grid', { name: /attendance calendar/i });
const lastQuery = () => [...seen].reverse().find((r) => r.path === '/attendance/summary')?.query;

/** The pixel-free height of a bar segment, as the style attribute states it. */
const heights = (bar: HTMLElement): string[] =>
  [...bar.querySelectorAll<HTMLElement>('div[style*="height"]')].map((el) => el.style.height);

/**
 * The value of one labelled figure in the detail panel.
 *
 * By label rather than by text, because several values legitimately repeat -
 * "Late" is both a status and a figure's name - and a bare text query cannot
 * tell which one it found.
 */
function figure(panel: HTMLElement, label: string): string {
  const dt = within(panel)
    .getAllByText(label)
    .find((el) => el.tagName === 'DT');
  if (!dt) throw new Error(`No figure labelled "${label}" in the panel.`);
  return (dt.nextElementSibling as HTMLElement).textContent ?? '';
}

describe('the employee attendance view switcher', () => {
  it('is on the page, offering all three views', async () => {
    renderViews();
    await screen.findByRole('group', { name: 'Attendance view' });

    expect(seg(/^Table$/)).toBeInTheDocument();
    expect(seg(/^Calendar$/)).toBeInTheDocument();
    expect(seg(/^Bars$/)).toBeInTheDocument();
  });

  it('opens on the calendar, which is what this page always showed', async () => {
    renderViews();
    await waitFor(() => expect(grid()).toBeInTheDocument());

    expect(seg(/^Calendar$/)).toHaveAttribute('aria-pressed', 'true');
    expect(chart()).not.toBeInTheDocument();
  });

  it('says which view is live', async () => {
    renderViews();
    await waitFor(() => expect(grid()).toBeInTheDocument());

    await userEvent.click(seg(/^Bars$/));
    expect(seg(/^Bars$/)).toHaveAttribute('aria-pressed', 'true');
    expect(seg(/^Calendar$/)).toHaveAttribute('aria-pressed', 'false');
  });

  it('swaps the rendered view, not just the pressed button', async () => {
    renderViews();
    await waitFor(() => expect(grid()).toBeInTheDocument());

    await userEvent.click(seg(/^Bars$/));
    await waitFor(() => expect(chart()).toBeInTheDocument());
    expect(grid()).not.toBeInTheDocument();

    await userEvent.click(seg(/^Table$/));
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Worked' })).toBeInTheDocument());
    expect(chart()).not.toBeInTheDocument();
    expect(grid()).not.toBeInTheDocument();

    await userEvent.click(seg(/^Calendar$/));
    await waitFor(() => expect(grid()).toBeInTheDocument());
  });

  it('remembers the chosen view for the next visit', async () => {
    const first = renderViews();
    await waitFor(() => expect(grid()).toBeInTheDocument());
    await userEvent.click(seg(/^Bars$/));
    await waitFor(() => expect(chart()).toBeInTheDocument());
    first.unmount();

    renderViews();
    await waitFor(() => expect(chart()).toBeInTheDocument());
  });

  it('falls back to the calendar when the stored view is not one we offer', async () => {
    window.localStorage.setItem('hrms.employee-attendance.view', 'gantt');
    renderViews();
    await waitFor(() => expect(grid()).toBeInTheDocument());
  });
});

describe('the month is shared by all three views', () => {
  it('asks for one month, for this employee only', async () => {
    renderViews();
    await waitFor(() => expect(lastQuery()).toBeTruthy());

    expect(lastQuery()?.employeeId).toBe('emp-1');
    expect(String(lastQuery()?.from)).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('moves every view when the month changes', async () => {
    renderViews();
    await waitFor(() => expect(lastQuery()).toBeTruthy());
    const opening = String(lastQuery()?.from);

    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await waitFor(() => expect(String(lastQuery()?.from)).not.toBe(opening));
    const previous = String(lastQuery()?.from);

    // Switching view must not re-ask for a different month.
    await userEvent.click(seg(/^Bars$/));
    await waitFor(() => expect(chart()).toBeInTheDocument());
    expect(String(lastQuery()?.from)).toBe(previous);

    await userEvent.click(seg(/^Table$/));
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Worked' })).toBeInTheDocument());
    expect(String(lastQuery()?.from)).toBe(previous);
  });

  it('keeps the month navigation reachable from the bars view', async () => {
    renderViews();
    await waitFor(() => expect(grid()).toBeInTheDocument());
    await userEvent.click(seg(/^Bars$/));
    await waitFor(() => expect(chart()).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Previous month' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeInTheDocument();
  });
});

describe('the bars', () => {
  const showBars = async () => {
    renderViews();
    await waitFor(() => expect(grid()).toBeInTheDocument());
    await userEvent.click(seg(/^Bars$/));
    await waitFor(() => expect(chart()).toBeInTheDocument());
  };

  it('draws one bar per day', async () => {
    days = [day({ date: '2026-09-01' }), day({ date: '2026-09-02' }), day({ date: '2026-09-03' })];
    await showBars();
    expect(within(chart()!).getAllByRole('listitem')).toHaveLength(3);
  });

  it('takes its height from worked minutes and nothing else', async () => {
    // 240 against a 480 maximum: half the tallest bar, whatever else differs.
    days = [day({ date: '2026-09-01', workedMinutes: 480 }), day({ date: '2026-09-02', workedMinutes: 240 })];
    await showBars();
    const bars = within(chart()!).getAllByRole('listitem');

    // The axis rounds up to 8h, so 480 of 480 minutes is 100% of it.
    expect(heights(bars[0]!)[0]).toBe('100%');
    expect(heights(bars[1]!)[0]).toBe('50%');
  });

  it('carves overtime out of the bar rather than stacking it on top', async () => {
    days = [day({ workedMinutes: 480, overtimeMinutes: 120 })];
    await showBars();
    const segments = heights(within(chart()!).getAllByRole('listitem')[0]!);

    // 360 worked + 120 overtime = the 480 the engine reported, not 600.
    expect(segments).toEqual(['75%', '25%']);
  });

  it('never lets a bar leave its own plot', () => {
    // A nine-hour day against a four-hour step used to stop the axis at eight.
    for (const minutes of [1, 59, 60, 510, 540, 720, 1440, 2000]) {
      const top = axisTicks(minutes).at(-1)! * 60;
      expect(minutes / top).toBeLessThanOrEqual(1);
    }
  });

  it('colours a bar by the status the engine assigned', () => {
    // The times below say "a full ordinary day" in every case. The status does
    // not, and the status is what must win.
    expect(barColor(day({ status: 'ABSENT' }))).toBe('var(--att-absent-border)');
    expect(barColor(day({ status: 'ON_LEAVE' }))).toBe('var(--att-leave-border)');
    expect(barColor(day({ status: 'HOLIDAY' }))).toBe('var(--att-holiday-border)');
    expect(barColor(day({ status: 'WEEKEND' }))).toBe('var(--att-weekend-border)');
    expect(barColor(day({ status: 'OFF_DAY' }))).toBe('var(--att-weekend-border)');
    expect(barColor(day({ status: 'HALF_DAY' }))).toBe('var(--att-half-day-border)');
    expect(barColor(day({ status: 'PRESENT' }))).toBe('var(--att-present-border)');
  });

  it('calls a late present day late, on the engine flag alone', () => {
    // No threshold is consulted here: a day with a 09:00 check-in is late if
    // and only if the engine said so.
    expect(barMeaning(day({ status: 'PRESENT', flags: ['LATE'] }))).toBe('Late');
    expect(barColor(day({ status: 'PRESENT', flags: ['LATE'] }))).toBe('var(--att-half-day-border)');
    expect(barMeaning(day({ status: 'PRESENT', flags: [] }))).toBe('Present');
  });

  it('shows the whole day in the detail panel when a bar is tapped', async () => {
    days = [
      day({
        date: '2026-09-03',
        status: 'PRESENT',
        flags: ['LATE', 'OVERTIME'],
        checkInAt: '2026-09-03T09:25:00.000Z',
        checkOutAt: '2026-09-03T19:00:00.000Z',
        workedMinutes: 500,
        lateMinutes: 25,
        earlyLeaveMinutes: 0,
        overtimeMinutes: 60,
        shiftName: 'General',
      }),
    ];
    await showBars();
    await userEvent.click(within(chart()!).getAllByRole('listitem')[0]!.querySelector('button')!);

    const panel = await screen.findByRole('status');
    expect(within(panel).getByText('Abdul Rehman')).toBeInTheDocument();
    expect(figure(panel, 'Status')).toBe('Late');
    expect(figure(panel, 'Shift')).toBe('General');
    expect(figure(panel, 'Late')).toMatch(/25/);
    expect(figure(panel, 'Overtime')).toMatch(/1h|60/);
    expect(figure(panel, 'Check in')).not.toBe('--');
    expect(figure(panel, 'Check out')).not.toBe('--');
    expect(figure(panel, 'Worked')).toMatch(/8h/);
  });

  it('keeps working for a day with no shift and no check-out', async () => {
    days = [
      day({
        shiftId: null,
        shiftName: null,
        checkOutAt: null,
        workedMinutes: null,
        overtimeMinutes: null,
        lateMinutes: null,
        earlyLeaveMinutes: null,
        flags: ['MISSING_PUNCH'],
      }),
    ];
    await showBars();
    await userEvent.click(within(chart()!).getAllByRole('listitem')[0]!.querySelector('button')!);

    const panel = await screen.findByRole('status');
    expect(figure(panel, 'Shift')).toBe('Unassigned');
    expect(figure(panel, 'Check out')).toBe('Missing');
    expect(figure(panel, 'Late')).toBe('--');
    expect(figure(panel, 'Overtime')).toBe('--');
  });

  it('draws a day whose flags array never arrived, rather than crashing', async () => {
    days = [day({ flags: undefined as never })];
    await showBars();
    expect(within(chart()!).getAllByRole('listitem')).toHaveLength(1);
  });

  it('still draws an axis for a month nobody worked', async () => {
    days = [day({ status: 'ABSENT', workedMinutes: 0, checkInAt: null, checkOutAt: null })];
    await showBars();
    expect(within(chart()!).getAllByRole('listitem')).toHaveLength(1);
  });

  it('says so plainly when the month is empty', async () => {
    days = [];
    renderViews();
    await waitFor(() => expect(grid()).toBeInTheDocument());
    await userEvent.click(seg(/^Bars$/));
    // No chart to wait for: the empty state stands in its place.
    expect(await screen.findByText(/Nothing to chart/i)).toBeInTheDocument();
    expect(chart()).not.toBeInTheDocument();
  });
});

describe('the table', () => {
  const showTable = async () => {
    renderViews();
    await waitFor(() => expect(grid()).toBeInTheDocument());
    await userEvent.click(seg(/^Table$/));
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Worked' })).toBeInTheDocument());
  };

  it('has a column for every figure the day carries', async () => {
    await showTable();
    for (const name of ['Date', 'Day', 'Check in', 'Check out', 'Worked', 'Late', 'Early', 'Overtime', 'Shift', 'Status', 'Notes']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
  });

  it('prints the engine figures for a worked day', async () => {
    days = [
      day({
        date: '2026-09-03',
        lateMinutes: 25,
        earlyLeaveMinutes: 10,
        overtimeMinutes: 60,
        workedMinutes: 500,
      }),
    ];
    await showTable();
    const cells = screen.getAllByRole('cell').map((c) => c.textContent);

    expect(cells).toContain('2026-09-03');
    expect(cells).toContain('25m');
    expect(cells).toContain('10m');
    expect(cells.some((c) => c?.includes('General'))).toBe(true);
  });

  it('marks a corrected day with the engine MANUAL flag', async () => {
    days = [day({ flags: ['MANUAL'], source: 'ADMIN' })];
    await showTable();
    expect(screen.getByText('Manually adjusted')).toBeInTheDocument();
  });

  it('says a check-out is missing rather than printing a dash', async () => {
    days = [day({ checkOutAt: null, flags: ['MISSING_PUNCH'] })];
    await showTable();
    expect(screen.getByText('Missing')).toBeInTheDocument();
  });

  it('shows an unassigned shift as unassigned, not as blank', async () => {
    days = [day({ shiftId: null, shiftName: null })];
    await showTable();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('names a holiday and a leave type where the engine gave one', async () => {
    days = [
      day({ date: '2026-09-01', status: 'HOLIDAY', holidayName: 'Independence Day', workedMinutes: null }),
      day({ date: '2026-09-02', status: 'ON_LEAVE', leaveTypeName: 'Annual leave', workedMinutes: null }),
    ];
    await showTable();
    expect(screen.getByText('Independence Day')).toBeInTheDocument();
    expect(screen.getByText('Annual leave')).toBeInTheDocument();
  });

  it('says so plainly when the month is empty', async () => {
    days = [];
    await showTable();
    expect(screen.getByText(/Nothing in this month/i)).toBeInTheDocument();
  });
});

describe('nothing in the views hard-codes a rule', () => {
  /**
   * The same 240 minutes is a HALF_DAY under one policy and a PRESENT day under
   * a shorter-day policy. The table must print what it is handed, both times,
   * with no threshold of its own overruling the engine.
   */
  it.each([
    ['HALF_DAY', 'Half day'],
    ['PRESENT', 'Present'],
  ] as const)('prints 240 worked minutes as %s when the engine says so', async (status, label) => {
    days = [day({ date: '2026-09-01', status, workedMinutes: 240 })];
    renderViews();
    await waitFor(() => expect(grid()).toBeInTheDocument());
    await userEvent.click(seg(/^Table$/));
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Worked' })).toBeInTheDocument());

    const row = screen.getByRole('cell', { name: '2026-09-01' }).closest('tr')!;
    expect(within(row).getByText(label)).toBeInTheDocument();
  });

  it('scales the axis to the data, not to a fixed working day', () => {
    // A 6-hour company and a 12-hour company both get a full-height tallest bar.
    expect(axisTicks(360).at(-1)! * 60).toBeGreaterThanOrEqual(360);
    expect(axisTicks(720).at(-1)! * 60).toBeGreaterThanOrEqual(720);
    expect(axisTicks(540).at(-1)! * 60).toBeGreaterThanOrEqual(540);
  });
});
