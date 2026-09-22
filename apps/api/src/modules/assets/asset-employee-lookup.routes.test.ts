import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The employee lookup the asset dialogs pick a person from.
 *
 * Three claims, and the middle one is why the endpoint exists at all.
 *
 *   - WHO MAY CALL IT is whoever may actually hand out, move on or write off
 *     company property. Not `asset.read`, which every member of staff holds for
 *     their own laptop and which would have turned this into a company roster
 *     for all eighty of them.
 *   - WHAT IT RETURNS is six fields, and the assertion is on the SELECT the
 *     route handed the database rather than only on the response. A route that
 *     read the whole employee row and mapped six fields out of it would pass a
 *     response-shaped test and would still have pulled somebody's CNIC, bank
 *     account and date of birth off the disk - and the next person to add a
 *     field to the mapper would have published them.
 *   - IT IS NOT NARROWED BY DATA SCOPE, deliberately, because the role it was
 *     built for is scoped OWN and a scoped lookup would return the caller and
 *     nobody else. What bounds it is the company and those six columns.
 */

const db = vi.hoisted(() => ({
  employee: { findMany: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const kit = await import('./assets.test-kit.js');
const { assetEmployeeLookupRoutes } = await import('./asset-employee-lookup.routes.js');
const { appAs } = kit;

const PREFIX = '/assets';
const URL = `${PREFIX}/employee-lookup`;

const IT_ASSET_MANAGER = DEFAULT_ROLE_PERMISSIONS.IT_ASSET_MANAGER as Permission[];
const ORDINARY_EMPLOYEE = DEFAULT_ROLE_PERMISSIONS.EMPLOYEE as Permission[];

/**
 * A row exactly as the route's own SELECT would produce it.
 *
 * Note what a Prisma `select` makes impossible and what this fixture therefore
 * cannot contain: there is no `nationalId`, `bankAccountNumber`, `dateOfBirth`,
 * `personalEmail` or `presentAddress` here, because the query never asked for
 * them. The "sensitive fields are absent" test below asserts that at the query,
 * not by checking this object.
 */
const ROW = {
  id: 'emp-ahmed',
  employeeNumber: 'GE-014',
  firstName: 'Ahmed',
  lastName: 'Raza',
  displayName: null,
  status: 'ACTIVE',
  workEmail: 'ahmed@example.com',
  department: { name: 'Engineering' },
  team: { name: 'Platform' },
};

const LEAVER = {
  ...ROW,
  id: 'emp-hira',
  employeeNumber: 'GE-002',
  firstName: 'Hira',
  lastName: 'Khan',
  status: 'RESIGNED',
  team: null,
  department: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.employee.findMany.mockResolvedValue([ROW]);
});

/** The single argument the route handed `employee.findMany`. */
function queryArgs(): {
  select: Record<string, unknown>;
  where: { AND: Array<Record<string, unknown>> };
  take: number;
} {
  return db.employee.findMany.mock.calls[0]![0] as never;
}

// -------------------------------------------------------------------- gates

describe('who may look a colleague up', () => {
  it('serves the IT Asset Manager, whose job is handing equipment out', async () => {
    const app = await appAs(assetEmployeeLookupRoutes, {
      prefix: PREFIX,
      permissions: IT_ASSET_MANAGER,
      dataScope: 'OWN',
    });

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
  });

  it('serves HR, who hold every operational grant in the module', async () => {
    const app = await appAs(assetEmployeeLookupRoutes, {
      prefix: PREFIX,
      permissions: DEFAULT_ROLE_PERMISSIONS.HR_ADMIN as Permission[],
      dataScope: 'ALL',
    });

    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(200);
  });

  it('refuses an ordinary member of staff, whose asset.read is for their own laptop', async () => {
    const app = await appAs(assetEmployeeLookupRoutes, {
      prefix: PREFIX,
      permissions: ORDINARY_EMPLOYEE,
      dataScope: 'OWN',
    });

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(403);
    // Refused BEFORE the query, not after it.
    expect(db.employee.findMany).not.toHaveBeenCalled();
  });

  it('refuses a manager, who may read their team’s assets but issues none', async () => {
    const app = await appAs(assetEmployeeLookupRoutes, {
      prefix: PREFIX,
      permissions: DEFAULT_ROLE_PERMISSIONS.MANAGER as Permission[],
      dataScope: 'REPORTS_AND_OWN',
    });

    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(403);
  });

  it('opens on any ONE of the three grants that need a person', async () => {
    for (const grant of [
      PERMISSIONS.ASSET_ASSIGN,
      PERMISSIONS.ASSET_TRANSFER,
      PERMISSIONS.ASSET_DISPOSE,
    ]) {
      const app = await appAs(assetEmployeeLookupRoutes, {
        prefix: PREFIX,
        permissions: [grant],
        dataScope: 'OWN',
      });

      expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(200);
    }
  });
});

// ------------------------------------------------------------- what it reads

describe('what the lookup is allowed to read', () => {
  it('asks the database for exactly the columns the picker renders', async () => {
    const app = await appAs(assetEmployeeLookupRoutes, {
      prefix: PREFIX,
      permissions: IT_ASSET_MANAGER,
      dataScope: 'OWN',
    });
    await app.inject({ method: 'GET', url: URL });

    expect(Object.keys(queryArgs().select).sort()).toEqual([
      'department',
      'displayName',
      'employeeNumber',
      'firstName',
      'id',
      'lastName',
      'status',
      'team',
      'workEmail',
    ]);
  });

  it('never asks for a sensitive field', async () => {
    const app = await appAs(assetEmployeeLookupRoutes, {
      prefix: PREFIX,
      permissions: IT_ASSET_MANAGER,
      dataScope: 'OWN',
    });
    await app.inject({ method: 'GET', url: URL });

    const select = queryArgs().select;
    for (const field of [
      'nationalId',
      'nationalIdIssueDate',
      'passportNumber',
      'visaNumber',
      'bankName',
      'bankAccountNumber',
      'bankAccountTitle',
      'dateOfBirth',
      'gender',
      'maritalStatus',
      'bloodGroup',
      'personalEmail',
      'personalPhone',
      'phone',
      'presentAddress',
      'permanentAddress',
      'emergencyContactName',
      'emergencyContactPhone',
      'hireDate',
      'salary',
      'managerId',
      'photoUrl',
      'photoObjectKey',
    ]) {
      expect(select).not.toHaveProperty(field);
    }
  });

  it('publishes exactly the six fields of the lookup shape', async () => {
    const app = await appAs(assetEmployeeLookupRoutes, {
      prefix: PREFIX,
      permissions: IT_ASSET_MANAGER,
      dataScope: 'OWN',
    });
    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.json().data[0]).toEqual({
      id: 'emp-ahmed',
      employeeNumber: 'GE-014',
      fullName: 'Ahmed Raza',
      departmentName: 'Engineering',
      teamName: 'Platform',
      isActive: true,
      status: 'ACTIVE',
      workEmail: 'ahmed@example.com',
    });
  });

  it('returns no pagination envelope, so the roster’s size is not published', async () => {
    const app = await appAs(assetEmployeeLookupRoutes, {
      prefix: PREFIX,
      permissions: IT_ASSET_MANAGER,
      dataScope: 'OWN',
    });
    const body = response(await app.inject({ method: 'GET', url: URL }));

    expect(body).toHaveProperty('data');
    expect(body).not.toHaveProperty('meta');
  });
});

function response(res: { json: () => unknown }): Record<string, unknown> {
  return res.json() as Record<string, unknown>;
}

// ------------------------------------------------------------ route ordering

describe('the URL cannot be swallowed by the asset detail route', () => {
  it('resolves /assets/employee-lookup to the lookup, not to an asset called "employee-lookup"', async () => {
    /*
     * `/assets/:id` lives in a different plugin on the same prefix, and a
     * router that matched it first would answer this URL with a 404 for an
     * asset nobody owns - which is a confusing way for a picker to break. The
     * segment is static and find-my-way prefers static over parametric, so it
     * wins regardless of registration order. This test is what makes that a
     * guarantee rather than an assumption.
     */
    const { assetRoutes } = await import('./assets.routes.js');
    const { registerErrorHandler } = await import('../../core/error-handler.js');
    const Fastify = (await import('fastify')).default;

    const app = Fastify();
    registerErrorHandler(app);
    app.decorateRequest('auth', null);
    app.addHook('onRequest', async (request) => {
      request.auth = {
        sessionId: 'session-1',
        userId: 'user-it',
        companyId: 'company-1',
        email: 'it@example.com',
        permissions: new Set(IT_ASSET_MANAGER),
        dataScope: 'OWN',
        mustChangePassword: false,
      };
    });
    // The DETAIL plugin registered first and the lookup second - the worst
    // case for ordering, and the one the router must still get right.
    await app.register(assetRoutes, { prefix: PREFIX });
    await app.register(assetEmployeeLookupRoutes, { prefix: PREFIX });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ leavers

describe('who appears in the list', () => {
  it('leaves out the people who have left', async () => {
    const app = await appAs(assetEmployeeLookupRoutes, {
      prefix: PREFIX,
      permissions: IT_ASSET_MANAGER,
      dataScope: 'OWN',
    });
    await app.inject({ method: 'GET', url: URL });

    expect(queryArgs().where.AND).toContainEqual({
      status: { notIn: ['RESIGNED', 'TERMINATED'] },
    });
  });

  it('includes them when a return or a disposal asks for them', async () => {
    db.employee.findMany.mockResolvedValue([LEAVER]);
    const app = await appAs(assetEmployeeLookupRoutes, {
      prefix: PREFIX,
      permissions: IT_ASSET_MANAGER,
      dataScope: 'OWN',
    });
    const res = await app.inject({ method: 'GET', url: `${URL}?includeInactive=true` });

    expect(queryArgs().where.AND).not.toContainEqual({
      status: { notIn: ['RESIGNED', 'TERMINATED'] },
    });
    // And they are flagged, so the picker can say so rather than imply they work here.
    expect(res.json().data[0].isActive).toBe(false);
    expect(res.json().data[0].status).toBe('RESIGNED');
  });

  it('is capped, whatever the caller asks for', async () => {
    const app = await appAs(assetEmployeeLookupRoutes, {
      prefix: PREFIX,
      permissions: IT_ASSET_MANAGER,
      dataScope: 'OWN',
    });
    const response = await app.inject({ method: 'GET', url: `${URL}?limit=5000` });

    // Refused rather than silently clamped: a caller asking for five thousand
    // people is not picking one of them.
    expect(response.statusCode).toBe(422);
  });

  it('searches the three columns that identify somebody, and no others', async () => {
    const app = await appAs(assetEmployeeLookupRoutes, {
      prefix: PREFIX,
      permissions: IT_ASSET_MANAGER,
      dataScope: 'OWN',
    });
    await app.inject({ method: 'GET', url: `${URL}?q=Ahmed` });

    const clause = queryArgs().where.AND.find((c) => Array.isArray(c.OR)) as {
      OR: Array<Record<string, unknown>>;
    };
    expect(Object.keys(clause.OR[0]!)).toEqual(['firstName']);
    expect(clause.OR.map((c) => Object.keys(c)[0])).toEqual([
      'firstName',
      'lastName',
      'displayName',
      'employeeNumber',
      'workEmail',
    ]);
    // Notably absent: department and job title. Being able to ask "who is in
    // Finance" and get a list back is a directory.
    expect(JSON.stringify(clause.OR)).not.toContain('department');
    expect(JSON.stringify(clause.OR)).not.toContain('jobTitle');
  });

  it('never leaves the caller’s own company', async () => {
    const app = await appAs(assetEmployeeLookupRoutes, {
      prefix: PREFIX,
      permissions: IT_ASSET_MANAGER,
      companyId: 'company-9',
      dataScope: 'OWN',
    });
    await app.inject({ method: 'GET', url: URL });

    expect(queryArgs().where.AND).toContainEqual({ companyId: 'company-9' });
  });
});
