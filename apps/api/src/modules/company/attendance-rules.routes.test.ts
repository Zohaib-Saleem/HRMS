import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Authorisation and validation on the attendance rules endpoints.
 *
 * The screen hides the controls a user cannot use, which is a courtesy and not
 * a control. These tests drive the routes directly - the same way anyone
 * holding a session cookie and a terminal would - so what is asserted is the
 * gate itself: an employee cannot change the company's overtime rules by
 * calling the endpoint, whatever the UI shows them.
 */

const db = vi.hoisted(() => ({
  company: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  // The rules screen reads the pay-side switches beside the rules they depend
  // on. It reads them; it never writes them.
  payrollSettings: { findUnique: vi.fn() },
  auditLog: { create: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { companyRoutes } = await import('./company.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const STORED = {
  defaultShiftStart: '09:00',
  defaultShiftEnd: '18:00',
  overtimeEnabled: true,
  overtimeFromShiftEnd: true,
  overtimeCountsEarlyArrival: false,
  overtimeReducedByLateArrival: false,
  overtimeDailyCapMinutes: 240,
  lateTrackingEnabled: true,
  graceMinutes: 10,
  earlyDepartureTrackingEnabled: true,
  earlyLeaveGraceMinutes: 10,
  fullDayToleranceMinutes: 30,
  irregularCheckInEnabled: true,
  irregularCheckInCutoff: '11:00',
  irregularCheckInMode: 'ABSOLUTE_TIME',
  irregularAfterShiftStartMinutes: 120,
  breakIncludedInWindow: true,
  overtimeMinimumMinutes: 0,
  overtimeRoundingMinutes: 0,
  overtimeWeeklyCapMinutes: null,
  overtimeMonthlyCapMinutes: null,
  missingCheckOutStatus: 'PRESENT',
  missingCheckInStatus: 'ABSENT',
  timezone: 'Asia/Karachi',
  weekendDays: ['SATURDAY', 'SUNDAY'],
  halfDayMinutes: 240,
  fullDayMinutes: 480,
  overtimeAfterMinutes: 480,
  defaultBreakMinutes: 0,
  lateThresholdMinutes: 0,
  earlyLeaveThresholdMinutes: 0,
  weekendWorkRule: 'AS_WORKING_DAY',
  holidayWorkRule: 'AS_WORKING_DAY',
};

/** A valid payload; individual cases corrupt one field. */
const VALID = {
  defaultShiftStart: '09:00',
  defaultShiftEnd: '18:00',
  overtimeEnabled: true,
  overtimeFromShiftEnd: true,
  overtimeCountsEarlyArrival: false,
  overtimeReducedByLateArrival: false,
  overtimeDailyCapMinutes: 240,
  lateTrackingEnabled: true,
  graceMinutes: 10,
  earlyDepartureTrackingEnabled: true,
  earlyLeaveGraceMinutes: 10,
  fullDayToleranceMinutes: 30,
  irregularCheckInEnabled: true,
  irregularCheckInCutoff: '11:00',
  irregularCheckInMode: 'ABSOLUTE_TIME',
  irregularAfterShiftStartMinutes: 120,
  breakIncludedInWindow: true,
  overtimeMinimumMinutes: 0,
  overtimeRoundingMinutes: 0,
  overtimeWeeklyCapMinutes: null,
  overtimeMonthlyCapMinutes: null,
  missingCheckOutStatus: 'PRESENT',
  missingCheckInStatus: 'ABSENT',
};

/** The permission sets the four seeded roles actually hold. */
const SUPER_ADMIN: Permission[] = [
  PERMISSIONS.COMPANY_READ,
  PERMISSIONS.COMPANY_MANAGE,
  PERMISSIONS.SETTINGS_MANAGE,
];
/** HR Admin holds company.manage but NOT settings.manage. */
const HR_ADMIN: Permission[] = [PERMISSIONS.COMPANY_READ, PERMISSIONS.COMPANY_MANAGE];
/** HR Admin, plus the rules permission granted to them explicitly. */
const HR_ADMIN_WITH_RULES: Permission[] = [
  PERMISSIONS.COMPANY_READ,
  PERMISSIONS.COMPANY_MANAGE,
  PERMISSIONS.ATTENDANCE_RULES_MANAGE,
];
const EMPLOYEE: Permission[] = [PERMISSIONS.COMPANY_READ];
const NOBODY: Permission[] = [];

/** Builds the routes with a caller holding exactly these permissions. */
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
  await app.register(companyRoutes, { prefix: '/company' });
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  db.company.findUniqueOrThrow.mockResolvedValue({ ...STORED });
  db.company.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...STORED,
    ...data,
  }));
  db.payrollSettings.findUnique.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('reading the rules', () => {
  it('lets a Super Admin read them, and says they may manage', async () => {
    app = await appAs(SUPER_ADMIN);

    const response = await app.inject({ method: 'GET', url: '/company/attendance-rules' });

    expect(response.statusCode).toBe(200);
    const { data } = response.json();
    expect(data.defaultShiftStart).toBe('09:00');
    expect(data.defaultShiftEnd).toBe('18:00');
    expect(data.overtimeDailyCapMinutes).toBe(240);
    expect(data.irregularCheckInCutoff).toBe('11:00');
    expect(data.canManage).toBe(true);
  });

  it('lets an ordinary employee read them, but tells them they cannot manage', async () => {
    app = await appAs(EMPLOYEE);

    const response = await app.inject({ method: 'GET', url: '/company/attendance-rules' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.canManage).toBe(false);
  });

  it('refuses a caller with no company access at all', async () => {
    app = await appAs(NOBODY);

    const response = await app.inject({ method: 'GET', url: '/company/attendance-rules' });

    expect(response.statusCode).toBe(403);
  });
});

describe('changing the rules', () => {
  it('lets a Super Admin save', async () => {
    app = await appAs(SUPER_ADMIN);

    const response = await app.inject({
      method: 'PATCH',
      url: '/company/attendance-rules',
      payload: { ...VALID, overtimeDailyCapMinutes: 120 },
    });

    expect(response.statusCode).toBe(200);
    expect(db.company.update).toHaveBeenCalledTimes(1);
  });

  it('persists exactly what was sent', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({
      method: 'PATCH',
      url: '/company/attendance-rules',
      payload: { ...VALID, defaultShiftEnd: '19:00', overtimeDailyCapMinutes: 120 },
    });

    const written = db.company.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(written.defaultShiftEnd).toBe('19:00');
    expect(written.overtimeDailyCapMinutes).toBe(120);
  });

  it('refuses an ordinary employee', async () => {
    app = await appAs(EMPLOYEE);

    const response = await app.inject({
      method: 'PATCH',
      url: '/company/attendance-rules',
      payload: { ...VALID, overtimeDailyCapMinutes: 999 },
    });

    expect(response.statusCode).toBe(403);
    expect(db.company.update).not.toHaveBeenCalled();
  });

  it('refuses HR Admin, who may manage the company but not its settings', async () => {
    // The distinction the whole gate exists for: company.manage is not enough.
    app = await appAs(HR_ADMIN);

    const response = await app.inject({
      method: 'PATCH',
      url: '/company/attendance-rules',
      payload: VALID,
    });

    expect(response.statusCode).toBe(403);
    expect(db.company.update).not.toHaveBeenCalled();
  });

  it('refuses before validating, so a bad payload cannot reveal the schema', async () => {
    app = await appAs(EMPLOYEE);

    const response = await app.inject({
      method: 'PATCH',
      url: '/company/attendance-rules',
      payload: { nonsense: true },
    });

    expect(response.statusCode).toBe(403);
  });

  it('ignores unknown fields in the payload rather than writing them', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({
      method: 'PATCH',
      url: '/company/attendance-rules',
      payload: { ...VALID, isSuperCompany: true, halfDayMinutes: 1 },
    });

    const written = db.company.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(written).not.toHaveProperty('isSuperCompany');
    // Half-day thresholds ARE this endpoint's to change now: the attendance
    // module moved every rule the engine reads onto one screen, so that a
    // rule Super Admin cannot see is not also a rule Super Admin cannot fix.
    expect(written).toHaveProperty('halfDayMinutes', 1);
  });
});

describe('validation', () => {
  const reject = async (payload: Record<string, unknown>, field: string) => {
    app = await appAs(SUPER_ADMIN);
    const response = await app.inject({
      method: 'PATCH',
      url: '/company/attendance-rules',
      payload: { ...VALID, ...payload },
    });
    expect(response.statusCode).toBe(422);
    expect(Object.keys(response.json().error.details ?? {})).toContain(field);
    expect(db.company.update).not.toHaveBeenCalled();
  };

  it('rejects a malformed time', () => reject({ defaultShiftStart: '9am' }, 'defaultShiftStart'));
  it('rejects an out-of-range time', () => reject({ defaultShiftEnd: '25:00' }, 'defaultShiftEnd'));
  it('rejects an invalid cutoff', () =>
    reject({ irregularCheckInCutoff: '11:75' }, 'irregularCheckInCutoff'));

  it('rejects a negative overtime cap', () =>
    reject({ overtimeDailyCapMinutes: -1 }, 'overtimeDailyCapMinutes'));
  it('rejects a negative grace period', () => reject({ graceMinutes: -5 }, 'graceMinutes'));
  it('rejects a negative early departure grace', () =>
    reject({ earlyLeaveGraceMinutes: -5 }, 'earlyLeaveGraceMinutes'));

  it('rejects an end time equal to the start time', () =>
    reject({ defaultShiftStart: '09:00', defaultShiftEnd: '09:00' }, 'defaultShiftEnd'));

  it('rejects a cutoff at or before the shift start, which would make every day irregular', () =>
    reject({ irregularCheckInCutoff: '08:00' }, 'irregularCheckInCutoff'));

  it('rejects overtime enabled with a zero cap, which can never produce a figure', () =>
    reject({ overtimeEnabled: true, overtimeDailyCapMinutes: 0 }, 'overtimeDailyCapMinutes'));
});

describe('audit', () => {
  it('records the change with its old and new value', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({
      method: 'PATCH',
      url: '/company/attendance-rules',
      payload: { ...VALID, overtimeDailyCapMinutes: 120 },
    });

    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const entry = db.auditLog.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(entry.action).toBe('company.attendance_rules.update');
    expect(entry.actorId).toBe('user-1');
    expect(entry.entityType).toBe('Company');
    expect((entry.before as Record<string, unknown>).overtimeDailyCapMinutes).toBe(240);
    expect((entry.after as Record<string, unknown>).overtimeDailyCapMinutes).toBe(120);
    expect(String(entry.summary)).toContain('overtimeDailyCapMinutes');
  });

  it('writes nothing to the audit log when nothing actually changed', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({ method: 'PATCH', url: '/company/attendance-rules', payload: VALID });

    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('never records a rejected change', async () => {
    app = await appAs(EMPLOYEE);

    await app.inject({
      method: 'PATCH',
      url: '/company/attendance-rules',
      payload: { ...VALID, overtimeDailyCapMinutes: 120 },
    });

    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('saving rules touches nothing but the company row', () => {
  it('writes no attendance, punch, payroll or employee record', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({
      method: 'PATCH',
      url: '/company/attendance-rules',
      payload: { ...VALID, defaultShiftEnd: '19:00' },
    });

    // The mocked client exposes only company and auditLog. Any attempt to reach
    // another model would throw rather than silently succeed, and the update
    // that did happen was scoped to the caller's own company.
    expect(db.company.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'company-1' } }),
    );
  });
});


describe('the explicit rules permission', () => {
  it('lets HR Admin save once attendance.rules.manage is granted', async () => {
    // The whole reason the permission exists: a company that wants its HR
    // team to own the attendance rules should not have to hand them every
    // other system setting to do it.
    app = await appAs(HR_ADMIN_WITH_RULES);

    const response = await app.inject({
      method: 'PATCH',
      url: '/company/attendance-rules',
      payload: VALID,
    });

    expect(response.statusCode).toBe(200);
    expect(db.company.update).toHaveBeenCalledTimes(1);
    expect(response.json().data.canManage).toBe(true);
  });

  it('still refuses HR Admin without it', async () => {
    app = await appAs(HR_ADMIN);

    const response = await app.inject({
      method: 'PATCH',
      url: '/company/attendance-rules',
      payload: VALID,
    });

    expect(response.statusCode).toBe(403);
    expect(db.company.update).not.toHaveBeenCalled();
  });
});

describe('what the screen reads back', () => {
  it('carries the shipped defaults, so "reset" offers what a new company gets', async () => {
    app = await appAs(SUPER_ADMIN);

    const response = await app.inject({ method: 'GET', url: '/company/attendance-rules' });
    const data = response.json().data;

    // The confirmed office policy, as configuration rather than as code.
    expect(data.defaults.defaultShiftStart).toBe('09:00');
    expect(data.defaults.defaultShiftEnd).toBe('18:00');
    expect(data.defaults.fullDayMinutes).toBe(480);
    expect(data.defaults.weekendDays).toEqual(['SATURDAY', 'SUNDAY']);
  });

  it('reads the pay-side switches, and never writes them', async () => {
    db.payrollSettings.findUnique.mockResolvedValue({
      deductUnpaidAbsence: true,
      deductUnpaidLeave: true,
      lateDeductionMode: 'PER_MINUTE',
      earlyLeaveDeductionMode: 'NONE',
      overtimeMode: 'MULTIPLIER',
      requireApprovedOvertime: true,
      overtimeMultiplier: 1.5,
      overtimeCapMinutes: 2400,
    });

    app = await appAs(SUPER_ADMIN);
    const response = await app.inject({ method: 'GET', url: '/company/attendance-rules' });
    const integration = response.json().data.payrollIntegration;

    expect(integration.lateDeductionEnabled).toBe(true);
    expect(integration.earlyLeaveDeductionEnabled).toBe(false);
    expect(integration.overtimePaid).toBe(true);
    expect(integration.overtimeCapMinutes).toBe(2400);
    // One store, no copy: this screen reads payroll settings and edits none.
    expect(db.payrollSettings).not.toHaveProperty('update');
    expect(db.payrollSettings).not.toHaveProperty('upsert');
  });

  it('says null when payroll has never been configured', async () => {
    app = await appAs(SUPER_ADMIN);
    const response = await app.inject({ method: 'GET', url: '/company/attendance-rules' });
    expect(response.json().data.payrollIntegration).toBeNull();
  });

  it('leaves a rule the payload did not mention exactly as it was', async () => {
    app = await appAs(SUPER_ADMIN);

    await app.inject({
      method: 'PATCH',
      url: '/company/attendance-rules',
      payload: VALID,
    });

    const written = db.company.update.mock.calls[0]![0]!.data as Record<string, unknown>;
    // The newer fields are optional so an older client can still save. An
    // absent field must mean "leave alone", never "reset to a default".
    expect(written.weekendWorkRule).toBeUndefined();
    expect(written.lateThresholdMinutes).toBeUndefined();
  });
});
