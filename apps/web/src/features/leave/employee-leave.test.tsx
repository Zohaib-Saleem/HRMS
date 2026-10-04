// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_ROLE_PERMISSIONS, type LeaveBalanceRecord, type Permission } from '@hrms/shared';

/**
 * The Leave tab on the profile: who is offered Edit.
 *
 * The button follows `leave.manage`, the grant `POST /leave/balances/adjust`
 * requires, so it appears for Super Admin and HR Admin and for nobody the API
 * would refuse. Hiding it is presentation; the 403 is pinned in
 * leave-balances.routes.test.ts.
 */

let permissions = new Set<Permission>();

vi.mock('@/features/auth/session-context', () => ({
  usePermissions: () => ({ has: (p: Permission) => permissions.has(p) }),
  useSession: () => ({ permissions }),
}));

const BALANCE: LeaveBalanceRecord = {
  leaveTypeId: 'type-annual',
  leaveTypeName: 'Annual',
  leaveTypeCode: 'AL',
  isPaid: true,
  year: 2026,
  annualEntitlementDays: 15,
  monthlyAccrualDays: 1.25,
  carryForwardEnabled: false,
  carryForwardCapDays: null,
  openingDays: 0,
  accruedDays: 11.25,
  adjustmentDays: 0,
  adjustmentNote: null,
  usedDays: 4,
  pendingDays: 0,
  availableDays: 7.25,
};

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(async () => [BALANCE]),
      getPage: vi.fn(async () => ({ data: [], meta: { total: 0 } })),
      post: vi.fn(),
    },
  };
});

import { EmployeeLeave } from './employee-leave';

function renderAs(grants: readonly Permission[]) {
  permissions = new Set(grants);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EmployeeLeave employeeId="emp-1" employeeName="Aisha Rahman" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('Edit on the Leave tab', () => {
  it('is offered to Super Admin, and opens on the current figures', async () => {
    const user = userEvent.setup();
    renderAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

    expect((await screen.findAllByText('7.25')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect((screen.getByLabelText(/Adjustment \(days\)/) as HTMLInputElement).value).toBe('0');
  });

  it('is offered to HR Admin, as before', async () => {
    renderAs(DEFAULT_ROLE_PERMISSIONS.HR_ADMIN);
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  for (const role of ['EMPLOYEE', 'MANAGER', 'TEAM_MANAGER'] as const) {
    it(`is not offered to ${role}`, async () => {
      renderAs(DEFAULT_ROLE_PERMISSIONS[role]);
      expect((await screen.findAllByText('7.25')).length).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
      expect(screen.queryByRole('button', { name: /Edit Annual balance/ })).toBeNull();
    });
  }
});
