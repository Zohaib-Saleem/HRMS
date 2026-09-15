// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserDetail } from '@hrms/shared';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, post: vi.fn() } };
});

import { toast } from 'sonner';
import { ApiError, api } from '@/lib/api';
import { ChangeEmailDialog } from './users-page';

/**
 * The Change sign-in email dialog, as an administrator meets it.
 *
 * What is asserted is the contract that keeps this from being a single
 * accidental click: the dialog names the current address and the separate
 * work email, states that the old address stops working, will not submit until
 * that has been acknowledged, defaults the work-email choice from whether the
 * two addresses currently agree, sends exactly the normalised payload the API
 * validates, and stays open on a refusal with the reason on screen.
 */

const USER: UserDetail = {
  id: 'user-2',
  email: 'old@example.com',
  firstName: 'Aisha',
  lastName: 'Rahman',
  fullName: 'Aisha Rahman',
  status: 'ACTIVE',
  avatarColor: '#3f6cd6',
  isLockedOut: false,
  lastLoginAt: null,
  suspendedReason: null,
  suspendedAt: null,
  suspendedByName: null,
  roles: [{ id: 'role-1', key: 'EMPLOYEE', name: 'Employee' }],
  employee: {
    id: 'emp-1',
    employeeNumber: 'EMP-0042',
    fullName: 'Aisha Rahman',
    status: 'ACTIVE',
    departmentName: 'Finance',
    workEmail: 'old@example.com',
  },
  activeSessionCount: 2,
  createdAt: '2025-06-20T00:00:00Z',
  sessions: [],
  restore: { allowed: false, reason: null },
};

const post = vi.mocked(api.post);

function renderDialog(user: UserDetail = USER) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onSaved = vi.fn(async () => undefined);
  render(
    <QueryClientProvider client={client}>
      <ChangeEmailDialog user={user} onClose={onClose} onSaved={onSaved} />
    </QueryClientProvider>,
  );
  return { onClose, onSaved };
}

const dialog = () => screen.getByRole('dialog');
const newEmail = () => within(dialog()).getByLabelText(/^New sign-in email/) as HTMLInputElement;
const acknowledge = () =>
  within(dialog()).getByLabelText(/I understand that the old sign-in email will stop working/) as HTMLInputElement;
const syncBox = () =>
  within(dialog()).queryByLabelText(/Also update employee work email/) as HTMLInputElement | null;
const submit = () => within(dialog()).getByRole('button', { name: /^Change Email/ });

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({
    id: 'user-2',
    email: 'new@example.com',
    previousEmail: 'old@example.com',
    employeeId: 'emp-1',
    retiredResetTokens: 0,
    revokedSessions: 2,
    invitationResent: false,
    employeeWorkEmailUpdated: false,
  });
});

afterEach(() => cleanup());

describe('ChangeEmailDialog: what it shows', () => {
  it('names the current sign-in email and the separate work email', () => {
    renderDialog();
    expect(screen.getByTestId('current-signin-email').textContent).toBe('old@example.com');
    expect(screen.getByTestId('current-work-email').textContent).toBe('old@example.com');
    expect(newEmail().value).toBe('');
  });

  it('states that the old address stops working, before anything is typed', () => {
    renderDialog();
    expect(dialog().textContent).toContain(
      'Changing this address will change where this user signs in. The old address will no longer work.',
    );
    expect(dialog().textContent).toContain('Existing sessions will be signed out');
    expect(dialog().textContent).toContain('password-reset and invitation links stop working');
    expect(dialog().textContent).toContain('password is unchanged');
  });

  it('will not submit until the consequence has been acknowledged', async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(acknowledge().checked).toBe(false);
    expect(submit()).toHaveProperty('disabled', true);

    await user.type(newEmail(), 'new@example.com');
    expect(submit()).toHaveProperty('disabled', true);

    await user.click(acknowledge());
    expect(submit()).toHaveProperty('disabled', false);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('ChangeEmailDialog: the work-email choice', () => {
  it('is pre-ticked when the login and work email currently agree', () => {
    renderDialog();
    expect(syncBox()?.checked).toBe(true);
  });

  it('is pre-ticked when they agree apart from case', () => {
    renderDialog({ ...USER, employee: { ...USER.employee!, workEmail: 'Old@Example.com' } });
    expect(syncBox()?.checked).toBe(true);
  });

  it('is left unticked when the two already differ', () => {
    renderDialog({ ...USER, employee: { ...USER.employee!, workEmail: 'aisha@hr.example.com' } });
    expect(syncBox()?.checked).toBe(false);
    expect(screen.getByTestId('current-work-email').textContent).toBe('aisha@hr.example.com');
  });

  it('is left unticked when the employee has no work email', () => {
    renderDialog({ ...USER, employee: { ...USER.employee!, workEmail: null } });
    expect(syncBox()?.checked).toBe(false);
  });

  it('is not offered for an account with no employee', () => {
    renderDialog({ ...USER, employee: null });
    expect(syncBox()).toBeNull();
    expect(dialog().textContent).toContain('not linked to an employee');
  });
});

describe('ChangeEmailDialog: what it sends', () => {
  it('posts the trimmed, lowercased address with the acknowledgement and the work-email choice', async () => {
    const user = userEvent.setup();
    const { onClose, onSaved } = renderDialog();

    await user.type(newEmail(), '  New@Example.COM ');
    await user.click(syncBox()!); // untick: login only
    await user.click(acknowledge());
    await user.click(submit());

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/users/user-2/change-email', {
      email: 'new@example.com',
      syncEmployeeWorkEmail: false,
      acknowledged: true,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalled();
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(expect.stringContaining('new@example.com'));
  });

  it('sends the work-email choice as true when it is left ticked', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(newEmail(), 'new@example.com');
    await user.click(acknowledge());
    await user.click(submit());

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1]).toMatchObject({ syncEmployeeWorkEmail: true });
  });

  it('refuses an invalid address before calling the API', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(newEmail(), 'not-an-address');
    await user.click(acknowledge());
    await user.click(submit());

    // The input is type="email", so the browser's own constraint validation
    // refuses the submit before the form handler runs; the zod rule behind it
    // (graded server-side in users.routes.test.ts) is the second line.
    expect(newEmail().checkValidity()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(post).not.toHaveBeenCalled();
  });

  it('stays open and says so when the address is already in use', async () => {
    post.mockRejectedValue(
      new ApiError(409, { code: 'CONFLICT', message: 'That email address is already in use.' }),
    );
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.type(newEmail(), 'taken@example.com');
    await user.click(acknowledge());
    await user.click(submit());

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('That email address is already in use.'),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(newEmail().value).toBe('taken@example.com');
  });

  it('puts a field-level refusal on the field', async () => {
    post.mockRejectedValue(
      new ApiError(422, {
        code: 'VALIDATION',
        message: 'Validation failed.',
        details: { email: ['That is already the address this account signs in with.'] },
      }),
    );
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.type(newEmail(), 'old2@example.com');
    await user.click(acknowledge());
    await user.click(submit());

    await waitFor(() =>
      expect(dialog().textContent).toContain('That is already the address this account signs in with.'),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
