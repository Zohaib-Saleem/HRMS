import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coversDay,
  periodsOverlap,
  resolveEmployeeOnDay,
  type MappingPeriod,
} from './mapping.service.js';

/**
 * PunchCode attribution.
 *
 * The pure half is tested directly - which employee a PIN resolves to on a
 * given day is the single decision the whole device pipeline rests on, and it
 * has no business needing a database to be checkable.
 *
 * The stateful half is tested against a mocked prisma, and asserts the two
 * rules that make a correction safe: the same PIN never belongs to two people
 * on the same day, and re-attribution starts at the effective date so history
 * keeps the employee it had.
 */

const db = vi.hoisted(() => ({
  attendanceDevice: { findFirst: vi.fn() },
  employee: { findFirst: vi.fn() },
  attendanceDeviceUserMapping: {
    findMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  attendanceRawPunch: { findMany: vi.fn(), updateMany: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { setMapping } = await import('./mapping.service.js');

const d = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const period = (over: Partial<MappingPeriod> = {}): MappingPeriod => ({
  deviceUserId: '42',
  employeeId: 'emp-1',
  isActive: true,
  effectiveFrom: null,
  effectiveTo: null,
  ...over,
});

// ------------------------------------------------------------------ pure part

describe('which day a mapping covers', () => {
  it('an open-ended mapping covers every day', () => {
    expect(coversDay(period(), '2020-01-01')).toBe(true);
    expect(coversDay(period(), '2030-12-31')).toBe(true);
  });

  it('a start date excludes everything before it', () => {
    const m = period({ effectiveFrom: d('2026-06-01') });
    expect(coversDay(m, '2026-05-31')).toBe(false);
    expect(coversDay(m, '2026-06-01')).toBe(true);
  });

  it('an end date excludes everything after it, inclusive of the day itself', () => {
    const m = period({ effectiveTo: d('2026-06-30') });
    expect(coversDay(m, '2026-06-30')).toBe(true);
    expect(coversDay(m, '2026-07-01')).toBe(false);
  });

  it('an inactive mapping covers nothing', () => {
    expect(coversDay(period({ isActive: false }), '2026-06-15')).toBe(false);
  });
});

describe('resolving a PunchCode to an employee', () => {
  /**
   * The case the effective dating exists for: a PIN handed from a leaver to a
   * new joiner. The leaver's punches must stay the leaver's.
   */
  const handover: MappingPeriod[] = [
    period({ employeeId: 'leaver', effectiveTo: d('2026-06-30') }),
    period({ employeeId: 'joiner', effectiveFrom: d('2026-07-01') }),
  ];

  it('gives the day before the handover to the leaver', () => {
    expect(resolveEmployeeOnDay(handover, '42', '2026-06-30')).toBe('leaver');
  });

  it('gives the day of the handover to the joiner', () => {
    expect(resolveEmployeeOnDay(handover, '42', '2026-07-01')).toBe('joiner');
  });

  it('resolves a PIN nobody holds to nobody', () => {
    expect(resolveEmployeeOnDay(handover, '99', '2026-07-01')).toBeNull();
  });

  it('is not confused by another device`s PIN', () => {
    const mixed = [...handover, period({ deviceUserId: '7', employeeId: 'other' })];
    expect(resolveEmployeeOnDay(mixed, '7', '2026-07-01')).toBe('other');
  });
});

describe('overlapping periods', () => {
  it('two open-ended periods always overlap', () => {
    expect(periodsOverlap({ effectiveFrom: null, effectiveTo: null }, { effectiveFrom: null, effectiveTo: null })).toBe(true);
  });

  it('periods that meet without touching do not overlap', () => {
    expect(
      periodsOverlap(
        { effectiveFrom: null, effectiveTo: d('2026-06-30') },
        { effectiveFrom: d('2026-07-01'), effectiveTo: null },
      ),
    ).toBe(false);
  });

  it('periods sharing a single day overlap', () => {
    expect(
      periodsOverlap(
        { effectiveFrom: null, effectiveTo: d('2026-07-01') },
        { effectiveFrom: d('2026-07-01'), effectiveTo: null },
      ),
    ).toBe(true);
  });
});

// ------------------------------------------------------------- stateful part

const EMPLOYEE = {
  id: 'emp-2',
  firstName: 'Bilal',
  lastName: 'Ahmed',
  displayName: null,
  employeeNumber: 'E-002',
};

const OTHER_EMPLOYEE = {
  id: 'emp-1',
  firstName: 'Ayesha',
  lastName: 'Khan',
  displayName: null,
  employeeNumber: 'E-001',
};

beforeEach(() => {
  vi.clearAllMocks();
  db.attendanceDevice.findFirst.mockResolvedValue({ id: 'dev-1', name: 'Main gate' });
  db.employee.findFirst.mockResolvedValue(EMPLOYEE);
  db.attendanceDeviceUserMapping.findMany.mockResolvedValue([]);
  db.attendanceDeviceUserMapping.create.mockResolvedValue({ id: 'map-new' });
  db.attendanceDeviceUserMapping.update.mockResolvedValue({ id: 'map-existing' });
  db.attendanceRawPunch.findMany.mockResolvedValue([]);
  db.attendanceRawPunch.updateMany.mockResolvedValue({ count: 0 });
});

const map = (over: Record<string, unknown> = {}) =>
  setMapping({
    companyId: 'company-1',
    deviceId: 'dev-1',
    deviceUserId: '42',
    employeeId: 'emp-2',
    isActive: true,
    effectiveFrom: null,
    effectiveTo: null,
    closeConflicting: false,
    ...over,
  } as never);

describe('duplicate PunchCode protection', () => {
  const held = {
    id: 'map-1',
    deviceUserId: '42',
    employeeId: 'emp-1',
    isActive: true,
    effectiveFrom: null,
    effectiveTo: null,
    employee: OTHER_EMPLOYEE,
  };

  it('refuses to give one PunchCode to a second employee over the same dates', async () => {
    db.attendanceDeviceUserMapping.findMany.mockResolvedValue([held]);

    await expect(map()).rejects.toThrow(/already assigned to Ayesha Khan/i);
    expect(db.attendanceDeviceUserMapping.create).not.toHaveBeenCalled();
    expect(db.attendanceRawPunch.updateMany).not.toHaveBeenCalled();
  });

  it('names who holds it and since when, rather than failing anonymously', async () => {
    db.attendanceDeviceUserMapping.findMany.mockResolvedValue([
      { ...held, effectiveFrom: d('2026-01-01') },
    ]);

    await expect(map()).rejects.toThrow(/E-002|E-001|2026-01-01/);
  });

  it('refuses a takeover without an effective date, even with consent', async () => {
    db.attendanceDeviceUserMapping.findMany.mockResolvedValue([held]);

    // Without a start date there is no line to draw: every punch the PIN ever
    // recorded would move to the new employee, including the old one's.
    await expect(map({ closeConflicting: true })).rejects.toThrow(/Set an effective date/i);
  });

  it('refuses to take over a mapping that already has an explicit end date', async () => {
    db.attendanceDeviceUserMapping.findMany.mockResolvedValue([
      { ...held, effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-12-31') },
    ]);

    await expect(
      map({ closeConflicting: true, effectiveFrom: d('2026-07-01') }),
    ).rejects.toThrow(/explicit end date/i);
  });

  it('does not treat the same employee holding the same PIN as a conflict', async () => {
    db.attendanceDeviceUserMapping.findMany.mockResolvedValue([
      { ...held, employeeId: 'emp-2', employee: EMPLOYEE },
    ]);

    const result = await map({ effectiveFrom: d('2026-07-01') });

    // An edit of the existing period, not a second row.
    expect(db.attendanceDeviceUserMapping.update).toHaveBeenCalledTimes(1);
    expect(db.attendanceDeviceUserMapping.create).not.toHaveBeenCalled();
    expect(result.closedMappingId).toBeNull();
  });
});

describe('correcting a mapping', () => {
  const held = {
    id: 'map-1',
    deviceUserId: '42',
    employeeId: 'emp-1',
    isActive: true,
    effectiveFrom: d('2026-01-01'),
    effectiveTo: null,
    employee: OTHER_EMPLOYEE,
  };

  beforeEach(() => {
    db.attendanceDeviceUserMapping.findMany.mockResolvedValue([held]);
    db.attendanceRawPunch.findMany.mockResolvedValue([
      { id: 'p1', localDayKey: '2026-07-01' },
      { id: 'p2', localDayKey: '2026-07-01' },
      { id: 'p3', localDayKey: '2026-07-02' },
    ]);
    db.attendanceRawPunch.updateMany.mockResolvedValue({ count: 3 });
  });

  it('closes the old mapping the day before the new one starts', async () => {
    const result = await map({ closeConflicting: true, effectiveFrom: d('2026-07-01') });

    expect(result.closedMappingId).toBe('map-1');
    const closed = db.attendanceDeviceUserMapping.update.mock.calls[0]![0]! as {
      where: { id: string };
      data: { effectiveTo: Date };
    };
    expect(closed.where.id).toBe('map-1');
    expect(closed.data.effectiveTo.toISOString().slice(0, 10)).toBe('2026-06-30');
  });

  it('re-attributes punches only from the effective date onward', async () => {
    await map({ closeConflicting: true, effectiveFrom: d('2026-07-01') });

    const where = db.attendanceRawPunch.findMany.mock.calls[0]![0]!.where as {
      localDayKey?: { gte?: string };
    };
    // Anything before 2026-07-01 is history and keeps the employee it had.
    expect(where.localDayKey?.gte).toBe('2026-07-01');
  });

  it('writes only the attribution and the processed flag on a punch', async () => {
    await map({ closeConflicting: true, effectiveFrom: d('2026-07-01') });

    const data = db.attendanceRawPunch.updateMany.mock.calls[0]![0]!.data as Record<string, unknown>;
    // The device's own fields - instant, PIN, direction, verification - are
    // never in this object. That is the promise the whole module rests on.
    expect(Object.keys(data).sort()).toEqual(['employeeId', 'processedAt']);
    expect(data.employeeId).toBe('emp-2');
    expect(data.processedAt).toBeNull();
  });

  it('reports what moved without recalculating any of it', async () => {
    const result = await map({ closeConflicting: true, effectiveFrom: d('2026-07-01') });

    expect(result.reattributedPunches).toBe(3);
    expect(result.affectedDays).toBe(2);
    expect(result.summary).toMatch(/re-attributing 3 punch\(es\) over 2 day\(s\)/);
  });

  it('preserves the historical mapping rather than deleting it', async () => {
    await map({ closeConflicting: true, effectiveFrom: d('2026-07-01') });

    expect(db.attendanceDeviceUserMapping).not.toHaveProperty('delete');
    expect(db.attendanceDeviceUserMapping).not.toHaveProperty('deleteMany');
    // The old row was closed, not removed: the leaver's punches still point
    // at a mapping that explains them.
    const closed = db.attendanceDeviceUserMapping.update.mock.calls[0]![0]!.data as Record<
      string,
      unknown
    >;
    expect(closed).not.toHaveProperty('employeeId');
    expect(closed).not.toHaveProperty('isActive');
  });
});

describe('validation', () => {
  it('refuses an end date before the start date', async () => {
    await expect(
      map({ effectiveFrom: d('2026-07-01'), effectiveTo: d('2026-06-01') }),
    ).rejects.toThrow();
  });

  it('refuses an employee from another company', async () => {
    db.employee.findFirst.mockResolvedValue(null);
    await expect(map()).rejects.toThrow();
  });

  it('refuses a device from another company', async () => {
    db.attendanceDevice.findFirst.mockResolvedValue(null);
    await expect(map()).rejects.toThrow();
  });

  it('attributes nothing when the mapping is created inactive', async () => {
    await map({ isActive: false });
    expect(db.attendanceRawPunch.updateMany).not.toHaveBeenCalled();
  });
});
