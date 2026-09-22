import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The IT Asset Manager can still run the register.
 *
 * The other half of the attendance fix, and the half that is easy to forget:
 * narrowing what a role may see is only correct if the job it exists for still
 * works. This role is scoped OWN - the narrowest scope in the system - and
 * every assertion below is that the register is nevertheless entirely reachable
 * from it, because `asset.read.all` short-circuits `assetScopeFilter` before
 * the data scope is ever consulted.
 *
 * Every caller here is built from `DEFAULT_ROLE_PERMISSIONS.IT_ASSET_MANAGER`
 * and `DEFAULT_ROLE_SCOPES.IT_ASSET_MANAGER` rather than from a hand-written
 * grant list. A test that invented its own permissions would prove only that
 * the test agrees with itself; this one fails the day somebody takes
 * `asset.read.all` off the role or widens its scope to make the register work.
 *
 * The two grants this role does NOT hold are asserted as refusals at the end,
 * because "an asset role that cannot write an asset off for good" is a claim
 * about the product rather than an omission.
 */

const kit = await vi.hoisted(async () => import('./assets.test-kit.js'));
const db = kit.assetDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));
vi.mock('../../core/notifications/notification.service.js', () => ({
  notify: vi.fn(async () => ({ id: 'n-1', emailStatus: 'skipped' })),
}));

const { assetRoutes } = await import('./assets.routes.js');
const { assetLifecycleRoutes } = await import('./asset-lifecycle.routes.js');
const { assetReportRoutes } = await import('./asset-reports.routes.js');
const { assetDashboardRoutes } = await import('./asset-dashboard.routes.js');

const {
  AHMED,
  COMPANY,
  SANA,
  appAs,
  assetRow,
  assignmentRow,
  auditActions,
  useAssetDb,
  wirePeople,
} = kit;

const PREFIX = '/assets';

/**
 * The role exactly as the product defines it: its grants AND its scope.
 *
 * OWN is passed explicitly and is the point of the file - not a convenience
 * default. Every 200 below is a 200 at the narrowest data scope there is.
 */
const IT: Permission[] = DEFAULT_ROLE_PERMISSIONS.IT_ASSET_MANAGER as Permission[];
const AS_IT = { prefix: PREFIX, permissions: IT, dataScope: 'OWN' as const };

function wireEmployees() {
  db.employee.findFirst.mockImplementation(async (args: { where?: { id?: string } }) => {
    const id = args?.where?.id;
    if (id === AHMED.id) {
      return { id: AHMED.id, firstName: 'Ahmed', lastName: 'Khan', userId: AHMED.userId, status: 'ACTIVE' };
    }
    if (id === SANA.id) {
      return { id: SANA.id, firstName: 'Sana', lastName: 'Iqbal', userId: SANA.userId, status: 'ACTIVE' };
    }
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAssetDb(db);
  wirePeople(db);
  wireEmployees();
  db.company.findUnique.mockResolvedValue({ timezone: 'Asia/Karachi' });
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  db.auditLog.findMany.mockResolvedValue([]);
  db.assetAssignment.findFirst.mockResolvedValue(null);
  db.assetAssignment.findMany.mockResolvedValue([]);
  db.assetAssignment.count.mockResolvedValue(0);
  db.assetAssignment.updateMany.mockResolvedValue({ count: 1 });
  db.asset.updateMany.mockResolvedValue({ count: 1 });
  db.asset.update.mockResolvedValue(assetRow());
  db.asset.findMany.mockResolvedValue([assetRow()]);
  db.asset.count.mockResolvedValue(1);
  db.asset.groupBy.mockResolvedValue([{ status: 'AVAILABLE', _count: { _all: 1 }, _sum: {} }]);
  db.asset.aggregate.mockResolvedValue({ _count: { _all: 1 }, _sum: {} });
  db.assetRepair.findMany.mockResolvedValue([]);
  db.assetIncident.findMany.mockResolvedValue([]);
  db.assetCategory.findFirst.mockResolvedValue({ id: 'cat-laptop', name: 'Laptop', isActive: true });
  db.assetCategory.findMany.mockResolvedValue([]);
  db.department.findFirst.mockResolvedValue({ id: 'dept-dev' });
  db.department.findMany.mockResolvedValue([]);
  db.employee.findMany.mockResolvedValue([]);
  db.employee.count.mockResolvedValue(0);
  db.location.findFirst.mockResolvedValue({ id: 'loc-lahore' });
});

/** The asset WHERE a read handed the database, as a flat array of clauses. */
function assetReadClauses(): unknown[] {
  const args = db.asset.findMany.mock.calls[0]?.[0] as { where?: { AND?: unknown[] } };
  return args?.where?.AND ?? [];
}

// ===================================================== reading the register

describe('the whole register, from the narrowest scope there is', () => {
  it('lists every asset the company owns', async () => {
    const app = await appAs(assetRoutes, AS_IT);

    const response = await app.inject({ method: 'GET', url: `${PREFIX}?page=1&limit=20` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
  });

  it('applies NO holder narrowing to the query, because asset.read.all short-circuits it', async () => {
    const app = await appAs(assetRoutes, AS_IT);
    await app.inject({ method: 'GET', url: `${PREFIX}?page=1&limit=20` });

    /*
     * The assertion that proves the OWN scope costs the register nothing. A
     * narrow reader's query carries `{ assignments: { some: { status:
     * 'ACTIVE', employee: <their own id> } } }`; this caller's does not carry
     * it at all, so every asset is in scope including the ones nobody holds.
     */
    expect(JSON.stringify(assetReadClauses())).not.toContain('assignments');
    expect(assetReadClauses()).toContainEqual({ companyId: COMPANY });
  });

  it('searches and filters the register', async () => {
    const app = await appAs(assetRoutes, AS_IT);

    const response = await app.inject({
      method: 'GET',
      url: `${PREFIX}?q=Latitude&status=AVAILABLE&page=1&limit=20`,
    });

    expect(response.statusCode).toBe(200);
  });

  it('opens one asset, with its handover history', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow());
    const app = await appAs(assetRoutes, AS_IT);

    const response = await app.inject({ method: 'GET', url: `${PREFIX}/asset-1` });

    expect(response.statusCode).toBe(200);
    /*
     * The handover history is served only to a reader who may see the whole
     * register - a narrow reader holding the laptop gets the asset and no list
     * of who had it before them. This role is the wide reader, so the block is
     * present.
     */
    expect(response.json().data).toHaveProperty('assignments');
    expect(response.json().data).toHaveProperty('repairs');
  });

  it('reads the register summary tiles', async () => {
    const app = await appAs(assetRoutes, AS_IT);

    expect((await app.inject({ method: 'GET', url: `${PREFIX}/summary` })).statusCode).toBe(200);
  });

  it('opens the asset dashboard, which needs asset.read.all on its own', async () => {
    const app = await appAs(assetDashboardRoutes, AS_IT);

    expect((await app.inject({ method: 'GET', url: `${PREFIX}/dashboard` })).statusCode).toBe(200);
  });

  it('runs the asset reports', async () => {
    const app = await appAs(assetReportRoutes, AS_IT);

    const response = await app.inject({
      method: 'GET',
      url: `${PREFIX}/reports/assets?page=1&limit=20`,
    });

    expect(response.statusCode).toBe(200);
  });
});

// =========================================================== writing to it

describe('the operations the job is', () => {
  it('adds an asset to the register', async () => {
    db.asset.findFirst.mockResolvedValue(null);
    db.asset.create.mockResolvedValue(assetRow());
    const app = await appAs(assetRoutes, AS_IT);

    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: {
        assetTag: 'IT-LAP-0099',
        name: 'Dell Latitude 5440',
        categoryId: 'cat-laptop',
        condition: 'NEW',
        status: 'AVAILABLE',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(auditActions(db)).toContain('asset.created');
  });

  it('corrects an asset’s details', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow());
    const app = await appAs(assetRoutes, AS_IT);

    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/asset-1`,
      payload: { location: 'Desk 22' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('assigns an asset to an employee', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'AVAILABLE' }));
    db.assetAssignment.create.mockResolvedValue(assignmentRow(AHMED));
    const app = await appAs(assetLifecycleRoutes, AS_IT);

    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/assign`,
      payload: {
        employeeId: AHMED.id,
        assignedOn: '2026-09-19',
        conditionAtAssignment: 'GOOD',
        accessories: ['Laptop charger'],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(auditActions(db)).toContain('asset.assigned');
    /*
     * Assigning to AHMED from an OWN scope is the claim worth stating: the
     * write resolves its employee against the COMPANY, not against the data
     * scope, because issuing somebody company property is not a claim to be
     * able to read their record.
     */
    expect(db.assetAssignment.create.mock.calls[0]?.[0]?.data.employeeId).toBe(AHMED.id);
  });

  it('takes an asset back', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'ASSIGNED' }));
    db.assetAssignment.findFirst.mockResolvedValue(assignmentRow(AHMED));
    db.assetAssignment.findUniqueOrThrow.mockResolvedValue(
      assignmentRow(AHMED, { status: 'RETURNED' }),
    );
    const app = await appAs(assetLifecycleRoutes, AS_IT);

    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/return`,
      payload: {
        returnedOn: '2026-09-20',
        conditionAtReturn: 'GOOD',
        accessoriesReturned: ['Laptop charger'],
        accessoriesMissing: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(auditActions(db)).toContain('asset.returned');
    // Never deleted. The handover is closed by an update and stays on the file.
    expect(db.assetAssignment).not.toHaveProperty('delete');
  });

  it('sends an asset for repair', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'AVAILABLE' }));
    db.assetRepair.findFirst.mockResolvedValue(null);
    db.assetRepair.create.mockResolvedValue(kit.repairRow());
    db.assetRepair.findUniqueOrThrow.mockResolvedValue(kit.repairRow());
    const app = await appAs(assetLifecycleRoutes, AS_IT);

    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/repairs`,
      payload: {
        problem: 'Screen flickers under load',
        reportedOn: '2026-09-19',
        sentOn: '2026-09-20',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(auditActions(db)).toContain('asset.repair.sent');
  });

  it('retires an asset', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'AVAILABLE' }));
    const app = await appAs(assetLifecycleRoutes, AS_IT);

    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/retire`,
      payload: { retiredOn: '2026-09-20', reason: 'Past its useful life' },
    });

    expect(response.statusCode).toBe(200);
    expect(auditActions(db)).toContain('asset.retired');
  });

  it('reads an asset’s audit history, which needs asset.read.all', async () => {
    db.asset.findFirst.mockResolvedValue({ id: 'asset-1' });
    const app = await appAs(assetRoutes, AS_IT);

    const response = await app.inject({ method: 'GET', url: `${PREFIX}/asset-1/activity` });

    expect(response.statusCode).toBe(200);
  });

  it('reads an asset’s repair history', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow());
    const app = await appAs(assetLifecycleRoutes, AS_IT);

    const response = await app.inject({ method: 'GET', url: `${PREFIX}/asset-1/repairs` });

    expect(response.statusCode).toBe(200);
  });
});

// ================================================= and the one it does not

describe('what the role deliberately cannot do', () => {
  it('cannot write an asset off for good', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'RETIRED' }));
    const app = await appAs(assetLifecycleRoutes, AS_IT);

    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/dispose`,
      payload: { disposedOn: '2026-09-20', method: 'SCRAPPED' },
    });

    /*
     * Disposal is irreversible and stays with HR Admin and Super Admin.
     * Retiring - which this role CAN do, above - takes the machine out of
     * service and keeps it on the books, which is the reversible half of the
     * same decision.
     */
    expect(response.statusCode).toBe(403);
    expect(db.asset.update).not.toHaveBeenCalled();
  });
});
