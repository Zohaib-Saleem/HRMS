import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The employee's own asset screen.
 *
 * Two claims, and both are about what this plugin CANNOT do:
 *
 *   - EVERY QUERY IS BOUND TO THE CALLER'S OWN EMPLOYEE RECORD, resolved from
 *     the session rather than read from the request. There is no employee id in
 *     any of these paths, so the test asserts the WHERE clause carries the
 *     caller's own id - a filter applied afterwards would pass a test that
 *     counted rows and would still have fetched a colleague's handover.
 *   - NOTHING HERE TOUCHES THE ASSET. Acknowledging writes three columns on one
 *     assignment row; reporting an issue writes an incident and a flag. Section
 *     14 asks that employees cannot change an asset's condition or its value,
 *     and the assertion is that `asset.update` is never called at all.
 *
 * Plus the one that would be expensive to get wrong: an employee poking at
 * assignment ids gets a 404 for somebody else's, not a 403, so the endpoint
 * cannot be used to discover that a handover exists.
 */

const kit = await vi.hoisted(async () => import('./assets.test-kit.js'));
const db = kit.assetDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { assetSelfRoutes } = await import('./asset-self.routes.js');
const {
  AHMED,
  COMPANY,
  EMPLOYEE,
  SANA,
  appAs,
  assignmentRow,
  auditActions,
  employeeAssignmentRow,
  useAssetDb,
  wirePeople,
} = kit;

const PREFIX = '/assets';

/** Everything an employee holds except the acknowledgement grant. */
const EMPLOYEE_NO_ACK = EMPLOYEE;
/** What the Employee role actually carries in step 2. */
const EMPLOYEE_WITH_ACK = [...EMPLOYEE, 'asset.acknowledge' as never];

beforeEach(() => {
  vi.clearAllMocks();
  useAssetDb(db);
  wirePeople(db);
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
});

describe('what I have been issued', () => {
  it('asks only for the caller’s own active handovers', async () => {
    db.assetAssignment.findMany.mockResolvedValue([employeeAssignmentRow(AHMED)]);

    const app = await appAs(assetSelfRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE_WITH_ACK,
      userId: AHMED.userId,
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/my` });

    expect(response.statusCode).toBe(200);
    expect(db.assetAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: COMPANY, employeeId: AHMED.id, status: 'ACTIVE' },
      }),
    );
    expect(response.json().data.totalAssigned).toBe(1);
  });

  /*
   * The caller's own id, and NOT their data scope. A manager opening their own
   * dashboard card wants their own laptop, not their team's six.
   */
  it('ignores the data scope entirely - a manager sees their own kit here', async () => {
    db.assetAssignment.findMany.mockResolvedValue([]);

    const app = await appAs(assetSelfRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE_WITH_ACK,
      userId: AHMED.userId,
      dataScope: 'ALL',
    });
    await app.inject({ method: 'GET', url: `${PREFIX}/my` });

    const where = db.assetAssignment.findMany.mock.calls[0]?.[0]?.where;
    expect(where.employeeId).toBe(AHMED.id);
  });

  it('separates the handovers still waiting on the employee', async () => {
    db.assetAssignment.findMany.mockResolvedValue([
      employeeAssignmentRow(AHMED),
      employeeAssignmentRow(AHMED, {
        id: 'assign-2',
        acknowledgementStatus: 'ACKNOWLEDGED',
      }),
    ]);

    const app = await appAs(assetSelfRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE_WITH_ACK,
      userId: AHMED.userId,
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/my` });

    const data = response.json().data;
    expect(data.assigned).toHaveLength(2);
    expect(data.awaitingAcknowledgement).toHaveLength(1);
  });

  it('answers empty for a login with no employee record, rather than erroring', async () => {
    db.employee.findFirst.mockResolvedValue(null);

    const app = await appAs(assetSelfRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE_WITH_ACK,
      userId: 'user-ghost',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/my` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.assigned).toEqual([]);
    expect(db.assetAssignment.findMany).not.toHaveBeenCalled();
  });
});

describe('acknowledging a handover', () => {
  it('records it against the caller’s own assignment and nothing else', async () => {
    db.assetAssignment.findFirst.mockResolvedValue({
      ...assignmentRow(AHMED),
      asset: { id: 'asset-1', assetTag: 'IT-LAP-0042', name: 'Dell Latitude 5440' },
    });
    db.assetAssignment.update.mockResolvedValue(assignmentRow(AHMED));

    const app = await appAs(assetSelfRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE_WITH_ACK,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/assignments/assign-${AHMED.id}/acknowledge`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);

    // The lookup carries the caller's own employee id, so a foreign assignment
    // id simply finds nothing.
    expect(db.assetAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: `assign-${AHMED.id}`,
          companyId: COMPANY,
          employeeId: AHMED.id,
        },
      }),
    );

    const data = db.assetAssignment.update.mock.calls[0]?.[0]?.data;
    expect(data.acknowledgementStatus).toBe('ACKNOWLEDGED');
    expect(data.acknowledgedById).toBe(AHMED.userId);

    // Section 14: an employee cannot change an asset. Not "is refused" - the
    // plugin never writes to that table.
    expect(db.asset.update).not.toHaveBeenCalled();

    expect(auditActions(db)).toContain('asset.acknowledged');
  });

  it('answers 404 for somebody else’s handover, not 403', async () => {
    // The WHERE clause carries the caller's employee id, so Sana's row is not
    // found rather than found and refused.
    db.assetAssignment.findFirst.mockResolvedValue(null);

    const app = await appAs(assetSelfRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE_WITH_ACK,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/assignments/assign-${SANA.id}/acknowledge`,
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(db.assetAssignment.update).not.toHaveBeenCalled();
  });

  it('refuses a second acknowledgement of the same handover', async () => {
    db.assetAssignment.findFirst.mockResolvedValue({
      ...assignmentRow(AHMED, { acknowledgementStatus: 'ACKNOWLEDGED' }),
      asset: { id: 'asset-1', assetTag: 'IT-LAP-0042', name: 'Dell Latitude 5440' },
    });

    const app = await appAs(assetSelfRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE_WITH_ACK,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/assignments/assign-${AHMED.id}/acknowledge`,
      payload: {},
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses a caller without the acknowledgement grant', async () => {
    const app = await appAs(assetSelfRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE_NO_ACK,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/assignments/assign-${AHMED.id}/acknowledge`,
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a login with no employee record', async () => {
    db.employee.findFirst.mockResolvedValue(null);

    const app = await appAs(assetSelfRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE_WITH_ACK,
      userId: 'user-ghost',
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/assignments/assign-1/acknowledge`,
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('reporting an issue', () => {
  beforeEach(() => {
    db.assetAssignment.findFirst.mockResolvedValue({
      ...assignmentRow(AHMED),
      asset: { id: 'asset-1', assetTag: 'IT-LAP-0042', name: 'Dell Latitude 5440' },
    });
    db.assetIncident.create.mockResolvedValue({
      id: 'incident-1',
      companyId: COMPANY,
      assetId: 'asset-1',
      assignmentId: `assign-${AHMED.id}`,
      kind: 'ISSUE_REPORTED',
      occurredOn: new Date('2026-09-19T00:00:00.000Z'),
      reason: 'Charger does not work',
      description: null,
      notes: null,
      reportedById: AHMED.userId,
      reportedByEmployeeId: AHMED.id,
      resolvedAt: null,
      resolvedById: null,
      resolutionNotes: null,
      createdAt: new Date('2026-09-19T05:00:00.000Z'),
      updatedAt: new Date('2026-09-19T05:00:00.000Z'),
      reportedBy: null,
      reportedByEmployee: null,
    });
    db.assetAssignment.update.mockResolvedValue(assignmentRow(AHMED));
  });

  it('files an auditable incident and flags the handover', async () => {
    const app = await appAs(assetSelfRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE_WITH_ACK,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/assignments/assign-${AHMED.id}/report-issue`,
      payload: { reason: 'Charger does not work' },
    });

    expect(response.statusCode).toBe(201);

    const incident = db.assetIncident.create.mock.calls[0]?.[0]?.data;
    expect(incident.kind).toBe('ISSUE_REPORTED');
    expect(incident.reportedByEmployeeId).toBe(AHMED.id);

    expect(db.assetAssignment.update.mock.calls[0]?.[0]?.data).toEqual({
      acknowledgementStatus: 'ISSUE_REPORTED',
    });

    expect(auditActions(db)).toContain('asset.issue.reported');
  });

  /*
   * The claim section 14 makes twice. An employee saying "the charger is
   * buzzing" raises a flag a person reads; it does not move the asset to
   * DAMAGED, does not change its condition and does not touch its value.
   */
  it('changes nothing whatsoever about the asset', async () => {
    const app = await appAs(assetSelfRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE_WITH_ACK,
      userId: AHMED.userId,
    });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/assignments/assign-${AHMED.id}/report-issue`,
      payload: { reason: 'Screen flickers', description: 'Only on the left third' },
    });

    expect(db.asset.update).not.toHaveBeenCalled();
    expect(db.asset.updateMany).not.toHaveBeenCalled();
  });

  it('insists on saying what is wrong', async () => {
    const app = await appAs(assetSelfRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE_WITH_ACK,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/assignments/assign-${AHMED.id}/report-issue`,
      payload: { reason: '   ' },
    });

    expect(response.statusCode).toBe(422);
    expect(db.assetIncident.create).not.toHaveBeenCalled();
  });

  it('cannot be used against a colleague’s handover', async () => {
    db.assetAssignment.findFirst.mockResolvedValue(null);

    const app = await appAs(assetSelfRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE_WITH_ACK,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/assignments/assign-${SANA.id}/report-issue`,
      payload: { reason: 'Something' },
    });

    expect(response.statusCode).toBe(404);
    expect(db.assetIncident.create).not.toHaveBeenCalled();
  });
});
