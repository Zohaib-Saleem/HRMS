// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PERMISSIONS } from '@hrms/shared';

/**
 * The asset dashboard and the two reports.
 *
 * What is pinned here is every way these screens could mislead somebody who
 * has no way of checking:
 *
 *   - THE DASHBOARD IS ONE QUERY. Every figure on it describes the same rows
 *     at the same instant, and the test asserts one request rather than nine
 *     - nine would produce a page whose tiles do not add up to its own lists;
 *   - the three alerts that ARE a status link to the register with that filter
 *     applied, rather than keeping a second copy of those rows in step;
 *   - the register OPENS narrowed when it is reached that way, which is what
 *     makes those links worth having;
 *   - THE REPORT FOOTER TOTALS EVERY MATCHING ROW. The test serves one row
 *     against totals that say eighty, and the footer must say eighty;
 *   - THE EXPORT CARRIES THE SCREEN'S FILTERS. A link built without them would
 *     be a spreadsheet with the wrong rows in it, emailed to somebody;
 *   - the two reports have different GRAINS, and switching between them asks
 *     the server a different question rather than re-slicing what is on screen.
 */

let permissions = new Set<string>();

vi.mock('@/features/auth/session-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth/session-context')>();
  return {
    ...actual,
    usePermissions: () => ({
      has: (p: string) => permissions.has(p),
      hasAny: (...list: string[]) => list.some((p) => permissions.has(p)),
      hasAll: (...list: string[]) => list.every((p) => permissions.has(p)),
    }),
    useSession: () => ({
      session: {
        employeeLinked: true,
        user: {},
        company: { name: 'Example Ltd', currency: 'PKR', timezone: 'Asia/Karachi' },
      },
      permissions,
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => Promise.resolve(),
      clear: () => {},
    }),
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AssetActivity } from './asset-activity';
import { AssetDashboardPage } from './asset-dashboard-page';
import { AssetReportsPage } from './asset-reports-page';
import { AssetsPage } from './assets-page';

const HR = [
  PERMISSIONS.ASSET_READ,
  PERMISSIONS.ASSET_READ_ALL,
  PERMISSIONS.ASSET_CREATE,
  PERMISSIONS.ASSET_UPDATE,
  PERMISSIONS.ASSET_REPORT,
];

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const DASHBOARD = {
  total: 128,
  byStatus: {
    AVAILABLE: 40,
    ASSIGNED: 71,
    UNDER_REPAIR: 9,
    LOST: 2,
    DAMAGED: 3,
    RETURNED: 1,
    RETIRED: 1,
    DISPOSED: 1,
  },
  totalPurchaseValue: 20_000_000,
  totalCurrentValue: 16_000_000,
  byCategory: [
    { key: 'cat-laptop', label: 'IT Equipment › Laptop', count: 60, purchaseValue: 15_000_000, currentValue: 12_000_000 },
    { key: null, label: 'Uncategorised', count: 4, purchaseValue: 100_000, currentValue: 80_000 },
  ],
  byDepartment: [
    { key: 'dept-dev', label: 'Development', count: 45, purchaseValue: 11_000_000, currentValue: 9_000_000 },
  ],
  alerts: {
    warrantyExpiring: 412,
    underRepair: 9,
    lost: 2,
    damaged: 3,
    notReturned: 5,
    employeesPendingClearance: 2,
    warrantyExpiringRows: [
      {
        id: 'asset-1',
        assetTag: 'IT-LAP-0042',
        name: 'Dell Latitude 5440',
        status: 'ASSIGNED',
        categoryName: 'Laptop',
        holderName: 'Ahmed Khan',
        holderEmployeeId: 'emp-ahmed',
        date: '2026-10-05',
        days: 16,
      },
    ],
    notReturnedRows: [
      {
        id: 'asset-9',
        assetTag: 'IT-MON-0003',
        name: 'Dell 24" Monitor',
        status: 'ASSIGNED',
        categoryName: 'Monitor',
        holderName: 'Sana Iqbal',
        holderEmployeeId: 'emp-sana',
        date: '2026-04-01',
        days: -171,
      },
    ],
    pendingClearanceRows: [
      {
        employeeId: 'emp-sana',
        employeeNumber: 'EMP-0011',
        fullName: 'Sana Iqbal',
        departmentName: 'Development',
        employmentStatus: 'RESIGNED',
        pending: 1,
        returned: 2,
        state: 'PARTIALLY_CLEARED',
      },
    ],
  },
  warrantyDays: 30,
  asOf: '2026-09-19',
};

/** One row, against totals that describe eighty. */
const ASSET_REPORT = {
  data: [
    {
      assetId: 'asset-1',
      assetTag: 'IT-LAP-0042',
      assetName: 'Dell Latitude 5440',
      categoryName: 'Laptop',
      brand: 'Dell',
      model: 'Latitude 5440',
      serialNumber: 'SN-ABC-123',
      purchaseDate: '2026-01-15',
      purchasePrice: 250000,
      currentValue: 200000,
      warrantyEnd: '2029-01-15',
      locationName: 'Lahore Office',
      condition: 'GOOD',
      status: 'ASSIGNED',
      employeeId: 'emp-ahmed',
      employeeName: 'Ahmed Khan',
      employeeNumber: 'EMP-0007',
      departmentName: 'Development',
      assignedAt: '2026-03-01T05:00:00.000Z',
    },
  ],
  meta: { page: 1, limit: 20, total: 80, totalPages: 4 },
  totals: { rows: 80, purchaseValue: 20_000_000, currentValue: 16_000_000 },
  asOf: '2026-09-19',
};

const EMPLOYEE_REGISTER = {
  data: [
    {
      assignmentId: 'assign-1',
      assetId: 'asset-1',
      employeeId: 'emp-ahmed',
      employeeName: 'Ahmed Khan',
      employeeNumber: 'EMP-0007',
      departmentName: 'Development',
      teamName: 'Platform',
      assetTag: 'IT-LAP-0042',
      assetName: 'Dell Latitude 5440',
      categoryName: 'Laptop',
      serialNumber: 'SN-ABC-123',
      assignedAt: '2026-03-01T05:00:00.000Z',
      returnedAt: null,
      condition: 'GOOD',
      assignmentStatus: 'ACTIVE',
      assetStatus: 'ASSIGNED',
      acknowledgementStatus: 'ACKNOWLEDGED',
      currentValue: 200000,
    },
  ],
  meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
  totals: { rows: 1, purchaseValue: 250000, currentValue: 200000 },
  asOf: '2026-09-19',
};

const CATEGORIES = [
  {
    id: 'cat-it',
    name: 'IT Equipment',
    description: null,
    parentCategoryId: null,
    parentName: null,
    sortOrder: 0,
    isActive: true,
    assetCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    children: [],
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Three events: one the shared step map knows, one it colours as a warning,
 * and one it has never heard of.
 */
const ACTIVITY = [
  {
    id: 'audit-3',
    action: 'asset.lost',
    summary: 'Marked IT-LAP-0042 lost',
    actorName: 'HR Admin',
    at: '2026-09-19T05:00:00.000Z',
  },
  {
    id: 'audit-2',
    action: 'asset.assigned',
    summary: 'Assigned IT-LAP-0042 to Ahmed Khan in Good condition',
    actorName: 'HR Admin',
    at: '2026-03-01T05:00:00.000Z',
  },
  {
    id: 'audit-1',
    action: 'asset.something.invented.next.release',
    summary: 'Something a later release started recording',
    actorName: null,
    at: '2026-01-15T05:00:00.000Z',
  },
];

function wireFetch() {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/activity')) return respond({ data: ACTIVITY });
    if (url.includes('/assets/dashboard')) return respond({ data: DASHBOARD });
    if (url.includes('/assets/reports/employees')) return respond(EMPLOYEE_REGISTER);
    if (url.includes('/assets/reports/assets')) return respond(ASSET_REPORT);
    if (url.includes('/assets/categories')) return respond({ data: CATEGORIES });
    if (url.includes('/assets/summary')) {
      return respond({ data: { total: 1, byStatus: DASHBOARD.byStatus } });
    }
    if (url.includes('/departments/lookups')) {
      return respond({
        data: {
          departments: [{ id: 'dept-dev', label: 'Development' }],
          teams: [{ id: 'team-platform', label: 'Platform', departmentId: 'dept-dev' }],
          designations: [],
          locations: [{ id: 'loc-lahore', label: 'Lahore Office' }],
          managers: [],
        },
      });
    }
    if (url.includes('/assets')) {
      return respond({ data: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    }
    return respond({ data: null }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderAt(node: React.ReactNode, grants: readonly string[], path = '/') {
  permissions = new Set(grants);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Every URL the page asked for, in order. */
function requested(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  wireFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the dashboard', () => {
  it('asks ONE question, so every figure on it describes the same instant', async () => {
    renderAt(<AssetDashboardPage />, HR);

    await waitFor(() => expect(screen.getByText('128')).toBeInTheDocument());

    const dashboardCalls = requested().filter((url) => url.includes('/assets/dashboard'));
    expect(dashboardCalls).toHaveLength(1);
  });

  it('shows the money as well as the count', async () => {
    renderAt(<AssetDashboardPage />, HR);

    // A register of forty chairs and eight laptops is not described by a count.
    await waitFor(() =>
      expect(screen.getAllByText(/16,000,000/).length).toBeGreaterThan(0),
    );
  });

  it('links the three status alerts to the register, filtered', async () => {
    renderAt(<AssetDashboardPage />, HR);

    await waitFor(() => expect(screen.getByText('Lost')).toBeInTheDocument());

    const hrefs = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter(Boolean) as string[];

    expect(hrefs).toContain('/assets?status=LOST');
    expect(hrefs).toContain('/assets?status=UNDER_REPAIR');
    expect(hrefs).toContain('/assets?status=DAMAGED');
  });

  it('carries the rows for the three alerts no status filter can reach', async () => {
    renderAt(<AssetDashboardPage />, HR);

    // A warranty running out is date arithmetic; "not returned" is a fact about
    // the HOLDER's employment; a person pending clearance is not an asset.
    await waitFor(() => expect(screen.getByText('Warranties running out')).toBeInTheDocument());
    // `getAllBy`: the alert tile's hint says the same thing as the card's
    // heading, which is the point - the tile counts it and the card lists it.
    expect(screen.getAllByText('Still out with somebody who has left').length).toBeGreaterThan(0);
    expect(screen.getAllByText('People pending clearance').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText('Sana Iqbal').length).toBeGreaterThan(0));
    expect(screen.getByText('Partially cleared')).toBeInTheDocument();
  });

  it('says so when it is showing a shortlist of a much longer list', async () => {
    renderAt(<AssetDashboardPage />, HR);

    await waitFor(() =>
      expect(screen.getByText(/Showing 1 of 412/)).toBeInTheDocument(),
    );
  });

  it('formats the days from the SERVER’s arithmetic, never the browser’s', async () => {
    renderAt(<AssetDashboardPage />, HR);

    // +16 and -171 as served. A browser in another timezone must not be able to
    // move a warranty boundary by a day.
    await waitFor(() => expect(screen.getByText('in 16 days')).toBeInTheDocument());
    expect(screen.getByText('171 days ago')).toBeInTheDocument();
  });

  it('re-asks the one question when the warranty window changes', async () => {
    renderAt(<AssetDashboardPage />, HR);
    await waitFor(() => expect(screen.getByText('128')).toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText('Warranty window'), '90');

    await waitFor(() =>
      expect(requested().some((url) => url.includes('warrantyDays=90'))).toBe(true),
    );
  });
});

describe('the register, reached from an alert', () => {
  it('opens already narrowed to the rows the tile was counting', async () => {
    renderAt(<AssetsPage />, HR, '/assets?status=LOST');

    await waitFor(() => expect(requested().some((url) => url.includes('status=LOST'))).toBe(true));
    // And the screen owns the filter from then on - the select shows it.
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('LOST');
  });
});

describe('the reports', () => {
  it('totals every matching row, not the page on screen', async () => {
    renderAt(<AssetReportsPage />, HR);

    await waitFor(() => expect(screen.getByText('Ahmed Khan')).toBeInTheDocument());

    // One row served, eighty matched. The footer describes the filters.
    expect(screen.getByText('80 assets matched')).toBeInTheDocument();
  });

  it('switches grain rather than re-slicing what is on screen', async () => {
    renderAt(<AssetReportsPage />, HR);
    await waitFor(() => expect(screen.getByText('Ahmed Khan')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /Employee register/ }));

    await waitFor(() =>
      expect(requested().some((url) => url.includes('/assets/reports/employees'))).toBe(true),
    );
    // A column that only exists at the handover grain. `getAllBy`, because the
    // heading and the cell under it read the same for an acknowledged handover.
    await waitFor(() => expect(screen.getAllByText('Acknowledged').length).toBeGreaterThan(0));
  });

  it('offers the handover scope only where it means something', async () => {
    renderAt(<AssetReportsPage />, HR);
    await waitFor(() => expect(screen.getByText('Ahmed Khan')).toBeInTheDocument());

    // The asset report has no handover grain for "every handover ever".
    expect(screen.queryByLabelText('Handovers')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Employee register/ }));
    await waitFor(() => expect(screen.getByLabelText('Handovers')).toBeInTheDocument());
  });

  it('builds the export link from the SAME filters as the table', async () => {
    renderAt(<AssetReportsPage />, HR);
    await waitFor(() => expect(screen.getByText('Ahmed Khan')).toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'LOST');

    await waitFor(() => {
      const href = screen
        .getByRole('link', { name: /Export CSV/ })
        .getAttribute('href') as string;
      expect(href).toContain('/assets/reports/assets.csv');
      expect(href).toContain('status=LOST');
      // And the columns, so the file has the columns the screen has.
      expect(href).toContain('columns=');
    });
  });

  it('asks the server for the filter rather than narrowing what arrived', async () => {
    renderAt(<AssetReportsPage />, HR);
    await waitFor(() => expect(screen.getByText('Ahmed Khan')).toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText('Department'), 'dept-dev');

    await waitFor(() =>
      expect(requested().some((url) => url.includes('departmentId=dept-dev'))).toBe(true),
    );
  });

  it('hides the dashboard button from somebody who may report and not read the register', async () => {
    renderAt(<AssetReportsPage />, [PERMISSIONS.ASSET_READ, PERMISSIONS.ASSET_REPORT]);

    await waitFor(() => expect(screen.getByText('Ahmed Khan')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /Dashboard/ })).not.toBeInTheDocument();
    // The export is still theirs: that is the grant they hold.
    expect(screen.getByRole('link', { name: /Export CSV/ })).toBeInTheDocument();
  });
});

describe('the asset timeline', () => {
  /*
   * The step map is presentation and nothing else: the events themselves are
   * the audit rows the lifecycle already writes. What it adds is a heading and
   * a colour, so a reader scanning a long timeline finds the row that means
   * something went wrong without reading twenty sentences.
   */
  it('gives a known action its heading, keeping the audit sentence underneath', async () => {
    renderAt(<AssetActivity assetId="asset-1" />, HR);

    await waitFor(() => expect(screen.getByText('Assigned')).toBeInTheDocument());
    expect(
      screen.getByText('Assigned IT-LAP-0042 to Ahmed Khan in Good condition'),
    ).toBeInTheDocument();
  });

  it('renders an action it has never heard of, as the sentence alone', async () => {
    renderAt(<AssetActivity assetId="asset-1" />, HR);

    // The fallback carries the action itself, which is a database string and
    // not a heading. A lifecycle step added in a later release appears here the
    // day it ships rather than the day somebody updates a lookup table.
    await waitFor(() =>
      expect(screen.getByText('Something a later release started recording')).toBeInTheDocument(),
    );
    expect(screen.queryByText('asset.something.invented.next.release')).not.toBeInTheDocument();
  });

  it('colours the row that means something went wrong', async () => {
    const { container } = renderAt(<AssetActivity assetId="asset-1" />, HR);

    await waitFor(() => expect(screen.getByText('Marked lost')).toBeInTheDocument());
    // The badge vocabulary the register uses, so LOST looks the same on the
    // timeline as it does on the list.
    expect(container.querySelector('.bg-destructive')).not.toBeNull();
    expect(container.querySelector('.bg-primary')).not.toBeNull();
  });
});
