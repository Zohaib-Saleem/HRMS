// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EmployeeSalaryRecord } from '@hrms/shared';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, post: vi.fn(), patch: vi.fn() } };
});

import { ApiError, api } from '@/lib/api';
import {
  SalaryDialog,
  salaryFormSchema,
  salaryStatus,
  todayLocal,
  type SalaryDialogProps,
} from './salary-dialog';

/**
 * The Add / Edit salary dialog, as the user meets it.
 *
 * What is asserted here is the contract the screen makes: it opens centred
 * with the form in a scrolling body and the buttons in a fixed footer, it
 * validates before it calls the API, it only closes once the API has said
 * yes, and an error leaves everything the user typed where it was.
 */

const RECORD: EmployeeSalaryRecord = {
  id: 'sal-1',
  employeeId: 'emp-1',
  employeeName: 'Aisha Rahman',
  salaryType: 'MONTHLY',
  amount: 100000,
  currency: 'PKR',
  effectiveFrom: '2025-07-01',
  effectiveTo: '2026-06-30',
  note: 'Joined',
  isCurrent: false,
  createdAt: '2025-06-20T00:00:00Z',
};

const post = vi.mocked(api.post);
const patch = vi.mocked(api.patch);

function renderDialog(props: Partial<SalaryDialogProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const invalidate = vi.spyOn(client, 'invalidateQueries');

  const ui = (override: Partial<SalaryDialogProps>) => (
    <QueryClientProvider client={client}>
      <button type="button">Open</button>
      <SalaryDialog
        employeeId="emp-1"
        employeeName="Aisha Rahman"
        currency="PKR"
        open
        onClose={onClose}
        onSaved={onSaved}
        {...props}
        {...override}
      />
    </QueryClientProvider>
  );

  const utils = render(ui({}));
  return { ...utils, onClose, onSaved, invalidate, rerender: (override: Partial<SalaryDialogProps>) => utils.rerender(ui(override)) };
}

const dialog = () => screen.getByRole('dialog');
const amount = () => within(dialog()).getByLabelText(/^Basic salary/) as HTMLInputElement;
const from = () => within(dialog()).getByLabelText(/^Effective from/) as HTMLInputElement;
const to = () => within(dialog()).getByLabelText(/^Effective to/) as HTMLInputElement;
const note = () => within(dialog()).getByLabelText(/^Reason/) as HTMLTextAreaElement;
const saveButton = () => within(dialog()).getByRole('button', { name: /^(Save salary|Save changes|Saving)/ });
const setDate = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });

beforeEach(() => {
  post.mockReset();
  patch.mockReset();
  post.mockResolvedValue({ id: 'sal-new' });
  patch.mockResolvedValue({ id: 'sal-1' });
});

afterEach(() => cleanup());

describe('SalaryDialog: opening and closing', () => {
  it('opens as a labelled dialog with the salary form inside it', () => {
    renderDialog();
    const dlg = screen.getByRole('dialog', { name: 'Add salary' });
    const describedBy = dlg.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain('Salary is effective-dated');
    expect(within(dlg).getByLabelText('Employee')).toHaveProperty('value', 'Aisha Rahman');
    expect(within(dlg).getByLabelText('Currency')).toHaveProperty('value', 'PKR');
    expect(within(dlg).getByLabelText('Pay frequency')).toHaveProperty('value', 'MONTHLY');
    expect(amount()).toHaveProperty('value', '0');
    expect(from()).toHaveProperty('value', todayLocal());
    expect(to()).toHaveProperty('value', '');
    expect(within(dlg).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(saveButton().textContent).toContain('Save salary');
  });

  it('renders nothing while closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Cancel, on the close icon, and on Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(post).not.toHaveBeenCalled();
  });

  it('puts focus on Basic salary when it opens, and back on the opener when it closes', async () => {
    const { rerender } = renderDialog({ open: false });
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    expect(document.activeElement).toBe(opener);

    rerender({ open: true });
    await waitFor(() => expect(document.activeElement).toBe(amount()));

    rerender({ open: false });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('keeps the form in a scrolling body between a fixed header and footer', () => {
    renderDialog();
    const panel = dialog();
    expect(panel.className).toContain('hrms-modal');
    expect(panel.className).toContain('overflow-hidden');

    const body = panel.querySelector('.overflow-y-auto');
    expect(body).not.toBeNull();
    expect(body!.className).toContain('min-h-0');
    expect(body!.contains(amount())).toBe(true);
    expect(body!.contains(note())).toBe(true);

    // Header and footer sit outside the scroll region so they never scroll away.
    expect(body!.contains(within(panel).getByText('Add salary'))).toBe(false);
    expect(body!.contains(saveButton())).toBe(false);
    expect(body!.contains(within(panel).getByRole('button', { name: 'Cancel' }))).toBe(false);
  });
});

describe('SalaryDialog: Add mode', () => {
  it('posts a new record for the employee and closes only after the API answers', async () => {
    const user = userEvent.setup();
    const { onClose, onSaved, invalidate } = renderDialog();
    // Always in the future, so the status reads Scheduled whatever today is.
    const effectiveFrom = `${new Date().getFullYear() + 1}-10-01`;

    await user.clear(amount());
    await user.type(amount(), '150000');
    setDate(from(), effectiveFrom);
    await user.type(note(), 'Promotion');

    expect(within(dialog()).getByTestId('salary-status').textContent).toContain('Scheduled');

    await user.click(saveButton());

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/payroll/salaries', {
      employeeId: 'emp-1',
      salaryType: 'MONTHLY',
      amount: 150000,
      currency: 'PKR',
      effectiveFrom,
      effectiveTo: null,
      note: 'Promotion',
    });
    expect(patch).not.toHaveBeenCalled();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['compensation', 'emp-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['salary-overview'] });
  });

  it('sends an empty Effective to as null, meaning open-ended', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.clear(amount());
    await user.type(amount(), '1');
    setDate(to(), '2026-12-31');
    setDate(to(), '');
    await user.click(saveButton());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[1]).toMatchObject({ effectiveTo: null });
  });
});

describe('SalaryDialog: Edit mode', () => {
  it('shows the existing record as stored, without shifting the dates', () => {
    renderDialog({ existing: RECORD });
    expect(screen.getByRole('dialog', { name: 'Edit salary' })).toBeTruthy();
    expect(amount()).toHaveProperty('value', '100000');
    expect(from()).toHaveProperty('value', '2025-07-01');
    expect(to()).toHaveProperty('value', '2026-06-30');
    expect(note()).toHaveProperty('value', 'Joined');
    expect(within(dialog()).getByLabelText('Currency')).toHaveProperty('value', 'PKR');
    expect(within(dialog()).getByTestId('salary-status').textContent).toContain('Ended');
    expect(saveButton().textContent).toContain('Save changes');
  });

  it('patches the record in place and never creates a second one', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog({ existing: RECORD });

    await user.clear(amount());
    await user.type(amount(), '105000');
    await user.click(saveButton());

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith('/payroll/salaries/sal-1', {
      employeeId: 'emp-1',
      salaryType: 'MONTHLY',
      amount: 105000,
      currency: 'PKR',
      effectiveFrom: '2025-07-01',
      effectiveTo: '2026-06-30',
      note: 'Joined',
    });
    expect(post).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('reloads the form when a different record is opened in the same dialog', () => {
    const { rerender } = renderDialog({ existing: RECORD });
    expect(amount()).toHaveProperty('value', '100000');
    rerender({ existing: { ...RECORD, id: 'sal-2', amount: 120000, effectiveFrom: '2026-07-01', effectiveTo: null } });
    expect(amount()).toHaveProperty('value', '120000');
    expect(from()).toHaveProperty('value', '2026-07-01');
    expect(to()).toHaveProperty('value', '');
  });
});

describe('SalaryDialog: validation', () => {
  it('requires a basic salary and an effective-from date before it calls the API', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.clear(amount());
    setDate(from(), '');
    await user.click(saveButton());

    expect(await within(dialog()).findByText('Enter the basic salary.')).toBeTruthy();
    expect(within(dialog()).getByText('Enter the date this salary takes effect.')).toBeTruthy();
    expect(amount().getAttribute('aria-invalid')).toBe('true');
    expect(from().getAttribute('aria-invalid')).toBe('true');
    expect(post).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('rejects a negative basic salary with the shared rule', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.clear(amount());
    await user.type(amount(), '-5');
    await user.click(saveButton());
    expect(await within(dialog()).findByText('A salary cannot be negative.')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects an Effective to that falls before Effective from', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.clear(amount());
    await user.type(amount(), '1');
    setDate(from(), '2026-07-01');
    setDate(to(), '2026-06-30');
    await user.click(saveButton());

    expect(await within(dialog()).findByText('A salary cannot end before it starts.')).toBeTruthy();
    expect(to().getAttribute('aria-invalid')).toBe('true');
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('accepts Effective to on the same day as Effective from', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.clear(amount());
    await user.type(amount(), '1');
    setDate(from(), '2026-07-01');
    setDate(to(), '2026-07-01');
    await user.click(saveButton());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });
});

describe('SalaryDialog: saving and errors', () => {
  it('shows a loading state and blocks a second submission while saving', async () => {
    const user = userEvent.setup();
    let resolve!: (value: unknown) => void;
    post.mockReturnValue(new Promise((r) => (resolve = r)));
    const { onClose } = renderDialog();

    await user.clear(amount());
    await user.type(amount(), '1');
    await user.click(saveButton());

    await waitFor(() => expect(saveButton().getAttribute('aria-busy')).toBe('true'));
    expect(saveButton().textContent).toContain('Saving');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog()).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(saveButton());
    fireEvent.submit(within(dialog()).getByRole('form', { name: 'Add salary' }));
    expect(post).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    resolve({ id: 'sal-new' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps the dialog open with a clear message and the typed values when the API fails', async () => {
    const user = userEvent.setup();
    post.mockRejectedValue(new ApiError(500, { code: 'INTERNAL', message: 'Simulated server failure.' }));
    const { onClose, onSaved } = renderDialog();

    await user.clear(amount());
    await user.type(amount(), '99000');
    await user.type(note(), 'Keep me');
    await user.click(saveButton());

    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain('Simulated server failure.');
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(amount()).toHaveProperty('value', '99000');
    expect(note()).toHaveProperty('value', 'Keep me');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('places a field-level rejection from the API next to its field', async () => {
    const user = userEvent.setup();
    post.mockRejectedValue(
      new ApiError(422, {
        code: 'VALIDATION',
        message: 'Validation failed',
        details: { effectiveTo: ['A salary cannot end before it starts.'], scope: ['Outside your data scope.'] },
      }),
    );
    renderDialog();
    await user.clear(amount());
    await user.type(amount(), '1');
    await user.click(saveButton());

    expect(await within(dialog()).findByText('A salary cannot end before it starts.')).toBeTruthy();
    expect(to().getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog()).getByRole('alert').textContent).toContain('Outside your data scope.');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('salary form helpers', () => {
  it('derives status from the dates', () => {
    expect(salaryStatus('2026-07-01', null, '2026-09-09').label).toBe('Current');
    expect(salaryStatus('2026-07-01', '2026-12-31', '2026-09-09').label).toBe('Current');
    expect(salaryStatus('2026-10-01', null, '2026-09-09').label).toBe('Scheduled');
    expect(salaryStatus('2025-07-01', '2026-06-30', '2026-09-09').label).toBe('Ended');
  });

  it('formats today as a local calendar day, not the UTC day', () => {
    expect(todayLocal(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
    expect(todayLocal(new Date(2026, 11, 31, 0, 5))).toBe('2026-12-31');
  });

  it('turns blank optional fields into null and keeps the shared rules', () => {
    const parsed = salaryFormSchema.safeParse({
      employeeId: 'emp-1',
      salaryType: 'MONTHLY',
      amount: '1000',
      currency: 'PKR',
      effectiveFrom: '2026-07-01',
      effectiveTo: '',
      note: '  ',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.amount).toBe(1000);
      expect(parsed.data.effectiveTo).toBeNull();
      expect(parsed.data.note).toBeNull();
    }

    const bad = salaryFormSchema.safeParse({
      employeeId: 'emp-1',
      salaryType: 'MONTHLY',
      amount: '',
      currency: 'PKR',
      effectiveFrom: 'not-a-date',
      effectiveTo: null,
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      const paths = bad.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('amount');
      expect(paths).toContain('effectiveFrom');
    }
  });
});
