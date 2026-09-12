// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { AttendanceDay, RegularizationRecord } from '@hrms/shared';

/**
 * The employee's own corrections screen.
 *
 * What is pinned here is the ownership story as a person experiences it: the
 * screen asks for the caller's own month and the caller's own requests, the
 * form it opens carries no employee id at all, and a decision that has been
 * made is reported with the reviewer's own words rather than a bare status.
 *
 * The security itself is enforced on the server - see
 * `apps/api/src/modules/time/regularizations.routes.test.ts`. What these tests
 * defend is that the client never asks a wider question than it is entitled to,
 * which is how a scope-filtered endpoint ends up serving a manager their team's
 * data on a screen labelled "yours".
 */

let employeeLinked = true;

vi.mock('@/features/auth/session-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth/session-context')>();
  return {
    ...actual,
    useAuthenticatedSession: () => ({
      employeeLinked,
      user: { employee: employeeLinked ? { id: 'emp-1' } : null },
      company: { currency: 'PKR' },
    }),
  };
});

import { api } from '@/lib/api';
import { MyCorrectionsPage, isCorrectable } from './my-corrections';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), getPage: vi.fn(), post: vi.fn() },
  };
});

const day = (over: Partial<AttendanceDay> & { date: string }): AttendanceDay => ({
  status: 'PRESENT',
  flags: [],
  checkInAt: null,
  checkOutAt: null,
  workedMinutes: null,
  expectedMinutes: 480,
  lateMinutes: null,
  earlyLeaveMinutes: null,
  overtimeMinutes: null,
  breakMinutes: null,
  irregular: false,
  mode: null,
  shiftId: null,
  shiftName: null,
  notes: null,
  leaveTypeName: null,
  holidayName: null,
  source: null,
  recordId: null,
  hasRecord: false,
  ...over,
});

const REQUEST: RegularizationRecord = {
  id: 'reg-1',
  employeeId: 'emp-1',
  employeeName: 'Awais Zahid',
  attendanceDate: '2026-09-02',
  issueType: 'MISSING_PUNCH',
  requestedCheckInAt: null,
  requestedCheckOutAt: '2026-09-02T13:05:00.000Z',
  requestedStatus: null,
  reason: 'The terminal was offline when I left.',
  status: 'PENDING',
  approvalRequestId: 'appr-1',
  decidedAt: null,
  reviewerName: null,
  reviewerComment: null,
  createdAt: '2026-09-03T05:00:00.000Z',
};

function renderPage(options: { days?: AttendanceDay[]; requests?: RegularizationRecord[] } = {}) {
  const days = options.days ?? [];
  const requests = options.requests ?? [];

  vi.mocked(api.get).mockImplementation(() => Promise.resolve({ days, totals: {} } as never));
  vi.mocked(api.getPage).mockImplementation(() =>
    Promise.resolve({
      data: requests,
      meta: { page: 1, limit: 20, total: requests.length, totalPages: 1 },
    } as never),
  );
  vi.mocked(api.post).mockResolvedValue({ id: 'reg-new' } as never);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MyCorrectionsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  employeeLinked = true;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('which days may be corrected', () => {
  it('offers a correction on a day that has happened, whatever it was worth', () => {
    const today = '2026-09-12';
    expect(isCorrectable(day({ date: '2026-09-11', status: 'ABSENT' }), today)).toBe(true);
    expect(isCorrectable(day({ date: '2026-09-06', status: 'WEEKEND' }), today)).toBe(true);
    // Working a holiday with no punch is precisely the case worth raising.
    expect(isCorrectable(day({ date: '2026-09-08', status: 'HOLIDAY' }), today)).toBe(true);
    expect(isCorrectable(day({ date: today, status: 'PRESENT' }), today)).toBe(true);
  });

  it('offers nothing on a day that has not happened', () => {
    const today = '2026-09-12';
    expect(isCorrectable(day({ date: '2026-09-20', status: 'UPCOMING' }), today)).toBe(false);
    expect(isCorrectable(day({ date: '2026-09-13', status: 'PRESENT' }), today)).toBe(false);
  });
});

describe('the screen', () => {
  it('asks for the caller own month and the caller own requests, naming nobody', async () => {
    renderPage();

    await waitFor(() => expect(api.get).toHaveBeenCalled());

    // The month: no employeeId, so the endpoint answers for the session.
    const summaryCall = vi.mocked(api.get).mock.calls.find(([path]) =>
      path === '/attendance/summary',
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall?.[1]?.query).not.toHaveProperty('employeeId');

    // The requests: view=mine, resolved server-side from the session.
    const listCall = vi.mocked(api.getPage).mock.calls[0];
    expect(listCall?.[0]).toBe('/attendance/regularizations');
    expect(listCall?.[1]?.query).toMatchObject({ view: 'mine' });
    expect(listCall?.[1]?.query).not.toHaveProperty('employeeId');
  });

  it('shows a pending request with what was asked for and no decision', async () => {
    renderPage({ requests: [REQUEST] });

    expect(await screen.findByText('The terminal was offline when I left.')).toBeInTheDocument();
    expect(screen.getByText('Missing punch')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Waiting for a decision')).toBeInTheDocument();
  });

  it('shows a rejected request with the reviewer and their comment', async () => {
    renderPage({
      requests: [
        {
          ...REQUEST,
          id: 'reg-2',
          status: 'REJECTED',
          decidedAt: '2026-09-04T09:00:00.000Z',
          reviewerName: 'Bilal Ahmed',
          reviewerComment: 'You were marked on leave that day.',
        },
      ],
    });

    expect(await screen.findByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('Bilal Ahmed')).toBeInTheDocument();
    expect(screen.getByText('"You were marked on leave that day."')).toBeInTheDocument();
  });

  it('puts a correction action on a past day and none on a future one', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);

    renderPage({
      days: [
        day({ date: past, status: 'ABSENT' }),
        day({ date: today, status: 'PRESENT' }),
        day({ date: future, status: 'UPCOMING' }),
      ],
    });

    expect(await screen.findByLabelText(`Request correction for ${past}`)).toBeInTheDocument();
    expect(screen.getByLabelText(`Request correction for ${today}`)).toBeInTheDocument();
    expect(
      screen.queryByLabelText(`Request correction for ${future}`),
    ).not.toBeInTheDocument();
  });

  it('opens the form on the day whose row was clicked', async () => {
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    renderPage({ days: [day({ date: past, status: 'ABSENT' })] });

    await userEvent.click(await screen.findByLabelText(`Request correction for ${past}`));

    const dialog = await screen.findByRole('dialog');
    // The date is carried over, so nobody retypes it from memory onto the
    // wrong day.
    expect(within(dialog).getByLabelText(/^Date/)).toHaveValue(past);
  });

  it('submits a correction with no employee id in the body', async () => {
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    renderPage({ days: [day({ date: past, status: 'ABSENT' })] });

    await userEvent.click(await screen.findByLabelText(`Request correction for ${past}`));
    const dialog = await screen.findByRole('dialog');

    await userEvent.type(
      within(dialog).getByLabelText(/^Reason/),
      'Neither punch reached the system.',
    );
    await userEvent.type(within(dialog).getByLabelText('Check-in time'), '09:00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit request' }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, body] = vi.mocked(api.post).mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/attendance/regularizations');
    expect(body).not.toHaveProperty('employeeId');
    expect(body.attendanceDate).toBe(past);
    expect(body.issueType).toBe('MISSING_PUNCH');
    // A wall-clock reading; the server resolves it in the company's timezone.
    expect(body.requestedCheckInAt).toBe('09:00');
  });

  it('offers only the time the chosen issue is about', async () => {
    renderPage();

    // Several entry points offer this; the header one is as good as any.
    const buttons = await screen.findAllByRole('button', { name: /Request a correction/ });
    await userEvent.click(buttons[0]!);
    const dialog = await screen.findByRole('dialog');

    // Missing punch: both ends may be missing.
    expect(within(dialog).getByLabelText('Check-in time')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Check-out time')).toBeInTheDocument();

    await userEvent.selectOptions(
      within(dialog).getByLabelText(/What went wrong/),
      'INCORRECT_CHECK_IN',
    );

    // Only the arrival. Offering the departure here invites a correction that
    // silently rewrites a time nobody complained about.
    expect(within(dialog).getByLabelText('Check-in time')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Check-out time')).not.toBeInTheDocument();
  });

  it('says so plainly when the login has no employee record', () => {
    employeeLinked = false;
    renderPage();

    expect(screen.getByText('Employee profile not configured')).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });
});
