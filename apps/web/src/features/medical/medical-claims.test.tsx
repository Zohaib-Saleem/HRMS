// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PERMISSIONS } from '@hrms/shared';

/**
 * The medical claims screen, and one claim in detail.
 *
 * Two rules these hold down, and both are about the server deciding.
 *
 * The first is that medical data narrows harder than a data scope. A manager's
 * reporting line is not a reason to see what treatment somebody had, so the
 * employee column and the "whose claims" toggle appear only for a caller who
 * holds medical oversight - not for anyone who merely has a wide scope.
 *
 * The second is that the actions on a claim are the server's answer. `canDecide`,
 * `canCancel` and `canMarkPaid` arrive on the record already resolved; the tests
 * below move those flags and expect the buttons to move with them, so a screen
 * that started deciding for itself from a permission list would fail here.
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

import { ConfirmProvider } from '@/components/feedback/confirm-dialog';
import { money } from '@/features/employment/employment-shared';
import { MedicalClaimsPage } from './medical-claims-page';
import { MedicalClaimDetailPanel } from './medical-claim-detail-panel';

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const shown = (amount: number) => money(amount, 'PKR').replace(/ /g, ' ');

const claim = (overrides: Record<string, unknown> = {}) => ({
  id: 'claim-1',
  claimNumber: 'MC-0001',
  employeeId: 'emp-1',
  employeeName: 'Sana Iqbal',
  employeeNumber: 'E-0001',
  category: 'OPD',
  categoryLabel: 'OPD',
  dependentId: null,
  dependentName: null,
  dependentRelationship: null,
  treatmentDate: '2026-09-01',
  providerName: 'City Clinic',
  notes: null,
  currency: 'PKR',
  requestedAmount: 10_000,
  approvedAmount: null,
  companyAmount: null,
  employeeAmount: null,
  companyContributionPercent: 80,
  employeeContributionPercent: 20,
  status: 'PENDING',
  policyId: 'pol-1',
  submittedAt: '2026-09-02T09:00:00.000Z',
  decidedAt: null,
  paidAt: null,
  cancelledAt: null,
  reviewedByName: null,
  decisionNote: null,
  rejectionReason: null,
  overrideReason: null,
  paymentReference: null,
  canDecide: false,
  canCancel: false,
  canMarkPaid: false,
  documents: [],
  ...overrides,
});

let fetchMock: ReturnType<typeof vi.fn>;

/** The API, answered by URL - each endpoint has an envelope of its own. */
const serve = (options: { claims?: unknown[]; detail?: unknown } = {}) => {
  const rows = options.claims ?? [claim()];
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/medical/claims/assessment')) {
      return respond({ data: assessment() });
    }
    if (/\/medical\/claims\/[^/?]+$/.test(url.split('?')[0] ?? '')) {
      return respond({ data: options.detail ?? claim() });
    }
    if (url.includes('/medical/claims')) {
      return respond({
        data: rows,
        meta: { page: 1, limit: 20, total: rows.length, totalPages: 1 },
      });
    }
    if (url.includes('/medical/dependents')) return respond({ data: [] });
    if (url.includes('/company')) return respond({ data: { currency: 'PKR' } });
    return respond({ data: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
};

const assessment = (overrides: Record<string, unknown> = {}) => ({
  allowed: true,
  reasons: [],
  failedRules: [],
  failures: [],
  warnings: [],
  policyVersion: {
    id: 'pol-1',
    name: 'Company Medical Benefit',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  },
  currency: 'PKR',
  requestedAmount: 0,
  companyAmount: 0,
  employeeAmount: 0,
  companyContributionPercent: 80,
  employeeContributionPercent: 20,
  annualLimit: 100_000,
  used: 0,
  pending: 0,
  available: 100_000,
  categoryAnnualLimit: null,
  categoryUsed: 0,
  categoryAvailable: null,
  maxClaimAmount: null,
  requiredDocuments: [],
  requireProviderName: true,
  requireTreatmentDate: true,
  overrideAllowed: true,
  requireOverrideReason: true,
  requiresApproval: true,
  ...overrides,
});

function renderWith(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  permissions = new Set([PERMISSIONS.MEDICAL_READ, PERMISSIONS.MEDICAL_CLAIM_REQUEST]);
  serve();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('the medical claims list', () => {
  it('shows the claim as the server reported it', async () => {
    renderWith(<MedicalClaimsPage />);

    expect(await screen.findByText('MC-0001')).toBeInTheDocument();
    expect(screen.getByText(shown(10_000))).toBeInTheDocument();
    // Scoped to the table: "Pending approval" is also one of the status filter's
    // options, and the assertion is about the ROW.
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Pending approval')).toBeInTheDocument();
  });

  it('hides other people entirely from a caller without medical oversight', async () => {
    renderWith(<MedicalClaimsPage />);

    await screen.findByText('MC-0001');
    // No employee column and no "whose claims" toggle: without oversight this
    // list can only ever hold the caller's own, so both would be furniture
    // implying a wider view than the endpoint will give.
    expect(screen.queryByText('Employee')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Whose claims')).not.toBeInTheDocument();
  });

  it('shows the employee column and the toggle to somebody who decides claims', async () => {
    permissions = new Set([
      PERMISSIONS.MEDICAL_READ,
      PERMISSIONS.MEDICAL_CLAIM_REQUEST,
      PERMISSIONS.MEDICAL_CLAIM_APPROVE,
    ]);
    renderWith(<MedicalClaimsPage />);

    await screen.findByText('MC-0001');
    expect(screen.getByText('Employee')).toBeInTheDocument();
    expect(screen.getByLabelText('Whose claims')).toBeInTheDocument();
    expect(screen.getByText('Sana Iqbal')).toBeInTheDocument();
  });

  it('offers "record a claim" only with medical.manage, and "submit" only with the request grant', async () => {
    renderWith(<MedicalClaimsPage />);
    await screen.findByText('MC-0001');
    expect(screen.getByText('Submit a claim')).toBeInTheDocument();
    expect(screen.queryByText('Record a claim')).not.toBeInTheDocument();

    cleanup();
    permissions = new Set([PERMISSIONS.MEDICAL_READ, PERMISSIONS.MEDICAL_MANAGE]);
    renderWith(<MedicalClaimsPage />);
    await screen.findByText('MC-0001');
    expect(screen.getByText('Record a claim')).toBeInTheDocument();
    expect(screen.queryByText('Submit a claim')).not.toBeInTheDocument();
  });
});

describe('one claim in detail', () => {
  it('draws no decision buttons when the server withheld them', async () => {
    // The caller holds every medical permission there is. The record says the
    // actions are not available - their own claim, say - and the record wins.
    permissions = new Set(Object.values(PERMISSIONS) as string[]);
    renderWith(<MedicalClaimDetailPanel claimId="claim-1" />);

    expect(await screen.findByText('MC-0001')).toBeInTheDocument();
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
    expect(screen.queryByText('Decline')).not.toBeInTheDocument();
    expect(screen.queryByText('Mark paid')).not.toBeInTheDocument();
  });

  it('draws them when the server granted them', async () => {
    serve({ detail: claim({ canDecide: true, canCancel: true }) });
    renderWith(<MedicalClaimDetailPanel claimId="claim-1" />);

    expect(await screen.findByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Decline')).toBeInTheDocument();
    expect(screen.getByText('Withdraw')).toBeInTheDocument();
  });

  it('offers payment once a claim is agreed, and not before', async () => {
    serve({
      detail: claim({
        status: 'APPROVED',
        approvedAmount: 10_000,
        companyAmount: 8_000,
        employeeAmount: 2_000,
        decidedAt: '2026-09-03T09:00:00.000Z',
        canMarkPaid: true,
      }),
    });
    renderWith(<MedicalClaimDetailPanel claimId="claim-1" />);

    expect(await screen.findByText('Mark paid')).toBeInTheDocument();
    // Claimed, agreed and the company's share are three different numbers, and
    // only the last is what came out of the annual limit.
    expect(screen.getByText(shown(8_000))).toBeInTheDocument();
    expect(screen.getByText(shown(2_000))).toBeInTheDocument();
    expect(screen.getByText(/the figure drawn from the limit/)).toBeInTheDocument();
  });

  it('reports a partial approval as the reduction it is', async () => {
    serve({
      detail: claim({
        status: 'PARTIALLY_APPROVED',
        approvedAmount: 6_000,
        companyAmount: 4_800,
        employeeAmount: 1_200,
        decidedAt: '2026-09-03T09:00:00.000Z',
        decisionNote: 'Optical is capped at 6,000 a year.',
      }),
    });
    renderWith(<MedicalClaimDetailPanel claimId="claim-1" />);

    expect(await screen.findByText('Partially approved')).toBeInTheDocument();
    expect(screen.getByText(`Reduced by ${shown(4_000)}`)).toBeInTheDocument();
    expect(screen.getByText('Optical is capped at 6,000 a year.')).toBeInTheDocument();
  });

  it('names the split from the version the claim is pinned to, not the live policy', async () => {
    renderWith(<MedicalClaimDetailPanel claimId="claim-1" />);

    await screen.findByText('MC-0001');
    expect(
      screen.getByText(/The company pays 80% under the policy version this claim was submitted/),
    ).toBeInTheDocument();
  });

  it('shows an override reason only when the API sent one', async () => {
    renderWith(<MedicalClaimDetailPanel claimId="claim-1" />);
    await screen.findByText('MC-0001');
    // Withheld from the claimant by the endpoint, so there is nothing to draw.
    expect(screen.queryByText('Allowed through because')).not.toBeInTheDocument();

    cleanup();
    serve({
      detail: claim({
        status: 'APPROVED',
        approvedAmount: 10_000,
        companyAmount: 8_000,
        employeeAmount: 2_000,
        decidedAt: '2026-09-03T09:00:00.000Z',
        overrideReason: 'Submitted four days after the deadline; hospital delay.',
      }),
    });
    renderWith(<MedicalClaimDetailPanel claimId="claim-1" />);

    await waitFor(() =>
      expect(screen.getByText('Allowed through because')).toBeInTheDocument(),
    );
    expect(
      screen.getByText('Submitted four days after the deadline; hospital delay.'),
    ).toBeInTheDocument();
  });
});
