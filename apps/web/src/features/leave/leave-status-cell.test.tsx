// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '@/components/feedback/confirm-dialog';
import { api } from '@/lib/api';
import type { LeaveRequestRecord } from '@hrms/shared';

/**
 * How a leave request reads once attendance reconciliation has touched it.
 *
 * A request the system cancelled must not look like one HR withdrew: it says
 * "Automatic" and carries the reason. A request that lost only some of its
 * days stays approved and names the days given back. Untouched requests look
 * exactly as they always did.
 */

vi.mock('@/features/auth/session-context', () => ({
  usePermissions: () => ({ has: () => false }),
  useSession: () => ({ permissions: new Set(), session: { company: { timezone: 'Asia/Karachi' } } }),
  Can: ({ children }: { children: unknown }) => children,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, post: vi.fn() } };
});

const { LeaveStatusCell } = await import('./leave-status-cell');

type Row = Pick<
  LeaveRequestRecord,
  'status' | 'cancelledBySystem' | 'cancellationReason' | 'reversedDays' | 'reversals'
>;

const reversal = (date: string, days = 1) => ({
  date,
  days,
  reason: `Automatically reversed because attendance was recorded on ${date}.`,
  checkInAt: `${date}T04:05:00.000Z`,
  checkOutAt: null,
  createdAt: `${date}T04:06:00.000Z`,
  manual: false,
});

afterEach(cleanup);

describe('LeaveStatusCell', () => {
  it('marks a system cancellation as automatic and gives the reason', () => {
    const row: Row = {
      status: 'CANCELLED',
      cancelledBySystem: true,
      cancellationReason: 'Automatically cancelled because attendance was recorded on 06-Oct-2026.',
      reversedDays: 1,
      reversals: [reversal('2026-10-06')],
    };
    render(<LeaveStatusCell row={row} />);

    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Automatic')).toBeInTheDocument();
    expect(
      screen.getByText('Automatically cancelled because attendance was recorded on 06-Oct-2026.'),
    ).toBeInTheDocument();
  });

  it('a cancellation by a person carries no automatic marker', () => {
    const row: Row = {
      status: 'CANCELLED',
      cancelledBySystem: false,
      cancellationReason: null,
      reversedDays: 0,
      reversals: [],
    };
    render(<LeaveStatusCell row={row} />);

    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByText('Automatic')).not.toBeInTheDocument();
    expect(screen.queryByText(/attendance was recorded/)).not.toBeInTheDocument();
  });

  it('a partly reversed request stays approved and names the day returned', () => {
    const row: Row = {
      status: 'APPROVED',
      cancelledBySystem: false,
      cancellationReason: null,
      reversedDays: 1,
      reversals: [reversal('2026-10-06')],
    };
    render(<LeaveStatusCell row={row} />);

    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.queryByText('Automatic')).not.toBeInTheDocument();
    expect(screen.getByText(/1 day returned automatically/)).toBeInTheDocument();
  });

  it('a Super Admin cancellation says so and gives the reason', () => {
    const row: Row = {
      status: 'CANCELLED',
      cancelledBySystem: false,
      cancellationReason:
        'Super Admin cancellation / attendance conflict: the employee attended work on 06-Oct-2026.',
      reversedDays: 1,
      reversals: [{ ...reversal('2026-10-06'), manual: true }],
    };
    render(<LeaveStatusCell row={row} />);

    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Super Admin')).toBeInTheDocument();
    expect(screen.queryByText('Automatic')).not.toBeInTheDocument();
    expect(screen.getByText(/attendance conflict: the employee attended work on 06-Oct-2026/)).toBeInTheDocument();
  });
});

describe('approved leave with attendance on it', () => {
  const conflicted = (canResolveConflict: boolean) => ({
    id: 'leave-1',
    employeeName: 'Hira Javed',
    leaveTypeName: 'Casual Leave',
    startDate: '2026-10-06',
    endDate: '2026-10-06',
    status: 'APPROVED' as const,
    cancelledBySystem: false,
    cancellationReason: null,
    reversedDays: 0,
    reversals: [],
    // 04:05 UTC is 09:05 in Karachi.
    attendanceConflicts: [{ date: '2026-10-06', checkInAt: '2026-10-06T04:05:00.000Z', checkOutAt: null }],
    canResolveConflict,
  });

  function renderCell(row: ReturnType<typeof conflicted>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <ConfirmProvider>
          <LeaveStatusCell row={row} />
        </ConfirmProvider>
      </QueryClientProvider>,
    );
  }

  it('shows the conflict to anyone who can see the request, with no button', () => {
    renderCell(conflicted(false));
    expect(screen.getByText(/Attendance recorded on leave/)).toHaveTextContent('09:05 AM');
    expect(screen.queryByRole('button', { name: 'Cancel Leave' })).not.toBeInTheDocument();
  });

  it('a Super Admin confirms with the employee, type, date and check-in in front of them', async () => {
    vi.mocked(api.post).mockResolvedValue({
      id: 'leave-1',
      status: 'CANCELLED',
      restoredDays: 1,
      reversedDates: ['2026-10-06'],
      alreadyResolved: false,
    } as never);
    renderCell(conflicted(true));

    await userEvent.click(screen.getByRole('button', { name: 'Cancel Leave' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Cancel this approved leave because the employee has attended work?');
    expect(dialog).toHaveTextContent('Hira Javed');
    expect(dialog).toHaveTextContent('Casual Leave');
    expect(dialog).toHaveTextContent('in 09:05 AM');
    expect(screen.getByRole('button', { name: 'Keep Leave' })).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('button', { name: 'Cancel Leave' }).at(-1)!);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/leave-requests/leave-1/cancel-for-attendance', {}),
    );
  });

  it('Keep Leave sends nothing', async () => {
    vi.mocked(api.post).mockClear();
    renderCell(conflicted(true));

    await userEvent.click(screen.getByRole('button', { name: 'Cancel Leave' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep Leave' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
  });
});
