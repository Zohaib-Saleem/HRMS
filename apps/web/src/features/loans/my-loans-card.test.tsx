// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { LoanRecord } from '@hrms/shared';

/**
 * The employee's loans card on their own dashboard.
 *
 * Two things are pinned, and they are the two things a person actually needs
 * to be told the truth about:
 *
 *   - what is coming out of their pay, and only when something is. A PENDING
 *     or APPROVED loan costs nothing, and the card says so in words rather
 *     than printing an installment figure next to a loan nobody is collecting.
 *   - that applying is for yourself. The card posts to `/loans/apply`, which
 *     takes no employee id at all.
 *
 * None of the figures are computed here: the card is handed records whose
 * totals do not follow from the principal, and must print what the API derived
 * from the installment rows. A second loan calculation in the browser is how a
 * dashboard and a payslip come to disagree.
 */

let permissions = new Set<string>();
let employee: { id: string } | null = { id: 'emp-1' };

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
      session: { user: { employee }, company: { currency: 'PKR' } },
      permissions,
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => Promise.resolve(),
      clear: () => {},
    }),
  };
});

import { api } from '@/lib/api';
import { MyLoansCard } from './my-loans-card';

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
};

const loan = (over: Partial<LoanRecord>): LoanRecord => ({ ...BASE, ...over });

function renderCard(rows: LoanRecord[]) {
  vi.mocked(api.getPage).mockImplementation(() =>
    Promise.resolve({
      data: rows,
      meta: { page: 1, limit: 20, total: rows.length, totalPages: 1 },
    } as never),
  );
  vi.mocked(api.post).mockResolvedValue({ id: 'loan-new' } as never);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MyLoansCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  permissions = new Set(['loan.read', 'loan.request']);
  employee = { id: 'emp-1' };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the loans card', () => {
  it('asks only for the caller own loans', async () => {
    renderCard([]);

    await waitFor(() => expect(api.getPage).toHaveBeenCalled());
    const [path, options] = vi.mocked(api.getPage).mock.calls[0] as [
      string,
      { query?: Record<string, unknown> },
    ];
    expect(path).toBe('/loans');
    expect(options.query).toMatchObject({ view: 'mine' });
    expect(options.query).not.toHaveProperty('employeeId');
  });

  it('renders nothing at all without loan.read', () => {
    permissions = new Set();
    const { container } = renderCard([loan({})]);

    expect(container).toBeEmptyDOMElement();
    expect(api.getPage).not.toHaveBeenCalled();
  });

  it('shows an active loan as the API derived it', async () => {
    renderCard([loan({})]);

    // Original amount, outstanding, installment, counts, next due, released.
    expect(await screen.findByText(/35,000/)).toBeInTheDocument();
    expect(screen.getByText(/of PKR\s?60,000 borrowed/)).toBeInTheDocument();
    // The monthly installment, under its own label rather than by the digits
    // alone - 5,000 also appears inside 35,000 and 60,000.
    expect(screen.getByText('PKR 5,000')).toBeInTheDocument();
    expect(screen.getByText('5 / 12')).toBeInTheDocument();
    expect(screen.getByText('7 remaining')).toBeInTheDocument();
    expect(screen.getByText(/Next due Sep 2026/)).toBeInTheDocument();
    expect(screen.getByText(/First deduction Apr 2026/)).toBeInTheDocument();
  });

  it('says plainly that a pending application is costing nothing', async () => {
    renderCard([
      loan({ id: 'loan-p', status: 'PENDING', activatedAt: null, paidInstallments: 0 }),
    ]);

    expect(await screen.findByText('Pending approval')).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing is being deducted from your pay/),
    ).toBeInTheDocument();
    // No installment figures for a loan nobody is collecting.
    expect(screen.queryByText('Monthly installment')).not.toBeInTheDocument();
    expect(screen.queryByText('Outstanding')).not.toBeInTheDocument();
  });

  it('offers no application button without loan.request', async () => {
    permissions = new Set(['loan.read']);
    renderCard([]);

    expect(await screen.findByText('No loans')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply for a loan' })).not.toBeInTheDocument();
  });

  it('applies for the caller, with no employee id in the body', async () => {
    renderCard([]);

    const buttons = await screen.findAllByRole('button', { name: 'Apply for a loan' });
    await userEvent.click(buttons[0]!);

    const dialog = await screen.findByRole('dialog');
    await userEvent.clear(within(dialog).getByLabelText(/^Amount/));
    await userEvent.type(within(dialog).getByLabelText(/^Amount/), '50000');
    await userEvent.type(
      within(dialog).getByLabelText(/What is it for/),
      'School fees for the year.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit application' }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, body] = vi.mocked(api.post).mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/loans/apply');
    expect(body).not.toHaveProperty('employeeId');
    expect(body.principalAmount).toBe(50000);
  });
});
