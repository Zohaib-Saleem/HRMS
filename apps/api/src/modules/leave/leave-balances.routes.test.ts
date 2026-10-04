import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Adjusting an employee's leave balance from their profile.
 *
 * The only stored, editable figure on a balance is the administrative
 * adjustment for one leave type and one year. Entitlement, accrual, used,
 * pending and remaining are derived from the leave type and the leave
 * requests, and this endpoint touches none of them - it never reads a leave
 * request, let alone writes one.
 *
 * What is pinned: `leave.manage` is the gate and HR Admin and Super Admin are
 * the only roles shipped with it; a reason is compulsory; and the audit entry
 * carries who, the old value and the new value.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn() },
  leaveType: { findFirst: vi.fn(), findMany: vi.fn() },
  leaveBalance: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
  leaveRequest: { findMany: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { leaveBalanceRoutes } = await import('./leave-requests.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

async function appAs(
  permissions: readonly Permission[],
  dataScope: 'ALL' | 'OWN' | 'REPORTS_AND_OWN' = 'ALL',
): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-hr',
      companyId: 'company-1',
      email: 'hr@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(leaveBalanceRoutes, { prefix: '/leave/balances' });
  await app.ready();
  return app;
}

const BODY = {
  employeeId: 'emp-1',
  leaveTypeId: 'type-annual',
  year: 2026,
  adjustmentDays: 2.5,
  adjustmentNote: 'Days carried over from the old spreadsheet',
};

const ANNUAL_TYPE = {
  id: 'type-annual',
  name: 'Annual',
  code: 'AL',
  isPaid: true,
  annualEntitlementDays: 15,
  monthlyAccrualDays: 15,
  carryForwardEnabled: false,
  carryForwardCapDays: null,
};

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  // The scope check: ALL scope sends an empty filter and finds the employee.
  db.employee.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if ('userId' in where) return { id: 'emp-self' };
    return { id: 'emp-1' };
  });
  db.leaveType.findFirst.mockResolvedValue({ id: 'type-annual', name: 'Annual' });
  db.leaveBalance.findUnique.mockResolvedValue({ adjustmentDays: -1, adjustmentNote: 'Taken in January' });
  db.leaveBalance.upsert.mockResolvedValue({ id: 'bal-1' });
  db.auditLog.create.mockResolvedValue({});
  /*
   * The balance as the profile computes it: 15 days a year, accrued in full
   * (a 15-day monthly rate caps at the annual figure after one month, so the
   * test does not move with the calendar), an adjustment of -1 and 6 days
   * taken. Allocation 14, remaining 8.
   */
  db.leaveType.findMany.mockResolvedValue([ANNUAL_TYPE]);
  db.leaveBalance.findMany.mockResolvedValue([
    { leaveTypeId: 'type-annual', openingDays: 0, adjustmentDays: -1, adjustmentNote: 'Taken in January' },
  ]);
  db.leaveRequest.findMany.mockResolvedValue([
    { leaveTypeId: 'type-annual', status: 'APPROVED', totalDays: 6 },
  ]);
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('who may adjust a balance', () => {
  it('ships leave.manage to HR Admin and Super Admin only', () => {
    const holders = Object.entries(DEFAULT_ROLE_PERMISSIONS)
      .filter(([, grants]) => grants.includes(PERMISSIONS.LEAVE_MANAGE))
      .map(([role]) => role)
      .sort();
    expect(holders).toEqual(['HR_ADMIN', 'SUPER_ADMIN']);
  });

  it('lets HR Admin adjust', async () => {
    app = await appAs(DEFAULT_ROLE_PERMISSIONS.HR_ADMIN);
    const res = await app.inject({ method: 'POST', url: '/leave/balances/adjust', payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(db.leaveBalance.upsert).toHaveBeenCalledTimes(1);
  });

  it('lets Super Admin adjust', async () => {
    app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
    const res = await app.inject({ method: 'POST', url: '/leave/balances/adjust', payload: BODY });
    expect(res.statusCode).toBe(200);
  });

  for (const role of ['MANAGER', 'TEAM_MANAGER', 'EMPLOYEE', 'IT_ASSET_MANAGER'] as const) {
    it(`refuses ${role} with 403 and writes nothing`, async () => {
      app = await appAs(DEFAULT_ROLE_PERMISSIONS[role], 'OWN');
      const res = await app.inject({ method: 'POST', url: '/leave/balances/adjust', payload: BODY });
      expect(res.statusCode).toBe(403);
      expect(db.leaveBalance.upsert).not.toHaveBeenCalled();
      expect(db.auditLog.create).not.toHaveBeenCalled();
    });
  }
});

describe('what an adjustment must carry', () => {
  it('requires a reason', async () => {
    app = await appAs(DEFAULT_ROLE_PERMISSIONS.HR_ADMIN);
    const res = await app.inject({
      method: 'POST',
      url: '/leave/balances/adjust',
      payload: { ...BODY, adjustmentNote: '' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.adjustmentNote).toBeDefined();
    expect(db.leaveBalance.upsert).not.toHaveBeenCalled();
  });

  it('writes only the adjustment and its reason, never a leave request', async () => {
    app = await appAs(DEFAULT_ROLE_PERMISSIONS.HR_ADMIN);
    await app.inject({ method: 'POST', url: '/leave/balances/adjust', payload: BODY });

    const upsert = db.leaveBalance.upsert.mock.calls[0]![0];
    expect(upsert.update).toEqual({
      adjustmentDays: 2.5,
      adjustmentNote: 'Days carried over from the old spreadsheet',
    });
    expect(upsert.create).toMatchObject({
      companyId: 'company-1',
      employeeId: 'emp-1',
      leaveTypeId: 'type-annual',
      year: 2026,
    });
    expect(upsert.create).not.toHaveProperty('openingDays');
    // Read, to know what has been taken; never written.
    expect(db.leaveRequest.update).not.toHaveBeenCalled();
  });

  it('audits who changed it, the old value and the new value', async () => {
    app = await appAs(DEFAULT_ROLE_PERMISSIONS.HR_ADMIN);
    await app.inject({ method: 'POST', url: '/leave/balances/adjust', payload: BODY });

    const audit = db.auditLog.create.mock.calls[0]![0].data;
    expect(audit.action).toBe('leave.balance.adjust');
    expect(audit.actorId).toBe('user-hr');
    expect(audit.entityId).toBe('bal-1');
    expect(audit.before).toEqual({
      adjustmentDays: -1,
      adjustmentNote: 'Taken in January',
      allocationDays: 14,
    });
    expect(audit.after).toEqual({
      adjustmentDays: 2.5,
      adjustmentNote: 'Days carried over from the old spreadsheet',
      allocationDays: 17.5,
    });
    expect(audit.summary).toContain('allocation 14 → 17.5');
    expect(audit.summary).toContain('adjustment -1 → 2.5');
  });

  it('records a zero before-value when no adjustment existed', async () => {
    db.leaveBalance.findUnique.mockResolvedValue(null);
    app = await appAs(DEFAULT_ROLE_PERMISSIONS.HR_ADMIN);
    await app.inject({ method: 'POST', url: '/leave/balances/adjust', payload: BODY });

    const audit = db.auditLog.create.mock.calls[0]![0].data;
    expect(audit.before).toEqual({ adjustmentDays: 0, adjustmentNote: null, allocationDays: 15 });
  });

  it('refuses an employee outside the caller data scope', async () => {
    db.employee.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if ('userId' in where) return { id: 'emp-self' };
      return null;
    });
    app = await appAs(DEFAULT_ROLE_PERMISSIONS.HR_ADMIN, 'REPORTS_AND_OWN');
    const res = await app.inject({ method: 'POST', url: '/leave/balances/adjust', payload: BODY });
    expect(res.statusCode).toBe(403);
    expect(db.leaveBalance.upsert).not.toHaveBeenCalled();
  });
});

describe('what an adjustment may not do', () => {
  const adjust = async (adjustmentDays: number) => {
    app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
    return app.inject({
      method: 'POST',
      url: '/leave/balances/adjust',
      payload: { ...BODY, adjustmentDays },
    });
  };

  it('refuses a figure no leave request could ever clear', async () => {
    const res = await adjust(0.3);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.adjustmentDays).toBeDefined();
    expect(db.leaveBalance.upsert).not.toHaveBeenCalled();
  });

  it('refuses to cut the balance below what has already been taken', async () => {
    // From -1 to -10: remaining 8 would become -1.
    const res = await adjust(-10);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.adjustmentDays[0]).toContain('already taken or pending');
    expect(db.leaveBalance.upsert).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('allows cutting it to exactly zero', async () => {
    const res = await adjust(-9);
    expect(res.statusCode).toBe(200);
  });

  it('refuses an allocation below zero', async () => {
    db.leaveRequest.findMany.mockResolvedValue([]);
    const res = await adjust(-16);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.adjustmentDays[0]).toContain('below zero');
  });

  it('still allows raising a balance that is already short', async () => {
    db.leaveRequest.findMany.mockResolvedValue([
      { leaveTypeId: 'type-annual', status: 'APPROVED', totalDays: 20 },
    ]);
    const res = await adjust(0);
    expect(res.statusCode).toBe(200);
  });

  it('counts pending requests as committed too', async () => {
    db.leaveRequest.findMany.mockResolvedValue([
      { leaveTypeId: 'type-annual', status: 'APPROVED', totalDays: 6 },
      { leaveTypeId: 'type-annual', status: 'PENDING', totalDays: 4 },
    ]);
    // Remaining 4; lowering by 5 would leave -1.
    const res = await adjust(-6);
    expect(res.statusCode).toBe(422);
  });
});
