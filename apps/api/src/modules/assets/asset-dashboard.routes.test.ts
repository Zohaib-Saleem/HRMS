import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The asset dashboard.
 *
 * Four claims, and each one is a way the screen could lie rather than merely
 * be wrong:
 *
 *   - it is gated on `asset.read.ALL`. A narrow reader must be refused outright
 *     rather than served a dashboard of one laptop that reads as the company's
 *     entire register;
 *   - the parts sum to the whole. Assets filed under no category and no
 *     department keep their bucket, because a slice list that quietly drops
 *     them adds up to less than the total printed above it;
 *   - the warranty window is the COMPANY's calendar and it excludes the assets
 *     that are out of service. A disposed laptop's expiring cover is not
 *     anybody's problem, and a list that says it is trains people to ignore
 *     the list;
 *   - the three status alerts are the status counts. Not a second query that
 *     could disagree with the tiles above them.
 */

const kit = await vi.hoisted(async () => import('./assets.test-kit.js'));
const db = kit.assetDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { assetDashboardRoutes } = await import('./asset-dashboard.routes.js');
const { COMPANY, EMPLOYEE, HR, MANAGER, appAs, wirePeople } = kit;

const PREFIX = '/assets';

/** A grouped row as `groupBy` returns it. */
function group(key: string | null, field: 'status' | 'categoryId' | 'departmentId', count: number, purchase = 0, current = 0) {
  return {
    [field]: key,
    _count: { _all: count },
    _sum: { purchasePrice: purchase, currentValue: current },
  };
}

/** An asset as an alert row reads it. */
function alertAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset-1',
    assetTag: 'IT-LAP-0042',
    name: 'Dell Latitude 5440',
    status: 'ASSIGNED',
    warrantyEnd: new Date('2026-10-05T00:00:00.000Z'),
    category: { name: 'Laptop' },
    assignments: [],
    ...overrides,
  };
}

/** Everything the dashboard asks for, answered with nothing. */
function wireEmpty() {
  db.asset.groupBy.mockResolvedValue([]);
  db.assetCategory.findMany.mockResolvedValue([]);
  db.department.findMany.mockResolvedValue([]);
  db.asset.count.mockResolvedValue(0);
  db.asset.findMany.mockResolvedValue([]);
  db.employee.count.mockResolvedValue(0);
  db.employee.findMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  wirePeople(db);
  wireEmpty();
});

async function dashboard(permissions = HR, query = '') {
  const app = await appAs(assetDashboardRoutes, { prefix: PREFIX, permissions, dataScope: 'ALL' });
  return app.inject({ method: 'GET', url: `${PREFIX}/dashboard${query}` });
}

describe('who may open it', () => {
  it('refuses a reader who holds asset.read but not asset.read.all', async () => {
    const response = await dashboard(MANAGER);

    expect(response.statusCode).toBe(403);
    // And nothing was read on the way to the refusal.
    expect(db.asset.groupBy).not.toHaveBeenCalled();
  });

  it('refuses an employee holding the widest employee-facing grants', async () => {
    const response = await dashboard(EMPLOYEE);

    expect(response.statusCode).toBe(403);
  });

  it('serves HR, who holds the register grant', async () => {
    const response = await dashboard();

    expect(response.statusCode).toBe(200);
  });
});

describe('the figures', () => {
  it('sums the counts and both money columns from ONE grouped query', async () => {
    db.asset.groupBy.mockImplementation(async (args: { by: string[] }) => {
      if (args.by[0] === 'status') {
        return [group('AVAILABLE', 'status', 3, 300, 240), group('ASSIGNED', 'status', 2, 500, 400)];
      }
      return [];
    });

    const response = await dashboard();
    const data = response.json().data;

    expect(data.total).toBe(5);
    expect(data.byStatus.AVAILABLE).toBe(3);
    expect(data.byStatus.ASSIGNED).toBe(2);
    // A status nobody's assets are in is zero, not absent: the browser reads
    // this as a complete record and would otherwise render `undefined`.
    expect(data.byStatus.LOST).toBe(0);
    expect(data.totalPurchaseValue).toBe(800);
    expect(data.totalCurrentValue).toBe(640);
  });

  it('keeps the unfiled bucket, and puts it last', async () => {
    db.asset.groupBy.mockImplementation(async (args: { by: string[] }) => {
      if (args.by[0] === 'categoryId') {
        return [group(null, 'categoryId', 9, 90, 90), group('cat-laptop', 'categoryId', 4, 40, 40)];
      }
      return [];
    });
    db.assetCategory.findMany.mockResolvedValue([
      { id: 'cat-laptop', name: 'Laptop', parent: { name: 'IT Equipment' } },
    ]);

    const data = (await dashboard()).json().data;

    expect(data.byCategory.map((slice: { key: string | null }) => slice.key)).toEqual([
      'cat-laptop',
      null,
    ]);
    // The group reads with its parent, the same label the register's filter
    // offers - "Laptop" alone is ambiguous the moment a second group has one.
    expect(data.byCategory[0].label).toBe('IT Equipment › Laptop');
    expect(data.byCategory[1].label).toBe('Uncategorised');
    // And the parts still sum to the whole, which is the point of keeping it.
    expect(data.byCategory.reduce((total: number, slice: { count: number }) => total + slice.count, 0)).toBe(13);
  });

  it('labels an asset booked to no department rather than dropping it', async () => {
    db.asset.groupBy.mockImplementation(async (args: { by: string[] }) =>
      args.by[0] === 'departmentId' ? [group(null, 'departmentId', 2, 20, 10)] : [],
    );

    const data = (await dashboard()).json().data;

    expect(data.byDepartment).toEqual([
      { key: null, label: 'No department', count: 2, purchaseValue: 20, currentValue: 10 },
    ]);
  });
});

describe('the alerts', () => {
  it('asks for warranties inside the window and skips what is out of service', async () => {
    await dashboard(HR, '?warrantyDays=45');

    const where = db.asset.count.mock.calls[0]?.[0]?.where;
    expect(where.companyId).toBe(COMPANY);
    expect(where.status).toEqual({ notIn: ['RETIRED', 'DISPOSED'] });
    // 45 days from today, not 30 - the window is what the caller asked for and
    // it is echoed back so the screen can say what it is showing.
    expect(where.warrantyEnd.gte).toBeInstanceOf(Date);
    expect(where.warrantyEnd.lte).toBeInstanceOf(Date);

    const days = Math.round(
      (where.warrantyEnd.lte.getTime() - where.warrantyEnd.gte.getTime()) / 86_400_000,
    );
    expect(days).toBe(45);
  });

  it('echoes the window back with the day it was computed against', async () => {
    const data = (await dashboard(HR, '?warrantyDays=45')).json().data;

    expect(data.warrantyDays).toBe(45);
    expect(data.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('counts every match and carries a capped shortlist of rows', async () => {
    db.asset.count.mockResolvedValue(412);
    db.asset.findMany.mockResolvedValue([alertAsset()]);

    const data = (await dashboard()).json().data;

    // The count tells the truth about the size of the problem; the rows are
    // the shortlist somebody acts on this morning.
    expect(data.alerts.warrantyExpiring).toBe(412);
    expect(data.alerts.warrantyExpiringRows).toHaveLength(1);
    expect(db.asset.findMany.mock.calls[0]?.[0]?.take).toBe(50);
  });

  it('reads under repair, lost and damaged off the status counts', async () => {
    db.asset.groupBy.mockImplementation(async (args: { by: string[] }) =>
      args.by[0] === 'status'
        ? [
            group('UNDER_REPAIR', 'status', 2),
            group('LOST', 'status', 1),
            group('DAMAGED', 'status', 3),
          ]
        : [],
    );

    const data = (await dashboard()).json().data;

    expect(data.alerts.underRepair).toBe(2);
    expect(data.alerts.lost).toBe(1);
    expect(data.alerts.damaged).toBe(3);
    // The same numbers the tiles show. Not a second query that could disagree.
    expect(data.byStatus.UNDER_REPAIR).toBe(2);
    expect(data.byStatus.LOST).toBe(1);
    expect(data.byStatus.DAMAGED).toBe(3);
  });

  it('names the holder and the days on an asset still out with a leaver', async () => {
    db.asset.findMany.mockImplementation(async (args: { where: { assignments?: unknown } }) =>
      args.where.assignments
        ? [
            alertAsset({
              assignments: [
                {
                  assignedAt: new Date('2026-09-09T09:00:00.000Z'),
                  employee: { id: 'emp-ahmed', firstName: 'Ahmed', lastName: 'Khan' },
                },
              ],
            }),
          ]
        : [],
    );

    const data = (await dashboard()).json().data;
    const row = data.alerts.notReturnedRows[0];

    expect(row.holderName).toBe('Ahmed Khan');
    expect(row.holderEmployeeId).toBe('emp-ahmed');
    expect(row.date).toBe('2026-09-09');
    // Negative: the date is behind us. Measured against the company's today.
    expect(row.days).toBeLessThan(0);
  });

  it('asks only for handovers still out with somebody who has left', async () => {
    await dashboard();

    const stillOut = db.asset.count.mock.calls
      .map((call) => call[0]?.where)
      .find((where) => where?.assignments);

    expect(stillOut.assignments.some).toEqual({
      status: 'ACTIVE',
      employee: { status: { in: ['RESIGNED', 'TERMINATED'] } },
    });
  });

  it('reports a leaver who has handed back some of it as partially cleared', async () => {
    db.employee.count.mockResolvedValue(1);
    db.employee.findMany.mockResolvedValue([
      {
        id: 'emp-sana',
        employeeNumber: 'EMP-0011',
        firstName: 'Sana',
        lastName: 'Iqbal',
        status: 'RESIGNED',
        department: { name: 'Development' },
        assetAssignments: [{ status: 'ACTIVE' }, { status: 'RETURNED' }, { status: 'RETURNED' }],
      },
    ]);

    const data = (await dashboard()).json().data;

    expect(data.alerts.employeesPendingClearance).toBe(1);
    expect(data.alerts.pendingClearanceRows[0]).toMatchObject({
      employeeId: 'emp-sana',
      fullName: 'Sana Iqbal',
      departmentName: 'Development',
      employmentStatus: 'RESIGNED',
      pending: 1,
      returned: 2,
      // Not PENDING: HR is waiting on one thing, not on everything, and a
      // two-valued flag cannot tell those apart.
      state: 'PARTIALLY_CLEARED',
    });
  });

  it('asks only for leavers who are still holding something', async () => {
    await dashboard();

    const where = db.employee.count.mock.calls[0]?.[0]?.where;
    expect(where).toEqual({
      companyId: COMPANY,
      status: { in: ['RESIGNED', 'TERMINATED'] },
      assetAssignments: { some: { status: 'ACTIVE' } },
    });
  });
});

describe('an empty register', () => {
  it('answers with zeroes rather than with nulls', async () => {
    const data = (await dashboard()).json().data;

    expect(data.total).toBe(0);
    expect(data.totalPurchaseValue).toBe(0);
    expect(data.byCategory).toEqual([]);
    expect(data.alerts.warrantyExpiringRows).toEqual([]);
    expect(data.alerts.pendingClearanceRows).toEqual([]);
  });
});
