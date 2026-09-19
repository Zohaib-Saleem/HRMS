// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PERMISSIONS } from '@hrms/shared';

/**
 * The asset register screen.
 *
 * Four claims are pinned here, and each is one the screen could plausibly get
 * wrong on its own while every endpoint behind it stays correct:
 *
 *   - THE TILES COME FROM THEIR OWN ENDPOINT. The test serves a summary that
 *     deliberately disagrees with the page of rows beside it, and expects the
 *     summary to win. Counting the rows on screen would produce figures that
 *     change when somebody clicks next, and four tiles that quietly describe
 *     twenty assets rather than the register.
 *   - STATUS AND CONDITION ARE TWO COLUMNS. The fixture is a laptop that is
 *     ASSIGNED and DAMAGED at the same time, which is the pair the whole data
 *     model exists to be able to say, and both must appear.
 *   - THE WRITE CONTROLS ARE ABSENT WITHOUT THE GRANT. An employee holding
 *     `asset.read` is shown neither "Add asset" nor an Edit button. This hides
 *     signposts and is never the gate: every endpoint re-checks.
 *   - THERE IS NO CONTROL THAT WIDENS THE QUERY. How much of the register a
 *     reader gets is decided server-side, so the page carries no "show
 *     everything" toggle for somebody to find.
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

import { AssetsPage } from './assets-page';

/** HR: runs the register. */
const HR = [
  PERMISSIONS.ASSET_READ,
  PERMISSIONS.ASSET_READ_ALL,
  PERMISSIONS.ASSET_CREATE,
  PERMISSIONS.ASSET_UPDATE,
  PERMISSIONS.ASSET_CATEGORY_MANAGE,
];

/** An employee: the read grant, entire. */
const EMPLOYEE = [PERMISSIONS.ASSET_READ];

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

/** The register's own figures. Deliberately unlike the rows served with them. */
const SUMMARY = {
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
};

/** A laptop that is out with somebody AND has a cracked screen. */
const ASSIGNED_AND_DAMAGED = {
  id: 'asset-1',
  assetTag: 'IT-LAP-0042',
  name: 'Dell Latitude 5440',
  category: { id: 'cat-laptop', name: 'Laptop', parentName: 'IT Equipment' },
  brand: 'Dell',
  model: 'Latitude 5440',
  serialNumber: 'SN-ABC-123',
  purchaseDate: '2026-01-15',
  purchasePrice: 250000,
  currentValue: 200000,
  vendor: 'Computer Marketing',
  warrantyStart: '2026-01-15',
  warrantyEnd: '2029-01-15',
  location: 'Desk 14',
  site: { id: 'loc-lahore', name: 'Lahore Office' },
  department: { id: 'dept-dev', name: 'Development' },
  condition: 'DAMAGED',
  status: 'ASSIGNED',
  notes: null,
  holder: {
    assignmentId: 'assign-1',
    employeeId: 'emp-ahmed',
    employeeNumber: 'EMP-0007',
    fullName: 'Ahmed Khan',
    departmentName: 'Development',
    assignedAt: '2026-03-01T05:00:00.000Z',
  },
  createdAt: '2026-01-15T05:00:00.000Z',
  updatedAt: '2026-03-01T05:00:00.000Z',
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
    children: [
      {
        id: 'cat-laptop',
        name: 'Laptop',
        description: null,
        parentCategoryId: 'cat-it',
        parentName: 'IT Equipment',
        sortOrder: 0,
        isActive: true,
        assetCount: 12,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        children: [],
      },
    ],
  },
];

/** One page holding a single asset, against a summary that says 128. */
const PAGE = {
  data: [ASSIGNED_AND_DAMAGED],
  meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

function wireFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/assets/summary')) return respond({ data: SUMMARY });
      if (url.includes('/assets/categories')) return respond({ data: CATEGORIES });
      if (url.includes('/departments/lookups')) {
        return respond({
          data: { departments: [], teams: [], designations: [], locations: [], managers: [] },
        });
      }
      if (url.includes('/assets')) return respond(PAGE);
      return respond({ data: null }, 404);
    }),
  );
}

function renderPage(grants: readonly string[]) {
  permissions = new Set(grants);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AssetsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  wireFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the tiles', () => {
  it('shows the register’s own figures, not a count of the rows on screen', async () => {
    renderPage(HR);

    await waitFor(() => expect(screen.getByText('Total assets')).toBeInTheDocument());

    // One row is served. The tiles must still say 128 / 40 / 71 / 9.
    await waitFor(() => expect(screen.getByText('128')).toBeInTheDocument());
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByText('71')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
  });

  it('shows the four section 10 asks for', async () => {
    renderPage(HR);

    // `getAllBy`, because "Assigned" is also a status badge in the table below
    // - which is the point of the tiles being their own query rather than a
    // count of what happens to be on screen.
    for (const label of ['Total assets', 'Available', 'Assigned', 'Under repair']) {
      await waitFor(() => expect(screen.getAllByText(label).length).toBeGreaterThan(0));
    }
  });
});

describe('the table', () => {
  it('renders a status and a condition as two separate facts', async () => {
    renderPage(HR);

    await waitFor(() => expect(screen.getAllByText('Dell Latitude 5440').length).toBeGreaterThan(0));

    // The pair the data model exists to be able to say.
    expect(screen.getAllByText('Assigned').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Damaged').length).toBeGreaterThan(0);
  });

  it('carries every column section 10 names', async () => {
    renderPage(HR);

    await waitFor(() => expect(screen.getByText('Asset tag')).toBeInTheDocument());

    for (const header of [
      'Asset tag',
      'Asset',
      'Category',
      'Brand / model',
      'Serial number',
      'Employee',
      'Status',
      'Condition',
      'Purchased',
      'Value',
      'Actions',
    ]) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
  });

  it('names the person holding the asset, read from the active assignment', async () => {
    renderPage(HR);

    await waitFor(() => expect(screen.getAllByText('Ahmed Khan').length).toBeGreaterThan(0));
  });

  it('offers the search and the three filters', async () => {
    renderPage(HR);

    await waitFor(() =>
      expect(
        screen.getByLabelText('Search by tag, name, brand, model or serial'),
      ).toBeInTheDocument(),
    );

    expect(screen.getByLabelText('Category')).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
    expect(screen.getByLabelText('Condition')).toBeInTheDocument();
  });
});

describe('what an employee is offered', () => {
  it('shows no way to add an asset', async () => {
    renderPage(EMPLOYEE);

    await waitFor(() => expect(screen.getAllByText('Dell Latitude 5440').length).toBeGreaterThan(0));

    expect(screen.queryByRole('button', { name: 'Add asset' })).not.toBeInTheDocument();
  });

  it('shows no way to edit one', async () => {
    renderPage(EMPLOYEE);

    await waitFor(() => expect(screen.getAllByText('Dell Latitude 5440').length).toBeGreaterThan(0));

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
  });

  /*
   * The register a reader gets is decided by a WHERE clause on the server. A
   * control here that widened it would be a control somebody had to check, and
   * the check already happened somewhere that cannot be edited from a browser.
   */
  it('is offered no control that widens the query', async () => {
    renderPage(EMPLOYEE);

    await waitFor(() => expect(screen.getByText('Total assets')).toBeInTheDocument());

    for (const label of [/show all/i, /everything/i, /whole company/i, /all assets/i]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: label })).not.toBeInTheDocument();
    }
  });
});

describe('what HR is offered', () => {
  it('shows the add and edit controls', async () => {
    renderPage(HR);

    await waitFor(() => expect(screen.getAllByText('Dell Latitude 5440').length).toBeGreaterThan(0));

    expect(screen.getAllByRole('button', { name: 'Add asset' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });
});
