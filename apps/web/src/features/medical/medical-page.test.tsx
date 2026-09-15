// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { MEDICAL_CATEGORIES, MEDICAL_CATEGORY_LABELS, PERMISSIONS } from '@hrms/shared';

/**
 * The employee's Medical screen and its dashboard card.
 *
 * What these hold down is that the screen DRAWS the server's answer and does
 * not compute one. Every figure asserted below is a figure that arrived in the
 * response - so a page that started doing its own arithmetic about somebody's
 * entitlement would fail here rather than quietly disagree with the API.
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
import { MedicalPage } from './medical-page';
import { MyMedicalCard } from './my-medical-card';

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const benefit = (overrides: Record<string, unknown> = {}) => ({
  employeeId: 'emp-1',
  employeeName: 'Sana Iqbal',
  currency: 'PKR',
  benefitYear: 2026,
  annualLimit: 100_000,
  used: 0,
  pending: 0,
  remaining: 100_000,
  available: 100_000,
  categoryUsage: MEDICAL_CATEGORIES.map((category) => ({
    category,
    label: MEDICAL_CATEGORY_LABELS[category],
    enabled: true,
    annualLimit: null,
    used: 0,
    pending: 0,
    available: null,
  })),
  canManageDependents: false,
  canSubmitClaim: true,
  dependentCoverage: {
    spouseCovered: true,
    childrenCovered: true,
    maxChildren: 2,
    parentsCovered: false,
    maxParents: 2,
    sharesEmployeeLimit: true,
    separateAnnualLimit: null,
  },
  dependents: [],
  eligibility: {
    eligible: true,
    reasons: [],
    failedRules: [],
    failures: [],
    warnings: [],
    policyVersion: {
      id: 'pol-1',
      name: 'Company Medical Benefit',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    },
    benefitLimit: 100_000,
    currency: 'PKR',
    categoryLimits: MEDICAL_CATEGORIES.map((category) => ({
      category,
      label: MEDICAL_CATEGORY_LABELS[category],
      enabled: true,
      annualLimit: null,
      maxClaimAmount: null,
      companyContributionPercent: 100,
      employeeContributionPercent: 0,
    })),
    employment: { status: 'ACTIVE', monthsServed: 20, onProbation: false },
  },
  ...overrides,
});

/**
 * A money figure as the DOM will actually carry it.
 *
 * `Intl` separates the currency code from the amount with a non-breaking space,
 * and Testing Library's text normalizer does not collapse that one - so a
 * matcher built straight from `money()` never matches. Normalizing here keeps
 * the assertion about the FIGURE rather than about Unicode.
 */
const shown = (amount: number) => money(amount, 'PKR').replace(/\u00a0/g, ' ');

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

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * The API, answered by URL.
 *
 * Route-aware rather than one body for every request, because the screen now
 * asks two endpoints with two different envelopes - the benefit is `{ data }`
 * and the claims list is `{ data, meta }`. A single stub would hand a benefit
 * object to the claims list and the failure would look like a render bug.
 */
const serve = (body: unknown, claims: unknown[] = []) => {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/medical/claims')) {
      return respond({
        data: claims,
        meta: { page: 1, limit: 5, total: claims.length, totalPages: 1 },
      });
    }
    if (url.includes('/medical/dependents')) return respond({ data: [] });
    return respond({ data: body });
  });
  vi.stubGlobal('fetch', fetchMock);
};

beforeEach(() => {
  permissions = new Set([PERMISSIONS.MEDICAL_READ]);
  serve(benefit());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('the employee medical screen', () => {
  it('shows the limit, what is used and what is left', async () => {
    renderWith(<MedicalPage />);

    await waitFor(() => expect(screen.getByText('Annual limit')).toBeInTheDocument());

    // The app's own formatter, so this asserts the FIGURE rather than the
    // locale's idea of where to put a space. The limit appears twice - as the
    // entitlement and, with nothing used, as the remainder.
    expect(screen.getAllByText(shown(100_000))).toHaveLength(2);
    expect(screen.queryByText(/available for a new claim/)).not.toBeInTheDocument();
    expect(screen.getByText(shown(0))).toBeInTheDocument();
    expect(screen.getByText('Used')).toBeInTheDocument();
    expect(screen.getByText('Remaining')).toBeInTheDocument();
  });

  it('shows a real balance once claims have consumed some of it', async () => {
    serve(benefit({ used: 25_000, remaining: 75_000 }));
    renderWith(<MedicalPage />);

    await waitFor(() => expect(screen.getByText(shown(25_000))).toBeInTheDocument());
    expect(screen.getByText(shown(75_000))).toBeInTheDocument();
  });

  it('reports eligibility as the server decided it', async () => {
    renderWith(<MedicalPage />);

    await waitFor(() => expect(screen.getByText('Eligible')).toBeInTheDocument());
    expect(screen.getByText(/20 completed months/)).toBeInTheDocument();
  });

  it('gives the reason when the server says not eligible', async () => {
    serve(
      benefit({
        eligibility: {
          ...benefit().eligibility,
          eligible: false,
          reasons: ['You have completed 1 month of service. The minimum is 3.'],
          failedRules: ['MIN_EMPLOYMENT'],
        },
      }),
    );
    renderWith(<MedicalPage />);

    await waitFor(() => expect(screen.getByText('Not eligible')).toBeInTheDocument());
    expect(
      screen.getByText('You have completed 1 month of service. The minimum is 3.'),
    ).toBeInTheDocument();
  });

  it('lists every category, and says which are off', async () => {
    const base = benefit();
    serve(
      benefit({
        eligibility: {
          ...base.eligibility,
          categoryLimits: base.eligibility.categoryLimits.map((c) =>
            c.category === 'DENTAL' ? { ...c, enabled: false } : c,
          ),
        },
      }),
    );
    renderWith(<MedicalPage />);

    await waitFor(() => expect(screen.getByText('What is covered')).toBeInTheDocument());

    expect(screen.getByText('Hospitalization')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText('Not covered')).toBeInTheDocument();
  });

  it('shows dependents with the coverage the server resolved', async () => {
    serve(
      benefit({
        dependents: [
          {
            id: 'd1',
            employeeId: 'emp-1',
            name: 'First Child',
            relationship: 'CHILD',
            dateOfBirth: '2018-05-04',
            gender: null,
            status: 'ACTIVE',
            covered: true,
            coverageNote: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'd2',
            employeeId: 'emp-1',
            name: 'Third Child',
            relationship: 'CHILD',
            dateOfBirth: null,
            gender: null,
            status: 'ACTIVE',
            covered: false,
            coverageNote: 'The policy covers 2 children, and that many are already registered ahead of this one.',
            createdAt: '2026-01-03T00:00:00.000Z',
            updatedAt: '2026-01-03T00:00:00.000Z',
          },
        ],
      }),
    );
    renderWith(<MedicalPage />);

    await waitFor(() => expect(screen.getByText('First Child')).toBeInTheDocument());

    expect(screen.getByText('Covered')).toBeInTheDocument();
    expect(screen.getByText('Not covered')).toBeInTheDocument();
    expect(screen.getByText(/already registered ahead of this one/)).toBeInTheDocument();
  });

  it('says who the policy covers, from the policy rather than from a guess', async () => {
    renderWith(<MedicalPage />);

    await waitFor(() => expect(screen.getByText('Dependents')).toBeInTheDocument());
    expect(screen.getByText(/covers a spouse, up to 2 children/)).toBeInTheDocument();
  });

  it('lists the claimant\'s own recent claims', async () => {
    renderWith(<MedicalPage />);

    // The empty state, because the claims list fixture returns nothing - the
    // point of the assertion is that the screen asks at all, and waits for the
    // answer rather than for the card that will hold it.
    expect(await screen.findByText('Your claims')).toBeInTheDocument();
    expect(await screen.findByText('No claims yet')).toBeInTheDocument();
  });

  it('asks for its own claims with view=mine rather than leaning on the scope', async () => {
    renderWith(<MedicalPage />);

    await waitFor(() => expect(screen.getByText('Your claims')).toBeInTheDocument());
    const claimCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/medical/claims'));
    expect(claimCalls.length).toBeGreaterThan(0);
    for (const url of claimCalls) expect(url).toContain('view=mine');
  });

  it('offers a claim button only when the server says the caller may submit one', async () => {
    renderWith(<MedicalPage />);
    await waitFor(() => expect(screen.getByText('Submit a claim')).toBeInTheDocument());

    cleanup();
    serve(benefit({ canSubmitClaim: false }));
    renderWith(<MedicalPage />);

    await waitFor(() => expect(screen.getByText('Eligibility')).toBeInTheDocument());
    expect(screen.queryByText('Submit a claim')).not.toBeInTheDocument();
  });

  it('separates what is left from what a new claim can draw on', async () => {
    serve(benefit({ used: 20_000, pending: 30_000, remaining: 80_000, available: 50_000 }));
    renderWith(<MedicalPage />);

    await waitFor(() => expect(screen.getByText(shown(80_000))).toBeInTheDocument());
    // `remaining` is the headline; `available` is named as such, because being
    // quoted a smaller balance for a claim that may yet be refused is a figure
    // people plan around.
    expect(screen.getByText(`${shown(50_000)} available for a new claim`)).toBeInTheDocument();
    expect(screen.getByText(`${shown(30_000)} more is awaiting a decision`)).toBeInTheDocument();
  });

  it('never asks about anybody but the caller', async () => {
    renderWith(<MedicalPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('employeeId');
    }
  });
});

describe('the dashboard card', () => {
  it('shows the three figures and the eligibility badge', async () => {
    renderWith(<MyMedicalCard />);

    expect(await screen.findByText('Eligible')).toBeInTheDocument();
    expect(screen.getByText('Medical')).toBeInTheDocument();
    expect(screen.getByText('Annual limit')).toBeInTheDocument();
    expect(screen.getByText('Remaining')).toBeInTheDocument();
  });

  it('renders nothing at all without medical.read', () => {
    permissions = new Set();
    const { container } = renderWith(<MyMedicalCard />);

    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The card used to render a "Not eligible" badge and the reason underneath.
   *
   * It no longer does, and that is the point rather than a regression: the
   * employee portal hides a benefit somebody cannot use instead of explaining
   * the refusal to them on every load. Somebody on probation does not need a
   * daily reminder that probationers are excluded. The reasons are still served
   * by the API and still shown on /medical itself, which is the screen you go
   * to when you want the answer.
   */
  it('hides itself completely when somebody is not eligible', async () => {
    serve(
      benefit({
        eligibility: {
          ...benefit().eligibility,
          eligible: false,
          reasons: ['The company medical benefit is currently switched off, so no one is eligible.'],
          failedRules: ['BENEFIT_DISABLED'],
        },
      }),
    );
    const { container } = renderWith(<MyMedicalCard />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText('Medical')).not.toBeInTheDocument();
    expect(screen.queryByText('Not eligible')).not.toBeInTheDocument();
    expect(screen.queryByText(/switched off/)).not.toBeInTheDocument();
  });
});
