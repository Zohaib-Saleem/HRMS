import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One employee's assets, on their profile.
 *
 * Three claims:
 *
 *   - CROSS-EMPLOYEE ACCESS IS REFUSED BY THE EXISTING SCOPE MACHINERY, not by
 *     a check written here for the third time. An employee on an OWN scope
 *     reaches their own id and is refused every other, and the refusal comes
 *     from `assertEmployeeInScope` - so the test asserts the 403 AND that no
 *     assignment was fetched, because a route that queried first and filtered
 *     afterwards would have read a colleague's kit off the disk either way.
 *   - THE CLEARANCE BLOCK APPLIES ONLY TO SOMEBODY LEAVING, and it COUNTS
 *     rather than acts. Section 11 is explicit that nothing here marks an asset
 *     returned, so the test pins that no write of any kind happens.
 *   - THE TOTALS ARE OF WHAT IS HELD NOW, not of everything ever issued.
 */

const kit = await vi.hoisted(async () => import('./assets.test-kit.js'));
const db = kit.assetDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { assetEmployeeRoutes } = await import('./asset-employees.routes.js');
const { AHMED, COMPANY, EMPLOYEE, HR, SANA, appAs, employeeAssignmentRow, useAssetDb } = kit;

const PREFIX = '/employees';

/**
 * The employee lookups this route makes: the subject, and - through
 * `employeeScopeFilter` - the caller's own record and the scope match.
 *
 * Written by hand rather than through `wirePeople`, because the interesting
 * cases here turn on whether the SCOPE match finds anything, which is a
 * different question from whether the person exists.
 */
function wireSubject(options: {
  subjectStatus?: string;
  callerEmployeeId?: string;
  scopeMatches?: boolean;
}) {
  const subjectStatus = options.subjectStatus ?? 'ACTIVE';
  const scopeMatches = options.scopeMatches ?? true;

  db.employee.findFirst.mockImplementation(async (args: Record<string, unknown>) => {
    const where = (args?.where ?? {}) as Record<string, unknown>;

    // `assertEmployeeInScope` asks with an AND array; everything else asks flat.
    if (Array.isArray(where.AND)) return scopeMatches ? { id: AHMED.id } : null;

    if (typeof where.userId === 'string') {
      return options.callerEmployeeId
        ? { id: options.callerEmployeeId, departmentId: 'dept-dev' }
        : null;
    }

    const select = (args?.select ?? {}) as Record<string, unknown>;
    if (select.status) return { id: AHMED.id, status: subjectStatus };
    return { id: AHMED.id, departmentId: 'dept-dev' };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAssetDb(db);
  db.assetAssignment.findMany.mockResolvedValue([]);
});

describe('who may open somebody’s asset tab', () => {
  it('serves HR, whose scope reaches everybody', async () => {
    wireSubject({ callerEmployeeId: 'emp-hr' });
    db.assetAssignment.findMany.mockResolvedValue([employeeAssignmentRow(AHMED)]);

    const app = await appAs(assetEmployeeRoutes, {
      prefix: PREFIX,
      permissions: HR,
      dataScope: 'ALL',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/${AHMED.id}/assets` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.totalAssigned).toBe(1);
  });

  it('serves an employee their own record', async () => {
    wireSubject({ callerEmployeeId: AHMED.id, scopeMatches: true });
    db.assetAssignment.findMany.mockResolvedValue([employeeAssignmentRow(AHMED)]);

    const app = await appAs(assetEmployeeRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE,
      userId: AHMED.userId,
      dataScope: 'OWN',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/${AHMED.id}/assets` });

    expect(response.statusCode).toBe(200);
  });

  /*
   * The one that matters. An employee asking for a colleague's assets is
   * refused by the scope resolver, and - the part worth pinning - nothing was
   * read before the refusal.
   */
  it('refuses an employee asking for a colleague, without reading a thing', async () => {
    wireSubject({ callerEmployeeId: AHMED.id, scopeMatches: false });

    const app = await appAs(assetEmployeeRoutes, {
      prefix: PREFIX,
      permissions: EMPLOYEE,
      userId: AHMED.userId,
      dataScope: 'OWN',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/${SANA.id}/assets` });

    expect(response.statusCode).toBe(403);
    expect(db.assetAssignment.findMany).not.toHaveBeenCalled();
  });

  it('refuses a caller with no asset grant at all', async () => {
    const app = await appAs(assetEmployeeRoutes, {
      prefix: PREFIX,
      permissions: [],
      userId: AHMED.userId,
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/${AHMED.id}/assets` });

    expect(response.statusCode).toBe(403);
  });

  it('404s for an employee in another company', async () => {
    db.employee.findFirst.mockResolvedValue(null);

    const app = await appAs(assetEmployeeRoutes, {
      prefix: PREFIX,
      permissions: HR,
      dataScope: 'ALL',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/emp-elsewhere/assets` });

    expect(response.statusCode).toBe(404);
  });
});

describe('what the tab says', () => {
  it('splits what they hold now from what they have had', async () => {
    wireSubject({ callerEmployeeId: 'emp-hr' });
    db.assetAssignment.findMany.mockResolvedValue([
      employeeAssignmentRow(AHMED),
      employeeAssignmentRow(AHMED, { id: 'assign-old', status: 'RETURNED' }),
      employeeAssignmentRow(AHMED, { id: 'assign-moved', status: 'TRANSFERRED' }),
    ]);

    const app = await appAs(assetEmployeeRoutes, {
      prefix: PREFIX,
      permissions: HR,
      dataScope: 'ALL',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/${AHMED.id}/assets` });

    const data = response.json().data;
    expect(data.assigned).toHaveLength(1);
    expect(data.history).toHaveLength(2);
  });

  it('totals the value of what is held NOW, not of everything ever issued', async () => {
    wireSubject({ callerEmployeeId: 'emp-hr' });
    db.assetAssignment.findMany.mockResolvedValue([
      employeeAssignmentRow(AHMED),
      employeeAssignmentRow(AHMED, { id: 'assign-2' }),
      employeeAssignmentRow(AHMED, { id: 'assign-old', status: 'RETURNED' }),
    ]);

    const app = await appAs(assetEmployeeRoutes, {
      prefix: PREFIX,
      permissions: HR,
      dataScope: 'ALL',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/${AHMED.id}/assets` });

    // Two active at 200,000 each. The returned one is not theirs any more.
    expect(response.json().data.totalCurrentValue).toBe(400_000);
  });
});

describe('asset clearance', () => {
  it('does not apply to somebody who is not going anywhere', async () => {
    wireSubject({ callerEmployeeId: 'emp-hr', subjectStatus: 'ACTIVE' });
    db.assetAssignment.findMany.mockResolvedValue([employeeAssignmentRow(AHMED)]);

    const app = await appAs(assetEmployeeRoutes, {
      prefix: PREFIX,
      permissions: HR,
      dataScope: 'ALL',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/${AHMED.id}/assets` });

    expect(response.json().data.clearance.applies).toBe(false);
  });

  /*
   * There is no NOTICE_PERIOD employment status in this product and this module
   * does not add one - inventing an employment state would change the people
   * module, and payroll, leave and attendance besides. RESIGNED is what notice
   * looks like in these tables.
   */
  it.each(['RESIGNED', 'TERMINATED'])('applies to somebody who is %s', async (status) => {
    wireSubject({ callerEmployeeId: 'emp-hr', subjectStatus: status });
    db.assetAssignment.findMany.mockResolvedValue([employeeAssignmentRow(AHMED)]);

    const app = await appAs(assetEmployeeRoutes, {
      prefix: PREFIX,
      permissions: HR,
      dataScope: 'ALL',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/${AHMED.id}/assets` });

    expect(response.json().data.clearance.applies).toBe(true);
  });

  it('counts what is still out, and says clearance is not complete', async () => {
    wireSubject({ callerEmployeeId: 'emp-hr', subjectStatus: 'RESIGNED' });
    db.assetAssignment.findMany.mockResolvedValue([
      employeeAssignmentRow(AHMED),
      employeeAssignmentRow(AHMED, { id: 'assign-back', status: 'RETURNED' }),
    ]);

    const app = await appAs(assetEmployeeRoutes, {
      prefix: PREFIX,
      permissions: HR,
      dataScope: 'ALL',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/${AHMED.id}/assets` });

    const clearance = response.json().data.clearance;
    expect(clearance.assigned).toBe(2);
    expect(clearance.returned).toBe(1);
    expect(clearance.pending).toBe(1);
    expect(clearance.cleared).toBe(false);
  });

  it('counts a lost and a damaged asset separately, and still as pending', async () => {
    wireSubject({ callerEmployeeId: 'emp-hr', subjectStatus: 'TERMINATED' });
    db.assetAssignment.findMany.mockResolvedValue([
      employeeAssignmentRow(AHMED, {
        id: 'assign-lost',
        asset: {
          id: 'asset-2',
          assetTag: 'IT-PHN-0007',
          name: 'iPhone 14',
          serialNumber: null,
          status: 'LOST',
          currentValue: 90000,
          category: { name: 'Mobile Phone' },
        },
      }),
      employeeAssignmentRow(AHMED, {
        id: 'assign-broken',
        asset: {
          id: 'asset-3',
          assetTag: 'IT-MON-0011',
          name: 'Dell 24"',
          serialNumber: null,
          status: 'DAMAGED',
          currentValue: 30000,
          category: { name: 'Monitor' },
        },
      }),
    ]);

    const app = await appAs(assetEmployeeRoutes, {
      prefix: PREFIX,
      permissions: HR,
      dataScope: 'ALL',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/${AHMED.id}/assets` });

    const clearance = response.json().data.clearance;
    expect(clearance.lost).toBe(1);
    expect(clearance.damaged).toBe(1);
    // Neither is the same as having handed it back. Both still need settling.
    expect(clearance.pending).toBe(2);
    expect(clearance.cleared).toBe(false);
  });

  it('says clearance is complete only when nothing is out', async () => {
    wireSubject({ callerEmployeeId: 'emp-hr', subjectStatus: 'TERMINATED' });
    db.assetAssignment.findMany.mockResolvedValue([
      employeeAssignmentRow(AHMED, { id: 'assign-back', status: 'RETURNED' }),
    ]);

    const app = await appAs(assetEmployeeRoutes, {
      prefix: PREFIX,
      permissions: HR,
      dataScope: 'ALL',
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/${AHMED.id}/assets` });

    expect(response.json().data.clearance.cleared).toBe(true);
  });

  /*
   * Section 11's explicit instruction. A clearance screen that could tick its
   * own boxes is a screen that says the laptop came back when it did not.
   */
  it('never marks anything returned - it is a read, entire', async () => {
    wireSubject({ callerEmployeeId: 'emp-hr', subjectStatus: 'TERMINATED' });
    db.assetAssignment.findMany.mockResolvedValue([employeeAssignmentRow(AHMED)]);

    const app = await appAs(assetEmployeeRoutes, {
      prefix: PREFIX,
      permissions: HR,
      dataScope: 'ALL',
    });
    await app.inject({ method: 'GET', url: `${PREFIX}/${AHMED.id}/assets` });

    expect(db.assetAssignment.update).not.toHaveBeenCalled();
    expect(db.assetAssignment.updateMany).not.toHaveBeenCalled();
    expect(db.asset.update).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});
