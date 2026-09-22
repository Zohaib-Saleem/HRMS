import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  EMPLOYMENT_STATUSES,
  PERMISSIONS,
  type DataScope,
  type Permission,
} from '@hrms/shared';

/**
 * Employment status on the employee record.
 *
 * The canonical field - the one Loans and Medical both read - so what this file
 * holds down is the field itself rather than any benefit's use of it:
 *
 *   - The three values exist, and nothing else does. An arbitrary string is
 *     refused by the schema before any route sees it, which is the difference
 *     between an enum and the free-text column this replaced.
 *   - Only somebody with employee.manage changes it. An employee reading their
 *     own record can SEE their status and has no route by which to move it, and
 *     that is asserted against the REAL default role catalogue rather than a
 *     hand-written permission list, so a drift in the defaults fails here.
 *   - Confirming somebody means saying when. Probation -> Permanent carries a
 *     confirmation date or it does not happen, merged against the stored row so
 *     the date may arrive in the same call or have been set earlier.
 *   - Nothing else on the record moves. Not the id, not the employee number,
 *     not the PunchCode, not the Active/Inactive status, not the employment
 *     type, and not the salary - asserted against the actual update rather than
 *     assumed from the response.
 *   - The change is recorded as the HR event it is, in the audit log the
 *     product already has.
 */

const db = vi.hoisted(() => {
  interface Row {
    id: string;
    companyId: string;
    employeeNumber: string;
    firstName: string;
    lastName: string;
    employmentStatus: string | null;
    employmentType: string;
    status: string;
    confirmationDate: Date | null;
    hireDate: Date | null;
    userId: string | null;
    managerId: string | null;
    departmentId: string | null;
    [key: string]: unknown;
  }

  const rows = new Map<string, Row>();
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const audits: Array<Record<string, unknown>> = [];

  const matches = (row: Row, where: Record<string, unknown>): boolean => {
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (key === 'AND') {
        const clauses = value as Array<Record<string, unknown>>;
        if (!clauses.every((clause) => matches(row, clause))) return false;
        continue;
      }
      if (key === 'NOT') {
        if (matches(row, value as Record<string, unknown>)) return false;
        continue;
      }
      if (key === 'OR') {
        const clauses = value as Array<Record<string, unknown>>;
        if (!clauses.some((clause) => matches(row, clause))) return false;
        continue;
      }
      if (row[key] !== value) return false;
    }
    return true;
  };

  const find = (where: Record<string, unknown>) => {
    const out: Row[] = [];
    for (const row of rows.values()) if (matches(row, where)) out.push({ ...row });
    return out;
  };

  return {
    rows,
    updates,
    audits,
    find,
    employee: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => find(where)[0] ?? null),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => find(where ?? {})),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => find(where ?? {}).length),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      }),
    },
    // Present so that a stray write to any of them is a failed assertion rather
    // than an undefined-is-not-a-function that reads like a bug in the test.
    employeeSalary: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    employeeLoan: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    medicalClaim: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    attendanceDeviceUserMapping: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    attendanceRawPunch: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    user: { update: vi.fn(), updateMany: vi.fn() },
  };
});

db.employee.update.mockImplementation(
  async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = db.rows.get(where.id);
    if (!row) throw new Error(`no such employee ${where.id}`);
    db.updates.push({ id: where.id, data: { ...data } });
    Object.assign(row, data);
    return { ...row, workExperience: [], education: [], reports: [] };
  },
);

vi.mock('../../core/db.js', () => ({ prisma: db }));

/**
 * The profile summary is a whole module's worth of salary, loan and attendance
 * reads that this file is not about. Stubbed so the GET under test returns the
 * employee record rather than exercising six other services.
 */
vi.mock('./employee-profile.service.js', () => ({
  employeeProfileSummary: vi.fn(async () => ({ punchCodes: [] })),
}));

const { employeeRoutes } = await import('./employees.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

// The real defaults, so a change to the catalogue is felt here.
const SUPER_ADMIN = DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN;
const HR_ADMIN = DEFAULT_ROLE_PERMISSIONS.HR_ADMIN;
const MANAGER = DEFAULT_ROLE_PERMISSIONS.MANAGER;
const EMPLOYEE = DEFAULT_ROLE_PERMISSIONS.EMPLOYEE;

const TARGET = 'emp-target';

function seed(): void {
  db.rows.clear();
  db.updates.length = 0;
  db.audits.length = 0;

  const base = {
    companyId: 'company-1',
    employmentType: 'FULL_TIME',
    status: 'ACTIVE',
    hireDate: new Date('2024-01-15T00:00:00Z'),
    confirmationDate: null,
    managerId: null,
    secondaryManagerId: null,
    departmentId: 'dept-1',
    teamId: null,
    designationId: null,
    locationId: null,
    photoUrl: null,
    photoObjectKey: null,
    photoUpdatedAt: null,
    middleName: null,
    displayName: null,
    workEmail: null,
    phone: null,
    jobTitle: null,
    excludedFromAttendance: false,
    createdAt: new Date('2024-01-15T00:00:00Z'),
    updatedAt: new Date('2024-01-15T00:00:00Z'),
    // The relations DETAIL_INCLUDE pulls in. Empty rather than absent, because
    // the detail payload maps over them.
    workExperience: [],
    education: [],
    reports: [],
    designation: null,
    department: null,
    team: null,
    location: null,
    manager: null,
    secondaryManager: null,
    user: null,
  };

  db.rows.set(TARGET, {
    ...base,
    id: TARGET,
    employeeNumber: '1020',
    firstName: 'Muhammad',
    lastName: 'AbuBakar',
    employmentStatus: 'PROBATION',
    userId: 'user-target',
  });
  db.rows.set('emp-permanent', {
    ...base,
    id: 'emp-permanent',
    employeeNumber: '1001',
    firstName: 'Already',
    lastName: 'Confirmed',
    employmentStatus: 'PERMANENT',
    confirmationDate: new Date('2024-07-15T00:00:00Z'),
    userId: 'user-permanent',
  });
  db.rows.set('emp-internee', {
    ...base,
    id: 'emp-internee',
    employeeNumber: '1099',
    firstName: 'Summer',
    lastName: 'Internee',
    employmentStatus: 'INTERNEE',
    userId: null,
  });
  db.rows.set('emp-unclassified', {
    ...base,
    id: 'emp-unclassified',
    employeeNumber: '1100',
    firstName: 'Not',
    lastName: 'Classified',
    employmentStatus: null,
    userId: null,
  });
}

interface Caller {
  permissions: readonly Permission[];
  dataScope: DataScope;
  userId: string;
}

async function appAs(caller: Caller): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: caller.userId,
      companyId: 'company-1',
      email: 'caller@example.com',
      permissions: new Set(caller.permissions),
      dataScope: caller.dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(employeeRoutes, { prefix: '/employees' });
  await app.ready();
  return app;
}

const superAdmin = () => appAs({ permissions: SUPER_ADMIN, dataScope: 'ALL', userId: 'user-admin' });
const hrAdmin = () => appAs({ permissions: HR_ADMIN, dataScope: 'ALL', userId: 'user-hr' });
const manager = () =>
  appAs({ permissions: MANAGER, dataScope: 'ALL', userId: 'user-manager' });
const selfServing = () => appAs({ permissions: EMPLOYEE, dataScope: 'OWN', userId: 'user-target' });

const patch = (app: FastifyInstance, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/employees/${id}`, payload });

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe('the three employment statuses', () => {
  it.each(EMPLOYMENT_STATUSES)('accepts %s as an employment status', async (status) => {
    // PERMANENT needs a date with it; the other two do not.
    const response = await patch(await hrAdmin(), TARGET, {
      employmentStatus: status,
      ...(status === 'PERMANENT' ? { confirmationDate: '2026-09-15' } : {}),
    });

    expect(response.statusCode).toBe(200);
    expect(db.rows.get(TARGET)!.employmentStatus).toBe(status);
    expect(response.json<{ data: { employmentStatus: string } }>().data.employmentStatus).toBe(status);
  });

  it('refuses an arbitrary string, which is what the enum is for', async () => {
    for (const bogus of ['Probation', 'probation', 'CONTRACTOR', 'INTERN', '', 'PERMANENT ']) {
      const response = await patch(await hrAdmin(), TARGET, { employmentStatus: bogus });
      expect(response.statusCode).toBe(422);
    }

    // Nothing was written by any of them.
    expect(db.updates).toHaveLength(0);
    expect(db.rows.get(TARGET)!.employmentStatus).toBe('PROBATION');
  });

  it('leaves an unclassified record unclassified rather than guessing', async () => {
    const response = await patch(await hrAdmin(), 'emp-unclassified', { jobTitle: 'Analyst' });

    expect(response.statusCode).toBe(200);
    expect(db.rows.get('emp-unclassified')!.employmentStatus).toBeNull();
  });
});

describe('excluding somebody from attendance', () => {
  /*
   * The partner case. The flag is not a status and not a lifecycle date, so
   * the thing worth pinning is that it travels the ordinary PATCH path: the
   * schema is the whitelist, `toPrismaData` carries it, and a call that does
   * not mention it must not reset it. That last one is the whole risk - the
   * base schema defaults it to false, and if `.partial()` ever stopped
   * suppressing that default, every unrelated save would quietly put a
   * partner back on the attendance sheet.
   */
  it('sets the flag when asked', async () => {
    const response = await patch(await hrAdmin(), TARGET, { excludedFromAttendance: true });

    expect(response.statusCode).toBe(200);
    expect(db.rows.get(TARGET)!.excludedFromAttendance).toBe(true);
  });

  it('carries the flag back on the detail payload', async () => {
    const response = await patch(await hrAdmin(), TARGET, { excludedFromAttendance: true });

    expect(
      response.json<{ data: { excludedFromAttendance: boolean } }>().data.excludedFromAttendance,
    ).toBe(true);
  });

  it('leaves it alone on a PATCH that does not mention it', async () => {
    await patch(await hrAdmin(), TARGET, { excludedFromAttendance: true });
    const response = await patch(await hrAdmin(), TARGET, { jobTitle: 'Partner' });

    expect(response.statusCode).toBe(200);
    expect(db.rows.get(TARGET)!.excludedFromAttendance).toBe(true);
  });

  it('clears it again when asked, so the exclusion is reversible', async () => {
    await patch(await hrAdmin(), TARGET, { excludedFromAttendance: true });
    const response = await patch(await hrAdmin(), TARGET, { excludedFromAttendance: false });

    expect(response.statusCode).toBe(200);
    expect(db.rows.get(TARGET)!.excludedFromAttendance).toBe(false);
  });

  it('refuses a caller who may read employees but not manage them', async () => {
    const response = await patch(await manager(), TARGET, { excludedFromAttendance: true });

    expect(response.statusCode).toBe(403);
    expect(db.rows.get(TARGET)!.excludedFromAttendance).toBe(false);
  });

  it('refuses the employee themselves - being outside attendance is not self-serve', async () => {
    const response = await patch(await selfServing(), TARGET, { excludedFromAttendance: true });

    expect(response.statusCode).toBe(403);
    expect(db.rows.get(TARGET)!.excludedFromAttendance).toBe(false);
  });

  it('rejects a non-boolean rather than coercing it', async () => {
    for (const bogus of ['yes', 'true', 1, null]) {
      const response = await patch(await hrAdmin(), TARGET, { excludedFromAttendance: bogus });
      expect(response.statusCode).toBe(422);
    }

    expect(db.rows.get(TARGET)!.excludedFromAttendance).toBe(false);
  });
});

describe('who may change it', () => {
  it('lets a Super Admin change it', async () => {
    const response = await patch(await superAdmin(), TARGET, { employmentStatus: 'INTERNEE' });

    expect(response.statusCode).toBe(200);
    expect(db.rows.get(TARGET)!.employmentStatus).toBe('INTERNEE');
  });

  it('lets an HR Admin change it, through the existing employee.manage grant', async () => {
    expect(HR_ADMIN).toContain(PERMISSIONS.EMPLOYEE_MANAGE);

    const response = await patch(await hrAdmin(), TARGET, { employmentStatus: 'INTERNEE' });

    expect(response.statusCode).toBe(200);
    expect(db.rows.get(TARGET)!.employmentStatus).toBe('INTERNEE');
  });

  it('refuses an employee changing their own, and writes nothing', async () => {
    // Not a rule invented for this field: the employee role holds no employee
    // permission at all, and PATCH has always required employee.manage.
    expect(EMPLOYEE).not.toContain(PERMISSIONS.EMPLOYEE_MANAGE);
    expect(EMPLOYEE).not.toContain(PERMISSIONS.EMPLOYEE_READ);

    const response = await patch(await selfServing(), TARGET, { employmentStatus: 'PERMANENT' });

    expect(response.statusCode).toBe(403);
    expect(db.updates).toHaveLength(0);
    expect(db.rows.get(TARGET)!.employmentStatus).toBe('PROBATION');
  });

  /*
   * An employee's own view of their status is /me/dashboard, not this module -
   * the employee role reaches no People route at all. What that leaves to prove
   * here is the rung above: a manager who can SEE a report's record still
   * cannot move their employment status, because reading and managing are
   * different grants and this field did not blur them.
   */
  it('lets a manager read the record but not move the status', async () => {
    expect(MANAGER).toContain(PERMISSIONS.EMPLOYEE_READ);
    expect(MANAGER).not.toContain(PERMISSIONS.EMPLOYEE_MANAGE);

    const read = await (await manager()).inject({ method: 'GET', url: `/employees/${TARGET}` });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ data: { employmentStatus: string } }>().data.employmentStatus).toBe(
      'PROBATION',
    );

    const write = await patch(await manager(), TARGET, { employmentStatus: 'PERMANENT' });
    expect(write.statusCode).toBe(403);
    expect(db.updates).toHaveLength(0);
    expect(db.rows.get(TARGET)!.employmentStatus).toBe('PROBATION');
  });
});

describe('probation to permanent', () => {
  it('confirms somebody when the date comes with it', async () => {
    const response = await patch(await hrAdmin(), TARGET, {
      employmentStatus: 'PERMANENT',
      confirmationDate: '2026-09-15',
    });

    expect(response.statusCode).toBe(200);
    const row = db.rows.get(TARGET)!;
    expect(row.employmentStatus).toBe('PERMANENT');
    expect((row.confirmationDate as Date).toISOString().slice(0, 10)).toBe('2026-09-15');
  });

  it('refuses to confirm somebody with no confirmation date anywhere', async () => {
    const response = await patch(await hrAdmin(), TARGET, { employmentStatus: 'PERMANENT' });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { details: Record<string, string[]> } }>().error.details)
      .toHaveProperty('confirmationDate');
    expect(db.rows.get(TARGET)!.employmentStatus).toBe('PROBATION');
  });

  it('accepts the status alone when the record already carries a date', async () => {
    // The date was set first, in an earlier call. Merging against the stored
    // row is what lets the two arrive in either order.
    await patch(await hrAdmin(), TARGET, { confirmationDate: '2026-09-15' });
    const response = await patch(await hrAdmin(), TARGET, { employmentStatus: 'PERMANENT' });

    expect(response.statusCode).toBe(200);
    expect(db.rows.get(TARGET)!.employmentStatus).toBe('PERMANENT');
  });

  it('refuses a payload that confirms somebody while clearing the date', async () => {
    const response = await patch(await hrAdmin(), 'emp-permanent', { confirmationDate: null });

    expect(response.statusCode).toBe(422);
  });

  it('changes nothing else: not Active/Inactive, not the type, not the salary', async () => {
    const before = { ...db.rows.get(TARGET)! };

    await patch(await hrAdmin(), TARGET, {
      employmentStatus: 'PERMANENT',
      confirmationDate: '2026-09-15',
    });

    const row = db.rows.get(TARGET)!;
    expect(row.status).toBe(before.status);
    expect(row.employmentType).toBe(before.employmentType);
    expect(row.hireDate).toEqual(before.hireDate);

    // The identity columns in particular. An employment stage is not an
    // identity change, and a PunchCode lives on the device mapping, which this
    // route has no business writing at all.
    expect(row.id).toBe(before.id);
    expect(row.employeeNumber).toBe(before.employeeNumber);
    expect(db.attendanceDeviceUserMapping.update).not.toHaveBeenCalled();
    expect(db.attendanceDeviceUserMapping.updateMany).not.toHaveBeenCalled();

    // No benefit record is touched. Loans and medical read the status when they
    // are next asked; nothing is pushed at them.
    expect(db.employeeSalary.create).not.toHaveBeenCalled();
    expect(db.employeeSalary.update).not.toHaveBeenCalled();
    expect(db.employeeLoan.update).not.toHaveBeenCalled();
    expect(db.employeeLoan.updateMany).not.toHaveBeenCalled();
    expect(db.medicalClaim.update).not.toHaveBeenCalled();
    expect(db.medicalClaim.updateMany).not.toHaveBeenCalled();

    // The columns that actually moved, and only those.
    expect(Object.keys(db.updates[0]!.data).filter((k) => k !== 'employeeNumber')).toEqual([
      'employmentStatus',
      'confirmationDate',
    ]);
  });

  it('records the move in the audit log the product already has', async () => {
    await patch(await hrAdmin(), TARGET, {
      employmentStatus: 'PERMANENT',
      confirmationDate: '2026-09-15',
    });

    expect(db.audits).toHaveLength(1);
    const entry = db.audits[0]!;
    expect(entry.action).toBe('employee.employment-status.update');
    expect(entry.entityType).toBe('Employee');
    expect(entry.entityId).toBe(TARGET);
    expect(entry.actorId).toBe('user-hr');
    expect(entry.summary).toContain('Muhammad AbuBakar');
    expect(entry.summary).toContain('Probation -> Permanent');
    expect(entry.summary).toContain('effective 2026-09-15');
    // The field-level diff, which is what makes the old value recoverable.
    expect(entry.before).toMatchObject({ employmentStatus: 'PROBATION' });
    expect(entry.after).toMatchObject({ employmentStatus: 'PERMANENT' });
  });

  it('does not write an audit entry for a change that did not happen', async () => {
    await patch(await hrAdmin(), 'emp-permanent', { employmentStatus: 'PERMANENT' });

    expect(db.audits).toHaveLength(0);
  });
});

describe('filtering People by employment status', () => {
  const list = async (query: string) => {
    const response = await (await hrAdmin()).inject({ method: 'GET', url: `/employees?${query}` });
    expect(response.statusCode).toBe(200);
    return response.json<{ data: Array<{ id: string; employmentStatus: string | null }> }>().data;
  };

  it('narrows to one status', async () => {
    expect((await list('employmentStatus=PROBATION')).map((r) => r.id)).toEqual([TARGET]);
    expect((await list('employmentStatus=PERMANENT')).map((r) => r.id)).toEqual(['emp-permanent']);
    expect((await list('employmentStatus=INTERNEE')).map((r) => r.id)).toEqual(['emp-internee']);
  });

  it('returns everybody, unclassified included, when no status is asked for', async () => {
    expect(await list('')).toHaveLength(4);
  });

  it('refuses a status that is not one of the three', async () => {
    const response = await (await hrAdmin()).inject({
      method: 'GET',
      url: '/employees?employmentStatus=Probation',
    });
    expect(response.statusCode).toBe(422);
  });

  it('carries the status on every list row, so the column can render', async () => {
    const rows = await list('');
    expect(rows.every((r) => 'employmentStatus' in r)).toBe(true);
    expect(rows.find((r) => r.id === 'emp-unclassified')!.employmentStatus).toBeNull();
  });
});
