// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LoanDeductionMonthInfo } from '@hrms/shared';

/**
 * The deduction month an employee sees when requesting a salary advance.
 *
 * It is the server's month - the one today falls in, in the company's
 * timezone - shown as "Deduction Month: October 2026" and sent back as it was
 * shown. The browser's own clock is never the source: these tests pin the
 * browser to a different month to prove it.
 */

import { api } from '@/lib/api';
import { LoanApplyDialog } from './loan-dialogs';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

function renderDialog(info: LoanDeductionMonthInfo) {
  vi.mocked(api.get).mockImplementation((path: string) =>
    path.startsWith('/loans/deduction-month')
      ? Promise.resolve(info as never)
      : Promise.reject(new Error('no eligibility in this test')),
  );
  vi.mocked(api.post).mockResolvedValue({ id: 'loan-new' } as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LoanApplyDialog open onClose={() => {}} currency="PKR" kind="SALARY_ADVANCE" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('requesting a salary advance', () => {
  it('shows the application month as the deduction month, not a picker', async () => {
    renderDialog({ currentMonth: '2026-10', defaultMonth: '2026-10', closedMonths: [] });

    const line = await screen.findByTestId('advance-deduction-month');
    await waitFor(() => expect(line).toHaveTextContent('Deduction Month: October 2026'));
    expect(screen.queryByLabelText(/deduction month/i, { selector: 'input[type="month"]' })).toBeNull();
  });

  it('submits the month the server gave, even when the browser clock says otherwise', async () => {
    // The browser thinks it is still 31 October; Karachi is already in November.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-31T12:00:00'));
    renderDialog({ currentMonth: '2026-11', defaultMonth: '2026-11', closedMonths: [] });

    await waitFor(() =>
      expect(screen.getByTestId('advance-deduction-month')).toHaveTextContent('November 2026'),
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/amount/i), '20000');
    await user.type(screen.getByLabelText(/what is it for/i), 'Rent due this week.');
    await user.click(screen.getByRole('button', { name: /submit|request|apply/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, body] = vi.mocked(api.post).mock.calls[0] as [string, { startMonth: string; kind: string }];
    expect(path).toBe('/loans/apply');
    expect(body).toMatchObject({ kind: 'SALARY_ADVANCE', startMonth: '2026-11' });
  });

  it('says plainly when that month is already finalized, and keeps it', async () => {
    renderDialog({ currentMonth: '2026-10', defaultMonth: '2026-11', closedMonths: ['2026-10'] });

    const line = await screen.findByTestId('advance-deduction-month');
    await waitFor(() => expect(line).toHaveTextContent('Deduction Month: October 2026'));
    expect(line).toHaveTextContent(/already finalized and will not be changed/);
    expect(line).toHaveTextContent(/Payroll will confirm/);
  });
});
