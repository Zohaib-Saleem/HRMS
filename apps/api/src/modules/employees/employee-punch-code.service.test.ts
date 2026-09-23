import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';
import type { AuthContext } from '../../auth/session.js';

/**
 * The punch code on the employee form.
 *
 * The scenario these tests are written from is a real one. Muhammad AbuBakar
 * is employee 1021 and punches as 51; Muhammad Aamir is employee 284 and
 * punched as nobody, so 5,339 punches sat on the Device Punches page reading
 * "Unmapped". The fix is a field on the employee form, and what has to hold of
 * it is: employee number and punch code are never the same fact, a code
 * already in use is refused by name rather than moved, and an employee with no
 * code stays unmapped instead of being guessed at.
 */

const db = vi.hoisted(() => ({
  attendanceDeviceUserMapping: {
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  attendanceDevice: { findFirst: vi.fn(), findMany: vi.fn() },
  employee: { findFirst: vi.fn() },
  attendanceRawPunch: { findMany: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { applyPunchCode, assertPunchCodeAssignable } = await import('./employee-punch-code.service.js');

const OFFICE = { id: 'dev-office', name: 'Office' };

const ABUBAKAR = {
  id: 'emp-1021',
  firstName: 'Muhammad',
  lastName: 'AbuBakar',
  displayName: null,
  employeeNumber: '1021',
};

const AAMIR = {
  id: 'emp-284',
  firstName: 'Muhammad',
  lastName: 'Aamir',
  displayName: null,
  employeeNumber: '284',
};

/** AbuBakar's mapping, exactly as production holds it: 1021 punches as 51. */
const ABUBAKAR_MAPPING = {
  id: 'map-51',
  deviceId: OFFICE.id,
  deviceUserId: '51',
  employeeId: ABUBAKAR.id,
  isActive: true,
  effectiveFrom: null,
  effectiveTo: null,
  employee: ABUBAKAR,
};

function auth(permissions: Permission[] = [PERMISSIONS.EMPLOYEE_MANAGE, PERMISSIONS.DEVICE_MANAGE]): AuthContext {
  return {
    sessionId: 'session-1',
    userId: 'user-1',
    companyId: 'company-1',
    email: 'hr@example.com',
    permissions: new Set(permissions),
    dataScope: 'ALL',
    mustChangePassword: false,
  } as AuthContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.attendanceDevice.findMany.mockResolvedValue([OFFICE]);
  db.attendanceDevice.findFirst.mockResolvedValue(OFFICE);
  db.attendanceDeviceUserMapping.findMany.mockResolvedValue([]);
  db.attendanceDeviceUserMapping.count.mockResolvedValue(0);
  db.attendanceDeviceUserMapping.updateMany.mockResolvedValue({ count: 0 });
  db.attendanceDeviceUserMapping.update.mockResolvedValue({ id: 'map-new' });
  db.attendanceDeviceUserMapping.create.mockResolvedValue({ id: 'map-new' });
  db.employee.findFirst.mockResolvedValue(AAMIR);
  db.attendanceRawPunch.findMany.mockResolvedValue([]);
  db.attendanceRawPunch.updateMany.mockResolvedValue({ count: 0 });
  db.auditLog.create.mockResolvedValue({});
});

describe('the field is only acted on when it is actually sent', () => {
  it('leaves the mapping alone when the payload does not mention a punch code', async () => {
    const result = await applyPunchCode({ auth: auth(), employeeId: AAMIR.id, input: {} });

    expect(result).toBeNull();
    expect(db.attendanceDeviceUserMapping.create).not.toHaveBeenCalled();
    expect(db.attendanceDeviceUserMapping.updateMany).not.toHaveBeenCalled();
  });

  it('does not demand the device grant to create somebody with no punch code', async () => {
    /*
     * The create schema fills the omitted field with null, so every create
     * "carries" a punch code. Refusing that for want of `device.manage` would
     * have broken employee creation for every role that has no business with
     * attendance - the field is blank because nobody filled it in.
     */
    const result = await applyPunchCode({
      auth: auth([PERMISSIONS.EMPLOYEE_MANAGE]),
      employeeId: AAMIR.id,
      input: { punchCode: null, punchDeviceId: OFFICE.id },
    });

    expect(result).toBeNull();
    expect(db.attendanceDeviceUserMapping.create).not.toHaveBeenCalled();
  });

  it('leaves an employee with no punch code unmapped when the field is left blank', async () => {
    const result = await applyPunchCode({
      auth: auth(),
      employeeId: AAMIR.id,
      input: { punchCode: '' },
    });

    expect(result).toBeNull();
    expect(db.attendanceDeviceUserMapping.create).not.toHaveBeenCalled();
    expect(db.attendanceRawPunch.updateMany).not.toHaveBeenCalled();
  });
});

describe('assigning a punch code', () => {
  it('maps device user 284 to Muhammad Aamir and picks up the punches already sitting unmapped', async () => {
    // Three punches under PIN 284 that the Device Punches page shows as Unmapped.
    db.attendanceRawPunch.findMany.mockResolvedValue([
      { id: 'p1', localDayKey: '2026-09-21' },
      { id: 'p2', localDayKey: '2026-09-21' },
      { id: 'p3', localDayKey: '2026-09-22' },
    ]);
    db.attendanceRawPunch.updateMany.mockResolvedValue({ count: 3 });

    const result = await applyPunchCode({
      auth: auth(),
      employeeId: AAMIR.id,
      input: { punchCode: '284' },
    });

    expect(result).toMatchObject({
      deviceId: OFFICE.id,
      punchCode: '284',
      reattributedPunches: 3,
      affectedDays: 2,
    });

    expect(db.attendanceDeviceUserMapping.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deviceId: OFFICE.id,
          deviceUserId: '284',
          employeeId: AAMIR.id,
          isActive: true,
        }),
      }),
    );

    // Only the attribution and the processed flag - the punch itself, its PIN,
    // its instant and its direction are never written.
    expect(db.attendanceRawPunch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p2', 'p3'] } },
      data: { employeeId: AAMIR.id, processedAt: null },
    });

    // Only the punches that belonged to nobody were eligible to move.
    const query = db.attendanceRawPunch.findMany.mock.calls[0]![0] as {
      where: { OR: unknown[] };
    };
    expect(query.where.OR).toEqual([{ employeeId: null }]);
  });

  it('is a string, not a number: a padded code is stored as typed', async () => {
    await applyPunchCode({ auth: auth(), employeeId: AAMIR.id, input: { punchCode: '007' } });

    expect(db.attendanceDeviceUserMapping.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deviceUserId: '007' }) }),
    );
  });

  it('writes nothing when the employee already punches under that code', async () => {
    db.attendanceDeviceUserMapping.findMany.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(where.employeeId === ABUBAKAR.id ? [ABUBAKAR_MAPPING] : [ABUBAKAR_MAPPING]),
    );

    const result = await applyPunchCode({
      auth: auth(),
      employeeId: ABUBAKAR.id,
      input: { punchCode: '51' },
    });

    expect(result).toBeNull();
    expect(db.attendanceDeviceUserMapping.create).not.toHaveBeenCalled();
    expect(db.attendanceDeviceUserMapping.updateMany).not.toHaveBeenCalled();
    expect(db.attendanceRawPunch.updateMany).not.toHaveBeenCalled();
  });
});

describe('a code somebody else holds', () => {
  beforeEach(() => {
    db.attendanceDeviceUserMapping.findMany.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(where.deviceUserId === '51' ? [ABUBAKAR_MAPPING] : []),
    );
  });

  it('is refused by name rather than silently moved', async () => {
    await expect(
      applyPunchCode({ auth: auth(), employeeId: AAMIR.id, input: { punchCode: '51' } }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Punch Code 51 is already assigned to another employee'),
    });
  });

  it('names who holds it, so the refusal is actionable', async () => {
    await expect(
      applyPunchCode({ auth: auth(), employeeId: AAMIR.id, input: { punchCode: '51' } }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Muhammad AbuBakar, 1021') });
  });

  it('leaves the existing mapping and its punches exactly as they were', async () => {
    await applyPunchCode({ auth: auth(), employeeId: AAMIR.id, input: { punchCode: '51' } }).catch(
      () => null,
    );

    expect(db.attendanceDeviceUserMapping.update).not.toHaveBeenCalled();
    expect(db.attendanceDeviceUserMapping.updateMany).not.toHaveBeenCalled();
    expect(db.attendanceRawPunch.updateMany).not.toHaveBeenCalled();
  });

  it('refuses on create too, before the employee row is written', async () => {
    await expect(
      assertPunchCodeAssignable(auth(), null, { punchCode: '51' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('changing and clearing', () => {
  it('closes the old mapping instead of editing it, so the old punches stay attributed', async () => {
    db.attendanceDeviceUserMapping.findMany.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(where.employeeId === ABUBAKAR.id ? [ABUBAKAR_MAPPING] : []),
    );

    await applyPunchCode({ auth: auth(), employeeId: ABUBAKAR.id, input: { punchCode: '77' } });

    expect(db.attendanceDeviceUserMapping.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['map-51'] } },
      data: { isActive: false },
    });
    expect(db.attendanceDeviceUserMapping.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deviceUserId: '77' }) }),
    );
  });

  it('clearing the field closes the mapping and re-attributes nothing', async () => {
    db.attendanceDeviceUserMapping.findMany.mockResolvedValue([ABUBAKAR_MAPPING]);
    db.attendanceDeviceUserMapping.count.mockResolvedValue(1);

    const result = await applyPunchCode({
      auth: auth(),
      employeeId: ABUBAKAR.id,
      input: { punchCode: null },
    });

    expect(result).toMatchObject({ punchCode: null, reattributedPunches: 0 });
    expect(db.attendanceDeviceUserMapping.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['map-51'] } },
      data: { isActive: false },
    });
    expect(db.attendanceRawPunch.updateMany).not.toHaveBeenCalled();
  });
});

describe('who may set one', () => {
  it('refuses a caller who can manage employees but not devices', async () => {
    await expect(
      applyPunchCode({
        auth: auth([PERMISSIONS.EMPLOYEE_MANAGE]),
        employeeId: AAMIR.id,
        input: { punchCode: '284' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(db.attendanceDeviceUserMapping.create).not.toHaveBeenCalled();
  });
});

describe('which terminal the code belongs to', () => {
  it('infers the device when the company has exactly one', async () => {
    await applyPunchCode({ auth: auth(), employeeId: AAMIR.id, input: { punchCode: '284' } });

    expect(db.attendanceDeviceUserMapping.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deviceId: OFFICE.id }) }),
    );
  });

  it('refuses to guess when there are several', async () => {
    db.attendanceDevice.findMany.mockResolvedValue([OFFICE, { id: 'dev-2', name: 'Warehouse' }]);

    await expect(
      applyPunchCode({ auth: auth(), employeeId: AAMIR.id, input: { punchCode: '284' } }),
    ).rejects.toMatchObject({
      statusCode: 422,
      details: { punchDeviceId: [expect.stringContaining('Warehouse')] },
    });
  });

  it('says so plainly when no device is configured at all', async () => {
    db.attendanceDevice.findMany.mockResolvedValue([]);

    await expect(
      applyPunchCode({ auth: auth(), employeeId: AAMIR.id, input: { punchCode: '284' } }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
