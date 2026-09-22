// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { AttendanceDayDetail, AttendanceMonthlyRow } from '@hrms/shared';

/**
 * The corrections page, which crashed in production on every load.
 *
 * The cause was one level of nesting. `/attendance/monthly` answers with
 * `meta`, `totals` and `range` BESIDE `data`, and the page read it with
 * `api.get`, which unwraps and returns the inner `data` - so the rows array
 * arrived where the envelope was expected. An empty array is still truthy, so
 * the `query.data ? <Pagination meta={query.data.meta}/> : null` guard let
 * `undefined` through and Pagination destructured it:
 *
 *   TypeError: Cannot destructure property 'page' of 'meta' as it is undefined.
 *
 * Every test here therefore serves the SHAPE THE SERVER ACTUALLY SENDS. A
 * fixture that nests one level deeper would pass against the broken code and
 * prove nothing.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const permissions = { canManage: true };
vi.mock('@/features/auth/session-context', () => ({
  usePermissions: () => ({
    has: (permission: string) =>
      permission === 'attendance.manage' ? permissions.canManage : true,
    hasAny: () => true,
    hasAll: () => true,
  }),
}));

import { api } from '@/lib/api';
import { AttendanceCorrectionsPage } from './attendance-corrections-page';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), getEnvelope: vi.fn(), getPage: vi.fn(), post: vi.fn() },
  };
});

const row = (over: Partial<AttendanceMonthlyRow> = {}): AttendanceMonthlyRow =>
  ({
    date: '2026-09-03',
    employeeId: 'emp-1',
    employeeName: 'Ada Lovelace',
    employeeNumber: 'E-001',
    departmentName: 'Engineering',
    teamName: 'Platform',
    shiftId: 'shift-1',
    shiftName: 'General',
    checkInAt: '2026-09-03T09:12:00.000Z',
    checkOutAt: '2026-09-03T18:20:00.000Z',
    workedMinutes: 488,
    expectedMinutes: 480,
    lateMinutes: 12,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 20,
    status: 'PRESENT',
    flags: ['LATE'],
    ...over,
  }) as AttendanceMonthlyRow;

const TOTALS = {
  present: 1, absent: 0, halfDay: 0, onLeave: 0, holiday: 0, weekend: 0, offDay: 0, upcoming: 0,
  late: 1, earlyLeave: 0, overtime: 1, missingPunch: 0, irregular: 0, manual: 0,
  workedMinutes: 488, overtimeMinutes: 20, lateMinutes: 12, earlyLeaveMinutes: 0,
};

/** The envelope exactly as `/attendance/monthly` sends it: siblings of `data`. */
const monthlyEnvelope = (rows: AttendanceMonthlyRow[]) => ({
  data: rows,
  meta: { page: 1, limit: 25, total: rows.length, totalPages: rows.length === 0 ? 0 : 1 },
  totals: TOTALS,
  range: { from: '2026-09-01', to: '2026-09-30' },
});

const dayDetail = (): AttendanceDayDetail =>
  ({
    date: '2026-09-03',
    employee: {
      id: 'emp-1',
      name: 'Ada Lovelace',
      employeeNumber: 'E-001',
      departmentName: 'Engineering',
      teamName: 'Platform',
      designationName: null,
      punchCodes: [{ deviceId: 'd1', deviceName: 'Gate K50', deviceUserId: '42' }],
    },
    shift: {
      id: 'shift-1', name: 'General', startTime: '09:00', endTime: '18:00',
      breakMinutes: 60, expectedMinutes: 480, assigned: true,
    },
    rules: {
      policyName: 'Default rules', graceMinutes: 10, earlyLeaveGraceMinutes: 10,
      fullDayMinutes: 480, fullDayToleranceMinutes: 15, fromShift: [],
    },
    processed: {
      date: '2026-09-03', status: 'PRESENT', flags: ['LATE'],
      checkInAt: '2026-09-03T09:12:00.000Z', checkOutAt: '2026-09-03T18:20:00.000Z',
      workedMinutes: 488, expectedMinutes: 480, lateMinutes: 12, earlyLeaveMinutes: 0,
      overtimeMinutes: 20, irregular: false, mode: 'OFFICE', shiftId: 'shift-1',
      shiftName: 'General', notes: null, leaveTypeName: null, holidayName: null,
      source: 'DEVICE', hasRecord: true,
    },
    fromPunches: {
      checkInAt: '2026-09-03T09:12:00.000Z', checkOutAt: '2026-09-03T18:20:00.000Z',
      workedMinutes: 488, lateMinutes: 12, earlyLeaveMinutes: 0, overtimeMinutes: 20,
      status: 'PRESENT', irregular: false,
    },
    rawPunches: [
      {
        id: 'p1', punchedAt: '2026-09-03T09:12:00.000Z', deviceName: 'Gate K50',
        deviceUserId: '42', punchState: 'IN', role: 'IN',
        importedAt: '2026-09-03T09:13:00.000Z',
      },
    ],
    adjustments: [
      {
        id: 'adj-1', actorName: 'Grace Hopper', createdAt: '2026-09-04T08:00:00.000Z',
        reason: 'Terminal clock drifted by an hour.',
        changedFields: ['checkInAt'],
        before: { checkInAt: '10:12' }, after: { checkInAt: '09:12' },
      },
    ],
  }) as unknown as AttendanceDayDetail;

const LOOKUPS = {
  departments: [{ id: 'dep-1', label: 'Engineering' }],
  teams: [{ id: 'team-1', label: 'Platform' }],
  designations: [],
  locations: [],
  managers: [{ id: 'emp-1', label: 'Ada Lovelace' }],
};

let monthly: unknown = monthlyEnvelope([row()]);
let monthlyFails = false;

beforeEach(() => {
  permissions.canManage = true;
  monthly = monthlyEnvelope([row()]);
  monthlyFails = false;

  vi.mocked(api.get).mockImplementation((path: string) => {
    if (path === '/departments/lookups') return Promise.resolve(LOOKUPS as never);
    if (path === '/attendance/day') return Promise.resolve(dayDetail() as never);
    return Promise.resolve(null as never);
  });
  vi.mocked(api.getEnvelope).mockImplementation((path: string) => {
    if (path === '/attendance/monthly') {
      return monthlyFails
        ? Promise.reject(new Error('The server refused that range.'))
        : Promise.resolve(monthly as never);
    }
    return Promise.resolve(null as never);
  });
  vi.mocked(api.post).mockResolvedValue(undefined as never);
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
        <AttendanceCorrectionsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('the corrections page renders at all', () => {
  it('loads a populated month without crashing', async () => {
    renderPage();

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Attendance corrections' })).toBeInTheDocument();
    // The regression itself: pagination reads the envelope's meta.
    expect(await screen.findByLabelText('Next page')).toBeInTheDocument();
  });

  it('survives an empty result, where an empty array is still truthy', async () => {
    monthly = monthlyEnvelope([]);
    renderPage();

    expect(await screen.findByText('No attendance matches those filters')).toBeInTheDocument();
    // The envelope still carries a real meta for an empty page, so pagination
    // renders and says so. The point is that it renders instead of throwing.
    expect(screen.getByText('No results')).toBeInTheDocument();
    expect(screen.getByLabelText('Next page')).toBeDisabled();
  });

  it('shows the error state rather than a blank screen when the API fails', async () => {
    monthlyFails = true;
    renderPage();

    expect(await screen.findByText(/The server refused that range\./)).toBeInTheDocument();
  });

  it('reads the envelope endpoint, never the unwrapping one', async () => {
    renderPage();
    await screen.findByText('Ada Lovelace');

    expect(vi.mocked(api.getEnvelope)).toHaveBeenCalledWith('/attendance/monthly', expect.anything());
    expect(vi.mocked(api.get)).not.toHaveBeenCalledWith('/attendance/monthly', expect.anything());
  });

  it('shows the month totals the envelope carries', async () => {
    renderPage();
    await screen.findByText('Ada Lovelace');

    // Scoped to the summary tiles: "Late" is also a column header below, and
    // "Missing punch" is also an option in the flag filter.
    const anchor = screen
      .getAllByText('Missing punch')
      .find((el) => el.tagName === 'P')!;
    const tiles = anchor.closest('.grid') as HTMLElement;
    const late = within(tiles).getByText('Late').closest('div')!;
    expect(within(late).getByText('1')).toBeInTheDocument();
  });
});

describe('the correction filters', () => {
  it('sends employee code, department, team, status and range to the API', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ada Lovelace');

    await user.type(screen.getByLabelText('Employee code'), 'E-001');
    await user.selectOptions(screen.getByLabelText('Department'), 'dep-1');
    await user.selectOptions(screen.getByLabelText('Team'), 'team-1');
    await user.selectOptions(screen.getByLabelText('Status'), 'ABSENT');

    await waitFor(() => {
      const last = vi.mocked(api.getEnvelope).mock.calls.at(-1);
      expect(last?.[1]?.query).toMatchObject({
        employeeNumber: 'E-001',
        departmentId: 'dep-1',
        teamId: 'team-1',
        status: 'ABSENT',
      });
    });
  });

  it('lets an explicit range win over the month', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ada Lovelace');

    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-09-10');

    await waitFor(() => {
      const last = vi.mocked(api.getEnvelope).mock.calls.at(-1);
      expect(last?.[1]?.query).toMatchObject({ from: '2026-09-10', month: undefined });
    });
  });
});

describe('correction permissions', () => {
  it('offers the correction form to somebody with attendance.manage', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Open' }));

    expect(await screen.findByText('Correct this day')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save correction' })).toBeInTheDocument();
  });

  it('gives a read-only viewer the evidence and no way to change it', async () => {
    permissions.canManage = false;
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'View' }));

    expect(await screen.findByText('Original punches')).toBeInTheDocument();
    expect(screen.queryByText('Correct this day')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save correction' })).not.toBeInTheDocument();
  });
});

describe('the correction itself', () => {
  it('refuses to submit without a reason, and accepts one', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    await screen.findByText('Correct this day');

    const save = screen.getByRole('button', { name: 'Save correction' });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText(/Reason/), 'Terminal clock drifted.');
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledTimes(1));

    const [path, body] = vi.mocked(api.post).mock.calls[0]!;
    expect(path).toBe('/attendance/corrections');
    expect(body).toMatchObject({
      employeeId: 'emp-1',
      date: '2026-09-03',
      reason: 'Terminal clock drifted.',
    });
  });

  it('leaves a blank minute box out entirely, so the server recomputes it', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    await screen.findByText('Correct this day');

    await user.type(screen.getByLabelText(/Reason/), 'Clock drift.');
    await user.click(screen.getByRole('button', { name: 'Save correction' }));

    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalled());
    const body = vi.mocked(api.post).mock.calls[0]![1] as Record<string, unknown>;
    // Undefined, not 0. Zero would be a claim that nothing was worked.
    expect(body.workedMinutes).toBeUndefined();
    expect(body.lateMinutes).toBeUndefined();
    expect(body.overtimeMinutes).toBeUndefined();
  });

  it('shows the punches as evidence and says they are never edited', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Open' }));

    expect(await screen.findByText('Original punches')).toBeInTheDocument();
    expect(screen.getByText('Gate K50')).toBeInTheDocument();
    expect(
      screen.getByText(/Punches are evidence and are never edited by a correction\./),
    ).toBeInTheDocument();
  });

  it('shows the audit trail for the day', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Open' }));

    expect(await screen.findByText('Corrections to this day')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByText('Terminal clock drifted by an hour.')).toBeInTheDocument();
    expect(screen.getByText(/10:12/)).toBeInTheDocument();
  });
});
