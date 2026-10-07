// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from '@hrms/shared';

/**
 * From the dashboard's My Assets card to one asset.
 *
 * Each row on the card links to the register's own detail page for THAT asset,
 * by its id. The detail page is the same one HR uses; for somebody who does not
 * run the register it shows the asset, their own handovers of it and nothing of
 * the register's business - no cost, no vendor, no repairs, documents or
 * activity. Whether they may see it at all is the server's 404, pinned in
 * assets.routes.test.ts; this file pins what the screens do with the answer.
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

const EMPLOYEE = [...DEFAULT_ROLE_PERMISSIONS.EMPLOYEE];
const HR = [...DEFAULT_ROLE_PERMISSIONS.HR_ADMIN];

const LONG_NAME = 'Core i5 10th Gen, 32GB DDR, 256GB SSD, 1TB HDD, 24" Dell monitor, keyboard and mouse';

function row(overrides: Record<string, unknown>) {
  return {
    assignmentId: 'assign-1',
    assetId: 'asset-pc',
    assetTag: 'DXT-GE-013',
    name: LONG_NAME,
    categoryName: 'Desktop',
    serialNumber: 'SN-PC-1',
    assignedAt: '2026-07-31T05:00:00.000Z',
    returnedAt: null,
    conditionAtAssignment: 'GOOD',
    conditionAtReturn: null,
    accessoriesIssued: [],
    accessoriesMissing: [],
    assignmentStatus: 'ACTIVE',
    assetStatus: 'ASSIGNED',
    acknowledgementStatus: 'ACKNOWLEDGED',
    acknowledgedAt: '2026-08-01T05:00:00.000Z',
    currentValue: null,
    ...overrides,
  };
}

const PC = row({});
const PHONE = row({
  assignmentId: 'assign-2',
  assetId: 'asset-phone',
  assetTag: 'MOB-GE-021',
  name: 'Samsung Mobile',
  serialNumber: 'SN-MOB-9',
  assignedAt: '2026-08-15T05:00:00.000Z',
});

const mine = (...assigned: unknown[]) => ({
  assigned,
  awaitingAcknowledgement: [],
  totalAssigned: assigned.length,
});

/** The detail answer for a narrow reader: no cost, no vendor, no notes. */
function detail(id: string, name: string, tag: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    assetTag: tag,
    name,
    category: { id: 'cat', name: 'Desktop', parentName: 'IT Equipment' },
    brand: 'Dell',
    model: 'OptiPlex 7080',
    serialNumber: `SN-${id}`,
    purchaseDate: '2026-01-15',
    purchasePrice: null,
    currentValue: null,
    vendor: null,
    warrantyStart: '2026-01-15',
    warrantyEnd: '2029-01-15',
    location: 'Desk 14',
    site: { id: 'loc', name: 'Lahore Office' },
    department: null,
    condition: 'GOOD',
    status: 'ASSIGNED',
    notes: null,
    holder: {
      assignmentId: `assign-${id}`,
      employeeId: 'emp-hira',
      employeeNumber: 'EMP-0101',
      fullName: 'Hira Javed',
      departmentName: 'Development',
      assignedAt: '2026-07-31T05:00:00.000Z',
    },
    assignments: [
      {
        id: `assign-${id}`,
        assetId: id,
        employee: { id: 'emp-hira', fullName: 'Hira Javed', employeeNumber: 'EMP-0101' },
        assignedAt: '2026-07-31T05:00:00.000Z',
        returnedAt: null,
        assignedBy: { id: 'u-hr', fullName: 'HR Person' },
        returnedBy: null,
        conditionAtAssignment: 'GOOD',
        conditionAtReturn: null,
        accessoriesIssued: [],
        accessoriesReturned: [],
        accessoriesMissing: [],
        damageDescription: null,
        notes: null,
        returnNotes: null,
        reason: null,
        status: 'ACTIVE',
        acknowledgementStatus: 'ACKNOWLEDGED',
        acknowledgedAt: '2026-08-01T05:00:00.000Z',
        acknowledgedByName: 'Hira Javed',
        createdAt: '2026-07-31T05:00:00.000Z',
      },
    ],
    repairs: [],
    incidents: [],
    retiredOn: null,
    retiredReason: null,
    disposal: null,
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
    createdAt: '2026-01-15T05:00:00.000Z',
    updatedAt: '2026-07-31T05:00:00.000Z',
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Answers by exact path, so `/assets/my` and `/assets/asset-pc` cannot be confused. */
function wireFetch(routes: Record<string, unknown>) {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
    const body = routes[path];
    return Promise.resolve({
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      text: () =>
        Promise.resolve(
          JSON.stringify(
            body !== undefined
              ? { data: body }
              : { error: { code: 'NOT_FOUND', message: 'Asset not found' } },
          ),
        ),
    } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
}

const requested = () =>
  fetchMock.mock.calls.map(([url]) =>
    new URL(String(url), 'http://localhost').pathname.replace('/api/v1', ''),
  );

/** The dashboard and the detail page, as the app routes them. */
function renderApp(grants: readonly string[], path = '/') {
  permissions = new Set(grants);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<MyAssetsCard />} />
          <Route path="/assets/:id" element={<AssetDetailPage />} />
          <Route path="/assets/requests" element={<p>Requests page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('My Assets card: each asset opens its own record', () => {
  it('an employee with one asset can open it', async () => {
    wireFetch({
      '/assets/my': mine(PC),
      '/assets/asset-pc': detail('asset-pc', LONG_NAME, 'DXT-GE-013'),
    });
    renderApp(EMPLOYEE);

    const link = await screen.findByRole('link', { name: /DXT-GE-013/ });
    expect(link).toHaveAttribute('href', '/assets/asset-pc');

    await userEvent.click(link);

    // The full name, untruncated, on the detail page.
    expect(await screen.findByRole('heading', { name: LONG_NAME })).toBeInTheDocument();
    expect(requested()).toContain('/assets/asset-pc');
  });

  it('with several assets, each row opens its own asset and not another', async () => {
    wireFetch({
      '/assets/my': mine(PC, PHONE),
      '/assets/asset-pc': detail('asset-pc', LONG_NAME, 'DXT-GE-013'),
      '/assets/asset-phone': detail('asset-phone', 'Samsung Mobile', 'MOB-GE-021'),
    });
    renderApp(EMPLOYEE);

    const phone = await screen.findByRole('link', { name: /MOB-GE-021/ });
    const pc = screen.getByRole('link', { name: /DXT-GE-013/ });
    expect(pc).toHaveAttribute('href', '/assets/asset-pc');
    expect(phone).toHaveAttribute('href', '/assets/asset-phone');

    await userEvent.click(phone);

    expect(await screen.findByRole('heading', { name: 'Samsung Mobile' })).toBeInTheDocument();
    expect(requested()).toContain('/assets/asset-phone');
    expect(requested()).not.toContain('/assets/asset-pc');
  });

  it('each row reads as clickable, with a way to the details', async () => {
    wireFetch({ '/assets/my': mine(PC) });
    renderApp(EMPLOYEE);

    const link = await screen.findByRole('link', { name: /DXT-GE-013/ });
    expect(within(link).getByText('View details →')).toBeInTheDocument();
    expect(link.className).toMatch(/hover:bg-muted/);
  });

  it('a long name truncates on the card instead of widening it, and keeps its full text', async () => {
    wireFetch({ '/assets/my': mine(PC) });
    renderApp(EMPLOYEE);

    const link = await screen.findByRole('link', { name: /DXT-GE-013/ });
    // The whole name is still there to read on hover and to assistive tech.
    expect(link).toHaveAttribute('title', LONG_NAME);
    const name = within(link).getByText(LONG_NAME);
    // Two lines, then an ellipsis - and breakable, so one long token cannot
    // push the card wider than its column.
    expect(name.className).toContain('line-clamp-2');
    expect(name.className).toContain('break-words');
    // min-w-0 is what lets a flex child shrink below its text and truncate.
    expect(name.parentElement?.className).toContain('min-w-0');
    // The badges sit under the name, not beside it squeezing it.
    expect(within(link).getByText('Confirmed').closest('div')?.previousElementSibling).not.toBe(name);
  });

  it('shows the asset name, tag, status, condition, assigned date and confirmation on each row', async () => {
    wireFetch({ '/assets/my': mine(PC) });
    renderApp(EMPLOYEE);

    const link = await screen.findByRole('link', { name: /DXT-GE-013/ });
    expect(within(link).getByText(LONG_NAME)).toBeInTheDocument();
    expect(within(link).getByText('DXT-GE-013')).toBeInTheDocument();
    expect(within(link).getByText('Assigned')).toBeInTheDocument();
    expect(link).toHaveTextContent(/Assigned (31 Jul 2026|Jul 31, 2026) · Good/);
    expect(within(link).getByText('Confirmed')).toBeInTheDocument();
  });

  it('lists every assigned asset - none hidden - and scrolls inside the card past three', async () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      row({ assignmentId: `assign-${i}`, assetId: `asset-${i}`, assetTag: `TAG-${i}`, name: `Item ${i}` }),
    );
    wireFetch({ '/assets/my': mine(...five) });
    renderApp(EMPLOYEE);

    const list = await screen.findByRole('list', { name: 'Assets assigned to you' });
    for (let i = 0; i < 5; i += 1) {
      expect(within(list).getByRole('link', { name: new RegExp(`TAG-${i}`) })).toHaveAttribute(
        'href',
        `/assets/asset-${i}`,
      );
    }
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toMatch(/max-h-/);
    // The header count is the server's total.
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('a short list does not scroll', async () => {
    wireFetch({ '/assets/my': mine(PC, PHONE) });
    renderApp(EMPLOYEE);

    const list = await screen.findByRole('list', { name: 'Assets assigned to you' });
    expect(list.className).not.toContain('overflow-y-auto');
  });

  it('a handover waiting for confirmation also links to its asset', async () => {
    wireFetch({
      '/assets/my': {
        assigned: [{ ...PC, acknowledgementStatus: 'PENDING', acknowledgedAt: null }],
        awaitingAcknowledgement: [{ ...PC, acknowledgementStatus: 'PENDING', acknowledgedAt: null }],
        totalAssigned: 1,
      },
    });
    renderApp(EMPLOYEE);

    await screen.findByText('You have received a company asset.');
    const links = screen.getAllByRole('link', { name: /View details/ });
    expect(links.every((l) => l.getAttribute('href') === '/assets/asset-pc')).toBe(true);
  });

  it('with no assets says so, with no link to a record, and offers asset requests', async () => {
    wireFetch({ '/assets/my': mine() });
    renderApp(EMPLOYEE);

    expect(await screen.findByText('No assets assigned')).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent('View asset requests →');
    expect(links[0]).toHaveAttribute('href', '/assets/requests');
  });

  it('offers no requests link to somebody who cannot open them', async () => {
    wireFetch({ '/assets/my': mine() });
    renderApp([PERMISSIONS.ASSET_READ]);

    expect(await screen.findByText('No assets assigned')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('the detail page, as the employee holding the asset', () => {
  it('shows the asset and their own history, and none of the register’s business', async () => {
    wireFetch({ '/assets/asset-pc': detail('asset-pc', LONG_NAME, 'DXT-GE-013') });
    renderApp(EMPLOYEE, '/assets/asset-pc');

    expect(await screen.findByRole('heading', { name: LONG_NAME })).toBeInTheDocument();
    for (const label of ['Asset tag', 'Serial number', 'Brand', 'Model', 'Status', 'Condition', 'Warranty', 'Location']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText('Purchase price')).not.toBeInTheDocument();
    expect(screen.queryByText('Current value')).not.toBeInTheDocument();
    expect(screen.queryByText('Vendor')).not.toBeInTheDocument();

    const tabs = within(screen.getByRole('navigation', { name: 'Asset sections' }))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(tabs).toEqual(['Overview', 'Assignment history']);

    // No action is offered: the server said so, and the page follows it.
    for (const action of ['Assign', 'Return', 'Transfer', 'Edit', 'Retire', 'Dispose']) {
      expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole('button', { name: 'Assignment history' }));
    expect(screen.getByText(/Your own handovers of this asset/)).toBeInTheDocument();
    const history = screen.getByRole('table');
    expect(within(history).getAllByRole('row')).toHaveLength(2);
    expect(within(history).getByText('Hira Javed')).toBeInTheDocument();
    expect(within(history).getByText('Still out')).toBeInTheDocument();

    // Opening it asked for the asset and the caller's own list - which is
    // what decides whether Report issue is offered - and nothing the register
    // keeps elsewhere.
    expect([...new Set(requested())].sort()).toEqual(['/assets/asset-pc', '/assets/my']);
  });

  it('only reads: no request it sends could change anything', async () => {
    wireFetch({ '/assets/asset-pc': detail('asset-pc', LONG_NAME, 'DXT-GE-013') });
    renderApp(EMPLOYEE, '/assets/asset-pc');

    await screen.findByRole('heading', { name: LONG_NAME });
    await userEvent.click(screen.getByRole('button', { name: 'Assignment history' }));

    const methods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? 'GET');
    expect(methods.every((m) => m === 'GET')).toBe(true);
  });

  it('a colleague’s asset, reached by editing the URL, shows an error and no record', async () => {
    // The server's answer for an asset this employee does not hold.
    wireFetch({});
    renderApp(EMPLOYEE, '/assets/asset-someone-else');

    await waitFor(() => expect(requested()).toContain('/assets/asset-someone-else'));
    expect(screen.queryByText('Currently assigned to')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Dell|Samsung|Core/ })).not.toBeInTheDocument();
  });

  it('offers the way back to the dashboard when opened from it', async () => {
    wireFetch({
      '/assets/my': mine(PC),
      '/assets/asset-pc': detail('asset-pc', LONG_NAME, 'DXT-GE-013'),
    });
    renderApp(EMPLOYEE);

    await userEvent.click(await screen.findByRole('link', { name: /DXT-GE-013/ }));
    await screen.findByRole('heading', { name: LONG_NAME });

    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/');
  });
});

describe('reporting an issue from the asset itself', () => {
  it('the employee holding it is offered Report issue, which posts against their own handover', async () => {
    wireFetch({
      '/assets/my': mine(PC),
      '/assets/asset-pc': detail('asset-pc', LONG_NAME, 'DXT-GE-013'),
    });
    renderApp(EMPLOYEE, '/assets/asset-pc');

    await userEvent.click(await screen.findByRole('button', { name: 'Report issue' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('DXT-GE-013');
    await userEvent.type(screen.getByLabelText(/What is wrong/), 'Fan is loud');
    await userEvent.click(screen.getByRole('button', { name: 'Report it' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(post).toBeDefined();
      expect(String(post![0])).toContain('/assets/assignments/assign-1/report-issue');
    });
  });

  it('is not offered on an asset the reader does not hold', async () => {
    wireFetch({
      '/assets/my': mine(PHONE),
      '/assets/asset-pc': detail('asset-pc', LONG_NAME, 'DXT-GE-013'),
    });
    renderApp(EMPLOYEE, '/assets/asset-pc');

    await screen.findByRole('heading', { name: LONG_NAME });
    await waitFor(() => expect(requested()).toContain('/assets/my'));
    expect(screen.queryByRole('button', { name: 'Report issue' })).not.toBeInTheDocument();
  });
});

describe('the detail page, for those who run the register', () => {
  it('HR keeps every tab and the cost figures', async () => {
    wireFetch({
      '/assets/asset-pc': detail('asset-pc', LONG_NAME, 'DXT-GE-013', {
        purchasePrice: 250000,
        currentValue: 200000,
        vendor: 'Computer Marketing',
      }),
    });
    renderApp(HR, '/assets/asset-pc');

    await screen.findByRole('heading', { name: LONG_NAME });
    const tabs = within(screen.getByRole('navigation', { name: 'Asset sections' }))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(tabs).toEqual(['Overview', 'Assignment history', 'Repairs', 'Documents', 'Activity']);
    expect(screen.getByText('Purchase price')).toBeInTheDocument();
    expect(screen.getByText('Computer Marketing')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Assets' })).toHaveAttribute('href', '/assets');
  });
});
