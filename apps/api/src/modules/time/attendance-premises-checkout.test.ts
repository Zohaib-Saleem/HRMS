import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@hrms/shared';

/**
 * Premises check-out: a web check-out made away from the terminal, by an
 * employee explicitly allowed to, inside the office premises boundary.
 *
 * What is pinned here: the flag is per person and off by default; the
 * location is checked on the server against the work location's configured
 * boundary, never trusted from the browser; a refusal says what to do and is
 * recorded with the distance; nothing is created on a refusal; the day can
 * only be closed once; and somebody without the flag behaves exactly as
 * before unless the company enforces a check-out geofence for everyone.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
  location: { findUnique: vi.fn() },
  company: { findUniqueOrThrow: vi.fn() },
  attendancePolicyAssignment: { findMany: vi.fn() },
  attendanceRecord: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  employeeShiftAssignment: { findMany: vi.fn(), findFirst: vi.fn() },
  leaveRequest: { findMany: vi.fn() },
  holiday: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { attendanceRoutes } = await import('./attendance.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const POLICY = {
  timezone: 'Asia/Karachi',
  weekendDays: [0, 6],
  workdayStart: '09:00',
  workdayEnd: '18:00',
  graceMinutes: 15,
  halfDayMinutes: 240,
  fullDayMinutes: 480,
  overtimeAfterMinutes: 540,
  overtimeEnabled: true,
  overtimeCountsEarlyArrival: false,
  overtimeReducedByLateArrival: false,
  lateTrackingEnabled: true,
  earlyDepartureTrackingEnabled: true,
  fullDayToleranceMinutes: 30,
  irregularCheckInEnabled: false,
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
  duplicatePunchWindowSeconds: 60,
  overnightCheckOutWindowMinutes: 1080,
  overnightCheckOutCutoff: '06:00',
};

const EMPLOYEE_ID = 'emp-1';
/** A Tuesday and the Wednesday after it. Karachi is UTC+5. */
const TUESDAY = new Date('2026-09-22T00:00:00.000Z');
const WEDNESDAY = new Date('2026-09-23T00:00:00.000Z');
/** 09:00 Tuesday in Karachi. */
const ARRIVED = new Date('2026-09-22T04:00:00.000Z');

const openTuesday = {
  id: 'rec-tue',
  companyId: 'company-1',
  employeeId: EMPLOYEE_ID,
  date: TUESDAY,
  checkInAt: ARRIVED,
  checkOutAt: null,
  shiftId: null,
  notes: null,
  status: 'PRESENT',
  mode: 'OFFICE',
};

let app: FastifyInstance | null = null;

async function makeApp() {
  const instance = Fastify();
  registerErrorHandler(instance);
  instance.decorateRequest('auth', null);
  instance.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-1',
      companyId: 'company-1',
      email: 'someone@example.com',
      permissions: new Set(DEFAULT_ROLE_PERMISSIONS.EMPLOYEE),
      dataScope: 'OWN',
      mustChangePassword: false,
    };
  });
  await instance.register(attendanceRoutes, { prefix: '/attendance' });
  await instance.ready();
  return instance;
}

/** Records by day; the route asks by `employeeId_date`. */
function recordsAre(byDay: Record<string, unknown>) {
  db.attendanceRecord.findUnique.mockImplementation(async (args: { where: { employeeId_date: { date: Date } } }) => {
    const key = args.where.employeeId_date.date.toISOString().slice(0, 10);
    return byDay[key] ?? null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });

  db.company.findUniqueOrThrow.mockResolvedValue(POLICY);
  db.attendancePolicyAssignment.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findFirst.mockResolvedValue(null);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.holiday.findMany.mockResolvedValue([]);
  db.attendanceRecord.findMany.mockResolvedValue([]);
  db.auditLog.create.mockResolvedValue({});
  db.employee.findFirst.mockResolvedValue({
    id: EMPLOYEE_ID,
    firstName: 'Some',
    lastName: 'One',
    locationId: null,
  });
  db.employee.findUnique.mockResolvedValue(null);
  db.employee.findMany.mockResolvedValue([]);
  db.employee.findUniqueOrThrow.mockResolvedValue({
    id: EMPLOYEE_ID,
    hireDate: new Date('2024-01-01T00:00:00.000Z'),
    terminationDate: null,
    resignationDate: null,
    status: 'ACTIVE',
  });
  db.attendanceRecord.update.mockImplementation(async (args: { where: { id: string }; data: object }) => ({
    ...openTuesday,
    ...args.data,
    id: args.where.id,
  }));
});

afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = null;
});

/** Head Office, as production has it. */
const OFFICE = { name: 'Head Office', latitude: 31.4919141, longitude: 74.3871466, geofenceRadiusMeters: 10, checkOutRadiusMeters: 150 };
/** About 65m north of the centre: in the car park, inside 150m, outside 10m. */
const CAR_PARK = { latitude: 31.4925, longitude: 74.3871466 };
/** About a kilometre away. */
const DOWN_THE_ROAD = { latitude: 31.5005, longitude: 74.3871466 };

/** 09:00 Tuesday arrival; 18:30 departure. */
const LEAVING = new Date('2026-09-22T13:30:00.000Z');

function asEmployee(premisesCheckOutAllowed: boolean) {
  db.employee.findFirst.mockResolvedValue({
    id: EMPLOYEE_ID,
    firstName: 'Some',
    lastName: 'One',
    locationId: 'loc-hq',
    premisesCheckOutAllowed,
  });
}

function companyEnforces(checkOutLocationEnforced: boolean) {
  db.company.findUniqueOrThrow.mockResolvedValue({
    ...POLICY,
    // The overtime fields the shared fixture leaves out, so the day is scored in full.
    overtimeDailyCapMinutes: 240,
    overtimeFromShiftEnd: false,
    defaultShiftStart: '09:00',
    defaultShiftEnd: '18:00',
    checkOutLocationEnforced,
    defaultGeofenceRadiusM: 200,
  });
}

const updates = () => db.attendanceRecord.update.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
const audits = () =>
  db.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string; summary: string; after: Record<string, unknown> } }).data);

async function checkOut(payload: Record<string, unknown>) {
  app = await makeApp();
  return app.inject({ method: 'POST', url: '/attendance/check-out', payload });
}

beforeEach(() => {
  vi.setSystemTime(LEAVING);
  recordsAre({ '2026-09-22': openTuesday });
  db.location.findUnique.mockResolvedValue(OFFICE);
  companyEnforces(false);
});

describe('an employee allowed to check out from the premises', () => {
  beforeEach(() => asEmployee(true));

  it('checks out inside the boundary, recording where, how far, and that it was the web', async () => {
    const response = await checkOut(CAR_PARK);

    expect(response.statusCode).toBe(200);
    const [data] = updates();
    expect(data).toMatchObject({
      checkOutAt: LEAVING,
      checkOutSource: 'SELF',
      checkOutLatitude: CAR_PARK.latitude,
      checkOutLongitude: CAR_PARK.longitude,
    });
    expect(data!.checkOutDistanceMeters).toBeGreaterThan(50);
    expect(data!.checkOutDistanceMeters).toBeLessThan(150);
    // The existing engine scores the day: 09:00-18:30 is 570 minutes, and
    // the 30 past the 540-minute threshold are overtime, exactly as before.
    expect(data).toMatchObject({ workedMinutes: 570, overtimeMinutes: 30 });

    const audit = audits().find((a) => a.action === 'attendance.check_out')!;
    expect(audit.after).toMatchObject({ source: 'WEB', location: { validated: true, boundary: 'PREMISES', radiusMeters: 150 } });
  });

  it('refuses outside the boundary, writes nothing, and records the attempt with the distance', async () => {
    const response = await checkOut(DOWN_THE_ROAD);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/outside the 150m office premises area/);
    expect(db.attendanceRecord.update).not.toHaveBeenCalled();
    const refused = audits().find((a) => a.action === 'attendance.check_out.refused')!;
    expect(refused.after).toMatchObject({ boundary: 'PREMISES', radiusMeters: 150 });
    expect(refused.after.distanceMeters as number).toBeGreaterThan(900);
  });

  it('explains a denied location permission, and writes nothing', async () => {
    const response = await checkOut({ locationUnavailable: 'DENIED' });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.latitude[0]).toMatch(/permission was denied/);
    expect(db.attendanceRecord.update).not.toHaveBeenCalled();
    expect(audits().some((a) => a.action === 'attendance.check_out.refused')).toBe(true);
  });

  it('explains a device that could not find itself', async () => {
    const response = await checkOut({ locationUnavailable: 'TIMEOUT' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.latitude[0]).toMatch(/could not determine its location/);
  });

  it('refuses rather than allowing anywhere when no premises boundary is configured', async () => {
    db.location.findUnique.mockResolvedValue({ ...OFFICE, checkOutRadiusMeters: null });
    const response = await checkOut(CAR_PARK);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/No office premises boundary is configured/);
    expect(db.attendanceRecord.update).not.toHaveBeenCalled();
  });

  it('refuses rather than inventing an office when the location has no coordinates', async () => {
    db.location.findUnique.mockResolvedValue({ ...OFFICE, latitude: null, longitude: null });
    const response = await checkOut(CAR_PARK);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/no office coordinates configured/);
  });

  it('cannot close the day twice', async () => {
    recordsAre({ '2026-09-22': { ...openTuesday, checkOutAt: new Date('2026-09-22T13:00:00.000Z') } });
    const response = await checkOut(CAR_PARK);
    expect(response.statusCode).toBe(409);
    expect(db.attendanceRecord.update).not.toHaveBeenCalled();
  });

  it('tells the widget to ask for the location', async () => {
    app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/attendance/today' });
    expect(response.json().data.checkOutLocationRequired).toBe(true);
  });
});

describe('an employee who is not allowed premises check-out', () => {
  beforeEach(() => asEmployee(false));

  it('checks out exactly as before when the company does not enforce a geofence', async () => {
    const response = await checkOut({});
    expect(response.statusCode).toBe(200);
    expect(db.location.findUnique).not.toHaveBeenCalled();
    expect(updates()[0]).toMatchObject({ checkOutSource: 'SELF', checkOutDistanceMeters: null });
  });

  it('is held to the office geofence, not the premises boundary, when the company enforces one', async () => {
    companyEnforces(true);
    // 65m away: inside the 150m premises boundary, outside the 10m office fence.
    const response = await checkOut(CAR_PARK);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/outside the 10m check-out area/);
    expect(db.attendanceRecord.update).not.toHaveBeenCalled();
  });

  it('is not asked for a location by the widget', async () => {
    app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/attendance/today' });
    expect(response.json().data.checkOutLocationRequired).toBe(false);
  });
});
