import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * "Cancel Leave" on approved leave the employee turned out to work.
 *
 * The behaviour of the cancellation itself - one reversal per day, the quota
 * restored once, nothing deleted - is pinned in leave-reconciliation.test.ts
 * against the real service. This file pins the door: `leave.conflict.resolve`
 * is the gate, only SUPER_ADMIN ships with it, a request in another company is
 * a 404, and the button is offered only to somebody who may press it.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn() },
  leaveRequest: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
}));

const service = vi.hoisted(() => ({
  attendanceConflictsFor: vi.fn(),
  cancelLeaveForAttendanceConflict: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));
vi.mock('./leave-reconciliation.service.js', () => service);
vi.mock('../../auth/scope.js', () => ({
  assertEmployeeInScope: vi.fn(async () => undefined),
  assertEmployeeInTeamScope: vi.fn(async () => undefined),
  teamScopeFilter: vi.fn(async () => ({})),
}));

const { leaveRequestRoutes } = await import('./leave-requests.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

async function appAs(permissions: readonly Permission[]): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-1',
      companyId: 'company-1',
      email: 'someone@example.com',
      permissions: new Set(permissions),
      dataScope: 'ALL',
      mustChangePassword: false,
    };
  });
  await app.register(leaveRequestRoutes, { prefix: '/leave-requests' });
  await app.ready();
  return app;
}

const LEAVE_ROW = {
  id: 'leave-1',
  companyId: 'company-1',
  employeeId: 'emp-hira',
  leaveTypeId: 'type-casual',
  startDate: new Date('2026-10-06T00:00:00.000Z'),
  endDate: new Date('2026-10-06T00:00:00.000Z'),
  dayPart: 'FULL_DAY',
  totalDays: 1,
  reason: 'Family matter',
  documentUrl: null,
  documentName: null,
  status: 'APPROVED',
  approvalRequestId: 'approval-1',
  decidedAt: new Date('2026-10-05T05:00:00.000Z'),
  cancelledAt: null,
  cancelledBySystem: false,
  cancellationReason: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  employee: { id: 'emp-hira', firstName: 'Hira', lastName: 'Javed', displayName: null },
  leaveType: { id: 'type-casual', name: 'Casual Leave', isPaid: true, isDeductible: true },
  reversals: [],
};

const CONFLICT = {
  dayKey: '2026-10-06',
  checkInAt: new Date('2026-10-06T04:05:00.000Z'),
  checkOutAt: null,
};

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  db.employee.findFirst.mockResolvedValue({ id: 'emp-self' });
  db.leaveRequest.findFirst.mockResolvedValue(LEAVE_ROW);
  db.user.findUnique.mockResolvedValue({ firstName: 'Zohaib', lastName: 'Saleem' });
  service.attendanceConflictsFor.mockResolvedValue(new Map([['leave-1', [CONFLICT]]]));
  service.cancelLeaveForAttendanceConflict.mockResolvedValue({
    leaveRequestId: 'leave-1',
    status: 'CANCELLED',
    restoredDays: 1,
    reversedDayKeys: ['2026-10-06'],
    alreadyResolved: false,
  });
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('who may cancel leave for an attendance conflict', () => {
  it('ships leave.conflict.resolve to SUPER_ADMIN alone', () => {
    const holders = Object.entries(DEFAULT_ROLE_PERMISSIONS)
      .filter(([, grants]) => grants.includes(PERMISSIONS.LEAVE_CONFLICT_RESOLVE))
      .map(([role]) => role);
    expect(holders).toEqual(['SUPER_ADMIN']);
  });

  it('lets a Super Admin cancel, as themselves', async () => {
    app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
    const res = await app.inject({ method: 'POST', url: '/leave-requests/leave-1/cancel-for-attendance' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      id: 'leave-1',
      status: 'CANCELLED',
      restoredDays: 1,
      reversedDates: ['2026-10-06'],
      alreadyResolved: false,
    });
    expect(service.cancelLeaveForAttendanceConflict).toHaveBeenCalledWith({
      companyId: 'company-1',
      leaveRequestId: 'leave-1',
      actor: { userId: 'user-1', name: 'Zohaib Saleem' },
    });
  });

  it.each([
    ['an employee', DEFAULT_ROLE_PERMISSIONS.EMPLOYEE],
    ['a manager', DEFAULT_ROLE_PERMISSIONS.MANAGER],
    ['HR Admin, who manages leave but was not given this', DEFAULT_ROLE_PERMISSIONS.HR_ADMIN],
  ])('refuses %s', async (_who, grants) => {
    app = await appAs(grants);
    const res = await app.inject({ method: 'POST', url: '/leave-requests/leave-1/cancel-for-attendance' });

    expect(res.statusCode).toBe(403);
    expect(service.cancelLeaveForAttendanceConflict).not.toHaveBeenCalled();
  });

  it("a request in another company is a 404, and nothing is cancelled", async () => {
    db.leaveRequest.findFirst.mockResolvedValue(null);
    app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
    const res = await app.inject({ method: 'POST', url: '/leave-requests/leave-x/cancel-for-attendance' });

    expect(res.statusCode).toBe(404);
    expect(service.cancelLeaveForAttendanceConflict).not.toHaveBeenCalled();
  });
});

describe('the request as the screens read it', () => {
  it('a Super Admin sees the conflict and is offered Cancel Leave', async () => {
    app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
    const res = await app.inject({ method: 'GET', url: '/leave-requests/leave-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      status: 'APPROVED',
      attendanceConflicts: [
        { date: '2026-10-06', checkInAt: '2026-10-06T04:05:00.000Z', checkOutAt: null },
      ],
      canResolveConflict: true,
    });
  });

  it('HR sees the conflict but is not offered the button', async () => {
    app = await appAs(DEFAULT_ROLE_PERMISSIONS.HR_ADMIN);
    const res = await app.inject({ method: 'GET', url: '/leave-requests/leave-1' });

    expect(res.json().data.attendanceConflicts).toHaveLength(1);
    expect(res.json().data.canResolveConflict).toBe(false);
  });

  it('with no conflict there is nothing to offer, even to a Super Admin', async () => {
    service.attendanceConflictsFor.mockResolvedValue(new Map());
    app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
    const res = await app.inject({ method: 'GET', url: '/leave-requests/leave-1' });

    expect(res.json().data.attendanceConflicts).toEqual([]);
    expect(res.json().data.canResolveConflict).toBe(false);
  });
});
