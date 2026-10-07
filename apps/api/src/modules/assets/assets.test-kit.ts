import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { vi } from 'vitest';
import { PERMISSIONS, type DataScope, type Permission } from '@hrms/shared';

/**
 * Shared scaffolding for the asset tests.
 *
 * Two things live here: the cast of people every test needs, and the one
 * function that mounts a plugin behind a chosen set of grants. Both exist
 * because the interesting claims in this module are almost all claims about WHO
 * CAN DO WHAT, and a test of that has to be able to say "the same request, from
 * somebody holding these permissions" without twenty lines of setup each time.
 *
 * The grant sets below are the roles as `DEFAULT_ROLE_PERMISSIONS` actually
 * defines them, restated here on purpose rather than imported: a test that read
 * the same constant the code reads would still pass if somebody handed the
 * Employee role `asset.create` tomorrow, which is precisely the change that
 * must fail loudly.
 */

export const COMPANY = 'company-1';

/** HR: runs the register, and holds every operational grant in the module. */
export const HR: Permission[] = [
  PERMISSIONS.ASSET_READ,
  PERMISSIONS.ASSET_READ_ALL,
  PERMISSIONS.ASSET_CREATE,
  PERMISSIONS.ASSET_UPDATE,
  PERMISSIONS.ASSET_ASSIGN,
  PERMISSIONS.ASSET_TRANSFER,
  PERMISSIONS.ASSET_RETURN,
  PERMISSIONS.ASSET_REPAIR,
  PERMISSIONS.ASSET_RETIRE,
  PERMISSIONS.ASSET_DISPOSE,
  PERMISSIONS.ASSET_CATEGORY_MANAGE,
  PERMISSIONS.ASSET_REPORT,
];

/**
 * A manager: `asset.read` and nothing else of the module.
 *
 * Note what is absent - `asset.read.all`. The assets nobody is holding are the
 * company's stock, not their team's.
 */
export const MANAGER: Permission[] = [PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.ASSET_READ];

/**
 * Everything an ordinary member of staff holds in this module, plus the widest
 * employee-facing grants in the product.
 *
 * Deliberately generous: the point of this set is that it contains
 * `employee.manage` and `employee.sensitive.read` and still cannot add, edit or
 * assign a single asset. Section 7 names six grants an employee must never
 * hold, and this set is the assertion that none of them arrives by another
 * route.
 */
export const EMPLOYEE: Permission[] = [
  PERMISSIONS.ASSET_READ,
  PERMISSIONS.EMPLOYEE_READ,
  PERMISSIONS.EMPLOYEE_MANAGE,
  PERMISSIONS.EMPLOYEE_SENSITIVE_READ,
  PERMISSIONS.LEAVE_READ,
  PERMISSIONS.ATTENDANCE_READ,
];

export interface Person {
  id: string;
  userId: string;
  departmentId: string | null;
}

export const HR_USER: Person = { id: 'emp-hr', userId: 'user-hr', departmentId: 'dept-hr' };
export const AHMED: Person = { id: 'emp-ahmed', userId: 'user-ahmed', departmentId: 'dept-dev' };
export const SANA: Person = { id: 'emp-sana', userId: 'user-sana', departmentId: 'dept-dev' };

export const PEOPLE: Person[] = [HR_USER, AHMED, SANA];

/**
 * Mounts one plugin behind a chosen session.
 *
 * The auth context is written directly rather than going through the real
 * session resolver, which is what lets a test ask "what does this endpoint do
 * for somebody holding exactly these two grants" - the question the whole
 * module's design turns on.
 *
 * `dataScope` defaults to OWN here, unlike the recruitment kit's ALL, and the
 * difference is itself an assertion: assets ARE narrowed by data scope, so a
 * test that handed every caller the widest scope would prove nothing about the
 * narrowing.
 */
export async function appAs(
  plugin: FastifyPluginAsync,
  options: {
    prefix: string;
    permissions?: Permission[];
    userId?: string;
    companyId?: string;
    dataScope?: DataScope;
  },
): Promise<FastifyInstance> {
  const { registerErrorHandler } = await import('../../core/error-handler.js');

  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: options.userId ?? HR_USER.userId,
      companyId: options.companyId ?? COMPANY,
      email: 'someone@example.com',
      permissions: new Set(options.permissions ?? HR),
      dataScope: options.dataScope ?? 'OWN',
      mustChangePassword: false,
    };
  });
  await app.register(plugin, { prefix: options.prefix });
  await app.ready();
  return app;
}

/**
 * The slice of Prisma the asset module touches.
 *
 * NOTE WHAT IS ABSENT: there is no `delete` on `asset`, `assetAssignment`,
 * `assetRepair` or `assetIncident`, and the omission is the assertion. Nothing
 * in this module removes an asset, a handover, a repair or an incident - a
 * disposed asset is an UPDATE, a returned handover is an UPDATE, and a lost
 * laptop stays on the register. A route that grew a `delete` call would crash
 * every test in every file that uses this kit, which is a louder failure than
 * any single expectation would give.
 *
 * Hoisted so `vi.mock` can close over it, in the style the recruitment, lunch
 * and cases tests already use. Every method is a bare `vi.fn`: each test wires
 * up only the calls its own route makes, which keeps a test readable as a
 * statement about one endpoint rather than as a database fixture.
 */
export function assetDb() {
  return {
    company: { findUnique: vi.fn() },
    department: { findFirst: vi.fn(), findMany: vi.fn() },
    location: { findFirst: vi.fn() },
    employee: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    assetCategory: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    asset: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
      // Step 3: the asset report totals every row the filters match, in one
      // round trip, rather than summing the page on screen.
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      // The compare-and-swap that claims an asset for a handover. `updateMany`
      // rather than `update` on purpose - see `asset-lifecycle.service.ts`.
      updateMany: vi.fn(),
    },
    assetAssignment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    assetRepair: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    assetIncident: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    // Who an employee's issue report is sent to. Empty unless a test says
    // otherwise - see `useAssetDb`.
    user: { findMany: vi.fn() },
    assetDocument: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn(), findMany: vi.fn() },
    notification: { create: vi.fn() },
    /**
     * Runs the callback against the same mock, which models the only property
     * of a transaction these tests care about: that the writes inside one are
     * the writes that happen. Atomicity is the database's job and is asserted
     * by the migration, not here.
     *
     * Wired by `useAssetDb` in each test file's `beforeEach`.
     */
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(assetDbRef)),
  };
}

/** The live mock, so `$transaction` can hand itself back. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let assetDbRef: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useAssetDb(db: any): void {
  assetDbRef = db;
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  db.user?.findMany?.mockResolvedValue([]);
}

/**
 * Wires the one lookup every narrowed read performs: the caller's own employee
 * row, which `employeeScopeFilter` uses to anchor a scope narrower than ALL.
 *
 * Note what this does NOT do: it does not decide who may see what. It answers
 * truthfully for anybody in the cast, so a test that ends in "and they saw
 * nothing" got that answer from the route's own filter rather than from a
 * lookup that quietly failed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wirePeople(db: any): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.employee.findFirst.mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    if (typeof where.userId === 'string') {
      const person = PEOPLE.find((candidate) => candidate.userId === where.userId);
      return person ? { id: person.id, departmentId: person.departmentId } : null;
    }
    if (typeof where.id === 'string') {
      const person = PEOPLE.find((candidate) => candidate.id === where.id);
      return person ? { id: person.id, departmentId: person.departmentId } : null;
    }
    return null;
  });
}

/** The audit actions recorded during one test, in order. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function auditActions(db: any): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.auditLog.create.mock.calls.map((call: any[]) => call[0].data.action as string);
}

/** The AND array a route hands Prisma, flattened for reading. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function andClauses(where: any): any[] {
  return (where?.AND ?? []) as unknown[];
}

// ------------------------------------------------------------------ fixtures

export const NOW = new Date('2026-09-19T05:00:00.000Z');

type Overrides = Record<string, unknown>;

/**
 * A row as Prisma hands it back, with the includes the service asks for.
 *
 * Dates are `Date` objects and not strings, because that is what Prisma returns
 * and because `toAssetRecord` calls `.toISOString()` on them: a string fixture
 * would pass a test that the real route would crash on.
 */
export function assetRow(overrides: Overrides = {}) {
  return {
    id: 'asset-1',
    companyId: COMPANY,
    assetTag: 'IT-LAP-0042',
    name: 'Dell Latitude 5440',
    categoryId: 'cat-laptop',
    brand: 'Dell',
    model: 'Latitude 5440',
    serialNumber: 'SN-ABC-123',
    purchaseDate: new Date('2026-01-15T00:00:00.000Z'),
    purchasePrice: 250000,
    currentValue: 200000,
    vendor: 'Computer Marketing',
    warrantyStart: new Date('2026-01-15T00:00:00.000Z'),
    warrantyEnd: new Date('2029-01-15T00:00:00.000Z'),
    locationId: 'loc-lahore',
    location: 'Desk 14',
    departmentId: 'dept-dev',
    condition: 'GOOD',
    status: 'AVAILABLE',
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    category: { id: 'cat-laptop', name: 'Laptop', parent: { name: 'IT Equipment' } },
    site: { id: 'loc-lahore', name: 'Lahore Office' },
    department: { id: 'dept-dev', name: 'Development' },
    assignments: [],
    ...overrides,
  };
}

/** The active-assignment include, as the register reads it off a row. */
export function activeAssignment(person: Person, overrides: Overrides = {}) {
  return {
    id: `assign-${person.id}`,
    assignedAt: NOW,
    employee: {
      id: person.id,
      employeeNumber: 'EMP-0007',
      firstName: 'Ahmed',
      lastName: 'Khan',
      department: { name: 'Development' },
    },
    ...overrides,
  };
}

export function categoryRow(overrides: Overrides = {}) {
  return {
    id: 'cat-it',
    companyId: COMPANY,
    parentCategoryId: null,
    name: 'IT Equipment',
    description: 'Computers and peripherals.',
    sortOrder: 0,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    parent: null,
    _count: { assets: 0 },
    ...overrides,
  };
}

/**
 * A full assignment row, as the lifecycle routes read it back.
 *
 * Carries the step 2 columns - accessories, acknowledgement, the transfer chain
 * - because `toAssetAssignmentRecord` reads every one of them, and a fixture
 * missing an array would pass a test the real route would crash on.
 */
export function assignmentRow(person: Person, overrides: Overrides = {}) {
  return {
    id: `assign-${person.id}`,
    companyId: COMPANY,
    assetId: 'asset-1',
    employeeId: person.id,
    assignedAt: NOW,
    returnedAt: null,
    assignedById: HR_USER.userId,
    returnedById: null,
    conditionAtAssignment: 'GOOD',
    conditionAtReturn: null,
    accessoriesIssued: ['Laptop charger', 'Laptop bag'],
    accessoriesReturned: [],
    accessoriesMissing: [],
    damageDescription: null,
    notes: null,
    returnNotes: null,
    reason: null,
    previousAssignmentId: null,
    acknowledgementStatus: 'PENDING',
    acknowledgedAt: null,
    acknowledgedById: null,
    status: 'ACTIVE',
    createdAt: NOW,
    updatedAt: NOW,
    employee: {
      id: person.id,
      employeeNumber: 'EMP-0007',
      firstName: 'Ahmed',
      lastName: 'Khan',
      department: { name: 'Development' },
    },
    assignedBy: null,
    returnedBy: null,
    acknowledgedBy: null,
    ...overrides,
  };
}

export function repairRow(overrides: Overrides = {}) {
  return {
    id: 'repair-1',
    companyId: COMPANY,
    assetId: 'asset-1',
    problem: 'Screen flickers',
    reportedOn: new Date('2026-09-18T00:00:00.000Z'),
    sentOn: new Date('2026-09-19T00:00:00.000Z'),
    expectedReturnOn: null,
    returnedOn: null,
    vendor: 'Dell Service',
    estimatedCost: 12000,
    actualCost: null,
    notes: null,
    completionNotes: null,
    status: 'IN_PROGRESS',
    statusBeforeRepair: 'ASSIGNED',
    sentById: HR_USER.userId,
    completedById: null,
    createdAt: NOW,
    updatedAt: NOW,
    sentBy: null,
    completedBy: null,
    ...overrides,
  };
}

export function incidentRow(overrides: Overrides = {}) {
  return {
    id: 'incident-1',
    companyId: COMPANY,
    assetId: 'asset-1',
    assignmentId: null,
    kind: 'DAMAGED',
    occurredOn: new Date('2026-09-19T00:00:00.000Z'),
    reason: 'Dropped, screen cracked',
    description: null,
    notes: null,
    reportedById: HR_USER.userId,
    reportedByEmployeeId: null,
    resolvedAt: null,
    resolvedById: null,
    resolutionNotes: null,
    createdAt: NOW,
    updatedAt: NOW,
    reportedBy: null,
    reportedByEmployee: null,
    ...overrides,
  };
}

/** An assignment row as the employee-facing screens read it back. */
export function employeeAssignmentRow(person: Person, overrides: Overrides = {}) {
  return {
    ...assignmentRow(person),
    asset: {
      id: 'asset-1',
      assetTag: 'IT-LAP-0042',
      name: 'Dell Latitude 5440',
      serialNumber: 'SN-ABC-123',
      status: 'ASSIGNED',
      currentValue: 200000,
      category: { name: 'Laptop' },
    },
    ...overrides,
  };
}
