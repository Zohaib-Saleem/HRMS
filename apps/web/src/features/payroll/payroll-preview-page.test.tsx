// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PayrollAdjustmentRecord } from '@hrms/shared';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, getPage: vi.fn(), post: vi.fn(), delete: vi.fn() },
  };
});

import { api } from '@/lib/api';
import { AdjustmentEditor } from './payroll-preview-page';

/**
 * Editing pay from the payroll preview.
 *
 * The edit is a payroll adjustment: it lists only the ones the preview is
 * counting, raises a new one with its reason, withdraws one, and refreshes
 * the preview so the figures move.
 */

const adjustment = (over: Partial<PayrollAdjustmentRecord>): PayrollAdjustmentRecord => ({
  id: 'adj-1',
  employeeId: 'emp-1',
  employeeName: 'Aisha Rahman',
  originLineId: null,
  appliedRunId: null,
  kind: 'EARNING',
  label: 'Eid bonus',
  amount: 5000,
  reason: 'Approved by the CEO',
  appliedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const getPage = vi.mocked(api.getPage);
const post = vi.mocked(api.post);
const del = vi.mocked(api.delete);

function renderEditor(runId: string | null = 'run-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const onEdited = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <AdjustmentEditor employeeId="emp-1" runId={runId} currency="PKR" onEdited={onEdited} />
    </QueryClientProvider>,
  );
  return { invalidate, onEdited };
}

beforeEach(() => {
  vi.clearAllMocks();
  getPage.mockResolvedValue({
    data: [
      adjustment({}),
      adjustment({ id: 'adj-2', label: 'Claimed by this run', appliedRunId: 'run-1' }),
      adjustment({ id: 'adj-3', label: 'Claimed by another run', appliedRunId: 'run-9' }),
      adjustment({ id: 'adj-4', label: 'Already paid', appliedAt: '2026-09-30T00:00:00.000Z' }),
    ],
    meta: { page: 1, limit: 100, total: 4, totalPages: 1 },
  } as never);
  post.mockResolvedValue({});
  del.mockResolvedValue({});
});

afterEach(() => cleanup());

describe('AdjustmentEditor', () => {
  it('lists only the adjustments this preview counts', async () => {
    renderEditor();
    expect(await screen.findByText('Eid bonus')).toBeTruthy();
    expect(screen.getByText('Claimed by this run')).toBeTruthy();
    expect(screen.queryByText('Claimed by another run')).toBeNull();
    expect(screen.queryByText('Already paid')).toBeNull();
  });

  it('refuses an adjustment without a reason', async () => {
    renderEditor();
    await userEvent.type(screen.getByLabelText(/Amount/), '2500');
    await userEvent.type(screen.getByLabelText(/Label/), 'Fine');
    await userEvent.click(screen.getByRole('button', { name: 'Add adjustment' }));
    expect(screen.getByText('Say why this adjustment is being made.')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('raises the adjustment and refreshes the preview', async () => {
    const { invalidate, onEdited } = renderEditor();
    await userEvent.selectOptions(screen.getByLabelText(/Type/), 'DEDUCTION');
    await userEvent.type(screen.getByLabelText(/Amount/), '2500');
    await userEvent.type(screen.getByLabelText(/Label/), 'Laptop damage');
    await userEvent.type(screen.getByLabelText(/Reason/), 'Agreed recovery');
    await userEvent.click(screen.getByRole('button', { name: 'Add adjustment' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/payroll/adjustments', {
        employeeId: 'emp-1',
        kind: 'DEDUCTION',
        label: 'Laptop damage',
        amount: 2500,
        reason: 'Agreed recovery',
      }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['payroll', 'preview'] }),
    );
    expect(onEdited).toHaveBeenCalled();
  });

  it('withdraws an adjustment', async () => {
    const { invalidate } = renderEditor();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Eid bonus' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/payroll/adjustments/adj-1'));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['payroll', 'preview'] }),
    );
  });
});
