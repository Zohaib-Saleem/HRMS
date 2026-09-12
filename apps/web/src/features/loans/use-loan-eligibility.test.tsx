// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LoanEligibilityResult } from '@hrms/shared';
import { useLoanEligibility } from './use-loan-eligibility';

/**
 * The eligibility hook, against the real api client.
 *
 * `fetch` is mocked, not `@/lib/api`, and that is the whole point of the file.
 * `api.get` unwraps the `{ data }` envelope itself; a caller that unwraps it a
 * second time gets undefined from a request that returned 200, and the panel
 * downstream renders nothing at all rather than reporting a failure. Mocking
 * the api client cannot catch that - it replaces the very layer the mistake
 * lives in.
 *
 * The failure this guards against is silent, which is what makes it worth a
 * test: an employee is shown no eligibility information and no error, and the
 * screen looks merely empty.
 */

const RESULT: LoanEligibilityResult = {
  eligible: true,
  maxAllowedAmount: 100_000,
  maxMonthlyDeduction: 30_000,
  monthlySalary: 100_000,
  currency: 'PKR',
  maxTenureMonths: 12,
  maxInstallments: 12,
  estimatedMonthlyDeduction: null,
  reasons: [],
  failedRules: [],
  failures: [],
  warnings: [],
  evaluation: {
    months: 3,
    from: '2026-04-01',
    to: '2026-06-30',
    attendancePercentage: 97,
    unapprovedAbsences: 0,
    lateDays: 1,
    missingPunches: 0,
    measured: true,
  },
  overrideAllowed: true,
};

/** Exactly the envelope the API sends. */
const respond = (body: unknown, status = 200) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);

let fetchMock: ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  fetchMock = vi.fn(() => respond({ data: RESULT }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('reading the eligibility endpoint', () => {
  it('hands back the result itself, not the envelope around it', async () => {
    const { result } = renderHook(() => useLoanEligibility(), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());

    // The exact regression: a second unwrap here yields undefined from a 200.
    expect(result.current.data).toMatchObject({
      eligible: true,
      maxAllowedAmount: 100_000,
      currency: 'PKR',
    });
    expect((result.current.data as unknown as { data?: unknown }).data).toBeUndefined();
  });

  it('asks the endpoint the caller is entitled to, with no employee id by default', async () => {
    renderHook(() => useLoanEligibility(), { wrapper });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/api/v1/loans/eligibility');
    expect(url).not.toContain('employeeId');
  });

  it('carries a refusal through unchanged, so the panel can name the rules', async () => {
    fetchMock.mockImplementation(() =>
      respond({
        data: {
          ...RESULT,
          eligible: false,
          reasons: ['You already have a loan in progress.'],
          failedRules: ['ACTIVE_LOAN'],
          failures: [{ rule: 'ACTIVE_LOAN', message: 'You already have a loan in progress.' }],
        },
      }),
    );

    const { result } = renderHook(() => useLoanEligibility(), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(result.current.data?.eligible).toBe(false);
    expect(result.current.data?.failures).toHaveLength(1);
  });

  it('does not ask at all while it is disabled', async () => {
    renderHook(() => useLoanEligibility({ enabled: false }), { wrapper });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
