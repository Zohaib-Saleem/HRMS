// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The company administrator's sidebar.
 *
 * Driven by the seeded role grants, like the employee file beside it. Pins:
 * the administrator is decided by GRANTS and not by a role name; their sidebar
 * carries no personal shortcuts; every management screen is still signposted;
 * nobody else's sidebar changes; and no screen a sidebar used to reach is now
 * unreachable from the administrator's navigation.
 */

let permissions = new Set<Permission>();

vi.mock('@/features/auth/session-context', () => ({
  useSession: () => ({
    permissions,
    session: { company: { name: 'Example Ltd' }, user: { id: 'u1', roles: [{ name: 'Super Admin' }] } },
  }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(() => new Promise(() => {})) },
}));

import { SidebarNav } from '@/components/layout/sidebar';
import { MY_MEDICAL_KEY } from '@/features/medical/my-medical-card';
import {
  ADMIN_NAV_SECTIONS,
  NAV_SECTIONS,
  SELF_SERVICE_ITEMS,
  activeNavPath,
  navModeFor,
  navigationFor,
  selfServiceFor,
} from './nav-config';

const SUPER_ADMIN = DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN;
const HR_ADMIN = DEFAULT_ROLE_PERMISSIONS.HR_ADMIN;
const EMPLOYEE = DEFAULT_ROLE_PERMISSIONS.EMPLOYEE;
const MANAGER = DEFAULT_ROLE_PERMISSIONS.MANAGER;

function Providers({ children, path = '/' }: { children: ReactNode; path?: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(MY_MEDICAL_KEY, { eligibility: { eligible: true } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function renderSidebar(grants: readonly Permission[], path = '/') {
  permissions = new Set(grants);
  return render(
    <Providers path={path}>
      <SidebarNav collapsed={false} onToggleCollapsed={() => {}} />
    </Providers>,
  );
}

const links = () => screen.getAllByRole('link').map((l) => l.textContent?.trim() ?? '');
const labels = (grants: readonly Permission[], showSelfService = false) =>
  navigationFor(new Set(grants), { showSelfService }).flatMap((s) => s.items.map((i) => i.label));

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('who gets the administration sidebar', () => {
  it('is the Super Admin, by the grants the role carries', () => {
    expect(navModeFor(new Set(SUPER_ADMIN))).toBe('administration');
  });

  it('is decided by grants, not by a role name', () => {
    // Super Admin with one of the two grants removed is no longer drawn as one.
    const withoutUsers = SUPER_ADMIN.filter((p) => p !== PERMISSIONS.USER_MANAGE);
    expect(navModeFor(new Set(withoutUsers))).toBe('employee');
    // A custom role holding both is.
    expect(navModeFor(new Set([PERMISSIONS.ROLE_MANAGE, PERMISSIONS.USER_MANAGE]))).toBe(
      'administration',
    );
  });

  it('leaves employees, managers and the seeded HR admin on the employee sidebar', () => {
    for (const grants of [EMPLOYEE, MANAGER, HR_ADMIN]) {
      expect(navModeFor(new Set(grants))).toBe('employee');
    }
    // Their sidebar is exactly the registry they had before, filtered.
    const employeeRows = labels(EMPLOYEE);
    expect(employeeRows).toContain('My leave');
    expect(employeeRows).toContain('My cases');
    expect(employeeRows).toContain('Loans');
    expect(employeeRows).toContain('Medical');
    expect(employeeRows).toContain('Payslips');
    expect(labels(HR_ADMIN)).toContain('My leave');
  });
});

describe('what the Super Admin is shown', () => {
  it('has no personal self-service shortcuts', () => {
    renderSidebar(SUPER_ADMIN);
    const rows = links();
    for (const personal of [
      'My leave',
      'My loans',
      'My medical',
      'My corrections',
      'My cases',
      'My equipment requests',
      'Lunch',
      'Loans',
      'Medical',
    ]) {
      expect(rows, personal).not.toContain(personal);
    }
  });

  it('still signposts every management screen', () => {
    renderSidebar(SUPER_ADMIN);
    const rows = links();
    for (const label of [
      'People',
      'Organisation',
      'Attendance',
      'Team attendance',
      'Attendance reports',
      'Approvals',
      'Correction centre',
      'Leave management',
      'Leave types',
      'Payroll',
      'Payslips',
      'Loans & salary advances',
      'Medical management',
      'Case queue',
      'Assets',
      'Asset issues',
      'Asset reports',
      'Lunch collection',
      'Recruitment',
      'Employee Master Report',
      'Shifts',
      'Holidays',
      'Devices',
      'Device punches',
      'Settings',
      'Roles & permissions',
      'Help & Documentation',
    ]) {
      expect(rows, label).toContain(label);
    }
  });

  it('groups them as Company management, Company configuration, System administration', () => {
    renderSidebar(SUPER_ADMIN);
    const headings = screen
      .getAllByRole('button', { expanded: true })
      .map((b) => b.textContent?.trim());
    expect(headings).toEqual(['Company management', 'Company configuration', 'System administration']);
  });

  it('keeps the requested order inside Company management', () => {
    const rows = labels(SUPER_ADMIN);
    const order = [
      'Dashboard',
      'People',
      'Organisation',
      'Attendance',
      'Team attendance',
      'Attendance reports',
      'Approvals',
      'Correction centre',
      'Leave management',
      'Leave types',
      'Payroll',
      'Payslips',
      'Loans & salary advances',
      'Medical management',
      'Case queue',
      'Assets',
      'Asset issues',
      'Asset reports',
      'Lunch collection',
      'Recruitment',
      'Employee Master Report',
      'Performance',
      'Shifts',
      'Holidays',
      'Devices',
      'Device punches',
      'Settings',
      'Roles & permissions',
      'Help & Documentation',
    ];
    const positions = order.map((l) => rows.indexOf(l));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('has no duplicate destinations', () => {
    for (const show of [false, true]) {
      const paths = navigationFor(new Set(SUPER_ADMIN), { showSelfService: show }).flatMap((s) =>
        s.items.map((i) => i.to),
      );
      expect(new Set(paths).size).toBe(paths.length);
    }
  });

  it('leaves no screen of the old sidebar unreachable from the new navigation', () => {
    const before = navigationFor(new Set(SUPER_ADMIN.filter((p) => p !== PERMISSIONS.USER_MANAGE)))
      .flatMap((s) => s.items)
      .filter((i) => i.status !== 'planned')
      .map((i) => i.to);
    const reachable = new Set([
      ...navigationFor(new Set(SUPER_ADMIN)).flatMap((s) => s.items.map((i) => i.to)),
      ...selfServiceFor(new Set(SUPER_ADMIN)).map((i) => i.to),
    ]);
    for (const path of before) expect(reachable.has(path), path).toBe(true);
    // And the employee registry as a whole, not just what one role sees.
    const everyEmployeeRoute = NAV_SECTIONS.flatMap((s) => s.items)
      .filter((i) => i.status !== 'planned')
      .map((i) => i.to);
    for (const path of everyEmployeeRoute) expect(reachable.has(path), path).toBe(true);
  });
});

describe('the administrator’s own services', () => {
  it('lists only the personal routes their sidebar does not already have', () => {
    const mine = selfServiceFor(new Set(SUPER_ADMIN)).map((i) => i.label);
    expect(mine).toEqual(['My leave', 'My corrections', 'My cases', 'Lunch']);
  });

  it('offers own loans and medical when the administrator does not manage them', () => {
    const grants = [
      PERMISSIONS.ROLE_MANAGE,
      PERMISSIONS.USER_MANAGE,
      PERMISSIONS.LOAN_READ,
      PERMISSIONS.MEDICAL_READ,
    ];
    expect(labels(grants)).not.toContain('Loans & salary advances');
    expect(selfServiceFor(new Set(grants)).map((i) => i.label)).toEqual(['My loans', 'My medical']);
  });

  it('can be added to the sidebar as its own section, before System administration', () => {
    const sections = navigationFor(new Set(SUPER_ADMIN), { showSelfService: true }).map((s) => s.key);
    expect(sections.slice(-2)).toEqual(['my-self-service', 'system-administration']);
    expect(labels(SUPER_ADMIN, true)).toContain('My leave');
  });

  it('follows the preference the account menu stores', () => {
    localStorage.setItem('hrms.nav.selfService.u1', '1');
    renderSidebar(SUPER_ADMIN);
    expect(links()).toContain('My leave');
  });

  it('carries the same grant as the employee sidebar row for the same route', () => {
    const employeeGrant = new Map(NAV_SECTIONS.flatMap((s) => s.items).map((i) => [i.to, i.permission]));
    for (const item of SELF_SERVICE_ITEMS) {
      expect(item.permission, item.to).toEqual(employeeGrant.get(item.to));
    }
  });
});

describe('permission boundaries', () => {
  it('shows an administration-mode user only the rows their grants open', () => {
    const grants = [PERMISSIONS.ROLE_MANAGE, PERMISSIONS.USER_MANAGE, PERMISSIONS.ROLE_READ];
    const rows = labels(grants);
    expect(rows).toEqual(['Dashboard', 'Settings', 'Roles & permissions', 'Help & Documentation']);
  });

  it('gates every administration row on a real permission or none', () => {
    const known = new Set<string>(Object.values(PERMISSIONS));
    for (const item of ADMIN_NAV_SECTIONS.flatMap((s) => s.items)) {
      const list = item.permission === undefined ? [] : [item.permission].flat();
      for (const p of list) expect(known.has(p), `${item.to} ${p}`).toBe(true);
    }
  });
});

describe('the sidebar itself', () => {
  it('highlights exactly one row, the most specific one', () => {
    const sections = navigationFor(new Set(SUPER_ADMIN));
    expect(activeNavPath(sections, '/settings/roles')).toBe('/settings/roles');
    expect(activeNavPath(sections, '/settings/company')).toBe('/settings');
    expect(activeNavPath(sections, '/assets/issues')).toBe('/assets/issues');
    expect(activeNavPath(sections, '/assets/abc')).toBeNull();

    renderSidebar(SUPER_ADMIN, '/settings/roles');
    const current = screen.getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current.map((l) => l.textContent?.trim())).toEqual(['Roles & permissions']);
  });

  it('finds a page by name', () => {
    renderSidebar(SUPER_ADMIN);
    fireEvent.change(screen.getByPlaceholderText('Find a page'), { target: { value: 'asset' } });
    expect(links()).toEqual(['Asset dashboard', 'Assets', 'Asset issues', 'Asset reports', 'Asset categories']);
  });

  it('folds a group and remembers it', () => {
    renderSidebar(SUPER_ADMIN);
    const toggle = screen.getByRole('button', { name: 'Company configuration' });
    fireEvent.click(toggle);
    expect(links()).not.toContain('Shifts');
    cleanup();
    renderSidebar(SUPER_ADMIN);
    expect(links()).not.toContain('Shifts');
    expect(within(document.body).getByRole('button', { name: 'Company configuration' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('shows the role badge only on the administration sidebar', () => {
    renderSidebar(SUPER_ADMIN);
    expect(screen.getByText('Super Admin')).toBeInTheDocument();
    cleanup();
    renderSidebar(EMPLOYEE);
    expect(screen.queryByText('Super Admin')).not.toBeInTheDocument();
  });
});
