// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { AttendanceDay, TeamAttendanceRow } from '@hrms/shared';

/**
 * The dashboard's figures, as a way in rather than as a full stop.
 *
 * Every attendance number here is a count of days the API classified. Clicking
 * one should land on the list of the people behind it - the same day, the same
 * classification - and not on an unfiltered team page the reader then has to
 * reconstruct the question on.
 *
 * So these assert the destinations, not the arithmetic: that each figure links
 * to team attendance carrying the status (or the flag, for late and overtime)
 * it counted and the date it counted it for.
 */

vi.mock('@/features/auth/session-context', () => ({
  usePermissions: () => ({ has: () => true, hasAny: () => true, hasAll: () => true }),
  useAuthenticatedSession: () => ({
    user: { firstName: 'Ada' },
    company: { name: 'Example Ltd' },
  }),
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

import { api } from '@/lib/api';
import { CompanyDashboard } from './company-dashboard';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), getEnvelope: vi.fn(), getPage: vi.fn() },
  };
});

/** The day the dashboard reads, computed the way the page computes it. */
const TODAY = new Date().toISOString().slice(0, 10);

const day = (over: Partial<AttendanceDay> = {}): AttendanceDay =>
  ({
    date: TODAY,
    status: 'PRESENT',
    flags: [],
    checkInAt: `${TODAY}T09:00:00.000Z`,
    checkOutAt: `${TODAY}T18:00:00.000Z`,
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

const person = (id: string, over: Partial<AttendanceDay>): TeamAttendanceRow =>
  ({
    employeeId: id,
    employeeName: `Person ${id}`,
    employeeNumber: `E-${id}`,
    departmentName: 'Engineering',
    teamId: 'team-1',
    teamName: 'Platform',
    shiftName: 'General',
    days: [day(over)],
    totals: {
      present: 0, halfDay: 0, absent: 0, onLeave: 0, holiday: 0, weekend: 0,
      upcoming: 0, offDay: 0, workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0,
    },
  }) as TeamAttendanceRow;

/** One of each, so no legend row is drawn as an empty slice. */
const ROWS: TeamAttendanceRow[] = [
  person('1', { status: 'PRESENT' }),
  person('2', { status: 'PRESENT', lateMinutes: 20, flags: ['LATE'] }),
  person('3', { status: 'HALF_DAY', workedMinutes: 240 }),
  person('4', { status: 'ABSENT', checkInAt: null, checkOutAt: null }),
  person('5', { status: 'ON_LEAVE', checkInAt: null, checkOutAt: null, leaveTypeName: 'Annual' }),
];

beforeEach(() => {
  vi.mocked(api.get).mockImplementation((path: string) => {
    if (path === '/company/stats') {
      return Promise.resolve({
        employees: 5, activeEmployees: 5, onLeave: 1,
        departments: 1, teams: 1, activeUsers: 5, newThisMonth: 0,
      } as never);
    }
    return Promise.resolve(null as never);
  });
  vi.mocked(api.getPage).mockImplementation((path: string) => {
    if (path === '/attendance/team') {
      return Promise.resolve({
        data: ROWS,
        meta: { page: 1, limit: 100, total: ROWS.length, totalPages: 1 },
      } as never);
    }
    return Promise.resolve({
      data: [],
      meta: { page: 1, limit: 100, total: 0, totalPages: 1 },
    } as never);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <CompanyDashboard />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const href = async (name: RegExp) => (await screen.findByRole('link', { name })).getAttribute('href');

describe('the headline tiles drill into team attendance', () => {
  it('sends Present today to the present people', async () => {
    renderDashboard();
    expect(await href(/Present today/)).toBe(
      `/attendance/team?status=PRESENT&from=${TODAY}&to=${TODAY}`,
    );
  });

  it('sends Absent today to the absent people', async () => {
    renderDashboard();
    expect(await href(/Absent today/)).toBe(
      `/attendance/team?status=ABSENT&from=${TODAY}&to=${TODAY}`,
    );
  });

  it('sends Late today to the late arrivals', async () => {
    renderDashboard();
    expect(await href(/Late today/)).toBe(
      `/attendance/team?status=LATE&from=${TODAY}&to=${TODAY}`,
    );
  });

  it('sends On leave to the attendance days, not to the leave register', async () => {
    renderDashboard();
    expect(await href(/On leave/)).toBe(
      `/attendance/team?status=ON_LEAVE&from=${TODAY}&to=${TODAY}`,
    );
  });

  it('sends the attendance rate to the day itself, with no status', async () => {
    renderDashboard();
    // A percentage is not a classification, so it filters to nothing but the day.
    expect(await href(/^Attendance\s*\d+%/)).toBe(`/attendance/team?from=${TODAY}&to=${TODAY}`);
  });

  it('carries the date the dashboard counted, not the destination default', async () => {
    renderDashboard();
    const link = await href(/Absent today/);
    expect(link).toContain(`from=${TODAY}`);
    expect(link).toContain(`to=${TODAY}`);
  });
});

describe('the attendance overview legend drills down too', () => {
  it('links Present, on time to Present', async () => {
    renderDashboard();
    expect(await href(/^Present, on time/)).toBe(
      `/attendance/team?status=PRESENT&from=${TODAY}&to=${TODAY}`,
    );
  });

  it('links Half day to Half day', async () => {
    renderDashboard();
    expect(await href(/^Half day/)).toBe(
      `/attendance/team?status=HALF_DAY&from=${TODAY}&to=${TODAY}`,
    );
  });

  it('links Late to the late flag', async () => {
    renderDashboard();
    expect(await href(/^Late:/)).toBe(`/attendance/team?status=LATE&from=${TODAY}&to=${TODAY}`);
  });

  it('links On leave to On leave', async () => {
    renderDashboard();
    expect(await href(/^On leave:/)).toBe(
      `/attendance/team?status=ON_LEAVE&from=${TODAY}&to=${TODAY}`,
    );
  });

  it('links Absent to Absent', async () => {
    renderDashboard();
    expect(await href(/^Absent:/)).toBe(
      `/attendance/team?status=ABSENT&from=${TODAY}&to=${TODAY}`,
    );
  });

  it('names the figure and its destination for a screen reader', async () => {
    renderDashboard();
    const link = await screen.findByRole('link', { name: /^Absent: 1\. Open in team attendance\./ });
    expect(link).toBeInTheDocument();
  });
});


