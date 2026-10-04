// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LeaveBalanceRecord } from '@hrms/shared';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, post: vi.fn() } };
});

import { api } from '@/lib/api';
import { LeaveAdjustmentDialog } from './leave-adjustment-dialog';

/**
 * The Adjust dialog on the profile's Leave tab.
 *
 * It opens on the adjustment and reason already on record, refuses to save
 * without a reason, posts the whole correction to the existing adjust
 * endpoint, and never offers an input for a derived figure.
 */

const BALANCE: LeaveBalanceRecord = {
  leaveTypeId: 'type-annual',
  leaveTypeName: 'Annual',
  leaveTypeCode: 'AL',
  isPaid: true,
  year: 2026,
  annualEntitlementDays: 20,
  monthlyAccrualDays: 1.67,
  carryForwardEnabled: false,
  carryForwardCapDays: null,
  openingDays: 0,
  accruedDays: 15,
  adjustmentDays: -3,
  adjustmentNote: 'Taken before HRMS',
  usedDays: 4,
  pendingDays: 0,
  availableDays: 8,
};

const post = vi.mocked(api.post);

function renderDialog(balance: LeaveBalanceRecord | null = BALANCE) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <LeaveAdjustmentDialog
        open
        onClose={onClose}
        employeeId="emp-1"
        employeeName="Aisha Rahman"
        year={2026}
        balance={balance}
      />
    </QueryClientProvider>,
  );
  return { onClose, invalidate };
}

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({});
});

afterEach(() => cleanup());

describe('LeaveAdjustmentDialog', () => {
  it('loads the adjustment and reason on record', () => {
    renderDialog();
    expect((screen.getByLabelText(/Adjustment \(days\)/) as HTMLInputElement).value).toBe('-3');
    expect((screen.getByLabelText(/Reason/) as HTMLTextAreaElement).value).toBe('Taken before HRMS');
  });

  it('offers no input for the calculated figures', () => {
    renderDialog();
    const inputs = screen.getAllByRole('spinbutton');
    expect(inputs).toHaveLength(1);
    expect(screen.queryByLabelText(/Entitlement/)).toBeNull();
    expect(screen.queryByLabelText(/Remaining/)).toBeNull();
    expect(screen.queryByLabelText(/Used/)).toBeNull();
  });

  it('refuses to save without a reason and calls nothing', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.clear(screen.getByLabelText(/Reason/));
    await user.click(screen.getByRole('button', { name: 'Save adjustment' }));

    expect(await screen.findByText('Give the reason for this adjustment.')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('posts the whole correction to the adjust endpoint and refreshes the balance', async () => {
    const user = userEvent.setup();
    const { onClose, invalidate } = renderDialog();

    const days = screen.getByLabelText(/Adjustment \(days\)/);
    await user.clear(days);
    await user.type(days, '2.5');
    const reason = screen.getByLabelText(/Reason/);
    await user.clear(reason);
    await user.type(reason, 'Carried over from the spreadsheet');
    await user.click(screen.getByRole('button', { name: 'Save adjustment' }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/leave/balances/adjust', {
      employeeId: 'emp-1',
      leaveTypeId: 'type-annual',
      year: 2026,
      adjustmentDays: 2.5,
      adjustmentNote: 'Carried over from the spreadsheet',
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['leave', 'balances'] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['employees', 'emp-1', 'profile-summary'],
    });
  });

  it('cancels without saving', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('shows the allocation and remaining balance before and after as the figure changes', async () => {
    const user = userEvent.setup();
    renderDialog();
    const days = screen.getByLabelText(/Adjustment \(days\)/);
    await user.clear(days);
    await user.type(days, '2');

    // Entitlement 20 + opening 0: allocation 17 → 22; remaining 8 → 13.
    const preview = screen.getByTestId('leave-adjustment-preview');
    expect(preview.textContent).toContain('17 → 22 days');
    expect(preview.textContent).toContain('8 → 13 days');
  });

  it('refuses a figure that is not a whole or half day', async () => {
    const user = userEvent.setup();
    renderDialog();
    const days = screen.getByLabelText(/Adjustment \(days\)/);
    await user.clear(days);
    await user.type(days, '1.3');
    await user.click(screen.getByRole('button', { name: 'Save adjustment' }));

    expect(await screen.findByText('Use whole or half days.')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
});
