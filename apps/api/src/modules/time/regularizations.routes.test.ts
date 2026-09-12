import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Employee self-service attendance corrections: who they are for, and what
 * submitting one is allowed to change.
 *
 * Three properties are pinned here, and all three are the kind that a frontend
 * cannot enforce:
 *
 *   1. The subject of a correction is the caller. The body carries no employee
 *      id, and adding one changes nothing - the row is filed against whoever
 *      the session resolves to.
 *   2. Reading is bounded by the employee data scope. An employee with an OWN
 *      scope sees their own requests; `?employeeId=` belonging to somebody
 *      else is a 403, not a wider list.
 *   3. Submitting asks for a change and makes none. No attendance record is
 *      written on the way in; that happens only when the approval engine calls
 *      `applyRegularization` after the chain has approved.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  company: { findUniqueOrThrow: vi.fn() },
  attendanceRegularizationRequest: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  approvalRequest: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  approvalStep: { findFirst: vi.fn() },
  attendanceRecord: { upsert: vi.fn(), update: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
  attendanceAdjustment: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  notification: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { attendanceRoutes } = await import('./attendance.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

/** An ordinary member of staff: reads attendance, cannot change it. */
const EMPLOYEE: Permission[] = [PERMISSIONS.ATTENDANCE_READ];

const CALLER_EMPLOYEE = { id: 'emp-self', departmentId: 'dep-1', firstName: 'Ayesha', lastName: 'Khan', locationId: null };

const COMPANY_POLICY = {
  timezone: 'Asia/Karachi',
  weekendDays: ['SATURDAY', 'SUNDAY'],
  graceMinutes: 10,
  halfDayMinutes: 240,
  fullDayMinutes: 480,
  earlyLeaveGraceMinutes: 10,
  overtimeEnabled: true,
  overtimeAfterMinutes: 480,
  overtimeDailyCapMinutes: 240,
  overtimeWeeklyCapMinutes: null,
  overtimeMonthlyCapMinutes: null,
  locationRestrictionEnabled: false,
  defaultGeofenceRadiusM: 200,
  ipRestrictionEnabled: false,
  allowedCheckInCidrs: [],
  defaultShiftStart: '09:00',
  defaultShiftEnd: '18:00',
  overtimeFromShiftEnd: true,
  overtimeCountsEarlyArrival: false,
  overtimeReducedByLateArrival: false,
  lateTrackingEnabled: true,
  earlyDepartureTrackingEnabled: true,
  fullDayToleranceMinutes: 30,
  irregularCheckInEnabled: true,
  irregularCheckInCutoff: '11:00',
  irregularCheckInMode: 'ABSOLUTE_TIME',
  irregularAfterShiftStartMinutes: 120,
  breakIncludedInWindow: true,
  overtimeMinimumMinutes: 0,
  overtimeRoundingMinutes: 0,
  missingPunchRule: 'THRESHOLD',
  nonWorkingDayWorkRule: 'AS_WORKING_DAY',
  duplicatePunchWindowSeconds: 60,
  maxPlausibleSpanMinutes: 960,
  allowImplausibleSpans: false,
  currency: 'PKR',
};

/** A day safely in the past whatever day the suite runs on. */
const PAST_DAY = '2026-01-12';

async function appAs(
  permissions: Permission[],
  dataScope: 'ALL' | 'OWN' | 'REPORTS' | 'NONE' = 'OWN',
): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-self',
      companyId: 'company-1',
      email: 'ayesha@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(attendanceRoutes, { prefix: '/attendance' });
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();

  db.company.findUniqueOrThrow.mockResolvedValue(COMPANY_POLICY);

  // The caller's own employee record, and their manager, for the chain.
  db.employee.findFirst.mockResolvedValue({
    ...CALLER_EMPLOYEE,
    managerId: 'emp-manager',
    secondaryManagerId: null,
    department: { headEmployeeId: 'emp-head' },
  });
  db.employee.findMany.mockResolvedValue([]);
  db.employee.count.mockResolvedValue(0);

  db.attendanceRegularizationRequest.findFirst.mockResolvedValue(null);
  db.attendanceRegularizationRequest.findMany.mockResolvedValue([]);
  db.attendanceRegularizationRequest.count.mockResolvedValue(0);
  db.attendanceRegularizationRequest.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'reg-1', ...data }),
  );
  db.attendanceRegularizationRequest.update.mockResolvedValue({ id: 'reg-1' });

  db.approvalRequest.create.mockResolvedValue({ id: 'appr-1', steps: [{ stepOrder: 1 }] });
  db.approvalRequest.findMany.mockResolvedValue([]);
  db.approvalStep.findFirst.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});

  // Run callbacks against the same mock client the routes would use live.
  db.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : arg,
  );
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('POST /attendance/regularizations', () => {
  it('files the request against the caller, not against an employee id in the body', async () => {
    app = await appAs(EMPLOYEE);

    const response = await app.inject({
      method: 'POST',
      url: '/attendance/regularizations',
      payload: {
        // The whole point of the test: this is ignored.
        employeeId: 'emp-someone-else',
        attendanceDate: PAST_DAY,
        issueType: 'MISSING_PUNCH',
        requestedCheckOutAt: '18:05',
        reason: 'The terminal was offline when I left.',
      },
    });

    expect(response.statusCode).toBe(201);
    const created = db.attendanceRegularizationRequest.create.mock.calls[0]?.[0] as {
      data: { employeeId: string };
    };
    expect(created.data.employeeId).toBe('emp-self');
  });

  it('refuses when the login has no employee record behind it', async () => {
    db.employee.findFirst.mockResolvedValue(null);
    app = await appAs(EMPLOYEE);

    const response = await app.inject({
      method: 'POST',
      url: '/attendance/regularizations',
      payload: { attendanceDate: PAST_DAY, issueType: 'OTHER', reason: 'Something is wrong.' },
    });

    expect(response.statusCode).toBe(403);
    expect(db.attendanceRegularizationRequest.create).not.toHaveBeenCalled();
  });

  it('writes no attendance record - submitting asks for a change, it does not make one', async () => {
    app = await appAs(EMPLOYEE);

    const response = await app.inject({
      method: 'POST',
      url: '/attendance/regularizations',
      payload: {
        attendanceDate: PAST_DAY,
        issueType: 'INCORRECT_CHECK_IN',
        requestedCheckInAt: '09:05',
        reason: 'I was in the building at five past nine.',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(db.attendanceRecord.upsert).not.toHaveBeenCalled();
    expect(db.attendanceRecord.update).not.toHaveBeenCalled();
    expect(db.attendanceRecord.create).not.toHaveBeenCalled();
    expect(db.attendanceAdjustment.create).not.toHaveBeenCalled();
  });

  it('routes the request through the shared approval engine, pending', async () => {
    app = await appAs(EMPLOYEE);

    await app.inject({
      method: 'POST',
      url: '/attendance/regularizations',
      payload: {
        attendanceDate: PAST_DAY,
        issueType: 'MISSING_PUNCH',
        requestedCheckInAt: '09:00',
        requestedCheckOutAt: '18:00',
        reason: 'Neither punch reached the system.',
      },
    });

    const approval = db.approvalRequest.create.mock.calls[0]?.[0] as {
      data: {
        subjectType: string;
        status: string;
        requesterEmployeeId: string;
        steps: { create: Array<{ approverEmployeeId: string }> };
      };
    };
    expect(approval.data.subjectType).toBe('ATTENDANCE_REGULARIZATION');
    expect(approval.data.status).toBe('PENDING');
    expect(approval.data.requesterEmployeeId).toBe('emp-self');
    // The existing chain: primary manager first. Never the requester.
    expect(approval.data.steps.create.map((s) => s.approverEmployeeId)).toEqual(['emp-manager']);

    const created = db.attendanceRegularizationRequest.create.mock.calls[0]?.[0] as {
      data: { status: string };
    };
    expect(created.data.status).toBe('PENDING');
  });

  it('refuses a request nobody could approve, and files nothing', async () => {
    // No manager, no secondary, no department head.
    db.employee.findFirst.mockResolvedValue({
      ...CALLER_EMPLOYEE,
      managerId: null,
      secondaryManagerId: null,
      department: null,
    });
    app = await appAs(EMPLOYEE);

    const response = await app.inject({
      method: 'POST',
      url: '/attendance/regularizations',
      payload: { attendanceDate: PAST_DAY, issueType: 'OTHER', reason: 'Please look at this day.' },
    });

    expect(response.statusCode).toBe(422);
    expect(db.attendanceRegularizationRequest.create).not.toHaveBeenCalled();
  });

  it('refuses a correction for a day that has not happened', async () => {
    app = await appAs(EMPLOYEE);
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

    const response = await app.inject({
      method: 'POST',
      url: '/attendance/regularizations',
      payload: { attendanceDate: future, issueType: 'OTHER', reason: 'Booking this in advance.' },
    });

    expect(response.statusCode).toBe(422);
    expect(db.attendanceRegularizationRequest.create).not.toHaveBeenCalled();
  });

  it('refuses a second pending correction for the same date', async () => {
    db.attendanceRegularizationRequest.findFirst.mockResolvedValue({ id: 'reg-existing' });
    app = await appAs(EMPLOYEE);

    const response = await app.inject({
      method: 'POST',
      url: '/attendance/regularizations',
      payload: { attendanceDate: PAST_DAY, issueType: 'OTHER', reason: 'Asking again.' },
    });

    expect(response.statusCode).toBe(409);
    expect(db.attendanceRegularizationRequest.create).not.toHaveBeenCalled();
  });
});

describe('GET /attendance/regularizations', () => {
  it('narrows an OWN scope to the caller, whatever the query asks for', async () => {
    app = await appAs(EMPLOYEE);

    const response = await app.inject({ method: 'GET', url: '/attendance/regularizations?view=mine' });

    expect(response.statusCode).toBe(200);
    const where = (db.attendanceRegularizationRequest.findMany.mock.calls[0]?.[0] as {
      where: { AND: Array<Record<string, unknown>> };
    }).where;
    // The scope filter, and the caller's own id from the session.
    expect(where.AND).toContainEqual({ employee: { id: 'emp-self' } });
    expect(where.AND).toContainEqual({ employeeId: 'emp-self' });
  });

  it('refuses an employeeId belonging to somebody else', async () => {
    // The scope lookup finds the caller; the ownership assertion then finds no
    // row matching both the requested id and the scope.
    db.employee.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve('AND' in where ? null : { ...CALLER_EMPLOYEE }),
    );
    app = await appAs(EMPLOYEE);

    const response = await app.inject({
      method: 'GET',
      url: '/attendance/regularizations?employeeId=emp-someone-else',
    });

    expect(response.statusCode).toBe(403);
    expect(db.attendanceRegularizationRequest.findMany).not.toHaveBeenCalled();
  });

  it('returns nothing for a scope of NONE rather than falling back to everything', async () => {
    app = await appAs(EMPLOYEE, 'NONE');

    const response = await app.inject({ method: 'GET', url: '/attendance/regularizations' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
    // The distinction that matters: no filter was built, so no query ran.
    expect(db.attendanceRegularizationRequest.findMany).not.toHaveBeenCalled();
  });

  it('is closed to a caller with no attendance permission at all', async () => {
    app = await appAs([]);

    const response = await app.inject({ method: 'GET', url: '/attendance/regularizations' });

    expect(response.statusCode).toBe(403);
  });

  it('reports the decision and the reviewer alongside the request', async () => {
    db.attendanceRegularizationRequest.count.mockResolvedValue(1);
    db.attendanceRegularizationRequest.findMany.mockResolvedValue([
      {
        id: 'reg-1',
        employeeId: 'emp-self',
        employee: { id: 'emp-self', firstName: 'Ayesha', lastName: 'Khan', displayName: null },
        attendanceDate: new Date('2026-01-12T00:00:00Z'),
        issueType: 'MISSING_PUNCH',
        requestedCheckInAt: new Date('2026-01-12T04:00:00Z'),
        requestedCheckOutAt: null,
        requestedStatus: null,
        reason: 'Terminal was offline.',
        status: 'REJECTED',
        approvalRequestId: 'appr-1',
        createdAt: new Date('2026-01-13T06:00:00Z'),
      },
    ]);
    db.approvalRequest.findMany.mockResolvedValue([
      {
        id: 'appr-1',
        decidedAt: new Date('2026-01-14T09:00:00Z'),
        steps: [
          {
            comment: 'You were marked on leave that day.',
            approverEmployee: { firstName: 'Bilal', lastName: 'Ahmed', displayName: null },
          },
        ],
      },
    ]);

    app = await appAs(EMPLOYEE);
    const response = await app.inject({ method: 'GET', url: '/attendance/regularizations?view=mine' });

    expect(response.statusCode).toBe(200);
    const rows = response.json().data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.issueType).toBe('MISSING_PUNCH');
    expect(row.status).toBe('REJECTED');
    expect(row.reviewerName).toBe('Bilal Ahmed');
    expect(row.reviewerComment).toBe('You were marked on leave that day.');
    expect(row.attendanceDate).toBe('2026-01-12');
  });
});
