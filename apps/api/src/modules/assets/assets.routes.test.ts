import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The asset register.
 *
 * What is pinned here is the gap between the two read grants and the wall
 * around the write ones, because those are the whole design of the plugin:
 *
 *   - `asset.read` ALONE returns the assets currently out with the people the
 *     caller's data scope reaches. The narrowing is a WHERE clause, so the test
 *     asserts the CLAUSE rather than the response - a filter applied after the
 *     query would pass a test that counted rows and would still have fetched
 *     the whole register;
 *   - a caller with no employee record is out with nobody, and the route must
 *     not read that as "no filter". The expensive version of this bug hands
 *     every asset in the company to a login that is not linked to anybody;
 *   - every write needs its own grant, and an employee holding the widest
 *     employee-facing permissions in the product is refused all of them;
 *   - the validation section 9 asks for is enforced server-side and answers 422
 *     with a FIELD error, not a 500 from a constraint;
 *   - ASSIGNED and RETURNED cannot be typed into the edit form. An asset
 *     becomes assigned by being assigned to somebody, which writes the row that
 *     says whose desk it is on.
 */

const kit = await vi.hoisted(async () => import('./assets.test-kit.js'));
const db = kit.assetDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { assetRoutes } = await import('./assets.routes.js');
const {
  AHMED,
  COMPANY,
  EMPLOYEE,
  HR,
  MANAGER,
  activeAssignment,
  andClauses,
  appAs,
  assetRow,
  auditActions,
  wirePeople,
} = kit;

const PREFIX = '/assets';

/** A payload that passes every rule, so a test can break exactly one of them. */
function validAsset(overrides: Record<string, unknown> = {}) {
  return {
    assetTag: 'IT-LAP-0099',
    name: 'ThinkPad T14',
    categoryId: 'cat-laptop',
    serialNumber: 'SN-XYZ-999',
    purchasePrice: 250000,
    currentValue: 200000,
    ...overrides,
  };
}

/** Wires the reference checks a create performs before it writes. */
function wireReferences(options: { categoryActive?: boolean } = {}) {
  db.assetCategory.findFirst.mockResolvedValue({
    id: 'cat-laptop',
    isActive: options.categoryActive ?? true,
  });
  db.department.findFirst.mockResolvedValue({ id: 'dept-dev' });
  db.location.findFirst.mockResolvedValue({ id: 'loc-lahore' });
}

beforeEach(() => {
  vi.clearAllMocks();
  wirePeople(db);
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  db.asset.findFirst.mockResolvedValue(null);
  db.assetAssignment.findMany.mockResolvedValue([]);
  // Step 2 put the repairs and the incidents on the detail response. Wired to
  // empty here so this file keeps asserting what it was written to assert.
  db.assetRepair.findMany.mockResolvedValue([]);
  db.assetIncident.findMany.mockResolvedValue([]);
});

describe('who sees which assets', () => {
  it('narrows a reader without asset.read.all to the assets their people hold', async () => {
    db.asset.count.mockResolvedValue(1);
    db.asset.findMany.mockResolvedValue([assetRow()]);

    const app = await appAs(assetRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE,
      userId: AHMED.userId,
      dataScope: 'OWN',
    });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.statusCode).toBe(200);

    const where = db.asset.findMany.mock.calls[0]?.[0]?.where;
    expect(andClauses(where)).toContainEqual({
      assignments: { some: { status: 'ACTIVE', employee: { id: AHMED.id } } },
    });
  });

  it('widens a manager to their reports without handing them the stock room', async () => {
    db.asset.count.mockResolvedValue(0);
    db.asset.findMany.mockResolvedValue([]);

    const app = await appAs(assetRoutes, {
      prefix: PREFIX,
      permissions: MANAGER,
      userId: AHMED.userId,
      dataScope: 'REPORTS_AND_OWN',
    });
    await app.inject({ method: 'GET', url: PREFIX });

    const where = db.asset.findMany.mock.calls[0]?.[0]?.where;
    const narrowing = andClauses(where).filter((clause) => 'assignments' in (clause as object));

    // Still an assignment clause: an asset nobody is holding is nobody's, so a
    // wider data scope reaches more PEOPLE and never the unassigned stock.
    expect(narrowing).toHaveLength(1);
    expect(narrowing[0]).toEqual({
      assignments: {
        some: {
          status: 'ACTIVE',
          employee: {
            OR: [{ id: AHMED.id }, { managerId: AHMED.id }, { secondaryManagerId: AHMED.id }],
          },
        },
      },
    });
  });

  it('applies no such clause for HR, who runs the register', async () => {
    db.asset.count.mockResolvedValue(1);
    db.asset.findMany.mockResolvedValue([assetRow()]);

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    await app.inject({ method: 'GET', url: PREFIX });

    const where = db.asset.findMany.mock.calls[0]?.[0]?.where;
    const narrowing = andClauses(where).filter((clause) => 'assignments' in (clause as object));
    expect(narrowing).toHaveLength(0);
  });

  /*
   * The one that would be expensive to get wrong. `assetScopeFilter` returns
   * null for "no rows", and a caller who read that as "no filter" would hand
   * every asset in the company to a login that is not linked to anybody.
   */
  it('returns nothing, and asks nothing, for a login with no employee record', async () => {
    const app = await appAs(assetRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE,
      userId: 'user-ghost',
      dataScope: 'OWN',
    });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
    expect(response.json().meta.total).toBe(0);
    expect(db.asset.findMany).not.toHaveBeenCalled();
    expect(db.asset.count).not.toHaveBeenCalled();
  });

  it('answers 404, not 403, for an asset outside the caller’s own', async () => {
    db.asset.findFirst.mockResolvedValue(null);

    const app = await appAs(assetRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE,
      userId: AHMED.userId,
      dataScope: 'OWN',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/asset-9` });

    // A guessed id must not confirm that the company owns something.
    expect(response.statusCode).toBe(404);
  });

  /*
   * Section 12's last item, and the reason the history is a separate query
   * rather than an include: a narrow reader's request never fetches the rows.
   */
  it('never shows an employee who held the asset before them', async () => {
    db.asset.findFirst.mockResolvedValue(
      assetRow({ assignments: [activeAssignment(AHMED)] }),
    );

    const app = await appAs(assetRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE,
      userId: AHMED.userId,
      dataScope: 'OWN',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/asset-1` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.assignments).toEqual([]);
    expect(db.assetAssignment.findMany).not.toHaveBeenCalled();
  });

  it('shows the whole handover history to a reader who runs the register', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow());
    db.assetAssignment.findMany.mockResolvedValue([]);

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/asset-1` });

    expect(response.statusCode).toBe(200);
    expect(db.assetAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { assetId: 'asset-1', companyId: COMPANY } }),
    );
  });

  it('counts the tiles over the same narrowed rows the list uses', async () => {
    db.asset.groupBy.mockResolvedValue([
      { status: 'AVAILABLE', _count: { _all: 4 } },
      { status: 'ASSIGNED', _count: { _all: 6 } },
      { status: 'UNDER_REPAIR', _count: { _all: 1 } },
    ]);

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/summary` });

    expect(response.statusCode).toBe(200);
    const summary = response.json().data;
    expect(summary.total).toBe(11);
    expect(summary.byStatus.AVAILABLE).toBe(4);
    expect(summary.byStatus.ASSIGNED).toBe(6);
    expect(summary.byStatus.UNDER_REPAIR).toBe(1);
    // A status nothing is in is zero rather than absent, so the tile renders.
    expect(summary.byStatus.DISPOSED).toBe(0);
  });
});

describe('what an employee cannot do', () => {
  /*
   * Section 7 names six grants an employee must never hold. This set carries
   * `employee.manage` and `employee.sensitive.read` as well, so a pass here is
   * a statement that no employee-facing grant reaches the asset writes by
   * another route.
   */
  it('cannot create an asset', async () => {
    const app = await appAs(assetRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE,
      userId: AHMED.userId,
    });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: validAsset() });

    expect(response.statusCode).toBe(403);
    expect(db.asset.create).not.toHaveBeenCalled();
  });

  it('cannot edit an asset, not even the one they are holding', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ assignments: [activeAssignment(AHMED)] }));

    const app = await appAs(assetRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/asset-1`,
      payload: { condition: 'NEW' },
    });

    expect(response.statusCode).toBe(403);
    expect(db.asset.update).not.toHaveBeenCalled();
  });
});

describe('creating an asset', () => {
  it('writes it and records asset.created', async () => {
    wireReferences();
    db.asset.create.mockResolvedValue(assetRow({ assetTag: 'IT-LAP-0099' }));

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: validAsset() });

    expect(response.statusCode).toBe(201);
    expect(db.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          companyId: COMPANY,
          assetTag: 'IT-LAP-0099',
          categoryId: 'cat-laptop',
          status: 'AVAILABLE',
        }),
      }),
    );
    expect(auditActions(db)).toContain('asset.created');
  });

  it('refuses a duplicate asset tag with a field error, not a constraint crash', async () => {
    wireReferences();
    db.asset.findFirst.mockResolvedValue({ id: 'asset-existing' });

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: validAsset() });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.assetTag).toBeTruthy();
    expect(db.asset.create).not.toHaveBeenCalled();
  });

  it('refuses a duplicate serial number', async () => {
    wireReferences();
    // The tag is free; the serial is not. Two calls, two answers.
    db.asset.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'asset-other' });

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: validAsset() });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.serialNumber).toBeTruthy();
    expect(db.asset.create).not.toHaveBeenCalled();
  });

  it('allows any number of assets with no serial number at all', async () => {
    wireReferences();
    db.asset.create.mockResolvedValue(assetRow({ serialNumber: null }));

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: validAsset({ serialNumber: '' }),
    });

    expect(response.statusCode).toBe(201);
    // A null serial is not a duplicate of another null serial - the check is
    // skipped entirely rather than asking the database about nothing.
    expect(db.asset.findFirst).toHaveBeenCalledTimes(1);
  });

  it('refuses a category that does not exist', async () => {
    db.assetCategory.findFirst.mockResolvedValue(null);

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: validAsset({ categoryId: 'cat-nonsense' }),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.categoryId).toBeTruthy();
    expect(db.asset.create).not.toHaveBeenCalled();
  });

  it('refuses a RETIRED category for a new asset', async () => {
    wireReferences({ categoryActive: false });

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: validAsset() });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.categoryId).toBeTruthy();
  });

  it('refuses a negative purchase price', async () => {
    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: validAsset({ purchasePrice: -1 }),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.purchasePrice).toBeTruthy();
    expect(db.asset.create).not.toHaveBeenCalled();
  });

  it('refuses a negative current value', async () => {
    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: validAsset({ currentValue: -0.01 }),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.currentValue).toBeTruthy();
  });

  it('refuses a warranty that ends before it starts', async () => {
    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: validAsset({ warrantyStart: '2026-06-01', warrantyEnd: '2026-01-01' }),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.warrantyEnd).toBeTruthy();
  });

  it('refuses an asset tag that is only whitespace', async () => {
    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: validAsset({ assetTag: '   ' }),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.assetTag).toBeTruthy();
  });

  it('refuses an asset born ASSIGNED, because there is nobody to assign it to', async () => {
    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: validAsset({ status: 'ASSIGNED' }),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.status).toBeTruthy();
    expect(db.asset.create).not.toHaveBeenCalled();
  });
});

describe('editing an asset', () => {
  it('updates it and records asset.updated', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow());
    db.asset.update.mockResolvedValue(assetRow({ condition: 'FAIR' }));

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/asset-1`,
      payload: { condition: 'FAIR' },
    });

    expect(response.statusCode).toBe(200);
    expect(auditActions(db)).toContain('asset.updated');
  });

  /*
   * Status and condition are different questions, and this is the proof: an
   * asset that is out with somebody can be recorded as damaged without its
   * custody changing.
   */
  it('lets an assigned asset be marked damaged without touching its status', async () => {
    db.asset.findFirst.mockResolvedValue(
      assetRow({ status: 'ASSIGNED', assignments: [activeAssignment(AHMED)] }),
    );
    db.asset.update.mockResolvedValue(assetRow({ status: 'ASSIGNED', condition: 'DAMAGED' }));

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/asset-1`,
      payload: { condition: 'DAMAGED' },
    });

    expect(response.statusCode).toBe(200);
    const data = db.asset.update.mock.calls[0]?.[0]?.data;
    expect(data.condition).toBe('DAMAGED');
    expect(data.status).toBeUndefined();
  });

  it('refuses ASSIGNED as an edit, because that is what assigning is for', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'AVAILABLE' }));

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/asset-1`,
      payload: { status: 'ASSIGNED' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.status).toBeTruthy();
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it('refuses to bring a DISPOSED asset back to life', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'DISPOSED' }));

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/asset-1`,
      payload: { status: 'AVAILABLE' },
    });

    expect(response.statusCode).toBe(422);
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it('allows the ordinary moves through an asset’s life', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'DAMAGED' }));
    db.asset.update.mockResolvedValue(assetRow({ status: 'UNDER_REPAIR' }));

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/asset-1`,
      payload: { status: 'UNDER_REPAIR' },
    });

    expect(response.statusCode).toBe(200);
  });

  /*
   * The schema cannot catch this one: the PATCH carries one end of the warranty
   * and the other is in the database. Checked against the merged pair, which is
   * the only place the real answer exists.
   */
  it('refuses a warranty end that falls before the STORED start', async () => {
    db.asset.findFirst.mockResolvedValue(
      assetRow({ warrantyStart: new Date('2026-06-01T00:00:00.000Z') }),
    );

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/asset-1`,
      payload: { warrantyEnd: '2026-01-01' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.warrantyEnd).toBeTruthy();
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it('leaves an asset already filed under a retired category where it is', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow());
    db.asset.update.mockResolvedValue(assetRow({ name: 'Renamed' }));

    const app = await appAs(assetRoutes, { prefix: PREFIX, permissions: HR, dataScope: 'ALL' });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/asset-1`,
      payload: { name: 'Renamed' },
    });

    expect(response.statusCode).toBe(200);
    // No categoryId in the payload means the category is not re-checked, so
    // renaming an asset cannot be blocked by a category somebody retired.
    expect(db.assetCategory.findFirst).not.toHaveBeenCalled();
  });
});
