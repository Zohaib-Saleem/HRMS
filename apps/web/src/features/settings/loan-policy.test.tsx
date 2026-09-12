// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  LOAN_POLICY_DEFAULTS,
  PERMISSIONS,
  type LoanPolicyInput,
  type Permission,
} from '@hrms/shared';
import { TABS, visibleTabs } from './settings-layout';

/**
 * The Loan Policy settings screen.
 *
 * Who can reach it, what the confirmation says before a rule moves, and the
 * fact that a reader without `loan.policy.manage` gets a form they cannot
 * submit. The endpoint is the real gate in every case - these assert that the
 * screen agrees with it rather than that it replaces it.
 */

let permissions = new Set<string>();

vi.mock('@/features/auth/session-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth/session-context')>();
  return {
    ...actual,
    usePermissions: () => ({
      has: (p: string) => permissions.has(p),
      hasAny: (list: string[]) => list.some((p) => permissions.has(p)),
      hasAll: (list: string[]) => list.every((p) => permissions.has(p)),
    }),
  };
});

/*
 * `fetch` is mocked here, NOT `@/lib/api`.
 *
 * The bug this file failed to catch lived between the two: `api.get` unwraps
 * the `{ data }` envelope itself, the page unwrapped it a second time, and the
 * result was undefined against a request that had returned 200. Mocking the
 * api client hid that completely - the test handed the page whatever shape the
 * test author believed in, so the test and the bug agreed with each other and
 * both were wrong.
 *
 * Feeding raw envelopes to the real client is the only version of this test
 * that can fail when the contract is misread.
 */
import { ConfirmProvider } from '@/components/feedback/confirm-dialog';
import { LoanPolicyPage, changedFields, toFormValues } from './loan-policy-page';

/** Exactly what the API sends, byte for byte. */
function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const POLICY = {
  id: 'pol-1',
  ...LOAN_POLICY_DEFAULTS,
  effectiveFrom: '2020-01-01T00:00:00.000Z',
  createdAt: '2020-01-01T00:00:00.000Z',
  createdByName: null,
  isCurrent: true,
};

function view(canManage: boolean) {
  return { policy: POLICY, scheduled: null, canManage, currency: 'PKR' };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConfirmProvider>
          <LoanPolicyPage />
        </ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  permissions = new Set<string>();
  // The real server envelopes: `{ data }` for the policy, `{ data, meta }` for
  // the paginated history.
  fetchMock = vi.fn((url: string) =>
    String(url).includes('history')
      ? respond({ data: [], meta: { page: 1, limit: 20, total: 0, pages: 1 } })
      : respond({ data: view(true) }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('who is offered the tab', () => {
  const holding =
    (...list: Permission[]) =>
    (permission: Permission) =>
      list.includes(permission);

  const labels = (has: (p: Permission) => boolean) =>
    visibleTabs(TABS, { has, capabilities: { attendanceRules: 'available' } }).map((t) => t.label);

  it('offers Loan policy to a holder of loan.policy.read', () => {
    expect(labels(holding(PERMISSIONS.LOAN_POLICY_READ))).toContain('Loan policy');
  });

  it('does not offer it to an employee', () => {
    expect(
      labels(holding(PERMISSIONS.LOAN_READ, PERMISSIONS.LOAN_REQUEST, PERMISSIONS.LEAVE_READ)),
    ).not.toContain('Loan policy');
  });
});

describe('the policy form', () => {
  it('shows Super Admin the saved values and lets them save', async () => {
    permissions = new Set([PERMISSIONS.LOAN_POLICY_READ, PERMISSIONS.LOAN_POLICY_MANAGE]);
    renderPage();

    await waitFor(() => expect(screen.getByText('Eligibility')).toBeInTheDocument());

    expect(screen.getByLabelText('Maximum loan multiple')).toHaveValue(1);
    expect(screen.getByLabelText('Minimum attendance')).toHaveValue(90);
    expect(screen.getByRole('button', { name: /save policy/i })).toBeInTheDocument();
  });

  it('gives a reader without manage a form with no save button', async () => {
    permissions = new Set([PERMISSIONS.LOAN_POLICY_READ]);
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('history')
        ? respond({ data: [], meta: { page: 1, limit: 20, total: 0, pages: 1 } })
        : respond({ data: view(false) }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText('Eligibility')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /save policy/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Maximum loan multiple')).toBeDisabled();
  });

  it('renders every section the policy is grouped into', async () => {
    permissions = new Set([PERMISSIONS.LOAN_POLICY_READ, PERMISSIONS.LOAN_POLICY_MANAGE]);
    renderPage();

    await waitFor(() => expect(screen.getByText('Eligibility')).toBeInTheDocument());

    for (const section of [
      'Eligibility',
      'Attendance restrictions',
      'Loan restrictions',
      'Employment restrictions',
      'Approval',
      'Policy history',
    ]) {
      expect(screen.getByText(section)).toBeInTheDocument();
    }
  });
});

describe('what the confirmation will say', () => {
  const saved: LoanPolicyInput = toFormValues(POLICY);

  it('reports nothing when nothing moved', () => {
    expect(changedFields(saved, { ...saved })).toEqual([]);
  });

  it('names the rule, what it was and what it becomes', () => {
    const changes = changedFields(saved, { ...saved, maxSalaryMultiplier: 2 });

    expect(changes).toEqual([
      { label: 'Maximum loan multiple', from: '1', to: '2' },
    ]);
  });

  it('reads a switch as Yes and No rather than true and false', () => {
    const changes = changedFields(saved, { ...saved, allowProbation: true });

    expect(changes).toEqual([
      { label: 'Allow probation employees', from: 'No', to: 'Yes' },
    ]);
  });

  it('lists every rule that moved, not just the first', () => {
    const changes = changedFields(saved, {
      ...saved,
      maxSalaryMultiplier: 3,
      minAttendancePercent: 80,
      oneActiveLoan: false,
    });

    expect(changes.map((c) => c.label).sort()).toEqual([
      'Maximum loan multiple',
      'Minimum attendance',
      'One active loan at a time',
    ]);
  });
});
