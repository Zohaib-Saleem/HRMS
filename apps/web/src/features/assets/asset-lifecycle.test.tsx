// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PERMISSIONS } from '@hrms/shared';

/**
 * The step 2 screens.
 *
 * Four claims are pinned here, and each is one a screen could plausibly get
 * wrong on its own while every endpoint behind it stays correct:
 *
 *   - WHICH ACTIONS APPEAR IS THE SERVER'S ANSWER. The page renders buttons
 *     from `detail.can` and never from the asset's status, so the test serves a
 *     `can` block that deliberately disagrees with what the status would
 *     suggest and expects `can` to win. Two copies of that rule eventually
 *     disagree, and the copy a person sees is the wrong one.
 *   - THE EMPLOYEE IS TOLD, not merely notified. An unacknowledged handover
 *     puts "You have received a company asset" at the top of their dashboard
 *     with the serial, the condition and the accessories - the four things
 *     section 7 names.
 *   - ACKNOWLEDGING SENDS NOTHING ABOUT THE ASSET. The request body carries no
 *     condition, no status and no value, so there is no shape this card can
 *     send that edits the register.
 *   - CLEARANCE COUNTS AND DOES NOT ACT. The tab shows what is outstanding and
 *     offers no control that marks anything returned.
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

import { AssetDetailPage } from './asset-detail-page';
import { MyAssetsCard } from './my-assets-card';
import { EmployeeAssetsTab } from './employee-assets-tab';

const HR = [
  PERMISSIONS.ASSET_READ,
  PERMISSIONS.ASSET_READ_ALL,
  PERMISSIONS.ASSET_CREATE,
  PERMISSIONS.ASSET_UPDATE,
  PERMISSIONS.ASSET_ASSIGN,
  PERMISSIONS.ASSET_RETURN,
  PERMISSIONS.ASSET_TRANSFER,
  PERMISSIONS.ASSET_REPAIR,
  PERMISSIONS.ASSET_RETIRE,
  PERMISSIONS.ASSET_DISPOSE,
];

const EMPLOYEE = [PERMISSIONS.ASSET_READ, PERMISSIONS.ASSET_ACKNOWLEDGE];

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const ACTIVE_ASSIGNMENT = {
  id: 'assign-1',
  assetId: 'asset-1',
  employee: { id: 'emp-ahmed', fullName: 'Ahmed Khan', employeeNumber: 'EMP-0007' },
  assignedAt: '2026-09-15T05:00:00.000Z',
  returnedAt: null,
  assignedBy: null,
  returnedBy: null,
  conditionAtAssignment: 'GOOD',
  conditionAtReturn: null,
  accessoriesIssued: ['Laptop charger', 'Laptop bag'],
  accessoriesReturned: [],
  accessoriesMissing: [],
  damageDescription: null,
  notes: null,
  returnNotes: null,
  reason: null,
  status: 'ACTIVE',
  acknowledgementStatus: 'PENDING',
  acknowledgedAt: null,
  acknowledgedByName: null,
  createdAt: '2026-09-15T05:00:00.000Z',
};

/**
 * `can` deliberately disagrees with the status.
 *
 * The asset says ASSIGNED, which would suggest "no Assign button". The server
 * says assign is allowed and transfer is not. The page must follow the server.
 */
function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset-1',
    assetTag: 'LAP-0021',
    name: 'Dell Latitude 5440',
    category: { id: 'cat-laptop', name: 'Laptop', parentName: 'IT Equipment' },
    brand: 'Dell',
    model: 'Latitude 5440',
    serialNumber: 'ABC123',
    purchaseDate: '2026-01-15',
    purchasePrice: 250000,
    currentValue: 200000,
    vendor: 'Computer Marketing',
    warrantyStart: '2026-01-15',
    warrantyEnd: '2029-01-15',
    location: 'Desk 14',
    site: { id: 'loc-lahore', name: 'Lahore Office' },
    department: { id: 'dept-dev', name: 'Development' },
    condition: 'GOOD',
    status: 'ASSIGNED',
    notes: null,
    holder: {
      assignmentId: 'assign-1',
      employeeId: 'emp-ahmed',
      employeeNumber: 'EMP-0007',
      fullName: 'Ahmed Khan',
      departmentName: 'Development',
      assignedAt: '2026-09-15T05:00:00.000Z',
    },
    assignments: [ACTIVE_ASSIGNMENT],
    repairs: [],
    incidents: [],
    retiredOn: null,
    retiredReason: null,
    disposal: null,
    can: {
      assign: false,
      transfer: true,
      returnToStock: true,
      repair: true,
      markLostOrDamaged: true,
      retire: false,
      dispose: false,
      update: true,
      manageDocuments: true,
    },
    createdAt: '2026-01-15T05:00:00.000Z',
    updatedAt: '2026-09-15T05:00:00.000Z',
    ...overrides,
  };
}

const MY_ASSETS = {
  assigned: [
    {
      assignmentId: 'assign-1',
      assetId: 'asset-1',
      assetTag: 'LAP-0021',
      name: 'Dell Latitude 5440',
      categoryName: 'Laptop',
      serialNumber: 'ABC123',
      assignedAt: '2026-09-15T05:00:00.000Z',
      returnedAt: null,
      conditionAtAssignment: 'GOOD',
      conditionAtReturn: null,
      accessoriesIssued: ['Laptop charger', 'Laptop bag'],
      accessoriesMissing: [],
      assignmentStatus: 'ACTIVE',
      assetStatus: 'ASSIGNED',
      acknowledgementStatus: 'PENDING',
      acknowledgedAt: null,
      currentValue: 200000,
    },
  ],
  get awaitingAcknowledgement() {
    return this.assigned;
  },
  totalAssigned: 1,
};

let fetchMock: ReturnType<typeof vi.fn>;

function wireFetch(routes: Record<string, unknown>) {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    for (const [fragment, body] of Object.entries(routes)) {
      if (url.includes(fragment)) return respond({ data: body });
    }
    return respond({ data: null }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderWith(node: React.ReactNode, grants: readonly string[], path = '/assets/asset-1') {
  permissions = new Set(grants);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/assets/:id" element={<>{node}</>} />
          <Route path="*" element={<>{node}</>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the asset detail page', () => {
  it('shows who has it, prominently', async () => {
    wireFetch({ '/assets/asset-1': detail() });
    renderWith(<AssetDetailPage />, HR);

    await waitFor(() => expect(screen.getByText('Currently assigned to')).toBeInTheDocument());
    expect(screen.getByText('Ahmed Khan')).toBeInTheDocument();
    expect(screen.getByText(/EMP-0007/)).toBeInTheDocument();
    // Locale-agnostic: `assetDate` renders through `toLocaleDateString`, and
    // the test runner's locale decides whether that is "15 Sep 2026" or
    // "Sep 15, 2026". Pinning one would be pinning the runner, not the code.
    expect(screen.getByText(/Assigned\b.*Sep.*2026/)).toBeInTheDocument();
  });

  /*
   * The claim this page turns on. The asset is ASSIGNED, which would suggest
   * an Assign button to anybody reasoning from the status - and the server
   * says otherwise, so there is none.
   */
  it('offers exactly the actions the server allows, not the ones the status suggests', async () => {
    wireFetch({ '/assets/asset-1': detail() });
    renderWith(<AssetDetailPage />, HR);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Return' })).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Transfer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send for repair' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Damaged' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lost' })).toBeInTheDocument();

    // `can.assign`, `can.retire` and `can.dispose` are all false.
    expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retire' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dispose' })).not.toBeInTheDocument();
  });

  it('offers a narrow reader no actions at all', async () => {
    wireFetch({
      '/assets/asset-1': detail({
        can: {
          assign: false,
          transfer: false,
          returnToStock: false,
          repair: false,
          markLostOrDamaged: false,
          retire: false,
          dispose: false,
          update: false,
          manageDocuments: false,
        },
      }),
    });
    renderWith(<AssetDetailPage />, EMPLOYEE);

    await waitFor(() => expect(screen.getByText('Currently assigned to')).toBeInTheDocument());

    for (const label of ['Assign', 'Return', 'Transfer', 'Send for repair', 'Edit', 'Dispose']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('carries every field section 1 asks for on the overview', async () => {
    wireFetch({ '/assets/asset-1': detail() });
    renderWith(<AssetDetailPage />, HR);

    await waitFor(() => expect(screen.getByText('Asset tag')).toBeInTheDocument());

    for (const label of [
      'Asset tag',
      'Asset name',
      'Category',
      'Brand',
      'Model',
      'Serial number',
      'Status',
      'Condition',
      'Purchase date',
      'Purchase price',
      'Current value',
      'Vendor',
      'Warranty',
      'Location',
      'Department',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('has the five sections section 12 asks for', async () => {
    wireFetch({ '/assets/asset-1': detail() });
    renderWith(<AssetDetailPage />, HR);

    await waitFor(() => expect(screen.getByText('Overview')).toBeInTheDocument());

    for (const tab of ['Overview', 'Assignment history', 'Repairs', 'Documents', 'Activity']) {
      expect(screen.getByRole('button', { name: tab })).toBeInTheDocument();
    }
  });

  it('shows the handover history, including what went missing', async () => {
    wireFetch({
      '/assets/asset-1': detail({
        assignments: [
          {
            ...ACTIVE_ASSIGNMENT,
            id: 'assign-0',
            status: 'RETURNED',
            returnedAt: '2026-09-10T05:00:00.000Z',
            conditionAtReturn: 'FAIR',
            accessoriesReturned: ['Laptop charger'],
            accessoriesMissing: ['Laptop bag'],
          },
        ],
      }),
    });
    renderWith(<AssetDetailPage />, HR);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Assignment history' })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Assignment history' }));

    expect(screen.getByText(/Missing: Laptop bag/)).toBeInTheDocument();
  });
});

describe('the employee’s own card', () => {
  it('tells them they have received a company asset, with the four facts', async () => {
    wireFetch({ '/assets/my': MY_ASSETS });
    renderWith(<MyAssetsCard />, EMPLOYEE, '/');

    await waitFor(() =>
      expect(screen.getByText('You have received a company asset.')).toBeInTheDocument(),
    );

    expect(screen.getByText(/Dell Latitude 5440 \(LAP-0021\)/)).toBeInTheDocument();
    expect(screen.getByText(/Serial: ABC123/)).toBeInTheDocument();
    expect(screen.getByText(/Condition: Good/)).toBeInTheDocument();
    expect(screen.getByText(/Accessories: Laptop charger, Laptop bag/)).toBeInTheDocument();
    expect(screen.getByText(/Assigned:.*Sep.*2026/)).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report issue' })).toBeInTheDocument();
  });

  /*
   * The request body is the assertion. An employee acknowledging a laptop must
   * not be able to send a condition, a status or a value along with it.
   */
  it('acknowledges by sending nothing about the asset', async () => {
    wireFetch({ '/assets/my': MY_ASSETS, '/acknowledge': { ok: true } });
    renderWith(<MyAssetsCard />, EMPLOYEE, '/');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/assignments/assign-1/acknowledge'),
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body ?? '{}'))).toEqual({});
    });
  });

  it('renders itself away for somebody with no asset grant', () => {
    wireFetch({ '/assets/my': MY_ASSETS });
    const { container } = renderWith(<MyAssetsCard />, [], '/');

    expect(container).toBeEmptyDOMElement();
  });

  it('shows no acknowledgement buttons without the acknowledge grant', async () => {
    wireFetch({ '/assets/my': MY_ASSETS });
    renderWith(<MyAssetsCard />, [PERMISSIONS.ASSET_READ], '/');

    await waitFor(() =>
      expect(screen.getByText('You have received a company asset.')).toBeInTheDocument(),
    );

    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Report issue' })).not.toBeInTheDocument();
  });
});

describe('the employee assets tab', () => {
  const EMPLOYEE_ASSETS = {
    employeeId: 'emp-ahmed',
    assigned: MY_ASSETS.assigned,
    history: [],
    totalAssigned: 1,
    totalCurrentValue: 200000,
    clearance: {
      applies: true,
      assigned: 2,
      returned: 1,
      pending: 1,
      damaged: 0,
      lost: 0,
      cleared: false,
    },
  };

  it('shows the totals and the clearance block for somebody leaving', async () => {
    wireFetch({ '/employees/emp-ahmed/assets': EMPLOYEE_ASSETS });
    renderWith(<EmployeeAssetsTab employeeId="emp-ahmed" />, HR, '/');

    await waitFor(() => expect(screen.getByText('Assets assigned')).toBeInTheDocument());

    expect(screen.getByText('Current asset value')).toBeInTheDocument();
    expect(screen.getByText('Asset clearance')).toBeInTheDocument();
    expect(screen.getByText(/Dell Latitude 5440 \(LAP-0021\) pending/)).toBeInTheDocument();
  });

  /*
   * Section 11's explicit instruction, pinned on the screen as well as on the
   * endpoint: a clearance view that could tick its own boxes would be a view
   * that says the laptop came back when it did not.
   */
  it('offers no way to mark anything returned', async () => {
    wireFetch({ '/employees/emp-ahmed/assets': EMPLOYEE_ASSETS });
    renderWith(<EmployeeAssetsTab employeeId="emp-ahmed" />, HR, '/');

    await waitFor(() => expect(screen.getByText('Asset clearance')).toBeInTheDocument());

    for (const label of [/mark returned/i, /returned/i, /clear/i]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
    expect(
      screen.getByText(/HR records each return from the asset itself/),
    ).toBeInTheDocument();
  });

  it('hides the clearance block for somebody who is staying', async () => {
    wireFetch({
      '/employees/emp-ahmed/assets': {
        ...EMPLOYEE_ASSETS,
        clearance: { ...EMPLOYEE_ASSETS.clearance, applies: false },
      },
    });
    renderWith(<EmployeeAssetsTab employeeId="emp-ahmed" />, HR, '/');

    await waitFor(() => expect(screen.getByText('Assigned assets')).toBeInTheDocument());
    expect(screen.queryByText('Asset clearance')).not.toBeInTheDocument();
  });
});
