import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  EMPLOYEE_PHOTO_MAX_BYTES,
  PERMISSIONS,
  type DataScope,
  type Permission,
} from '@hrms/shared';

/**
 * The employee profile photo endpoints.
 *
 * What this file is here to hold down, in order of how much it would cost to
 * get wrong:
 *
 *   - Nobody changes anybody else's photograph. An employee reaches exactly one
 *     record - their own - and a manager who can SEE a report's photo still
 *     cannot replace it, because seeing and editing are different grants. The
 *     role sets below are the REAL defaults from the shared catalogue, so a
 *     default that drifts fails here rather than in production.
 *   - The server decides what a file is. Every check the browser makes is made
 *     again here against the bytes that actually arrived: a script renamed
 *     `photo.jpg` is refused, and so is a 6 MB image, whatever the request
 *     claimed about either.
 *   - An upload cannot name where it lands. The object key is generated from
 *     the company and employee the request was authorised against, so there is
 *     no payload that reaches another employee's photo or another company's.
 *   - Nothing else on the record moves. Not the employee id, not the employee
 *     number, not the name, the emails, the salary or the device mapping the
 *     PunchCode lives on. Three columns change and no others, which is asserted
 *     against the actual update rather than assumed.
 */

/**
 * A tiny employee table with just enough `where` support for the two shapes
 * these routes produce: the direct company-scoped lookup, and the data-scope
 * check, which nests the scope filter inside an `AND`.
 *
 * Written out rather than mocked per-call so the scope rules are genuinely
 * exercised - a manager's REPORTS filter has to actually fail to match somebody
 * outside their line, which a `mockResolvedValue` would never prove.
 */
const db = vi.hoisted(() => {
  interface Row {
    id: string;
    companyId: string;
    employeeNumber: string;
    firstName: string;
    lastName: string;
    workEmail: string | null;
    userId: string | null;
    managerId: string | null;
    secondaryManagerId: string | null;
    departmentId: string | null;
    photoUrl: string | null;
    photoObjectKey: string | null;
    photoContentType: string | null;
    photoUpdatedAt: Date | null;
    [key: string]: unknown;
  }

  const rows = new Map<string, Row>();
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const audits: Array<Record<string, unknown>> = [];

  const matches = (row: Row, where: Record<string, unknown>): boolean => {
    for (const [key, value] of Object.entries(where)) {
      if (key === 'AND') {
        const clauses = value as Array<Record<string, unknown>>;
        if (!clauses.every((clause) => matches(row, clause))) return false;
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

  return {
    rows,
    updates,
    audits,
    employee: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const row of rows.values()) if (matches(row, where)) return { ...row };
        return null;
      }),
      // Implemented below, where the row map is in scope.
      update: vi.fn(),
    },
    auditLog: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      audits.push(data);
      return data;
    }) },
    // Present so a stray write to any of them is a failed assertion rather than
    // an undefined-is-not-a-function that reads like a test bug.
    attendanceDeviceUserMapping: { update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    user: { update: vi.fn(), updateMany: vi.fn() },
    employeeSalary: { update: vi.fn(), create: vi.fn() },
    attendanceRecord: { update: vi.fn(), updateMany: vi.fn() },
    attendanceRawPunch: { update: vi.fn(), updateMany: vi.fn() },
  };
});

// `update` needs the row map, which is only assembled above, so it is wired
// here rather than inside the hoisted factory.
db.employee.update.mockImplementation(
  async ({
    where,
    data,
  }: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => {
    const row = db.rows.get(where.id);
    if (!row) throw new Error(`no such employee ${where.id}`);
    db.updates.push({ id: where.id, data: { ...data } });
    Object.assign(row, data);
    return { ...row };
  },
);

vi.mock('../../core/db.js', () => ({ prisma: db }));

/** An in-memory stand-in for the file store, so no test writes to a disk. */
const store = vi.hoisted(() => {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    putObject: vi.fn(async (key: string, data: Buffer) => {
      objects.set(key, data);
    }),
    getObject: vi.fn(async (key: string) => objects.get(key) ?? null),
    deleteObject: vi.fn(async (key: string) => objects.delete(key)),
  };
});

vi.mock('../../core/storage/object-store.js', () => store);

const { employeePhotoRoutes } = await import('./employee-photo.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

// The real defaults, so a change to the catalogue is felt here.
const SUPER_ADMIN = DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN;
const HR_ADMIN = DEFAULT_ROLE_PERMISSIONS.HR_ADMIN;
const MANAGER = DEFAULT_ROLE_PERMISSIONS.MANAGER;
const EMPLOYEE = DEFAULT_ROLE_PERMISSIONS.EMPLOYEE;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('a real enough png body'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 7)]);

/** The employee whose photo is being managed throughout. */
const TARGET = 'emp-target';
/** Their manager's record, and a bystander in another reporting line. */
const MANAGER_EMP = 'emp-manager';
const OTHER = 'emp-other';

function seed(): void {
  db.rows.clear();
  db.updates.length = 0;
  db.audits.length = 0;
  store.objects.clear();

  const base = {
    companyId: 'company-1',
    workEmail: null,
    managerId: null,
    secondaryManagerId: null,
    departmentId: 'dept-1',
    photoUrl: null,
    photoObjectKey: null,
    photoContentType: null,
    photoUpdatedAt: null,
  };

  db.rows.set(TARGET, {
    ...base,
    id: TARGET,
    employeeNumber: '1020',
    firstName: 'Muhammad',
    lastName: 'AbuBakar',
    workEmail: 'abubakar@example.com',
    userId: 'user-target',
    managerId: MANAGER_EMP,
  });
  db.rows.set(MANAGER_EMP, {
    ...base,
    id: MANAGER_EMP,
    employeeNumber: '1001',
    firstName: 'Line',
    lastName: 'Manager',
    userId: 'user-manager',
  });
  db.rows.set(OTHER, {
    ...base,
    id: OTHER,
    employeeNumber: '1099',
    firstName: 'Some',
    lastName: 'Bystander',
    userId: 'user-other',
    departmentId: 'dept-2',
  });
  // Another company's employee, to prove the tenant boundary is not a
  // permission question.
  db.rows.set('emp-elsewhere', {
    ...base,
    companyId: 'company-2',
    id: 'emp-elsewhere',
    employeeNumber: '2001',
    firstName: 'Far',
    lastName: 'Away',
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
  await app.register(employeePhotoRoutes, { prefix: '/employees' });
  await app.ready();
  return app;
}

const superAdmin = () =>
  appAs({ permissions: SUPER_ADMIN, dataScope: 'ALL', userId: 'user-admin' });
const hrAdmin = () => appAs({ permissions: HR_ADMIN, dataScope: 'ALL', userId: 'user-hr' });
const manager = () =>
  appAs({ permissions: MANAGER, dataScope: 'REPORTS_AND_OWN', userId: 'user-manager' });
const employee = () => appAs({ permissions: EMPLOYEE, dataScope: 'OWN', userId: 'user-target' });
const bystander = () => appAs({ permissions: EMPLOYEE, dataScope: 'OWN', userId: 'user-other' });

const upload = (app: FastifyInstance, id: string, body: Buffer, contentType = 'image/png') =>
  app.inject({
    method: 'POST',
    url: `/employees/${id}/photo`,
    payload: body,
    headers: { 'content-type': contentType },
  });

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe('uploading a photo', () => {
  it('lets a Super Admin upload one for any employee', async () => {
    const response = await upload(await superAdmin(), TARGET, PNG);

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { photoUrl: string; hasPhoto: boolean } }>();
    expect(body.data.hasPhoto).toBe(true);
    expect(body.data.photoUrl).toContain(`/api/v1/employees/${TARGET}/photo`);

    const row = db.rows.get(TARGET)!;
    expect(row.photoContentType).toBe('image/png');
    expect(store.objects.get(row.photoObjectKey!)).toEqual(PNG);
  });

  it('lets an HR Admin upload one, through employee.manage', async () => {
    expect(HR_ADMIN).toContain(PERMISSIONS.EMPLOYEE_MANAGE);

    const response = await upload(await hrAdmin(), TARGET, JPEG, 'image/jpeg');

    expect(response.statusCode).toBe(200);
    expect(db.rows.get(TARGET)!.photoContentType).toBe('image/jpeg');
  });

  it('lets an employee upload their own', async () => {
    const response = await upload(await employee(), TARGET, PNG);

    expect(response.statusCode).toBe(200);
    expect(db.rows.get(TARGET)!.photoObjectKey).not.toBeNull();
  });

  it('stores the object under the company and the employee it was authorised for', async () => {
    await upload(await superAdmin(), TARGET, PNG);

    const key = db.rows.get(TARGET)!.photoObjectKey!;
    expect(key.startsWith(`employee-photos/company-1/${TARGET}/`)).toBe(true);
    expect(key.endsWith('.png')).toBe(true);
  });

  it('records the format the bytes are, not the one the request declared', async () => {
    // A PNG announced as a JPEG. Stored and served as a PNG.
    const response = await upload(await superAdmin(), TARGET, PNG, 'image/jpeg');

    expect(response.statusCode).toBe(200);
    expect(db.rows.get(TARGET)!.photoContentType).toBe('image/png');
    expect(db.rows.get(TARGET)!.photoObjectKey!.endsWith('.png')).toBe(true);
  });
});

describe('replacing a photo', () => {
  it('writes a new object, points the record at it and deletes the old one', async () => {
    const app = await superAdmin();
    await upload(app, TARGET, PNG);
    const firstKey = db.rows.get(TARGET)!.photoObjectKey!;

    const response = await upload(app, TARGET, JPEG, 'image/jpeg');
    expect(response.statusCode).toBe(200);

    const secondKey = db.rows.get(TARGET)!.photoObjectKey!;
    expect(secondKey).not.toBe(firstKey);
    expect(store.objects.has(firstKey)).toBe(false);
    expect(store.objects.get(secondKey)).toEqual(JPEG);
  });

  it('never reuses a key, so one employee cannot overwrite another', async () => {
    const app = await superAdmin();
    await upload(app, TARGET, PNG);
    await upload(app, OTHER, PNG);

    const keys = [db.rows.get(TARGET)!.photoObjectKey, db.rows.get(OTHER)!.photoObjectKey];
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toContain(TARGET);
    expect(keys[1]).toContain(OTHER);
  });
});

describe('removing a photo', () => {
  it('clears the record, deletes the file and falls back to initials', async () => {
    const app = await superAdmin();
    await upload(app, TARGET, PNG);
    const key = db.rows.get(TARGET)!.photoObjectKey!;

    const response = await app.inject({ method: 'DELETE', url: `/employees/${TARGET}/photo` });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { photoUrl: string | null; hasPhoto: boolean } }>();
    // Nothing to render means the avatar shows initials, which is exactly what
    // it did before there was ever a photo.
    expect(body.data).toMatchObject({ photoUrl: null, hasPhoto: false });

    expect(db.rows.get(TARGET)!.photoObjectKey).toBeNull();
    expect(db.rows.get(TARGET)!.photoContentType).toBeNull();
    expect(store.objects.has(key)).toBe(false);
  });

  it('falls back to a typed Photo URL when the record has one', async () => {
    db.rows.get(TARGET)!.photoUrl = 'https://example.com/legacy.jpg';
    const app = await superAdmin();
    await upload(app, TARGET, PNG);

    const response = await app.inject({ method: 'DELETE', url: `/employees/${TARGET}/photo` });

    expect(response.json<{ data: { photoUrl: string | null } }>().data.photoUrl).toBe(
      'https://example.com/legacy.jpg',
    );
    // The link was never touched by the upload either.
    expect(db.rows.get(TARGET)!.photoUrl).toBe('https://example.com/legacy.jpg');
  });

  it('is idempotent when there is no photo', async () => {
    const response = await (await superAdmin()).inject({
      method: 'DELETE',
      url: `/employees/${TARGET}/photo`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { hasPhoto: boolean } }>().data.hasPhoto).toBe(false);
    // Nothing happened, so nothing is recorded as having happened.
    expect(db.updates).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it('lets an employee remove their own', async () => {
    await upload(await superAdmin(), TARGET, PNG);

    const response = await (await employee()).inject({
      method: 'DELETE',
      url: `/employees/${TARGET}/photo`,
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('who may not', () => {
  it('refuses an employee changing somebody else', async () => {
    const response = await upload(await bystander(), TARGET, PNG);

    expect(response.statusCode).toBe(403);
    expect(db.rows.get(TARGET)!.photoObjectKey).toBeNull();
    expect(store.putObject).not.toHaveBeenCalled();
  });

  it('refuses an employee removing somebody else', async () => {
    await upload(await superAdmin(), TARGET, PNG);
    const key = db.rows.get(TARGET)!.photoObjectKey;

    const response = await (await bystander()).inject({
      method: 'DELETE',
      url: `/employees/${TARGET}/photo`,
    });

    expect(response.statusCode).toBe(403);
    expect(db.rows.get(TARGET)!.photoObjectKey).toBe(key);
    expect(store.deleteObject).not.toHaveBeenCalled();
  });

  it('refuses a manager changing a direct report, who they can otherwise see', async () => {
    // The distinction that matters: the manager is allowed to READ this exact
    // photo and is still refused the write.
    expect(MANAGER).toContain(PERMISSIONS.EMPLOYEE_READ);
    expect(MANAGER).not.toContain(PERMISSIONS.EMPLOYEE_MANAGE);

    await upload(await superAdmin(), TARGET, PNG);
    const app = await manager();

    expect((await app.inject({ url: `/employees/${TARGET}/photo` })).statusCode).toBe(200);
    expect((await upload(app, TARGET, JPEG, 'image/jpeg')).statusCode).toBe(403);
  });

  it('refuses an HR Admin outside their data scope', async () => {
    // employee.manage without the reach: the permission says what, the scope
    // says which, and both have to agree.
    const app = await appAs({
      permissions: HR_ADMIN,
      dataScope: 'DEPARTMENT',
      userId: 'user-manager',
    });

    expect((await upload(app, OTHER, PNG)).statusCode).toBe(403);
    expect(db.rows.get(OTHER)!.photoObjectKey).toBeNull();
  });

  it('cannot reach another company at all', async () => {
    const response = await upload(await superAdmin(), 'emp-elsewhere', PNG);

    expect(response.statusCode).toBe(404);
    expect(db.rows.get('emp-elsewhere')!.photoObjectKey).toBeNull();
  });

  it('refuses an anonymous caller', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.decorateRequest('auth', null);
    await app.register(employeePhotoRoutes, { prefix: '/employees' });
    await app.ready();

    expect((await app.inject({ url: `/employees/${TARGET}/photo` })).statusCode).toBe(401);
    expect((await upload(app, TARGET, PNG)).statusCode).toBe(401);
  });
});

describe('what may be uploaded', () => {
  it('refuses a file whose bytes are not an image, however it was announced', async () => {
    const script = Buffer.from('#!/bin/sh\nrm -rf /\npadding padding padding');

    const response = await upload(await superAdmin(), TARGET, script, 'image/png');

    expect(response.statusCode).toBe(422);
    // The reason lands on the field, which is where the form shows it.
    expect(
      response.json<{ error: { details: Record<string, string[]> } }>().error.details.photo?.[0],
    ).toMatch(/JPG, PNG/i);
    expect(store.putObject).not.toHaveBeenCalled();
    expect(db.rows.get(TARGET)!.photoObjectKey).toBeNull();
  });

  it('refuses an SVG, which a browser would execute', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

    expect((await upload(await superAdmin(), TARGET, svg, 'image/png')).statusCode).toBe(422);
  });

  it('refuses a content type it does not serve', async () => {
    const response = await upload(await superAdmin(), TARGET, PNG, 'image/gif');

    // No parser is registered for it, so it never reaches the handler.
    expect(response.statusCode).toBe(415);
    expect(db.rows.get(TARGET)!.photoObjectKey).toBeNull();
  });

  it('refuses a file over 5 MB', async () => {
    const tooBig = Buffer.concat([PNG, Buffer.alloc(EMPLOYEE_PHOTO_MAX_BYTES)]);
    expect(tooBig.length).toBeGreaterThan(EMPLOYEE_PHOTO_MAX_BYTES);

    const response = await upload(await superAdmin(), TARGET, tooBig);

    expect(response.statusCode).toBe(413);
    expect(store.putObject).not.toHaveBeenCalled();
    expect(db.rows.get(TARGET)!.photoObjectKey).toBeNull();
  });

  it('accepts a file just under the limit', async () => {
    const justUnder = Buffer.concat([PNG, Buffer.alloc(EMPLOYEE_PHOTO_MAX_BYTES - PNG.length - 1)]);

    expect((await upload(await superAdmin(), TARGET, justUnder)).statusCode).toBe(200);
  });

  it('refuses an empty body', async () => {
    const response = await upload(await superAdmin(), TARGET, Buffer.alloc(0));

    expect(response.statusCode).toBe(422);
    expect(store.putObject).not.toHaveBeenCalled();
  });
});

describe('serving a photo', () => {
  it('sends the bytes with the format they were stored as', async () => {
    const app = await superAdmin();
    await upload(app, TARGET, PNG);

    const response = await app.inject({ url: `/employees/${TARGET}/photo` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.rawPayload).toEqual(PNG);
  });

  it('never lets a browser sniff a different type out of the bytes', async () => {
    const app = await superAdmin();
    await upload(app, TARGET, PNG);

    const response = await app.inject({ url: `/employees/${TARGET}/photo` });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe('inline');
  });

  it('keeps the image out of shared caches and revalidates a bare URL', async () => {
    const app = await superAdmin();
    await upload(app, TARGET, PNG);

    const response = await app.inject({ url: `/employees/${TARGET}/photo` });

    expect(response.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    expect(response.headers.etag).toBeTruthy();
  });

  it('lets the browser keep a versioned URL, which cannot change under it', async () => {
    const app = await superAdmin();
    const uploaded = await upload(app, TARGET, PNG);
    const url = uploaded.json<{ data: { photoUrl: string } }>().data.photoUrl;

    // The URL the avatar actually renders, carrying the photo's timestamp.
    const response = await app.inject({ url: url.replace('/api/v1', '') });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('immutable');
    // Still private: a shared cache must never hold somebody's face.
    expect(response.headers['cache-control']).toContain('private');
  });

  it('answers 304 for a browser that already has the current photo', async () => {
    const app = await superAdmin();
    await upload(app, TARGET, PNG);
    const first = await app.inject({ url: `/employees/${TARGET}/photo` });

    const second = await app.inject({
      url: `/employees/${TARGET}/photo`,
      headers: { 'if-none-match': String(first.headers.etag) },
    });

    expect(second.statusCode).toBe(304);
  });

  it('is 404 when there is no photo', async () => {
    const response = await (await superAdmin()).inject({ url: `/employees/${TARGET}/photo` });

    expect(response.statusCode).toBe(404);
  });

  it('is 404, not a crash, when the record points at a file that is gone', async () => {
    const app = await superAdmin();
    await upload(app, TARGET, PNG);
    store.objects.clear();

    expect((await app.inject({ url: `/employees/${TARGET}/photo` })).statusCode).toBe(404);
  });

  it('lets a manager see a direct report, and not somebody outside their line', async () => {
    const admin = await superAdmin();
    await upload(admin, TARGET, PNG);
    await upload(admin, OTHER, PNG);

    const app = await manager();
    expect((await app.inject({ url: `/employees/${TARGET}/photo` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/employees/${OTHER}/photo` })).statusCode).toBe(403);
  });
});

describe('the rest of the employee record', () => {
  /** Every column the brief says must not move. */
  const untouched = (id: string) => {
    const row = db.rows.get(id)!;
    return {
      id: row.id,
      employeeNumber: row.employeeNumber,
      firstName: row.firstName,
      lastName: row.lastName,
      workEmail: row.workEmail,
      userId: row.userId,
      managerId: row.managerId,
      departmentId: row.departmentId,
      companyId: row.companyId,
    };
  };

  it('changes three columns and no others, on upload and on removal', async () => {
    const before = untouched(TARGET);
    const app = await superAdmin();

    await upload(app, TARGET, PNG);
    await upload(app, TARGET, JPEG, 'image/jpeg');
    await app.inject({ method: 'DELETE', url: `/employees/${TARGET}/photo` });

    expect(db.updates).toHaveLength(3);
    for (const update of db.updates) {
      expect(Object.keys(update.data).sort()).toEqual([
        'photoContentType',
        'photoObjectKey',
        'photoUpdatedAt',
      ]);
    }

    expect(untouched(TARGET)).toEqual(before);
  });

  it('touches no other table - not the device mapping the PunchCode lives on', async () => {
    const app = await superAdmin();
    await upload(app, TARGET, PNG);
    await app.inject({ method: 'DELETE', url: `/employees/${TARGET}/photo` });

    for (const model of [
      db.attendanceDeviceUserMapping,
      db.user,
      db.employeeSalary,
      db.attendanceRecord,
      db.attendanceRawPunch,
    ]) {
      for (const fn of Object.values(model)) expect(fn).not.toHaveBeenCalled();
    }
  });

  it('leaves nobody else’s photo alone', async () => {
    const app = await superAdmin();
    await upload(app, OTHER, PNG);
    const othersKey = db.rows.get(OTHER)!.photoObjectKey;

    await upload(app, TARGET, JPEG, 'image/jpeg');
    await app.inject({ method: 'DELETE', url: `/employees/${TARGET}/photo` });

    expect(db.rows.get(OTHER)!.photoObjectKey).toBe(othersKey);
    expect(store.objects.has(othersKey!)).toBe(true);
  });
});

describe('the audit trail', () => {
  it('tells an upload from a replacement from a removal', async () => {
    const app = await superAdmin();
    await upload(app, TARGET, PNG);
    await upload(app, TARGET, JPEG, 'image/jpeg');
    await app.inject({ method: 'DELETE', url: `/employees/${TARGET}/photo` });

    expect(db.audits.map((a) => a.action)).toEqual([
      'employee.photo.upload',
      'employee.photo.change',
      'employee.photo.remove',
    ]);
    expect(db.audits[0]).toMatchObject({ entityType: 'Employee', entityId: TARGET });
    expect(String(db.audits[0]!.summary)).toContain('Muhammad AbuBakar');
  });

  it('never writes the image into the log', async () => {
    await upload(await superAdmin(), TARGET, PNG);

    const serialised = JSON.stringify(db.audits);
    expect(serialised).not.toContain(PNG.toString('base64'));
    expect(serialised).not.toContain('png body');
    // The facts about the file, yes. The file, no.
    expect(db.audits[0]!.after).toMatchObject({ contentType: 'image/png', bytes: PNG.length });
  });

  it('records nothing for a refused upload', async () => {
    await upload(await superAdmin(), TARGET, Buffer.from('not an image at all, really'));

    expect(db.audits).toHaveLength(0);
  });
});
