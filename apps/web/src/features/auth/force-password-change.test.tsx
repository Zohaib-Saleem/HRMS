// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Permission, SessionContext } from '@hrms/shared';
import { PERMISSIONS } from '@hrms/shared';

/**
 * The gate in front of a password somebody else chose.
 *
 * Every one of the 82 accounts created by
 * `scripts/create-employee-logins.mjs` carries `mustChangePassword`, and so
 * does every account an administrator touches through
 * `POST /users/:id/set-password`. Until this gate existed the flag was written,
 * carried on the session, exposed on `/me` - and enforced nowhere, so a
 * "temporary" password was in practice permanent and the administrator who
 * issued it kept a working credential indefinitely.
 *
 * What these tests hold down is that the gate is a WALL and not a banner:
 *
 *   - it replaces the whole application, so there is no route to navigate to
 *     and no URL to type that reaches the app around it;
 *   - it goes through the ordinary `PATCH /me/password`, which verifies the
 *     current password, so possession of an unlocked browser is not enough;
 *   - it lets go the moment the server says the flag is cleared, and not on
 *     this screen's own say-so.
 */

const state = vi.hoisted(() => ({ mustChangePassword: true }));

const makeSession = (): SessionContext => ({
  user: {
    id: 'u1',
    email: 'joiner@example.test',
    firstName: 'Ayesha',
    lastName: 'Khan',
    fullName: 'Ayesha Khan',
    status: 'ACTIVE',
    mustChangePassword: state.mustChangePassword,
    lastLoginAt: null,
    avatarColor: '#4f46e5',
    roles: [{ id: 'r1', key: 'employee', name: 'Employee' }],
    employee: {
      id: 'e1',
      employeeNumber: '233',
      jobTitle: 'Designer',
      departmentName: 'Designing',
      teamName: null,
      photoUrl: null,
    },
  },
  company: {
    id: 'c1',
    name: 'GamEmpires',
    timezone: 'Asia/Karachi',
    currency: 'PKR',
    dateFormat: 'dd/MM/yyyy',
    weekStartsOn: 'MONDAY',
  },
  permissions: Object.values(PERMISSIONS) as Permission[],
  dataScope: 'ALL',
  employeeLinked: true,
});

const clearSpy = vi.hoisted(() => vi.fn());

vi.mock('@/features/auth/session-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth/session-context')>();
  return {
    ...actual,
    useSession: () => ({
      session: makeSession(),
      permissions: new Set(Object.values(PERMISSIONS) as Permission[]),
      isLoading: false,
      error: null,
      isError: false,
      refetch: vi.fn(),
      clear: clearSpy,
    }),
    // Stubbed too, because the flag-clear case falls THROUGH the gate into the
    // real dashboard - which is the point of that test, and which reaches for
    // the session by a different hook.
    useAuthenticatedSession: () => makeSession(),
    usePermissions: () => {
      const permissions = new Set(Object.values(PERMISSIONS) as Permission[]);
      return {
        has: (p: Permission) => permissions.has(p),
        hasAny: (...list: Permission[]) => list.some((p) => permissions.has(p)),
        hasAll: (...list: Permission[]) => list.every((p) => permissions.has(p)),
      };
    },
  };
});

const apiMock = vi.hoisted(() => ({
  patch: vi.fn(),
  post: vi.fn(),
  get: vi.fn().mockResolvedValue({ count: 0 }),
  getPage: vi.fn().mockResolvedValue({
    data: [],
    meta: { page: 1, limit: 12, total: 0, totalPages: 1 },
  }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, ...apiMock } };
});

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

import { ThemeProvider } from '@/app/theme';
import { ConfirmProvider } from '@/components/feedback/confirm-dialog';
import { AppRoutes } from '@/app/router';

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
          </MemoryRouter>
        </ConfirmProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const heading = () => screen.queryByRole('heading', { name: /choose your own password/i });

beforeEach(() => {
  state.mustChangePassword = true;
  vi.clearAllMocks();
  apiMock.get.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  cleanup();
});

describe('the forced password change gate', () => {
  it('replaces the dashboard when the flag is set', () => {
    renderAt('/');
    expect(heading()).toBeInTheDocument();
  });

  it('cannot be walked around by typing a different URL', () => {
    // The flag is checked above the route table, so a deep link lands here too.
    renderAt('/payroll');
    expect(heading()).toBeInTheDocument();
  });

  it('gets out of the way once the flag is clear', () => {
    state.mustChangePassword = false;
    renderAt('/');
    expect(heading()).not.toBeInTheDocument();
  });

  it('sends the temporary password with the new one, so possession is not enough', async () => {
    apiMock.patch.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderAt('/');

    await user.type(screen.getByLabelText(/password you were given/i), 'given-one-11');
    await user.type(screen.getByLabelText(/^new password/i), 'chosen-secret-42');
    await user.type(screen.getByLabelText(/confirm new password/i), 'chosen-secret-42');
    await user.click(screen.getByRole('button', { name: /set password and continue/i }));

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/me/password', {
        currentPassword: 'given-one-11',
        newPassword: 'chosen-secret-42',
        confirmPassword: 'chosen-secret-42',
      });
    });
  });

  it('refuses a new password that does not meet the house rules', async () => {
    const user = userEvent.setup();
    renderAt('/');

    await user.type(screen.getByLabelText(/password you were given/i), 'given-one-11');
    await user.type(screen.getByLabelText(/^new password/i), 'short');
    await user.type(screen.getByLabelText(/confirm new password/i), 'short');
    await user.click(screen.getByRole('button', { name: /set password and continue/i }));

    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it('refuses a confirmation that does not match', async () => {
    const user = userEvent.setup();
    renderAt('/');

    await user.type(screen.getByLabelText(/password you were given/i), 'given-one-11');
    await user.type(screen.getByLabelText(/^new password/i), 'chosen-secret-42');
    await user.type(screen.getByLabelText(/confirm new password/i), 'chosen-secret-43');
    await user.click(screen.getByRole('button', { name: /set password and continue/i }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it('offers a way out for somebody who is not the account holder', async () => {
    apiMock.post.mockResolvedValue({});
    const user = userEvent.setup();
    renderAt('/');

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/auth/logout'));
    expect(clearSpy).toHaveBeenCalled();
  });
});
