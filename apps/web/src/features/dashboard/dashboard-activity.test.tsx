// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The dashboard's activity tables: each drawn only for a reader holding the
 * grant its own screen needs, each reading that screen's own endpoint, and
 * each row opening the record it shows.
 */

let grants = new Set<Permission>();

vi.mock('@/features/auth/session-context', () => ({
  usePermissions: () => ({ has: (p: Permission) => grants.has(p) }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), getPage: vi.fn() } };
});

import { api } from '@/lib/api';
import { DashboardActivity } from './dashboard-activity';

const page = <T,>(data: T[]) => ({ data, meta: { page: 1, limit: 5, total: data.length, totalPages: 1 } });

const CASE = {
  id: 'c1',
  caseNumber: 'CASE-2026-000293',
  subject: 'Laptop not working',
  categoryName: 'IT',
  subcategoryName: 'IT Support',
  requesterName: 'Asad Farooq',
  status: 'OPEN',
  priority: 'HIGH',
  updatedAt: new Date().toISOString(),
};
const LEAVE = {
  id: 'l1',
  employeeName: 'Hira Javed',
  leaveTypeName: 'Casual Leave',
  startDate: '2026-10-28',
  endDate: '2026-10-29',
  status: 'PENDING',
};
const LOAN = {
  id: 'n1',
  employeeName: 'Rana Saif',
  kind: 'LOAN',
  principalAmount: 150000,
  currency: 'PKR',
  status: 'APPROVED',
  statusLabel: 'Approved',
  nextDueMonth: '2026-11-01',
};
const ISSUE = {
  id: 'i1',
  asset: { id: 'a1', assetTag: 'DXT-GE-013', name: 'Laptop' },
  reason: 'Not working',
  reportedByEmployee: { id: 'e1', fullName: 'Asad Farooq' },
  reportedBy: null,
  status: 'OPEN',
};
const APPROVAL = {
  id: 'p1',
  subjectType: 'LEAVE',
  title: 'Leave request',
  summary: 'Casual Leave',
  requesterName: 'Hira Javed',
  createdAt: new Date().toISOString(),
};

function renderActivity(permissions: readonly Permission[]) {
  grants = new Set(permissions);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardActivity />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getPage).mockImplementation(async (path: string) => {
    if (path === '/cases/queue') return page([CASE]) as never;
    if (path === '/leave/requests') return page([LEAVE]) as never;
    if (path === '/loans') return page([LOAN]) as never;
    if (path === '/approvals') return page([APPROVAL]) as never;
    throw new Error(`unexpected ${path}`);
  });
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/assets/issues') return [ISSUE] as never;
    throw new Error(`unexpected ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('dashboard activity tables', () => {
  it('shows the Super Admin all five, with their rows', async () => {
    renderActivity(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

    const cases = await screen.findByRole('region', { name: 'Recent cases' });
    expect(await within(cases).findByText('CASE-2026-000293')).toBeInTheDocument();
    expect(within(cases).getByText('IT Support')).toBeInTheDocument();
    expect(within(cases).getByText('High')).toBeInTheDocument();

    const leave = screen.getByRole('region', { name: 'Leave requests' });
    expect(await within(leave).findByText('Casual Leave')).toBeInTheDocument();

    const loans = screen.getByRole('region', { name: 'Loans & salary advances' });
    expect(await within(loans).findByText('Approved')).toBeInTheDocument();

    const issues = screen.getByRole('region', { name: 'Asset issues' });
    expect(await within(issues).findByText('DXT-GE-013')).toBeInTheDocument();

    const approvals = screen.getByRole('region', { name: 'Pending approvals' });
    expect(await within(approvals).findByText('Hira Javed')).toBeInTheDocument();
  });

  it('reads each screen’s own endpoint, first page only', async () => {
    renderActivity(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
    await screen.findByText('CASE-2026-000293');

    const calls = vi.mocked(api.getPage).mock.calls.map(([path, opts]) => [path, opts?.query]);
    expect(calls).toContainEqual(['/cases/queue', { page: 1, limit: 5 }]);
    expect(calls).toContainEqual(['/leave/requests', { page: 1, limit: 5, view: 'all' }]);
    expect(calls).toContainEqual(['/loans', { page: 1, limit: 5, view: 'all' }]);
    expect(calls).toContainEqual([
      '/approvals',
      { page: 1, limit: 5, view: 'inbox', status: 'PENDING' },
    ]);
  });

  it('draws only the tables the reader’s grants open, and asks for nothing else', async () => {
    renderActivity([PERMISSIONS.LEAVE_READ, PERMISSIONS.APPROVAL_READ]);
    await screen.findByText('Casual Leave');

    expect(screen.queryByRole('region', { name: 'Recent cases' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Loans & salary advances' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Asset issues' })).not.toBeInTheDocument();
    const paths = vi.mocked(api.getPage).mock.calls.map(([p]) => p);
    expect(paths).not.toContain('/cases/queue');
    expect(paths).not.toContain('/loans');
    expect(api.get).not.toHaveBeenCalled();
  });

  it('keeps loans away from somebody who can only read their own', async () => {
    renderActivity(DEFAULT_ROLE_PERMISSIONS.EMPLOYEE);
    expect(screen.queryByRole('region', { name: 'Loans & salary advances' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Recent cases' })).not.toBeInTheDocument();
  });

  it('renders nothing without any of the grants', () => {
    const { container } = renderActivity([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('links every table to its screen and rows to their record', async () => {
    renderActivity(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
    expect(await screen.findByRole('link', { name: 'CASE-2026-000293' })).toHaveAttribute(
      'href',
      '/case-queue/c1',
    );
    expect(screen.getByRole('link', { name: 'Laptop' })).toHaveAttribute('href', '/assets/issues?issue=i1');
    const viewAll = screen.getAllByRole('link', { name: 'View all' }).map((l) => l.getAttribute('href'));
    expect(viewAll).toEqual(['/case-queue', '/leave/requests', '/loans', '/assets/issues', '/approvals']);
  });

  it('says so when a list is empty rather than drawing a blank table', async () => {
    vi.mocked(api.getPage).mockResolvedValue(page([]) as never);
    renderActivity([PERMISSIONS.APPROVAL_READ]);
    expect(await screen.findByText('Nothing is waiting on you.')).toBeInTheDocument();
  });
});
