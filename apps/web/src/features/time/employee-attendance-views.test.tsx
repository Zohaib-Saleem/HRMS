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

/** The same heights as fractions of the plot, for comparing one bar to another. */
const shares = (bar: HTMLElement): number[] =>
  heights(bar).map((h) => Number.parseFloat(h) / 100);

/** The y axis labels, in the order they are drawn. */
const axisLabels = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('span.tabular.absolute')]
    .map((el) => el.textContent ?? '')
    .filter((t) => /^\d+:\d\d$/.test(t));

/**
 * The value of one labelled figure in the tooltip.
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

  /** What a finger does on a phone, where there is no hover to rely on. */
  const tap = (index: number) =>
    userEvent.pointer({
      target: within(chart()!).getAllByRole('listitem')[index]!.querySelector('button')!,
      keys: '[TouchA]',
    });

  /** What a mouse does on a desktop. */
  const hover = (index: number) =>
    userEvent.hover(within(chart()!).getAllByRole('listitem')[index]!.querySelector('button')!);

  it('labels the y axis in hours and minutes, not in percentages', async () => {
    days = [day({ workedMinutes: 539 })];
    await showBars();

    const labels = axisLabels();
    expect(labels[0]).toBe('0:00');
    expect(labels).toHaveLength(axisTicks(539).length);
    for (const label of labels) expect(label).toMatch(/^\d+:[0-5]\d$/);
  });

  it('shows the day under the pointer without needing a tap', async () => {
    days = [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })];
    await showBars();

    await hover(1);
    expect(within(await screen.findByRole('status')).getByText('02-Sep')).toBeInTheDocument();

    await userEvent.unhover(
      within(chart()!).getAllByRole('listitem')[1]!.querySelector('button')!,
    );
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  /**
   * Real maxima from the attendance data, and the axis each one produces.
   *
   * Pinned because "sensible intervals" is the whole requirement and it is the
   * kind of thing that decays into 0:00, 0:50, 1:40 the moment somebody
   * reaches for a round decimal. Every tick here is a readable clock duration
   * and the top of each axis clears its own tallest day.
   */
  it.each([
    [539, ['0:00', '1:30', '3:00', '4:30', '6:00', '7:30', '9:00', '10:30']],
    [737, ['0:00', '2:00', '4:00', '6:00', '8:00', '10:00', '12:00', '14:00']],
    [240, ['0:00', '1:00', '2:00', '3:00', '4:00', '5:00']],
  ])('divides an axis for a %i-minute day into readable steps', async (max, expected) => {
    days = [day({ workedMinutes: max })];
    await showBars();
    expect(axisLabels()).toEqual(expected);
  });

  it('names every calendar day on the x axis', async () => {
    days = [
      day({ date: '2026-09-01' }),
      day({ date: '2026-09-02' }),
      day({ date: '2026-09-30' }),
    ];
    await showBars();

    const axisRow = chart()!.nextElementSibling as HTMLElement;
    expect([...axisRow.children].map((el) => el.textContent)).toEqual([
      '01-Sep',
      '02-Sep',
      '30-Sep',
    ]);
  });

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

    // Against whatever ceiling the axis chose, half the minutes is half the
    // bar. The ratio is the claim; the ceiling is the axis's business.
    expect(shares(bars[1]!)[0]!).toBeCloseTo(shares(bars[0]!)[0]! / 2, 6);
    expect(shares(bars[0]!)[0]!).toBeLessThanOrEqual(1);
  });

  it('leaves the tallest day a little air rather than pinning it to the ceiling', async () => {
    days = [day({ workedMinutes: 539 })];
    await showBars();

    const top = axisTicks(539).at(-1)!;
    expect(top).toBeGreaterThan(539);
    expect(shares(within(chart()!).getAllByRole('listitem')[0]!)[0]!).toBeLessThan(1);
  });

  it('carves overtime out of the bar rather than stacking it on top', async () => {
    days = [day({ workedMinutes: 480, overtimeMinutes: 120 })];
    await showBars();
    const segments = heights(within(chart()!).getAllByRole('listitem')[0]!);

    // 360 worked + 120 overtime = the 480 the engine reported, not 600.
    const bar = within(chart()!).getAllByRole('listitem')[0]!;
    const top = axisTicks(480).at(-1)!;
    expect(segments).toHaveLength(2);
    expect(shares(bar)[0]!).toBeCloseTo(360 / top, 6);
    expect(shares(bar)[1]!).toBeCloseTo(120 / top, 6);
    expect(shares(bar)[0]! + shares(bar)[1]!).toBeCloseTo(480 / top, 6);
  });

  it('never lets a bar leave its own plot', () => {
    // A nine-hour day against a four-hour step used to stop the axis at eight.
    for (const minutes of [1, 59, 60, 510, 540, 720, 1440, 2000]) {
      const top = axisTicks(minutes).at(-1)!;
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

  it('shows the whole day in the tooltip when a bar is tapped', async () => {
    days = [
      day({
        date: '2026-09-03',
        status: 'PRESENT',
        flags: ['LATE', 'OVERTIME'],
        checkInAt: '2026-09-03T09:25:00.000Z',
        checkOutAt: '2026-09-03T19:00:00.000Z',
        workedMinutes: 500,
        breakMinutes: 0,
        lateMinutes: 25,
        earlyLeaveMinutes: 0,
        overtimeMinutes: 60,
        shiftName: 'General',
      }),
    ];
    await showBars();
    await tap(0);

    const tip = await screen.findByRole('status');
    expect(within(tip).getByText('03-Sep')).toBeInTheDocument();
    expect(figure(tip, 'Status')).toBe('Late');
    expect(figure(tip, 'Shift')).toBe('General');
    expect(figure(tip, 'Late')).toBe('0:25');
    expect(figure(tip, 'Overtime')).toBe('1:00');
    expect(figure(tip, 'Time In')).not.toBe('--');
    expect(figure(tip, 'Time Out')).not.toBe('--');
    expect(figure(tip, 'Break Hrs')).toBe('0:00');
    expect(figure(tip, 'Remote Hrs')).toBe('0:00');
    // 500 minutes as the engine reported them - never checkOut - checkIn,
    // which would have said 9:35.
    expect(figure(tip, 'Total Worked Hrs')).toBe('8:20');
  });

  it('quotes the engine minutes rather than the gap between the punches', async () => {
    // The span is nine hours; the engine took an hour of it off as break and
    // said eight. Eight is what the tooltip must say.
    days = [
      day({
        checkInAt: '2026-09-03T09:00:00.000Z',
        checkOutAt: '2026-09-03T18:00:00.000Z',
        workedMinutes: 480,
        breakMinutes: 60,
      }),
    ];
    await showBars();
    await tap(0);

    const tip = await screen.findByRole('status');
    expect(figure(tip, 'Total Worked Hrs')).toBe('8:00');
    expect(figure(tip, 'Break Hrs')).toBe('1:00');
  });

  it('calls a remote day remote, on the engine mode alone', async () => {
    days = [day({ mode: 'REMOTE', workedMinutes: 480 })];
    await showBars();
    await tap(0);
    expect(figure(await screen.findByRole('status'), 'Remote Hrs')).toBe('8:00');
  });

  it('moves the tooltip to the next bar tapped, and closes on a second tap', async () => {
    days = [
      day({ date: '2026-09-01', workedMinutes: 480 }),
      day({ date: '2026-09-02', workedMinutes: 240 }),
    ];
    await showBars();

    await tap(0);
    expect(within(await screen.findByRole('status')).getByText('01-Sep')).toBeInTheDocument();

    await tap(1);
    expect(within(await screen.findByRole('status')).getByText('02-Sep')).toBeInTheDocument();

    await tap(1);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
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
    await tap(0);

    const tip = await screen.findByRole('status');
    expect(figure(tip, 'Shift')).toBe('Unassigned');
    expect(figure(tip, 'Time Out')).toBe('Missing');
    // A figure the engine had no answer for is a dash, never a zero.
    expect(figure(tip, 'Total Worked Hrs')).toBe('--');
    expect(figure(tip, 'Break Hrs')).toBe('--');
    // Nothing to say about lateness or overtime, so nothing is said.
    expect(within(tip).queryByText('Overtime')).not.toBeInTheDocument();
  });

  it('gives a day nobody worked its place on the axis and no height', async () => {
    days = [
      day({ date: '2026-09-05', status: 'WEEKEND', checkInAt: null, checkOutAt: null, workedMinutes: null, hasRecord: false, recordId: null, source: null, mode: null }),
      day({ date: '2026-09-06', status: 'ON_LEAVE', leaveTypeName: 'Annual leave', checkInAt: null, checkOutAt: null, workedMinutes: null, hasRecord: false, recordId: null, source: null, mode: null }),
      day({ date: '2026-09-07', status: 'UPCOMING', checkInAt: null, checkOutAt: null, workedMinutes: null, hasRecord: false, recordId: null, source: null, mode: null }),
      day({ date: '2026-09-08', workedMinutes: 480 }),
    ];
    await showBars();

    const bars = within(chart()!).getAllByRole('listitem');
    expect(bars).toHaveLength(4);
    // A marker in pixels, not a share of the plot: no hours are claimed.
    for (const bar of bars.slice(0, 3)) {
      for (const h of heights(bar)) expect(h).not.toMatch(/%$/);
    }
    expect(heights(bars[3]!)[0]).toMatch(/%$/);

    await tap(2);
    const tip = await screen.findByRole('status');
    expect(figure(tip, 'Status')).toBe('Upcoming');
    expect(figure(tip, 'Total Worked Hrs')).toBe('--');
    expect(figure(tip, 'Remote Hrs')).toBe('--');
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

  /**
   * The chart used to paint `days x 25px` and stop, leaving half a wide card
   * empty. Columns must SHARE the plot, so none of them may carry a width of
   * its own - only a floor, below which the track scrolls instead.
   */
  it('lets the columns share the full width rather than fixing each one', async () => {
    days = [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })];
    await showBars();

    for (const bar of within(chart()!).getAllByRole('listitem')) {
      expect(bar.style.flex).toBe('1 1 0px');
      expect(bar.style.width).toBe('');
      expect(bar.style.maxWidth).toBe('');
      expect(bar.style.minWidth).toBe('18px');
    }
  });

  it('keeps the day labels on the same footing as the bars they name', async () => {
    days = [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })];
    await showBars();

    // Labels drift out from under their bars the moment the two disagree.
    // Scoped to the axis row: "1" also appears in the month totals above.
    const axisRow = chart()!.nextElementSibling as HTMLElement;
    const labels = [...axisRow.children] as HTMLElement[];
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.style.flex).toBe('1 1 0px');
      expect(label.style.width).toBe('');
    }
  });

  it('keeps a scrollable floor so a phone does not squash the month', async () => {
    days = Array.from({ length: 30 }, (_, i) =>
      day({ date: `2026-09-${String(i + 1).padStart(2, '0')}` }));
    await showBars();

    const track = chart()!.parentElement!;
    // 30 columns at the 18px floor, 29 three-pixel gaps, and the lead the
    // turned date labels need in front of the first column.
    expect(track.style.minWidth).toBe(`${30 * 18 + 29 * 3 + 20}px`);
    expect(track).toHaveClass('w-full');
  });

  it('does not change the plot height to fill horizontal space', async () => {
    days = [day({ date: '2026-09-01', workedMinutes: 480 })];
    await showBars();
    // Height still comes from worked minutes against the axis, not from layout.
    const top = axisTicks(480).at(-1)!;
    expect(shares(within(chart()!).getAllByRole('listitem')[0]!)[0]!).toBeCloseTo(480 / top, 6);
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
    // A 6-hour company and a 12-hour company both get a tallest bar that fits.
    expect(axisTicks(360).at(-1)!).toBeGreaterThanOrEqual(360);
    expect(axisTicks(720).at(-1)!).toBeGreaterThanOrEqual(720);
    expect(axisTicks(540).at(-1)!).toBeGreaterThanOrEqual(540);

    // And the ceiling follows the data rather than sitting at some fixed day.
    expect(axisTicks(360).at(-1)!).toBeLessThan(axisTicks(720).at(-1)!);
  });
});
