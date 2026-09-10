import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The Device User Mapping screen's endpoints.
 *
 * Attribution is the most consequential setting in the attendance module:
 * changing who a PunchCode belongs to changes whose days those punches
 * become. Reading the mappings is an ordinary device permission; changing one
 * is not, and a mapping is never deleted - only closed - so the history of who
 * held a PIN survives every correction.
 */

const db = vi.hoisted(() => ({
  attendanceDeviceUserMapping: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  attendanceDevice: { findFirst: vi.fn() },
  employee: { findFirst: vi.fn() },
  attendanceRawPunch: { findMany: vi.fn(), updateMany: vi.fn(), groupBy: vi.fn() },
  company: { findUniqueOrThrow: vi.fn() },
  auditLog: { create: vi.fn(), findMany: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { deviceMappingRoutes } = await import('./mappings.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const DEVICE_ADMIN: Permission[] = [PERMISSIONS.DEVICE_READ, PERMISSIONS.DEVICE_MANAGE];
const DEVICE_VIEWER: Permission[] = [PERMISSIONS.DEVICE_READ];
const OUTSIDER: Permission[] = [PERMISSIONS.ATTENDANCE_READ];

const EMPLOYEE = {
  id: 'emp-2',
  firstName: 'Bilal',
  lastName: 'Ahmed',
  displayName: null,
  employeeNumber: 'E-002',
};

const MAPPING = {
  id: 'map-1',
  deviceId: 'dev-1',
  deviceUserId: '42',
  deviceUserName: 'BILAL',
  employeeId: 'emp-2',
  isActive: true,
  effectiveFrom: null,
  effectiveTo: null,
  notes: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  device: { id: 'dev-1', name: 'Main gate', serialNumber: 'ZK-1' },
  employee: EMPLOYEE,
};

async function appAs(permissions: Permission[]): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-1',
      companyId: 'company-1',
      email: 'caller@example.com',
      permissions: new Set(permissions),
      dataScope: 'ALL',
      mustChangePassword: false,
    };
  });
  await app.register(deviceMappingRoutes, { prefix: '/attendance/mappings' });
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  db.attendanceDeviceUserMapping.findMany.mockResolvedValue([MAPPING]);
  db.attendanceDeviceUserMapping.findFirst.mockResolvedValue(MAPPING);
  db.attendanceDeviceUserMapping.update.mockResolvedValue(MAPPING);
  db.attendanceDeviceUserMapping.create.mockResolvedValue({ id: 'map-new' });
  db.attendanceDevice.findFirst.mockResolvedValue({ id: 'dev-1', name: 'Main gate' });
  db.employee.findFirst.mockResolvedValue(EMPLOYEE);
  db.attendanceRawPunch.findMany.mockResolvedValue([]);
  db.attendanceRawPunch.updateMany.mockResolvedValue({ count: 0 });
  db.attendanceRawPunch.groupBy.mockResolvedValue([
    { deviceId: 'dev-1', deviceUserId: '42', employeeId: 'emp-2', _count: { _all: 128 } },
  ]);
  db.company.findUniqueOrThrow.mockResolvedValue({
    timezone: 'Asia/Karachi',
    weekendDays: ['SATURDAY', 'SUNDAY'],
    graceMinutes: 10,
    halfDayMinutes: 240,
    fullDayMinutes: 480,
    earlyLeaveGraceMinutes: 10,
    overtimeEnabled: true,
    overtimeAfterMinutes: 480,
    overtimeDailyCapMinutes: 240,
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
    breakIncludedInWindow: true,
    overtimeMinimumMinutes: 0,
    overtimeRoundingMinutes: 0,
    overtimeWeeklyCapMinutes: null,
    overtimeMonthlyCapMinutes: null,
    missingCheckOutStatus: 'PRESENT',
    missingCheckInStatus: 'ABSENT',
    irregularCheckInMode: 'ABSOLUTE_TIME',
    irregularAfterShiftStartMinutes: 120,
    defaultBreakMinutes: 0,
    lateThresholdMinutes: 0,
    earlyLeaveThresholdMinutes: 0,
    weekendWorkRule: 'AS_WORKING_DAY',
    holidayWorkRule: 'AS_WORKING_DAY',
  });
  db.auditLog.create.mockResolvedValue({});
  db.auditLog.findMany.mockResolvedValue([]);
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('reading mappings', () => {
  it('lets anyone who may read devices see them', async () => {
    app = await appAs(DEVICE_VIEWER);
    const response = await app.inject({ method: 'GET', url: '/attendance/mappings' });

    expect(response.statusCode).toBe(200);
    const row = response.json().data[0];
    expect(row.deviceUserId).toBe('42');
    expect(row.employeeName).toBe('Bilal Ahmed');
    expect(row.employeeNumber).toBe('E-002');
    expect(row.deviceSerial).toBe('ZK-1');
    expect(row.punchCount).toBe(128);
    // An open-ended active mapping attributes punches today.
    expect(row.isCurrent).toBe(true);
  });

  it('refuses somebody with no device permission', async () => {
    app = await appAs(OUTSIDER);
    const response = await app.inject({ method: 'GET', url: '/attendance/mappings' });
    expect(response.statusCode).toBe(403);
  });

  it('hides retired mappings by default and shows them on request', async () => {
    app = await appAs(DEVICE_VIEWER);

    await app.inject({ method: 'GET', url: '/attendance/mappings' });
    expect(JSON.stringify(db.attendanceDeviceUserMapping.findMany.mock.calls[0])).toContain(
      '"isActive":true',
    );

    await app.inject({ method: 'GET', url: '/attendance/mappings?includeInactive=true' });
    expect(JSON.stringify(db.attendanceDeviceUserMapping.findMany.mock.calls[1])).not.toContain(
      '"isActive":true',
    );
  });
});

describe('changing a mapping', () => {
  const CREATE = { deviceId: 'dev-1', deviceUserId: '42', employeeId: 'emp-2' };

  it('lets a device administrator add one', async () => {
    db.attendanceDeviceUserMapping.findMany.mockResolvedValue([]);
    app = await appAs(DEVICE_ADMIN);

    const response = await app.inject({
      method: 'POST',
      url: '/attendance/mappings',
      payload: CREATE,
    });

    expect(response.statusCode).toBe(201);
    expect(db.attendanceDeviceUserMapping.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a reader who may not manage devices', async () => {
    app = await appAs(DEVICE_VIEWER);
    const response = await app.inject({
      method: 'POST',
      url: '/attendance/mappings',
      payload: CREATE,
    });

    expect(response.statusCode).toBe(403);
    expect(db.attendanceDeviceUserMapping.create).not.toHaveBeenCalled();
    expect(db.attendanceRawPunch.updateMany).not.toHaveBeenCalled();
  });

  it('records the change with its old and new value', async () => {
    db.attendanceDeviceUserMapping.findMany.mockResolvedValue([]);
    app = await appAs(DEVICE_ADMIN);

    await app.inject({
      method: 'POST',
      url: '/attendance/mappings',
      payload: { ...CREATE, effectiveFrom: '2026-07-01' },
    });

    const entry = db.auditLog.create.mock.calls[0]![0]!.data as {
      action: string;
      entityType: string;
      summary: string;
      after: Record<string, unknown>;
    };
    expect(entry.entityType).toBe('AttendanceDeviceUserMapping');
    expect(entry.action).toBe('device.mapping.set');
    expect(entry.summary).toMatch(/PunchCode 42/);
    expect(entry.after.effectiveFrom).toBe('2026-07-01');
  });

  it('refuses re-dating a mapping into another employee`s period', async () => {
    db.attendanceDeviceUserMapping.findMany.mockResolvedValue([
      {
        ...MAPPING,
        id: 'map-2',
        employeeId: 'emp-1',
        employee: { ...EMPLOYEE, id: 'emp-1', firstName: 'Ayesha', lastName: 'Khan', employeeNumber: 'E-001' },
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: null,
      },
    ]);

    app = await appAs(DEVICE_ADMIN);
    const response = await app.inject({
      method: 'PATCH',
      url: '/attendance/mappings/map-1',
      payload: { effectiveFrom: '2026-06-01' },
    });

    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.json())).toMatch(/Ayesha Khan/);
    expect(db.attendanceDeviceUserMapping.update).not.toHaveBeenCalled();
  });

  it('refuses an end date before the start date', async () => {
    app = await appAs(DEVICE_ADMIN);
    const response = await app.inject({
      method: 'PATCH',
      url: '/attendance/mappings/map-1',
      payload: { effectiveFrom: '2026-07-01', effectiveTo: '2026-06-01' },
    });

    expect(response.statusCode).toBe(422);
  });
});

describe('retiring a mapping', () => {
  it('deactivates rather than deletes, so the history survives', async () => {
    app = await appAs(DEVICE_ADMIN);
    const response = await app.inject({
      method: 'POST',
      url: '/attendance/mappings/map-1/disable',
    });

    expect(response.statusCode).toBe(200);
    // There is no `delete` on the mock at all: an attempt would crash.
    expect(db.attendanceDeviceUserMapping).not.toHaveProperty('delete');
    const data = db.attendanceDeviceUserMapping.update.mock.calls[0]![0]!.data as Record<
      string,
      unknown
    >;
    expect(data).toEqual({ isActive: false });
  });

  it('refuses a reader', async () => {
    app = await appAs(DEVICE_VIEWER);
    const response = await app.inject({
      method: 'POST',
      url: '/attendance/mappings/map-1/disable',
    });
    expect(response.statusCode).toBe(403);
    expect(db.attendanceDeviceUserMapping.update).not.toHaveBeenCalled();
  });
});

describe('mapping history', () => {
  it('reads the audit trail rather than a private copy of it', async () => {
    db.auditLog.findMany.mockResolvedValue([
      {
        id: 'audit-1',
        action: 'device.mapping.correct',
        summary: 'Mapped PunchCode 42 to Bilal Ahmed',
        before: { employeeId: 'emp-1' },
        after: { employeeId: 'emp-2' },
        createdAt: new Date('2026-07-01T09:00:00Z'),
        actor: { email: 'hr@example.com', employee: null },
      },
    ]);

    app = await appAs(DEVICE_VIEWER);
    const response = await app.inject({
      method: 'GET',
      url: '/attendance/mappings/history?deviceUserId=42',
    });

    expect(response.statusCode).toBe(200);
    const entry = response.json().data[0];
    expect(entry.action).toBe('device.mapping.correct');
    expect(entry.actorName).toBe('hr@example.com');
    expect(entry.before.employeeId).toBe('emp-1');
    expect(entry.after.employeeId).toBe('emp-2');

    // Narrowed to the matching mappings, not the whole company's trail.
    const where = db.auditLog.findMany.mock.calls[0]![0]!.where as { entityId?: unknown };
    expect(where.entityId).toBeDefined();
  });
});
