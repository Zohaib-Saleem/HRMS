import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The asset lifecycle.
 *
 * What is pinned here is the set of claims section 14 asks to be enforced
 * server-side, and each one is asserted at the level it is actually enforced
 * rather than at the level it is convenient to check:
 *
 *   - ONE ACTIVE ASSIGNMENT PER ASSET is a conditional UPDATE, so the test
 *     asserts the WHERE clause and the refusal when it matches nothing. A test
 *     that only checked "a second assign returns 422 when the fixture says the
 *     asset is assigned" would pass against a read-then-write with a race in
 *     the middle, which is the bug this design exists to avoid;
 *   - DISPOSED, RETIRED and LOST assets cannot be assigned, each refused by
 *     name and each before anything is written;
 *   - RETURN closes the active handover and never deletes it;
 *   - TRANSFER writes a SECOND row and leaves the first one's employee alone,
 *     which is the whole of "do not overwrite history";
 *   - A REPAIR does not un-assign anybody, and completing one puts the asset
 *     back where it was - which is what `statusBeforeRepair` is for;
 *   - LOST and DAMAGED never delete anything;
 *   - every one of them writes its audit verb.
 */

const kit = await vi.hoisted(async () => import('./assets.test-kit.js'));
const db = kit.assetDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));
vi.mock('../../core/notifications/notification.service.js', () => ({
  notify: vi.fn(async () => ({ id: 'n-1', emailStatus: 'skipped' })),
}));

const { assetLifecycleRoutes } = await import('./asset-lifecycle.routes.js');
const {
  AHMED,
  COMPANY,
  EMPLOYEE,
  HR,
  SANA,
  appAs,
  assetRow,
  assignmentRow,
  auditActions,
  incidentRow,
  repairRow,
  useAssetDb,
  wirePeople,
} = kit;

const PREFIX = '/assets';

/** The employee lookup every write performs before it writes. */
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
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  db.assetAssignment.findFirst.mockResolvedValue(null);
  db.assetAssignment.updateMany.mockResolvedValue({ count: 1 });
  db.asset.updateMany.mockResolvedValue({ count: 1 });
  db.asset.update.mockResolvedValue(assetRow());
});

const ASSIGN = {
  employeeId: AHMED.id,
  assignedOn: '2026-09-19',
  conditionAtAssignment: 'GOOD',
  accessories: ['Laptop charger', 'Laptop bag'],
};

describe('assigning an asset', () => {
  it('claims the asset with a conditional update, then writes the handover', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'AVAILABLE' }));
    db.assetAssignment.create.mockResolvedValue(assignmentRow(AHMED));

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/assign`,
      payload: ASSIGN,
    });

    expect(response.statusCode).toBe(201);

    /*
     * THE constraint, and the reason it is asserted as a WHERE clause: an
     * asset that is already out has status ASSIGNED and matches nothing here,
     * so two concurrent calls produce one assignment and one refusal. A filter
     * applied after a read would pass a weaker test and lose the race.
     */
    expect(db.asset.updateMany).toHaveBeenCalledWith({
      where: { id: 'asset-1', companyId: COMPANY, status: { in: ['AVAILABLE', 'RETURNED'] } },
      data: { status: 'ASSIGNED', condition: 'GOOD' },
    });

    const data = db.assetAssignment.create.mock.calls[0]?.[0]?.data;
    expect(data.employeeId).toBe(AHMED.id);
    expect(data.status).toBe('ACTIVE');
    expect(data.acknowledgementStatus).toBe('PENDING');
    expect(data.accessoriesIssued).toEqual(['Laptop charger', 'Laptop bag']);

    expect(auditActions(db)).toContain('asset.assigned');
  });

  /*
   * The double-assignment test that matters. The fixture says AVAILABLE - so
   * the pre-flight check passes - and the conditional update reports nothing
   * claimed, which is exactly what happens when somebody else won the race in
   * the millisecond between. The write must not proceed.
   */
  it('refuses when the conditional claim matches nothing, and writes no handover', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'AVAILABLE' }));
    db.asset.updateMany.mockResolvedValue({ count: 0 });

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/assign`,
      payload: ASSIGN,
    });

    expect(response.statusCode).toBe(409);
    expect(db.assetAssignment.create).not.toHaveBeenCalled();
  });

  it('refuses an asset somebody already has', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'ASSIGNED' }));

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/assign`,
      payload: ASSIGN,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.assetId[0]).toMatch(/already has/i);
    expect(db.asset.updateMany).not.toHaveBeenCalled();
    expect(db.assetAssignment.create).not.toHaveBeenCalled();
  });

  it.each([
    ['DISPOSED', /disposed/i],
    ['RETIRED', /retired/i],
    ['LOST', /lost/i],
  ])('refuses a %s asset, by name', async (status, message) => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status }));

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/assign`,
      payload: ASSIGN,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.assetId[0]).toMatch(message);
    expect(db.assetAssignment.create).not.toHaveBeenCalled();
  });

  it('refuses an employee from another company', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'AVAILABLE' }));
    db.employee.findFirst.mockResolvedValue(null);

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/assign`,
      payload: { ...ASSIGN, employeeId: 'emp-elsewhere' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.employeeId).toBeTruthy();
  });

  it('refuses an employee who has left', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'AVAILABLE' }));
    db.employee.findFirst.mockResolvedValue({
      id: AHMED.id,
      firstName: 'Ahmed',
      lastName: 'Khan',
      userId: AHMED.userId,
      status: 'TERMINATED',
    });

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/assign`,
      payload: ASSIGN,
    });

    expect(response.statusCode).toBe(422);
  });

  /*
   * Somebody working out their notice is still at work and still needs a
   * laptop. Refusing them would also make the clearance screen unreachable,
   * because there would be nothing to clear.
   */
  it('still issues to somebody serving notice', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'AVAILABLE' }));
    db.employee.findFirst.mockResolvedValue({
      id: AHMED.id,
      firstName: 'Ahmed',
      lastName: 'Khan',
      userId: AHMED.userId,
      status: 'RESIGNED',
    });
    db.assetAssignment.create.mockResolvedValue(assignmentRow(AHMED));

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/assign`,
      payload: ASSIGN,
    });

    expect(response.statusCode).toBe(201);
  });

  it('refuses an employee holding only the read grant', async () => {
    const app = await appAs(assetLifecycleRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/assign`,
      payload: ASSIGN,
    });

    expect(response.statusCode).toBe(403);
    expect(db.assetAssignment.create).not.toHaveBeenCalled();
  });
});

describe('returning an asset', () => {
  const RETURN = {
    returnedOn: '2026-09-20',
    conditionAtReturn: 'GOOD',
    accessoriesReturned: ['Laptop charger', 'Laptop bag'],
    additionalMissing: [],
    outcome: 'RETURNED',
  };

  beforeEach(() => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'ASSIGNED' }));
    db.assetAssignment.findFirst.mockResolvedValue(assignmentRow(AHMED));
    db.assetAssignment.findUniqueOrThrow.mockResolvedValue(
      assignmentRow(AHMED, { status: 'RETURNED' }),
    );
  });

  it('closes the active handover rather than deleting it', async () => {
    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/return`,
      payload: RETURN,
    });

    expect(response.statusCode).toBe(200);

    // The lock: an update conditional on the row still being ACTIVE.
    const call = db.assetAssignment.updateMany.mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: `assign-${AHMED.id}`, status: 'ACTIVE' });
    expect(call.data.status).toBe('RETURNED');

    expect(auditActions(db)).toContain('asset.returned');
  });

  it('works out what did not come back and stores it', async () => {
    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/return`,
      payload: { ...RETURN, accessoriesReturned: ['Laptop charger'] },
    });

    expect(response.statusCode).toBe(200);
    const data = db.assetAssignment.updateMany.mock.calls[0]?.[0]?.data;
    expect(data.accessoriesMissing).toEqual(['Laptop bag']);
  });

  /*
   * "Checked and back in stock" is a positive claim. The schema refuses it for
   * a damaged asset; this is the half the schema cannot see, because what was
   * ISSUED lives in the database rather than in the payload.
   */
  it('refuses "back in stock" while something is missing', async () => {
    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/return`,
      payload: { ...RETURN, accessoriesReturned: [], outcome: 'AVAILABLE' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.outcome[0]).toMatch(/Laptop charger/);
    expect(db.assetAssignment.updateMany).not.toHaveBeenCalled();
  });

  it('refuses "back in stock" for an asset that came back damaged', async () => {
    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/return`,
      payload: { ...RETURN, conditionAtReturn: 'DAMAGED', outcome: 'AVAILABLE' },
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses when nobody is holding it', async () => {
    db.assetAssignment.findFirst.mockResolvedValue(null);

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/return`,
      payload: RETURN,
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses when the close matches nothing - somebody got there first', async () => {
    db.assetAssignment.updateMany.mockResolvedValue({ count: 0 });

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/return`,
      payload: RETURN,
    });

    expect(response.statusCode).toBe(409);
    expect(db.asset.update).not.toHaveBeenCalled();
  });
});

describe('transferring an asset', () => {
  const TRANSFER = {
    toEmployeeId: SANA.id,
    transferredOn: '2026-09-20',
    conditionAtTransfer: 'GOOD',
    reason: 'Moved to the support team',
    accessories: ['Laptop charger'],
  };

  beforeEach(() => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'ASSIGNED' }));
    db.assetAssignment.findFirst.mockResolvedValue(assignmentRow(AHMED));
    db.assetAssignment.create.mockResolvedValue(assignmentRow(SANA));
  });

  /*
   * The whole of section 5 in one assertion: the previous handover is CLOSED
   * and keeps its employee, and a SECOND row is inserted. Nothing edits the
   * first row's employeeId, which is what overwriting history would look like.
   */
  it('closes the old handover and writes a new one, chained to it', async () => {
    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/transfer`,
      payload: TRANSFER,
    });

    expect(response.statusCode).toBe(201);

    const closed = db.assetAssignment.updateMany.mock.calls[0]?.[0];
    expect(closed.where).toEqual({ id: `assign-${AHMED.id}`, status: 'ACTIVE' });
    expect(closed.data.status).toBe('TRANSFERRED');
    expect(closed.data.reason).toBe('Moved to the support team');
    // The closed row's employee is untouched - it is still Ahmed's handover.
    expect(closed.data.employeeId).toBeUndefined();

    const created = db.assetAssignment.create.mock.calls[0]?.[0]?.data;
    expect(created.employeeId).toBe(SANA.id);
    expect(created.previousAssignmentId).toBe(`assign-${AHMED.id}`);
    expect(created.status).toBe('ACTIVE');
    // A fresh handover is un-acknowledged, whoever acknowledged the last one.
    expect(created.acknowledgementStatus).toBe('PENDING');

    expect(auditActions(db)).toContain('asset.transferred');
  });

  it('leaves the asset assigned - it does not come back to the store on the way', async () => {
    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'POST', url: `${PREFIX}/asset-1/transfer`, payload: TRANSFER });

    expect(db.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ASSIGNED', condition: 'GOOD' } }),
    );
  });

  it('refuses a transfer to the person who already has it', async () => {
    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/transfer`,
      payload: { ...TRANSFER, toEmployeeId: AHMED.id },
    });

    expect(response.statusCode).toBe(422);
    expect(db.assetAssignment.create).not.toHaveBeenCalled();
  });

  it('insists on a reason', async () => {
    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/transfer`,
      payload: { ...TRANSFER, reason: '' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.reason).toBeTruthy();
  });

  it('refuses an employee - section 14 says they cannot transfer assets', async () => {
    const app = await appAs(assetLifecycleRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/transfer`,
      payload: TRANSFER,
    });

    expect(response.statusCode).toBe(403);
    expect(db.assetAssignment.create).not.toHaveBeenCalled();
  });
});

describe('repairs', () => {
  const SEND = {
    problem: 'Screen flickers',
    reportedOn: '2026-09-18',
    sentOn: '2026-09-19',
    vendor: 'Dell Service',
    estimatedCost: 12000,
  };

  /*
   * The column the whole of section 8 turns on. An ASSIGNED laptop that goes
   * away for repair remembers that it was assigned, and the assignment row is
   * not touched - the employee still has it on paper, which is true.
   */
  it('remembers what the asset was before it left, and does not un-assign anybody', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'ASSIGNED' }));
    db.assetRepair.create.mockResolvedValue(repairRow());

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/repairs`,
      payload: SEND,
    });

    expect(response.statusCode).toBe(201);
    expect(db.assetRepair.create.mock.calls[0]?.[0]?.data.statusBeforeRepair).toBe('ASSIGNED');
    expect(db.assetAssignment.updateMany).not.toHaveBeenCalled();
    expect(auditActions(db)).toContain('asset.repair.sent');
  });

  it('puts an ASSIGNED asset back to ASSIGNED when the repair ends', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'UNDER_REPAIR' }));
    db.assetRepair.findFirst.mockResolvedValue(repairRow({ statusBeforeRepair: 'ASSIGNED' }));
    db.assetRepair.updateMany.mockResolvedValue({ count: 1 });
    db.assetRepair.findUniqueOrThrow.mockResolvedValue(
      repairRow({ status: 'COMPLETED', statusBeforeRepair: 'ASSIGNED' }),
    );

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/asset-1/repairs/repair-1`,
      payload: { status: 'COMPLETED', returnedOn: '2026-09-25', actualCost: 11000 },
    });

    expect(response.statusCode).toBe(200);
    expect(db.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ASSIGNED' }) }),
    );
    expect(auditActions(db)).toContain('asset.repaired');
  });

  it('puts an AVAILABLE asset back to AVAILABLE', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'UNDER_REPAIR' }));
    db.assetRepair.findFirst.mockResolvedValue(repairRow({ statusBeforeRepair: 'AVAILABLE' }));
    db.assetRepair.updateMany.mockResolvedValue({ count: 1 });
    db.assetRepair.findUniqueOrThrow.mockResolvedValue(
      repairRow({ status: 'COMPLETED', statusBeforeRepair: 'AVAILABLE' }),
    );

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/asset-1/repairs/repair-1`,
      payload: { status: 'COMPLETED', returnedOn: '2026-09-25' },
    });

    expect(db.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'AVAILABLE' }) }),
    );
  });

  /*
   * A repair that never happened must not strand the asset in UNDER_REPAIR
   * forever, which is the one way this workflow could quietly lose a laptop.
   */
  it('restores the asset even when the repair is called off', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'UNDER_REPAIR' }));
    db.assetRepair.findFirst.mockResolvedValue(repairRow({ statusBeforeRepair: 'ASSIGNED' }));
    db.assetRepair.updateMany.mockResolvedValue({ count: 1 });
    db.assetRepair.findUniqueOrThrow.mockResolvedValue(repairRow({ status: 'CANCELLED' }));

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/asset-1/repairs/repair-1`,
      payload: { status: 'CANCELLED', returnedOn: '2026-09-25' },
    });

    expect(db.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ASSIGNED' }) }),
    );
    expect(auditActions(db)).toContain('asset.repair.cancelled');
  });

  it('refuses to send an asset that is already away', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'UNDER_REPAIR' }));

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/repairs`,
      payload: SEND,
    });

    expect(response.statusCode).toBe(422);
    expect(db.assetRepair.create).not.toHaveBeenCalled();
  });

  it('refuses to close a repair twice', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'AVAILABLE' }));
    db.assetRepair.findFirst.mockResolvedValue(repairRow({ status: 'COMPLETED' }));

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/asset-1/repairs/repair-1`,
      payload: { status: 'COMPLETED', returnedOn: '2026-09-25' },
    });

    expect(response.statusCode).toBe(422);
  });
});

describe('lost and damaged', () => {
  const INCIDENT = { occurredOn: '2026-09-19', reason: 'Left on a train' };

  it('records a LOST asset and keeps it on the register', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'ASSIGNED' }));
    db.assetAssignment.findFirst.mockResolvedValue({ id: `assign-${AHMED.id}` });
    db.assetIncident.create.mockResolvedValue(incidentRow({ kind: 'LOST' }));

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/incidents`,
      payload: { ...INCIDENT, kind: 'LOST' },
    });

    expect(response.statusCode).toBe(201);
    expect(db.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'LOST' } }),
    );
    expect(auditActions(db)).toContain('asset.lost');
  });

  it('records a DAMAGED asset and moves its condition as well', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'ASSIGNED' }));
    db.assetIncident.create.mockResolvedValue(incidentRow());

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/incidents`,
      payload: { ...INCIDENT, kind: 'DAMAGED', reason: 'Dropped' },
    });

    expect(response.statusCode).toBe(201);
    expect(db.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'DAMAGED', condition: 'DAMAGED' } }),
    );
    expect(auditActions(db)).toContain('asset.damaged');
  });

  /*
   * A laptop that went missing while Ahmed had it is still Ahmed's to account
   * for. Closing his handover here would quietly clear him.
   */
  it('leaves the handover open, and files the incident against it', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'ASSIGNED' }));
    db.assetAssignment.findFirst.mockResolvedValue({ id: `assign-${AHMED.id}` });
    db.assetIncident.create.mockResolvedValue(incidentRow({ kind: 'LOST' }));

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/incidents`,
      payload: { ...INCIDENT, kind: 'LOST' },
    });

    expect(db.assetAssignment.updateMany).not.toHaveBeenCalled();
    expect(db.assetIncident.create.mock.calls[0]?.[0]?.data.assignmentId).toBe(
      `assign-${AHMED.id}`,
    );
  });

  it('refuses an employee - section 14 says they cannot change an asset', async () => {
    const app = await appAs(assetLifecycleRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/incidents`,
      payload: { ...INCIDENT, kind: 'DAMAGED' },
    });

    expect(response.statusCode).toBe(403);
    expect(db.assetIncident.create).not.toHaveBeenCalled();
  });
});

describe('retiring and disposing', () => {
  it('retires an asset nobody is holding', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'AVAILABLE' }));

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/retire`,
      payload: { retiredOn: '2026-09-19', reason: 'End of life' },
    });

    expect(response.statusCode).toBe(200);
    expect(db.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'RETIRED', retiredReason: 'End of life' }),
      }),
    );
    expect(auditActions(db)).toContain('asset.retired');
  });

  it('refuses to retire one that is on somebody’s desk', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'ASSIGNED' }));
    db.assetAssignment.findFirst.mockResolvedValue({ id: `assign-${AHMED.id}` });

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/retire`,
      payload: { retiredOn: '2026-09-19', reason: 'End of life' },
    });

    expect(response.statusCode).toBe(422);
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it('disposes of one, recording the method and what it fetched', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'RETIRED' }));

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/dispose`,
      payload: {
        disposedOn: '2026-09-19',
        method: 'SOLD',
        reason: 'Beyond economic repair',
        finalValue: 15000,
      },
    });

    expect(response.statusCode).toBe(200);
    const data = db.asset.update.mock.calls[0]?.[0]?.data;
    expect(data.status).toBe('DISPOSED');
    expect(data.disposalMethod).toBe('SOLD');
    expect(data.disposalFinalValue).toBe(15000);
    // The row stays, and is UPDATED rather than removed. Last year's asset
    // register has to keep adding up.
    expect(auditActions(db)).toContain('asset.disposed');
  });

  it('refuses to dispose of the same asset twice', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'DISPOSED' }));

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/dispose`,
      payload: { disposedOn: '2026-09-19', method: 'SCRAPPED', reason: 'Gone' },
    });

    expect(response.statusCode).toBe(422);
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it('refuses a disposal approver from another company', async () => {
    db.asset.findFirst.mockResolvedValue(assetRow({ status: 'RETIRED' }));
    db.employee.findFirst.mockResolvedValue(null);

    const app = await appAs(assetLifecycleRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/asset-1/dispose`,
      payload: {
        disposedOn: '2026-09-19',
        method: 'SOLD',
        reason: 'Sold on',
        approvedByEmployeeId: 'emp-elsewhere',
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.approvedByEmployeeId).toBeTruthy();
  });
});
