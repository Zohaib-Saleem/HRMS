import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '@hrms/shared';

/**
 * The two asset reports.
 *
 * What is pinned here is everything that would make a report lie:
 *
 *   - a reporting grant is permission to EXPORT what you can see, never
 *     permission to see more. The data-scope filter is on the report's WHERE
 *     exactly as it is on the list screen, and a caller linked to nobody gets
 *     no rows rather than the whole register;
 *   - `asset.report` is needed as well as `asset.read`. HR holds both; a
 *     manager holds neither of the second;
 *   - THE PAGE AND THE TOTALS COME FROM THE SAME `where`. A footer that
 *     totalled the twenty rows on screen would change when somebody paged,
 *     which is the most quietly wrong thing a report can do;
 *   - the CSV is the JSON, formatted. Same filters, same rows, same order - an
 *     export that interpreted "category" differently from the screen it was
 *     taken from is discovered in a meeting;
 *   - an export too big to be honest is REFUSED, not truncated;
 *   - the two reports have different GRAINS, and the employee register keeps
 *     the person who handed everything back.
 */

const kit = await vi.hoisted(async () => import('./assets.test-kit.js'));
const db = kit.assetDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { assetReportRoutes } = await import('./asset-reports.routes.js');
const { AHMED, EMPLOYEE, HR, MANAGER, NOW, andClauses, appAs, auditActions, wirePeople } = kit;

/**
 * Somebody who may run reports and may NOT read the whole register.
 *
 * Not a role the product ships - HR holds `asset.read.all` alongside these -
 * and that is exactly why it is worth testing. It is the combination that
 * proves the scope filter is on the report's WHERE rather than being made
 * irrelevant by a wide grant that happens to sit beside it in every preset.
 */
const REPORTER = [PERMISSIONS.ASSET_READ, PERMISSIONS.ASSET_REPORT];

const PREFIX = '/assets';

/**
 * The first argument of the first call, as the route handed it to Prisma.
 *
 * A helper rather than `calls[0][0]` at every site: under the strict index
 * checks this project compiles tests with, each of those needs two assertions
 * that add nothing to what the test is saying.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstArg(mock: { mock: { calls: any[][] } }): any {
  return mock.mock.calls[0]?.[0];
}

/** An asset as the report's select reads it. */
function reportAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset-1',
    assetTag: 'IT-LAP-0042',
    name: 'Dell Latitude 5440',
    brand: 'Dell',
    model: 'Latitude 5440',
    serialNumber: 'SN-ABC-123',
    purchaseDate: new Date('2026-01-15T00:00:00.000Z'),
    purchasePrice: 250000,
    currentValue: 200000,
    warrantyEnd: new Date('2029-01-15T00:00:00.000Z'),
    condition: 'GOOD',
    status: 'ASSIGNED',
    category: { name: 'Laptop' },
    site: { name: 'Lahore Office' },
    assignments: [
      {
        assignedAt: NOW,
        employee: {
          id: AHMED.id,
          employeeNumber: 'EMP-0007',
          firstName: 'Ahmed',
          lastName: 'Khan',
          department: { name: 'Development' },
        },
      },
    ],
    ...overrides,
  };
}

/** A handover as the employee register's include reads it. */
function registerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'assign-1',
    assignedAt: NOW,
    returnedAt: null,
    conditionAtAssignment: 'GOOD',
    conditionAtReturn: null,
    acknowledgementStatus: 'ACKNOWLEDGED',
    status: 'ACTIVE',
    employee: {
      id: AHMED.id,
      employeeNumber: 'EMP-0007',
      firstName: 'Ahmed',
      lastName: 'Khan',
      department: { name: 'Development' },
      team: { name: 'Platform' },
    },
    asset: {
      id: 'asset-1',
      assetTag: 'IT-LAP-0042',
      name: 'Dell Latitude 5440',
      serialNumber: 'SN-ABC-123',
      status: 'ASSIGNED',
      purchasePrice: 250000,
      currentValue: 200000,
      category: { name: 'Laptop' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  wirePeople(db);
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  db.asset.findMany.mockResolvedValue([]);
  db.asset.count.mockResolvedValue(0);
  db.asset.aggregate.mockResolvedValue({
    _count: { _all: 0 },
    _sum: { purchasePrice: null, currentValue: null },
  });
  db.assetAssignment.findMany.mockResolvedValue([]);
  db.assetAssignment.count.mockResolvedValue(0);
});

async function get(url: string, permissions = HR, dataScope: 'ALL' | 'OWN' = 'ALL') {
  const app = await appAs(assetReportRoutes, { prefix: PREFIX, permissions, dataScope });
  return app.inject({ method: 'GET', url: `${PREFIX}${url}` });
}

describe('who may run a report', () => {
  it('refuses a manager, who holds asset.read and not asset.report', async () => {
    expect((await get('/reports/assets', MANAGER)).statusCode).toBe(403);
    expect((await get('/reports/employees', MANAGER)).statusCode).toBe(403);
  });

  it('refuses an employee holding the widest employee-facing grants', async () => {
    expect((await get('/reports/assets.csv', EMPLOYEE)).statusCode).toBe(403);
  });

  it('serves HR, who holds both', async () => {
    expect((await get('/reports/assets')).statusCode).toBe(200);
  });
});

describe('a report never widens what its reader may see', () => {
  it('puts the data-scope clause on the asset report WHERE', async () => {
    await get('/reports/assets', REPORTER, 'OWN');

    const clauses = andClauses(db.asset.findMany.mock.calls[0]?.[0]?.where);
    // The scope fragment is the same nested `some` the list screen builds.
    expect(clauses).toContainEqual({
      assignments: { some: { status: 'ACTIVE', employee: { id: 'emp-hr' } } },
    });
  });

  it('answers a caller linked to nobody with no rows, never with no filter', async () => {
    db.employee.findFirst.mockResolvedValue(null);

    const response = await get('/reports/assets', REPORTER, 'OWN');
    const body = response.json();

    expect(body.data).toEqual([]);
    expect(body.totals).toEqual({ rows: 0, purchaseValue: 0, currentValue: 0 });
    // And nothing was read at all - the refusal is a decision, not an empty
    // result set that came back from a query over the whole company.
    expect(db.asset.findMany).not.toHaveBeenCalled();
  });

  it('exports nothing for that caller too, and still records the export', async () => {
    db.employee.findFirst.mockResolvedValue(null);

    const response = await get('/reports/assets.csv', REPORTER, 'OWN');

    expect(response.statusCode).toBe(200);
    expect(db.asset.findMany).not.toHaveBeenCalled();
    expect(auditActions(db)).toEqual(['asset.report.export']);
  });
});

describe('the asset report', () => {
  it('is one row per asset, with the ACTIVE holder on it', async () => {
    db.asset.findMany.mockResolvedValue([reportAsset()]);
    db.asset.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _sum: { purchasePrice: 250000, currentValue: 200000 },
    });

    const body = (await get('/reports/assets')).json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      assetId: 'asset-1',
      assetTag: 'IT-LAP-0042',
      employeeName: 'Ahmed Khan',
      employeeNumber: 'EMP-0007',
      departmentName: 'Development',
      locationName: 'Lahore Office',
    });
  });

  it('leaves the holder null on an asset nobody is holding', async () => {
    db.asset.findMany.mockResolvedValue([reportAsset({ assignments: [], status: 'AVAILABLE' })]);

    const row = (await get('/reports/assets')).json().data[0];

    // Never the last person who had it: printing a previous holder's name in a
    // column headed Employee is how somebody is asked to return a laptop they
    // handed in.
    expect(row.employeeId).toBeNull();
    expect(row.employeeName).toBeNull();
    expect(row.assignedAt).toBeNull();
  });

  it('totals every matching row, from the same WHERE as the page', async () => {
    db.asset.findMany.mockResolvedValue([reportAsset()]);
    db.asset.aggregate.mockResolvedValue({
      _count: { _all: 80 },
      _sum: { purchasePrice: 20_000_000, currentValue: 16_000_000 },
    });

    const body = (await get('/reports/assets?limit=1')).json();

    expect(body.data).toHaveLength(1);
    // Eighty, not one. The footer describes the filters, not the page.
    expect(body.totals).toEqual({ rows: 80, purchaseValue: 20_000_000, currentValue: 16_000_000 });
    expect(body.meta.total).toBe(80);

    const page = firstArg(db.asset.findMany).where;
    const totals = firstArg(db.asset.aggregate).where;
    // The SAME object, not two built the same way.
    expect(totals).toBe(page);
  });

  it('reads department and team as facts about the HOLDER, beside the column it prints', async () => {
    await get('/reports/assets?departmentId=dept-dev&teamId=team-platform');

    const clauses = andClauses(firstArg(db.asset.findMany).where);
    expect(clauses).toContainEqual({
      assignments: {
        some: {
          status: 'ACTIVE',
          employee: { departmentId: 'dept-dev', teamId: 'team-platform' },
        },
      },
    });
    // And NOT as the asset's own department column, which is what the list
    // screen's filter of the same name means.
    expect(clauses).not.toContainEqual({ departmentId: 'dept-dev' });
  });

  it('adds no holder clause at all when nobody asked for one', async () => {
    await get('/reports/assets');

    const clauses = andClauses(firstArg(db.asset.findMany).where);
    // An unasked-for `some` on ACTIVE would quietly drop every unheld asset
    // from a report nobody had narrowed.
    expect(clauses.some((clause) => JSON.stringify(clause).includes('ACTIVE'))).toBe(false);
  });

  it('shares its category clause with the list screen, groups included', async () => {
    await get('/reports/assets?categoryId=cat-it');

    const clauses = andClauses(firstArg(db.asset.findMany).where);
    expect(clauses).toContainEqual({
      OR: [{ categoryId: 'cat-it' }, { category: { parentCategoryId: 'cat-it' } }],
    });
  });
});

describe('the employee register', () => {
  it('is one row per HANDOVER', async () => {
    db.assetAssignment.findMany.mockResolvedValue([registerRow()]);
    db.assetAssignment.count.mockResolvedValue(1);

    const row = (await get('/reports/employees')).json().data[0];

    expect(row).toMatchObject({
      assignmentId: 'assign-1',
      employeeName: 'Ahmed Khan',
      teamName: 'Platform',
      assetTag: 'IT-LAP-0042',
      assignmentStatus: 'ACTIVE',
      acknowledgementStatus: 'ACKNOWLEDGED',
      condition: 'GOOD',
    });
  });

  it('defaults to what people are holding NOW', async () => {
    await get('/reports/employees');

    expect(firstArg(db.assetAssignment.findMany).where.status).toBe('ACTIVE');
  });

  it('keeps every handover ever recorded when asked for ALL', async () => {
    await get('/reports/employees?scope=ALL');

    const where = firstArg(db.assetAssignment.findMany).where;
    // No status constraint: flattening this into the asset report would drop
    // everybody who has handed something back, which is exactly the list HR
    // cannot afford to be missing from.
    expect(where.status).toBeUndefined();
  });

  it('reads the condition it came back in once it has come back', async () => {
    db.assetAssignment.findMany.mockResolvedValue([
      registerRow({
        status: 'RETURNED',
        returnedAt: new Date('2026-09-18T10:00:00.000Z'),
        conditionAtAssignment: 'NEW',
        conditionAtReturn: 'FAIR',
      }),
    ]);
    db.assetAssignment.count.mockResolvedValue(1);

    const row = (await get('/reports/employees')).json().data[0];

    expect(row.condition).toBe('FAIR');
    expect(row.returnedAt).not.toBeNull();
  });

  it('totals the money off the assets behind the handovers, not off the page', async () => {
    db.assetAssignment.count.mockResolvedValue(3);
    db.assetAssignment.findMany.mockImplementation(async (args: { select?: unknown }) =>
      args.select
        ? [
            { asset: { purchasePrice: 100, currentValue: 80 } },
            { asset: { purchasePrice: 200, currentValue: 150 } },
            { asset: { purchasePrice: null, currentValue: null } },
          ]
        : [registerRow()],
    );

    const body = (await get('/reports/employees?limit=1')).json();

    expect(body.data).toHaveLength(1);
    expect(body.totals).toEqual({ rows: 3, purchaseValue: 300, currentValue: 230 });
  });
});

describe('the exports', () => {
  it('is the JSON, formatted: a header row of labels and a row per asset', async () => {
    db.asset.count.mockResolvedValue(1);
    db.asset.findMany.mockResolvedValue([reportAsset()]);

    const response = await get('/reports/assets.csv');
    const lines = response.body.replace(/^﻿/, '').trim().split('\r\n');

    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('asset-report-');
    expect(lines[0]).toMatch(/^Employee,Employee ID,Department,Asset Tag/);
    expect(lines[1]).toContain('Ahmed Khan');
    expect(lines[1]).toContain('IT-LAP-0042');
    // The LABEL, not the enum: a spreadsheet is read by a person.
    expect(lines[1]).toContain('Assigned');
    expect(lines[1]).not.toContain('ASSIGNED');
  });

  it('carries only the columns that were asked for, in the catalogue order', async () => {
    db.asset.count.mockResolvedValue(1);
    db.asset.findMany.mockResolvedValue([reportAsset()]);

    const response = await get('/reports/assets.csv?columns=assetName,assetTag');
    const header = response.body.replace(/^﻿/, '').split('\r\n')[0];

    expect(header).toBe('Asset Tag,Asset');
  });

  it('ignores a column key it does not recognise rather than refusing the export', async () => {
    db.asset.count.mockResolvedValue(1);
    db.asset.findMany.mockResolvedValue([reportAsset()]);

    const response = await get('/reports/assets.csv?columns=assetTag,inventedLastWeek');
    const header = response.body.replace(/^﻿/, '').split('\r\n')[0];

    // A browser a release behind should get the columns that still exist, not
    // a 422 halfway through somebody's export.
    expect(response.statusCode).toBe(200);
    expect(header).toBe('Asset Tag');
  });

  it('escapes a value carrying a comma', async () => {
    db.asset.count.mockResolvedValue(1);
    db.asset.findMany.mockResolvedValue([
      reportAsset({ name: 'Latitude 5440, dock and bag' }),
    ]);

    const response = await get('/reports/assets.csv?columns=assetName');

    expect(response.body).toContain('"Latitude 5440, dock and bag"');
  });

  it('REFUSES an export too big to be honest, rather than truncating it', async () => {
    db.asset.count.mockResolvedValue(20_001);

    const response = await get('/reports/assets.csv');

    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain('20,001');
    // Nothing was read and nothing was written: a silently shortened export is
    // a spreadsheet with the wrong rows in it, emailed to somebody.
    expect(db.asset.findMany).not.toHaveBeenCalled();
    expect(auditActions(db)).toEqual([]);
  });

  it('records every export that does leave the building', async () => {
    db.asset.count.mockResolvedValue(1);
    db.asset.findMany.mockResolvedValue([reportAsset()]);

    await get('/reports/assets.csv');

    expect(auditActions(db)).toEqual(['asset.report.export']);
    const summary = firstArg(db.auditLog.create).data.summary;
    expect(summary).toContain('asset report');
    expect(summary).toContain('1 rows');
  });

  it('names the employee register export by the scope it was taken in', async () => {
    db.assetAssignment.count.mockResolvedValue(0);

    const current = await get('/reports/employees.csv');
    const all = await get('/reports/employees.csv?scope=ALL');

    expect(current.headers['content-disposition']).toContain('employee-asset-register-current-');
    expect(all.headers['content-disposition']).toContain('employee-asset-register-all-');
  });

  it('applies the SAME filters to the export as to the screen', async () => {
    db.asset.count.mockResolvedValue(0);

    await get('/reports/assets?categoryId=cat-it&status=LOST');
    const screen = firstArg(db.asset.findMany).where;

    vi.clearAllMocks();
    wirePeople(db);
    db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
    db.asset.count.mockResolvedValue(0);
    db.asset.findMany.mockResolvedValue([]);

    await get('/reports/assets.csv?categoryId=cat-it&status=LOST');
    const exported = firstArg(db.asset.findMany).where;

    expect(exported).toEqual(screen);
  });
});
