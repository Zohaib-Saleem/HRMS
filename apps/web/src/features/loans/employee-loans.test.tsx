// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { loanStatusLabel, type LoanDetail, type LoanRecord } from '@hrms/shared';

/**
 * The Loans tab of a person's profile.
 *
 * What is pinned here is that the tab is an honest account of the money, in
 * the four states a person is ever actually in: nothing on record, a loan
 * being repaid, an application waiting on somebody, and a loan that finished.
 *
 * None of the figures are computed here, and the test says so by handing the
 * component records whose totals do not follow from the principal: the tab
 * must print what the API derived from the installment rows rather than
 * arriving at its own answer. A second loan calculation in the browser is
 * exactly how a profile and a payslip come to disagree.
 */

let permissions = new Set<string>();
let callerEmployeeId: string | null = 'emp-1';

vi.mock('@/features/auth/session-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth/session-context')>();
  return {
    ...actual,
    usePermissions: () => ({
      has: (p: string) => permissions.has(p),
      hasAny: (list: string[]) => list.some((p) => permissions.has(p)),
      hasAll: (list: string[]) => list.every((p) => permissions.has(p)),
    }),
    useSession: () => ({
      session: {
        user: { employee: callerEmployeeId ? { id: callerEmployeeId } : null },
        company: { currency: 'PKR' },
      },
      permissions,
      isLoading: false,
      error: null,
      isError: false,
      refetch: () => Promise.resolve(),
      clear: () => {},
    }),
  };
});

import { api } from '@/lib/api';
import { ConfirmProvider } from '@/components/feedback/confirm-dialog';
import { EmployeeLoans } from './employee-loans';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), getPage: vi.fn(), post: vi.fn() },
  };
});

const BASE: LoanRecord = {
  id: 'loan-1',
  employeeId: 'emp-1',
  employeeName: 'Awais Zahid',
  employeeNumber: '1020',
  kind: 'LOAN',
  reference: null,
  principalAmount: 60000,
  currency: 'PKR',
  installmentCount: 12,
  monthlyDeduction: 5000,
  startMonth: '2026-04-01',
  status: 'ACTIVE',
  purpose: 'Home repairs',
  notes: null,
  paidAmount: 25000,
  remainingAmount: 35000,
  paidInstallments: 5,
  nextDueMonth: '2026-09-01',
  requestedAt: null,
  approvalRequestId: null,
  approvedAt: '2026-03-20T00:00:00.000Z',
  approvedByName: 'HR',
  rejectedAt: null,
  rejectionReason: null,
  activatedAt: '2026-03-21T00:00:00.000Z',
  completedAt: null,
  cancelledAt: null,
  createdAt: '2026-03-19T00:00:00.000Z',
  canApprove: false,
  canCancel: false,
  statusLabel: 'Repayment in progress',
};

/** The label follows the status unless a case sets it, as the server's would. */
const loan = (over: Partial<LoanRecord>): LoanRecord => ({
  ...BASE,
  statusLabel: over.status ? loanStatusLabel({ status: over.status, kind: over.kind ?? BASE.kind, paidInstallments: over.paidInstallments ?? BASE.paidInstallments }) : BASE.statusLabel,
  ...over,
});

/** A detail response for whichever loan the panel opens, from the same record. */
function detailFor(record: LoanRecord): LoanDetail {
  return {
    ...record,
    installments: Array.from({ length: record.installmentCount }, (_, index) => ({
      id: `${record.id}-i${index + 1}`,
      sequence: index + 1,
      dueMonth: `2026-${String(4 + index).padStart(2, '0')}-01`,
      amount: record.monthlyDeduction,
      status:
        index < record.paidInstallments
          ? ('PAID' as const)
          : index === record.paidInstallments && record.status === 'ACTIVE'
            ? ('PENDING_PAYROLL' as const)
            : ('SCHEDULED' as const),
      payrollRunId: index < record.paidInstallments ? 'run-1' : null,
      paidAt: index < record.paidInstallments ? '2026-08-31T00:00:00.000Z' : null,
      note: null,
      displayStatus:
        index < record.paidInstallments
          ? ('PAID' as const)
          : index === record.paidInstallments && record.status === 'ACTIVE'
            ? ('IN_PAYROLL' as const)
            : ('UPCOMING' as const),
      settledBy: index < record.paidInstallments ? ('PAYROLL_DEDUCTION' as const) : null,
      actions: [],
    })),
    transactions: [],
    canCorrect: false,
  };
}

function renderTab(rows: LoanRecord[], employeeId = 'emp-1') {
  vi.mocked(api.getPage).mockImplementation(() =>
    Promise.resolve({
      data: rows,
      meta: { page: 1, limit: 50, total: rows.length, pages: 1 },
    } as never),
  );
  vi.mocked(api.get).mockImplementation((path: string) => {
    const found = rows.find((row) => path === `/loans/${row.id}`);
    if (found) return Promise.resolve(detailFor(found) as never);
    return Promise.resolve({ currency: 'PKR' } as never);
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <MemoryRouter>
          <EmployeeLoans employeeId={employeeId} employeeName="Awais Zahid" />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  permissions = new Set(['loan.read', 'loan.request']);
  callerEmployeeId = 'emp-1';
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the Loans tab on a profile', () => {
  it('says there are no loans rather than showing an empty table', async () => {
    renderTab([]);

    expect(await screen.findByText('No loans')).toBeInTheDocument();
    // No schedule, no totals, nothing that implies a loan exists.
    expect(screen.queryByText(/remaining/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Repayment schedule and history')).not.toBeInTheDocument();
  });

  it('shows an active loan with what is paid, what is left and when', async () => {
    renderTab([loan({})]);

    // The terms.
    expect(await screen.findByText(/over 12 months/)).toBeInTheDocument();
    // Paid, remaining and next due - all as the API derived them.
    expect(screen.getByText(/5\/12 paid/)).toBeInTheDocument();
    expect(screen.getByText(/Sep 2026/)).toBeInTheDocument();

    // The panel below opens on the live loan without being asked.
    expect(await screen.findByText('Repayment schedule and history')).toBeInTheDocument();
    expect(screen.getByText(/5 of 12 installments · 7 left/)).toBeInTheDocument();
    expect(screen.getByText('42% repaid')).toBeInTheDocument();
    // First deduction month and the date it was actually released.
    expect(screen.getByText('First deduction')).toBeInTheDocument();
    expect(screen.getByText('Released')).toBeInTheDocument();
  });

  it('names the installment payroll is collecting, without recomputing it', async () => {
    renderTab([loan({})]);

    // Read off the schedule the API returned: the run claimed installment 6.
    expect(
      await screen.findByText(/Installment 6 of 12 .* is in an unfinalized payroll run/),
    ).toBeInTheDocument();
  });

  it('shows a pending application as pending, with nothing deducted', async () => {
    renderTab([
      loan({
        id: 'loan-2',
        status: 'PENDING',
        paidAmount: 0,
        remainingAmount: 60000,
        paidInstallments: 0,
        activatedAt: null,
        approvedAt: null,
        requestedAt: '2026-09-01T00:00:00.000Z',
      }),
    ]);

    expect(await screen.findAllByText('Pending approval')).not.toHaveLength(0);
    expect(
      await screen.findByText('Applied for and awaiting a decision. Nothing is deducted.'),
    ).toBeInTheDocument();
    // A pending loan is not being collected against.
    expect(screen.queryByText(/unfinalized payroll run/)).not.toBeInTheDocument();
  });

  it('keeps a completed loan on the record instead of hiding it', async () => {
    renderTab([
      loan({
        id: 'loan-3',
        status: 'COMPLETED',
        paidAmount: 60000,
        remainingAmount: 0,
        paidInstallments: 12,
        nextDueMonth: null,
        completedAt: '2027-03-31T00:00:00.000Z',
      }),
    ]);

    expect(await screen.findAllByText('Fully repaid')).not.toHaveLength(0);
    expect(screen.getByText(/12\/12 paid/)).toBeInTheDocument();
    expect(screen.getByText(/nothing outstanding/)).toBeInTheDocument();
    // Still openable: last year's payslip has to stay explainable.
    expect(await screen.findByText('Repayment schedule and history')).toBeInTheDocument();
  });

  it('counts every status the person has been in', async () => {
    renderTab([
      loan({ id: 'a', status: 'ACTIVE' }),
      loan({ id: 'b', status: 'PENDING' }),
      loan({ id: 'c', status: 'COMPLETED', remainingAmount: 0, nextDueMonth: null }),
      loan({ id: 'd', status: 'REJECTED', remainingAmount: 0, nextDueMonth: null }),
    ]);

    await screen.findAllByText(/over 12 months/);
    const summary = screen.getByText('Outstanding').closest('dl')!;
    // Only the ACTIVE loan is outstanding money - the other three cost nothing.
    expect(within(summary).getByText('PKR 35,000')).toBeInTheDocument();
    expect(within(summary).getByText('PKR 5,000')).toBeInTheDocument();
    // A rejected loan is history: listed below, but not a headline figure.
    expect(within(summary).queryByText('Rejected')).not.toBeInTheDocument();
  });
});

describe('what the Loans tab lets you do', () => {
  it('offers to apply on your own profile when you may request a loan', async () => {
    renderTab([], 'emp-1');
    await screen.findByText('No loans');

    expect(screen.getByRole('button', { name: 'Apply for a loan' })).toBeInTheDocument();
    // Reading somebody's loans is not permission to record one for them.
    expect(screen.queryByRole('button', { name: /Record a loan/ })).not.toBeInTheDocument();
  });

  it('does not offer to apply on somebody else’s profile', async () => {
    renderTab([], 'emp-9');
    await screen.findByText('No loans');

    // The endpoint files an application against the caller, whoever is on
    // screen, so the button would raise a loan for the wrong person.
    expect(screen.queryByRole('button', { name: 'Apply for a loan' })).not.toBeInTheDocument();
  });

  it('offers to record a loan only with loan.manage', async () => {
    permissions = new Set(['loan.read', 'loan.manage']);
    renderTab([], 'emp-9');
    await screen.findByText('No loans');

    expect(screen.getByRole('button', { name: /Record a loan/ })).toBeInTheDocument();
  });

  it('renders nothing at all without loan.read', () => {
    permissions = new Set([]);
    const { container } = renderTab([loan({})]);

    expect(container).toBeEmptyDOMElement();
  });
});
