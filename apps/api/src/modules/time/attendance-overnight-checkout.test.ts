import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@hrms/shared';

/**
 * The self-service check-out after midnight.
 *
 * The bug: somebody checks in at 09:00 and leaves at 01:00. At 01:00 "today"
 * is already the next day, so the check-out found no check-in and refused, the
 * widget offered Check in instead, and pressing it opened the next day with an
 * arrival nobody made - while the long day stayed open and earned nothing.
 *
 * The device import was fixed for this in fe273b8; the buttons were not. They
 * now apply the same company settings: a departure before the cutoff, within
 * the window of yesterday's arrival, closes yesterday.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
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
      dataScope: 'SELF',
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

describe('checking out at 01:00 after a 09:00 arrival', () => {
  beforeEach(() => {
    // 01:00 Wednesday in Karachi.
    vi.setSystemTime(new Date('2026-09-22T20:00:00.000Z'));
    recordsAre({ '2026-09-22': openTuesday });
  });

  it('closes Tuesday rather than refusing', async () => {
    app = await makeApp();
    const response = await app.inject({ method: 'POST', url: '/attendance/check-out', payload: {} });

    expect(response.statusCode).toBe(200);
    expect(db.attendanceRecord.update).toHaveBeenCalledTimes(1);
    const call = db.attendanceRecord.update.mock.calls[0]![0] as { where: { id: string }; data: { workedMinutes: number } };
    expect(call.where.id).toBe('rec-tue');
    expect(call.data.workedMinutes).toBe(16 * 60);
  });

  it('refuses a check-in, which would open Wednesday from a departure', async () => {
    app = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/attendance/check-in',
      payload: { mode: 'OFFICE' },
    });

    expect(response.statusCode).toBe(409);
    expect(db.attendanceRecord.upsert).not.toHaveBeenCalled();
  });

  it('shows Tuesday in the widget, still waiting for a check-out', async () => {
    app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/attendance/today' });

    expect(response.statusCode).toBe(200);
    const state = response.json().data;
    expect(state.date).toBe('2026-09-22');
    expect(state.carriedOver).toBe(true);
    expect(state.isWorkingDay).toBe(true);
  });
});

describe('the morning after the cutoff belongs to the new day', () => {
  it('does not reach back to Tuesday at 07:00', async () => {
    vi.setSystemTime(new Date('2026-09-23T02:00:00.000Z'));
    recordsAre({ '2026-09-22': openTuesday });

    app = await makeApp();
    const response = await app.inject({ method: 'POST', url: '/attendance/check-out', payload: {} });

    expect(response.statusCode).toBe(409);
    expect(db.attendanceRecord.update).not.toHaveBeenCalled();
  });

  it('shows Wednesday in the widget', async () => {
    vi.setSystemTime(new Date('2026-09-23T02:00:00.000Z'));
    recordsAre({ '2026-09-22': openTuesday });

    app = await makeApp();
    const state = (await app.inject({ method: 'GET', url: '/attendance/today' })).json().data;
    expect(state.date).toBe(WEDNESDAY.toISOString().slice(0, 10));
    expect(state.carriedOver).toBe(false);
  });
});

it('leaves a Tuesday that already closed alone', async () => {
  vi.setSystemTime(new Date('2026-09-22T20:00:00.000Z'));
  recordsAre({ '2026-09-22': { ...openTuesday, checkOutAt: new Date('2026-09-22T13:00:00.000Z') } });

  app = await makeApp();
  const response = await app.inject({ method: 'POST', url: '/attendance/check-out', payload: {} });

    expect(response.statusCode).toBe(409);
  expect(db.attendanceRecord.update).not.toHaveBeenCalled();
});
