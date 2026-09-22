// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_ROLE_SCOPES,
  PERMISSIONS,
  type Permission,
} from '@hrms/shared';

/**
 * The dashboard an IT Asset Manager lands on.
 *
 * The symptom that started this: a person whose whole job is the laptop
 * cupboard opened the product and was shown the company's headcount, how many
 * people were present, absent and late today, and attendance broken down by
 * department and by team. None of it was theirs to see, and half of it 403'd
 * while the other half rendered.
 *
 * So what is pinned here is the COMPOSITION, from both ends:
 *
 *   - which dashboard the router picks, driven by the role's real permissions
 *     and its real data scope rather than by a hand-written pair;
 *   - and, more usefully, WHICH REQUESTS THE PAGE MAKES. A dashboard that
 *     rendered the right cards while still asking `/attendance/team` for the
 *     company would be the same bug with better CSS, so the assertion is on the
 *     fetches rather than on the pixels.
 *
 * The server refuses all of it independently - see the API's
 * attendance-self-only tests. This is the signpost agreeing with the gate.
 */

const IT_ASSET_MANAGER = DEFAULT_ROLE_PERMISSIONS.IT_ASSET_MANAGER as readonly Permission[];
const HR_ADMIN = DEFAULT_ROLE_PERMISSIONS.HR_ADMIN as readonly Permission[];

let granted = new Set<Permission>(IT_ASSET_MANAGER);
let scope: string = DEFAULT_ROLE_SCOPES.IT_ASSET_MANAGER;

const SESSION = {
  user: {
    firstName: 'Abdul',
    fullName: 'Abdul Aziz',
    employee: { id: 'emp-abdul', employeeNumber: 'GE-031', jobTitle: 'IT Executive' },
  },
  employeeLinked: true,
  company: { name: 'Example Ltd' },
  get dataScope() {
    return scope;
  },
};

vi.mock('@/features/auth/session-context', () => ({
  usePermissions: () => ({
    has: (permission: Permission) => granted.has(permission),
    hasAny: (...list: Permission[]) => list.some((p) => granted.has(p)),
    hasAll: (...list: Permission[]) => list.every((p) => granted.has(p)),
  }),
  useSession: () => ({ session: SESSION, permissions: granted, isLoading: false }),
  useAuthenticatedSession: () => SESSION,
  Can: ({
    permission,
    mode = 'all',
    children,
    fallback = null,
  }: {
    permission: Permission | Permission[];
    mode?: 'all' | 'any';
    children: React.ReactNode;
    fallback?: React.ReactNode;
  }) => {
    const list = Array.isArray(permission) ? permission : [permission];
    const ok =
      mode === 'any' ? list.some((p) => granted.has(p)) : list.every((p) => granted.has(p));
    return <>{ok ? children : fallback}</>;
  },
}));

import { api } from '@/lib/api';
import { DashboardPage } from './dashboard-page';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), getEnvelope: vi.fn(), getPage: vi.fn(), post: vi.fn() },
  };
});

/** Every path the page asked the API for, in order. */
function requested(): string[] {
  const get = vi.mocked(api.get).mock.calls.map((call) => call[0]);
  const page = vi.mocked(api.getPage).mock.calls.map((call) => call[0]);
  const envelope = vi.mocked(api.getEnvelope).mock.calls.map((call) => call[0]);
  return [...get, ...page, ...envelope];
}

const EMPTY_SUMMARY = {
  total: 125,
  byStatus: {
    AVAILABLE: 60,
    ASSIGNED: 62,
    UNDER_REPAIR: 3,
    LOST: 0,
    DAMAGED: 0,
    RETURNED: 0,
    RETIRED: 0,
    DISPOSED: 0,
  },
  totalPurchaseValue: 0,
  totalCurrentValue: 0,
};

beforeEach(() => {
  granted = new Set(IT_ASSET_MANAGER);
  scope = DEFAULT_ROLE_SCOPES.IT_ASSET_MANAGER;

  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/assets/summary') return EMPTY_SUMMARY as never;
    if (path === '/assets/my') return { assigned: [], pendingAcknowledgement: [] } as never;
    // The self-service cards on this dashboard each read their own endpoint.
    // They are all the caller's own and none takes an employee id.
    if (path === '/medical/benefit') {
      return { eligibility: { eligible: false }, dependents: [] } as never;
    }
    if (path === '/attendance/summary') return { days: [], totals: {} } as never;
    if (path === '/attendance/today') return { state: 'NOT_CHECKED_IN' } as never;
    if (path === '/leave/balances/me') return [] as never;
    if (path === '/me/company-moments') {
      return { birthdays: [], anniversaries: [], newJoiners: [] } as never;
    }
    if (path === '/company/stats') throw new Error('403');
    return { data: null } as never;
  });
  vi.mocked(api.getEnvelope).mockResolvedValue({ data: null } as never);
  vi.mocked(api.getPage).mockResolvedValue({
    data: [],
    meta: { page: 1, limit: 20, total: 0, totalPages: 1 },
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const view = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('the dashboard an IT Asset Manager is shown', () => {
  it('greets them by name rather than opening on the company’s figures', async () => {
    view();

    await waitFor(() => expect(screen.getByText(/Abdul/)).toBeInTheDocument());
    // The company dashboard's own headings, which must not be here.
    expect(screen.queryByText(/Total employees/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Present today/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Absent today/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Late today/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Department attendance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Team attendance/i)).not.toBeInTheDocument();
  });

  it('never asks the server for anybody else’s attendance', async () => {
    view();

    await waitFor(() => expect(requested().length).toBeGreaterThan(0));

    /*
     * THE assertion of this file. `/attendance/team` is the endpoint every
     * company-wide figure on the old dashboard was folded out of, and
     * `/company/stats` is the headcount. Neither is requested - not requested
     * and discarded, not requested and hidden.
     */
    for (const path of requested()) {
      expect(path).not.toContain('/attendance/team');
      expect(path).not.toContain('/company/stats');
      expect(path).not.toContain('/attendance/reports');
      expect(path).not.toContain('/employees');
    }
  });

  it('asks for its own month and nobody else’s', async () => {
    view();

    /*
     * `/attendance/summary` with no employeeId is the caller's own month,
     * resolved from the session on the server. It is the only attendance
     * request this dashboard makes.
     */
    await waitFor(() => expect(requested()).toContain('/attendance/summary'));

    const attendanceCalls = vi
      .mocked(api.get)
      .mock.calls.filter(([path]) => String(path).startsWith('/attendance'));

    /*
     * Two, and both are the caller's own: `/attendance/today` behind the
     * check-in control and `/attendance/summary` behind the month. Neither
     * carries an employeeId, so neither has a parameter that could be changed
     * to somebody else - the server resolves the subject from the session.
     */
    expect(attendanceCalls.map(([path]) => path).sort()).toEqual([
      '/attendance/summary',
      '/attendance/today',
    ]);
    for (const call of attendanceCalls) {
      expect(JSON.stringify(call[1] ?? {})).not.toContain('employeeId');
    }
  });

  it('shows the asset register figures, which are about equipment', async () => {
    view();

    expect(await screen.findByRole('heading', { name: 'Asset register' })).toBeInTheDocument();
    expect(await screen.findByText('125')).toBeInTheDocument();
    expect(screen.getByText('Total assets')).toBeInTheDocument();
    expect(screen.getByText('Assigned')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Under repair')).toBeInTheDocument();
  });
});

describe('a wide data scope does not bring the company dashboard back', () => {
  it('still shows the personal dashboard when the session says ALL', async () => {
    /*
     * The exact production state: the hand-made IT role carried an ALL scope
     * because the asset register is company-wide. Scope alone used to decide
     * this, and it sent them to the company dashboard. It no longer can - the
     * grant the page is built on is absent, and that is now half the test.
     */
    scope = 'ALL';
    view();

    await waitFor(() => expect(screen.getByText(/Abdul/)).toBeInTheDocument());
    expect(screen.queryByText(/Total employees/i)).not.toBeInTheDocument();
    for (const path of requested()) {
      expect(path).not.toContain('/attendance/team');
      expect(path).not.toContain('/company/stats');
    }
  });
});

describe('an ordinary employee’s dashboard is unchanged', () => {
  it('shows no asset register strip, because they do not run one', async () => {
    granted = new Set(DEFAULT_ROLE_PERMISSIONS.EMPLOYEE as readonly Permission[]);
    scope = 'OWN';
    view();

    await waitFor(() => expect(screen.getByText(/Abdul/)).toBeInTheDocument());
    expect(screen.queryByText('Asset register')).not.toBeInTheDocument();
    // And it never asked for the figures, rather than asking and hiding them.
    expect(requested()).not.toContain('/assets/summary');
  });
});

describe('HR is unaffected', () => {
  it('still lands on the company dashboard', async () => {
    granted = new Set(HR_ADMIN);
    scope = DEFAULT_ROLE_SCOPES.HR_ADMIN;
    expect(granted.has(PERMISSIONS.EMPLOYEE_READ)).toBe(true);

    view();

    // The company dashboard is the one that asks for the headcount and the
    // company's attendance; the employee dashboard never does either.
    await waitFor(() => expect(requested()).toContain('/company/stats'));
    expect(requested().some((path) => path.includes('/attendance/team'))).toBe(true);
  });
});
