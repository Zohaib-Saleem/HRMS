import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Leave and attendance reconciliation.
 *
 * Approved leave on a day the person turned out to work is given back. These
 * tests drive the real paths - the punch import, the approval sync, the nightly
 * pass, the balance and the attendance deriver - against a small in-memory
 * database, so what is pinned is the behaviour of the code that runs in
 * production rather than of a re-statement of it.
 *
 * The company is configured as production was on 2026-09-24 (09:00-18:00,
 * half day 240, full day 540, grace 15, weekend Saturday and Sunday, Karachi),
 * except that overtime is switched on so that rule can be seen to still apply,
 * and the irregular-arrival cutoff is 11:00.
 */

// ------------------------------------------------------------ in-memory store

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  seq: 0,
}));

function cmp(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : (a as number | string);
  const bv = b instanceof Date ? b.getTime() : (b as number | string);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a != null && b != null && cmp(a, b) === 0;
  return a === b;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'AND') {
      if (!(cond as Row[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matches(row, cond as Row)) return false;
      continue;
    }
    if (key === 'employeeId_date') {
      const c = cond as { employeeId: string; date: Date };
      if (row.employeeId !== c.employeeId || !eq(row.date, c.date)) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Row;
      if ('in' in c && !(c.in as unknown[]).some((v) => eq(v, value))) return false;
      if ('lte' in c && (value == null || cmp(value, c.lte) > 0)) return false;
      if ('gte' in c && (value == null || cmp(value, c.gte) < 0)) return false;
      if ('lt' in c && (value == null || cmp(value, c.lt) >= 0)) return false;
      if ('gt' in c && (value == null || cmp(value, c.gt) <= 0)) return false;
      if ('not' in c) {
        if (c.not === null ? value == null : eq(value, c.not)) return false;
      }
    } else if (!eq(value, cond)) {
      return false;
    }
  }
  return true;
}

/** Relations the code reads, joined on the way out. */
function hydrate(table: string, row: Row): Row {
  const t = store.tables;
  if (table === 'leaveRequest') {
    return {
      ...row,
      leaveType: t.leaveType!.find((l) => l.id === row.leaveTypeId),
      employee: t.employee!.find((e) => e.id === row.employeeId),
      reversals: t.leaveReversal!
        .filter((r) => r.leaveRequestId === row.id)
        .sort((a, b) => cmp(a.date, b.date)),
    };
  }
  if (table === 'attendanceRecord') return { shift: null, ...row };
  return { ...row };
}

function model(table: string, unique: (row: Row) => string | null = () => null) {
  const rows = () => (store.tables[table] ??= []);
  const find = (where?: Row) => rows().filter((r) => matches(r, where));
  return {
    findMany: vi.fn(async (args: { where?: Row } = {}) => find(args.where).map((r) => hydrate(table, r))),
    findFirst: vi.fn(async (args: { where?: Row } = {}) => {
      const r = find(args.where)[0];
      return r ? hydrate(table, r) : null;
    }),
    findUnique: vi.fn(async (args: { where: Row }) => {
      const r = find(args.where)[0];
      return r ? hydrate(table, r) : null;
    }),
    findUniqueOrThrow: vi.fn(async (args: { where: Row }) => {
      const r = find(args.where)[0];
      if (!r) throw new Error(`${table} not found`);
      return hydrate(table, r);
    }),
    count: vi.fn(async (args: { where?: Row } = {}) => find(args.where).length),
    create: vi.fn(async (args: { data: Row }) => {
      const row: Row = { id: `${table}-${++store.seq}`, createdAt: new Date(), ...args.data };
      const key = unique(row);
      if (key && rows().some((r) => unique(r) === key)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      rows().push(row);
      return { ...row };
    }),
    update: vi.fn(async (args: { where: Row; data: Row }) => {
      const r = find(args.where)[0];
      if (!r) throw new Error(`${table} not found`);
      Object.assign(r, args.data);
      return { ...r };
    }),
    updateMany: vi.fn(async (args: { where?: Row; data: Row }) => {
      const hit = find(args.where);
      for (const r of hit) Object.assign(r, args.data);
      return { count: hit.length };
    }),
    upsert: vi.fn(async (args: { where: Row; create: Row; update: Row }) => {
      const r = find(args.where)[0];
      if (r) {
        Object.assign(r, args.update);
        return { ...r };
      }
      const row: Row = { id: `${table}-${++store.seq}`, createdAt: new Date(), ...args.create };
      rows().push(row);
      return { ...row };
    }),
  };
}

const db = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock('../../core/db.js', () => ({ prisma: db }));
// Notifications are a side effect of approvals that these tests do not read.
vi.mock('../../core/notifications/notification.service.js', () => ({ notify: vi.fn() }));

const { recalculateDays } = await import('../attendance-device/attendance-import.service.js');
const { syncSubjectStatus } = await import('../../core/approvals/approval.service.js');
const { deriveRangeForEmployees } = await import('../time/attendance.service.js');
const { balancesForEmployee } = await import('./leave.service.js');
const {
  attendanceConflictsFor,
  cancelLeaveForAttendanceConflict,
  decideReversal,
  isQualifyingAttendance,
  reconcileLeaveForDays,
  reconcileLeaveRequest,
  reconcileRecentLeave,
} = await import('./leave-reconciliation.service.js');

// ------------------------------------------------------------------ fixtures

const COMPANY = 'company-1';
const HIRA = 'emp-hira';
const OTHER = 'emp-other';
const DEVICE = 'device-1';

const COMPANY_ROW = {
  id: COMPANY,
  timezone: 'Asia/Karachi',
  weekendDays: ['SATURDAY', 'SUNDAY'],
  graceMinutes: 15,
  halfDayMinutes: 240,
  fullDayMinutes: 540,
  earlyLeaveGraceMinutes: 15,
  overtimeEnabled: true,
  overtimeAfterMinutes: 540,
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
  fullDayToleranceMinutes: 0,
  // On, as in production, so a late-morning arrival is measured by the time
  // actually worked. 11:00 rather than production's 09:15 so that a 09:40
  // arrival can still be shown to be scored late rather than irregular.
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
  irregularAfterShiftStartMinutes: 15,
  defaultBreakMinutes: 0,
  lateThresholdMinutes: 0,
  earlyLeaveThresholdMinutes: 0,
  weekendWorkRule: 'IGNORE',
  holidayWorkRule: 'IGNORE',
  duplicatePunchWindowSeconds: 30,
  maxPlausibleSpanMinutes: 0,
  allowImplausibleSpans: false,
  overnightCheckOutWindowMinutes: 0,
  overnightCheckOutCutoff: '06:00',
};

const employee = (id: string, firstName: string, lastName: string) => ({
  id,
  companyId: COMPANY,
  firstName,
  lastName,
  displayName: null,
  locationId: null,
  departmentId: null,
  teamId: null,
  status: 'ACTIVE',
  hireDate: day('2024-01-01'),
  terminationDate: null,
  resignationDate: null,
  excludedFromAttendance: false,
});

const ANNUAL = {
  id: 'type-annual',
  companyId: COMPANY,
  name: 'Annual Leave',
  code: 'AL',
  isActive: true,
  isPaid: true,
  isDeductible: false,
  annualEntitlementDays: 15,
  monthlyAccrualDays: 15,
  carryForwardEnabled: false,
  carryForwardCapDays: null,
};

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** A wall-clock time in Karachi (UTC+5) as the instant it is. */
function pkt(iso: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), h! - 5, m!));
}

let punchSeq = 0;
function punch(input: {
  employeeId: string | null;
  dayKey: string;
  at: string;
  state?: string | null;
  deviceUserId?: string;
}): Row {
  const row: Row = {
    id: `punch-${++punchSeq}`,
    companyId: COMPANY,
    deviceId: DEVICE,
    deviceUserId: input.deviceUserId ?? '101',
    employeeId: input.employeeId,
    rawTimestamp: `${input.dayKey} ${input.at}:00`,
    deviceTimeZone: 'Asia/Karachi',
    punchedAt: pkt(input.dayKey, input.at),
    localDayKey: input.dayKey,
    punchState: input.state ?? null,
    verifyMode: 'FINGERPRINT',
    processedAt: null,
  };
  store.tables.attendanceRawPunch!.push(row);
  return row;
}

function leave(input: {
  id: string;
  start: string;
  end?: string;
  totalDays: number;
  dayPart?: 'FULL_DAY' | 'FIRST_HALF' | 'SECOND_HALF';
  status?: 'PENDING' | 'APPROVED';
  employeeId?: string;
}): Row {
  const row: Row = {
    id: input.id,
    companyId: COMPANY,
    employeeId: input.employeeId ?? HIRA,
    leaveTypeId: ANNUAL.id,
    startDate: day(input.start),
    endDate: day(input.end ?? input.start),
    dayPart: input.dayPart ?? 'FULL_DAY',
    totalDays: input.totalDays,
    reason: 'Family matter',
    status: input.status ?? 'APPROVED',
    approvalRequestId: `approval-${input.id}`,
    decidedAt: input.status === 'PENDING' ? null : new Date('2026-10-05T05:53:22.000Z'),
    cancelledAt: null,
    cancelledBySystem: false,
    cancellationReason: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
  };
  store.tables.leaveRequest!.push(row);
  return row;
}

function record(input: {
  employeeId?: string;
  dayKey: string;
  in: string | null;
  out?: string | null;
  source?: 'DEVICE' | 'SELF' | 'ADMIN' | 'SYSTEM';
  status?: string;
}): Row {
  const row: Row = {
    id: `rec-${input.employeeId ?? HIRA}-${input.dayKey}`,
    companyId: COMPANY,
    employeeId: input.employeeId ?? HIRA,
    date: day(input.dayKey),
    status: input.status ?? 'PRESENT',
    checkInAt: input.in ? pkt(input.dayKey, input.in) : null,
    checkOutAt: input.out ? pkt(input.dayKey, input.out) : null,
    workedMinutes: null,
    source: input.source ?? 'DEVICE',
    shiftId: null,
    lateMinutes: null,
    earlyLeaveMinutes: null,
    overtimeMinutes: null,
    irregular: false,
    notes: null,
    mode: null,
  };
  store.tables.attendanceRecord!.push(row);
  return row;
}

const T = () => store.tables;
const leaveRow = (id: string) => T().leaveRequest!.find((r) => r.id === id)!;
const reversals = (id: string) => T().leaveReversal!.filter((r) => r.leaveRequestId === id);
const reversalAudits = () => T().auditLog!.filter((a) => a.action === 'leave.request.auto_reverse');

async function annualBalance() {
  const all = await balancesForEmployee(COMPANY, HIRA, 2026);
  return all.find((b) => b.leaveTypeId === ANNUAL.id)!;
}

async function derived(dayKey: string, employeeId = HIRA) {
  const emp = T().employee!.find((e) => e.id === employeeId)!;
  const map = await deriveRangeForEmployees(COMPANY, [emp as never], day(dayKey), day(dayKey));
  return map.get(employeeId)![0]!;
}

/** What a device sync does once it has stored the punches it pulled. */
const importDays = (...days: Array<{ employeeId: string; dayKey: string }>) =>
  recalculateDays({ companyId: COMPANY, pairing: 'FIRST_IN_LAST_OUT', days });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store.seq = 0;
  store.tables = {
    company: [{ ...COMPANY_ROW }],
    employee: [employee(HIRA, 'Hira', 'Javed'), employee(OTHER, 'Other', 'Person')],
    leaveType: [{ ...ANNUAL }],
    leaveBalance: [],
    leaveRequest: [],
    leaveReversal: [],
    attendanceRecord: [],
    attendanceRawPunch: [],
    holiday: [],
    attendancePolicyAssignment: [],
    employeeShiftAssignment: [],
    auditLog: [],
  };

  const unique: Record<string, (r: Row) => string | null> = {
    leaveReversal: (r) => `${r.leaveRequestId}:${(r.date as Date).toISOString()}`,
    attendanceRecord: (r) => `${r.employeeId}:${(r.date as Date).toISOString()}`,
  };
  for (const table of Object.keys(store.tables)) db[table] = model(table, unique[table]);
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));

  /*
   * Five days of Annual Leave already taken in September, so the balance
   * starts where the requirement's example does: 15 entitled, 5 used, 10 left.
   */
  leave({ id: 'leave-sept', start: '2026-09-14', end: '2026-09-18', totalDays: 5 });
});

// --------------------------------------------------------------------- tests

describe('1. approved full-day leave + valid attendance', () => {
  it('reverses the leave, restores the quota and scores the day normally', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });
    expect(await annualBalance()).toMatchObject({ usedDays: 6, availableDays: 9 });

    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '09:05' });
    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '18:02' });
    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });

    const row = leaveRow('leave-hira');
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelledBySystem).toBe(true);
    expect(row.cancellationReason).toBe(
      'Automatically cancelled because attendance was recorded on 06-Oct-2026.',
    );
    expect(reversals('leave-hira')).toHaveLength(1);
    expect(reversals('leave-hira')[0]).toMatchObject({
      days: 1,
      reason: 'Automatically reversed because attendance was recorded on 06-Oct-2026.',
    });

    expect(await annualBalance()).toMatchObject({ usedDays: 5, availableDays: 10 });

    const d = await derived('2026-10-06');
    expect(d.status).toBe('PRESENT');
    expect(d.leaveTypeName).toBeNull();
    expect(d.checkInAt).toBe(pkt('2026-10-06', '09:05').toISOString());
  });

  it('reverses on a check-in alone, the morning it happens', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });
    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '09:05' });
    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });

    expect(leaveRow('leave-hira').status).toBe('CANCELLED');
    expect((await derived('2026-10-06')).status).not.toBe('ON_LEAVE');
  });
});

describe('2. approved leave + no attendance', () => {
  it('leaves the leave approved and the balance as it was', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });

    await reconcileLeaveRequest('leave-hira');
    await reconcileRecentLeave({ companyId: COMPANY, from: day('2026-10-01'), to: day('2026-10-10') });
    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });

    expect(leaveRow('leave-hira').status).toBe('APPROVED');
    expect(reversals('leave-hira')).toHaveLength(0);
    expect(await annualBalance()).toMatchObject({ usedDays: 6, availableDays: 9 });
    expect((await derived('2026-10-06')).status).toBe('ON_LEAVE');
  });
});

describe('3 & 12. unmapped punches never cancel leave', () => {
  it('an unmapped punch on the day leaves the leave approved', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });
    // A PIN nobody is mapped to: stored, kept, attributed to no one.
    punch({ employeeId: null, deviceUserId: '999', dayKey: '2026-10-06', at: '09:05' });
    punch({ employeeId: null, deviceUserId: '999', dayKey: '2026-10-06', at: '18:00' });

    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });
    await reconcileRecentLeave({ companyId: COMPANY, from: day('2026-10-06'), to: day('2026-10-06') });

    expect(T().attendanceRecord).toHaveLength(0);
    expect(leaveRow('leave-hira').status).toBe('APPROVED');
    expect(reversals('leave-hira')).toHaveLength(0);
    expect(reversalAudits()).toHaveLength(0);
  });

  it("somebody else's punch does not cancel Hira's leave", async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });
    punch({ employeeId: OTHER, deviceUserId: '202', dayKey: '2026-10-06', at: '09:00' });
    punch({ employeeId: OTHER, deviceUserId: '202', dayKey: '2026-10-06', at: '18:00' });

    await importDays({ employeeId: OTHER, dayKey: '2026-10-06' });

    expect(T().attendanceRecord).toHaveLength(1);
    expect(leaveRow('leave-hira').status).toBe('APPROVED');
    expect(reversals('leave-hira')).toHaveLength(0);
  });
});

describe('4. approved leave + invalid punch', () => {
  it('a punch the pairing cannot read as an arrival cancels nothing', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });
    // DEVICE_STATE pairing and a state this system has no reading for.
    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '13:00', state: 'BREAK_OUT' });

    await recalculateDays({
      companyId: COMPANY,
      pairing: 'DEVICE_STATE',
      days: [{ employeeId: HIRA, dayKey: '2026-10-06' }],
    });

    expect(T().attendanceRecord).toHaveLength(0);
    expect(leaveRow('leave-hira').status).toBe('APPROVED');
    expect(reversals('leave-hira')).toHaveLength(0);
  });

  it('the absence marker and an ABSENT correction are not attendance', async () => {
    expect(isQualifyingAttendance({ id: 'r', source: 'SYSTEM', status: 'ABSENT', checkInAt: null, checkOutAt: null })).toBe(false);
    expect(
      isQualifyingAttendance({ id: 'r', source: 'ADMIN', status: 'ABSENT', checkInAt: new Date(), checkOutAt: null }),
    ).toBe(false);
    expect(
      isQualifyingAttendance({ id: 'r', source: 'ADMIN', status: 'ON_LEAVE', checkInAt: new Date(), checkOutAt: null }),
    ).toBe(false);
    expect(
      isQualifyingAttendance({ id: 'r', source: 'DEVICE', status: 'PRESENT', checkInAt: null, checkOutAt: null }),
    ).toBe(false);
    expect(
      isQualifyingAttendance({ id: 'r', source: 'DEVICE', status: 'PRESENT', checkInAt: new Date(), checkOutAt: null }),
    ).toBe(true);
  });
});

describe('5. approved half-day leave + attendance', () => {
  it('working the other half is what a half day means: the leave stands', async () => {
    leave({ id: 'leave-half', start: '2026-10-06', totalDays: 0.5, dayPart: 'FIRST_HALF' });
    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '13:00' });
    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '18:00' });
    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });

    expect(leaveRow('leave-half').status).toBe('APPROVED');
    expect(reversals('leave-half')).toHaveLength(0);
    expect(await annualBalance()).toMatchObject({ usedDays: 5.5, availableDays: 9.5 });
  });

  it('an open day does not decide a half day; the check-out that closes it does', async () => {
    leave({ id: 'leave-half', start: '2026-10-06', totalDays: 0.5, dayPart: 'SECOND_HALF' });

    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '09:00' });
    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });
    expect(leaveRow('leave-half').status).toBe('APPROVED');

    // She stayed the whole day after all - the half booked off was worked.
    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '18:05' });
    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });

    expect(reversals('leave-half')).toHaveLength(1);
    expect(reversals('leave-half')[0]!.days).toBe(0.5);
    expect(leaveRow('leave-half').status).toBe('CANCELLED');
    expect(await annualBalance()).toMatchObject({ usedDays: 5, availableDays: 10 });
    expect((await derived('2026-10-06')).status).toBe('PRESENT');
  });

  it('the decision gives back only the half, never more than the request holds', () => {
    const attendance = {
      id: 'r',
      source: 'DEVICE' as const,
      status: 'PRESENT' as const,
      checkInAt: pkt('2026-10-06', '09:00'),
      checkOutAt: pkt('2026-10-06', '18:00'),
    };
    expect(
      decideReversal({ dayPart: 'FIRST_HALF', totalDays: 0.5, alreadyReversedDays: 0, countedDays: 0.5, attendance, scoredStatus: 'PRESENT' }),
    ).toEqual({ reverse: true, days: 0.5 });
    expect(
      decideReversal({ dayPart: 'FIRST_HALF', totalDays: 0.5, alreadyReversedDays: 0, countedDays: 0.5, attendance, scoredStatus: 'HALF_DAY' }),
    ).toEqual({ reverse: false, why: 'HALF_DAY_NOT_CONFLICTING' });
    expect(
      decideReversal({ dayPart: 'FULL_DAY', totalDays: 1, alreadyReversedDays: 1, countedDays: 1, attendance, scoredStatus: null }),
    ).toEqual({ reverse: false, why: 'NOTHING_LEFT_TO_REVERSE' });
  });
});

describe('6. multi-day leave + attendance on part of it', () => {
  it('gives back only the day worked and keeps the rest of the leave', async () => {
    leave({ id: 'leave-range', start: '2026-10-05', end: '2026-10-07', totalDays: 3 });
    expect(await annualBalance()).toMatchObject({ usedDays: 8, availableDays: 7 });

    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '09:00' });
    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '18:00' });
    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });

    const row = leaveRow('leave-range');
    expect(row.status).toBe('APPROVED');
    expect(row.totalDays).toBe(3);
    expect(reversals('leave-range').map((r) => r.days)).toEqual([1]);
    expect(await annualBalance()).toMatchObject({ usedDays: 7, availableDays: 8 });

    expect((await derived('2026-10-05')).status).toBe('ON_LEAVE');
    expect((await derived('2026-10-06')).status).toBe('PRESENT');
    expect((await derived('2026-10-07')).status).toBe('ON_LEAVE');
  });

  it('a weekend inside the range was never leave, so working it restores nothing', async () => {
    // Fri 2 Oct to Mon 5 Oct: two working days.
    leave({ id: 'leave-weekend', start: '2026-10-02', end: '2026-10-05', totalDays: 2 });
    record({ dayKey: '2026-10-03', in: '10:00', out: '14:00' });

    const outcomes = await reconcileLeaveRequest('leave-weekend');

    expect(outcomes[0]).toMatchObject({ result: 'KEPT', why: 'NOT_A_LEAVE_DAY' });
    expect(reversals('leave-weekend')).toHaveLength(0);
    expect(leaveRow('leave-weekend').status).toBe('APPROVED');
  });

  it('cancels the request once every day it covered has been worked', async () => {
    leave({ id: 'leave-range', start: '2026-10-05', end: '2026-10-06', totalDays: 2 });
    for (const dayKey of ['2026-10-05', '2026-10-06']) {
      punch({ employeeId: HIRA, dayKey, at: '09:00' });
      punch({ employeeId: HIRA, dayKey, at: '18:00' });
    }
    await importDays({ employeeId: HIRA, dayKey: '2026-10-05' });
    expect(leaveRow('leave-range').status).toBe('APPROVED');

    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });
    expect(leaveRow('leave-range')).toMatchObject({
      status: 'CANCELLED',
      cancelledBySystem: true,
      cancellationReason: 'Automatically cancelled because attendance was recorded on 05-Oct-2026, 06-Oct-2026.',
    });
    expect(await annualBalance()).toMatchObject({ usedDays: 5, availableDays: 10 });
  });
});

describe('7. attendance imported after the leave was approved', () => {
  it('10:00 approved, 10:30 punched in: the import reverses it', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1, status: 'PENDING' });
    await syncSubjectStatus('LEAVE_REQUEST', 'leave-hira', 'APPROVED');
    expect(leaveRow('leave-hira').status).toBe('APPROVED');
    expect(reversals('leave-hira')).toHaveLength(0);

    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '10:30' });
    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });

    expect(leaveRow('leave-hira').status).toBe('CANCELLED');
    expect(await annualBalance()).toMatchObject({ usedDays: 5, availableDays: 10 });
  });
});

describe('8. leave approved after the attendance already exists', () => {
  it('the approval itself detects the conflict and reverses it', async () => {
    record({ dayKey: '2026-10-06', in: '09:05', out: '18:00' });
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1, status: 'PENDING' });

    await syncSubjectStatus('LEAVE_REQUEST', 'leave-hira', 'APPROVED');

    const row = leaveRow('leave-hira');
    expect(row.decidedAt).toBeInstanceOf(Date);
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelledBySystem).toBe(true);
    expect(await annualBalance()).toMatchObject({ usedDays: 5, availableDays: 10 });
  });

  it('a rejection does not reconcile anything', async () => {
    record({ dayKey: '2026-10-06', in: '09:05', out: '18:00' });
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1, status: 'PENDING' });

    await syncSubjectStatus('LEAVE_REQUEST', 'leave-hira', 'REJECTED');

    expect(leaveRow('leave-hira').status).toBe('REJECTED');
    expect(reversals('leave-hira')).toHaveLength(0);
  });
});

describe('9. reconciliation is idempotent', () => {
  it('three runs restore the day once', async () => {
    leave({ id: 'leave-range', start: '2026-10-05', end: '2026-10-07', totalDays: 3 });
    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '09:05' });
    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '18:00' });

    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });
    // The device re-sends the same punch; a recalculation runs; the night pass runs.
    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '18:00' });
    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });
    await reconcileLeaveForDays({ companyId: COMPANY, days: [{ employeeId: HIRA, dayKey: '2026-10-06' }] });
    await reconcileRecentLeave({ companyId: COMPANY, from: day('2026-10-01'), to: day('2026-10-10') });

    expect(reversals('leave-range')).toHaveLength(1);
    expect(reversalAudits()).toHaveLength(1);
    expect(await annualBalance()).toMatchObject({ usedDays: 7, availableDays: 8 });
  });

  it('two runs racing restore the day once', async () => {
    leave({ id: 'leave-range', start: '2026-10-05', end: '2026-10-07', totalDays: 3 });
    record({ dayKey: '2026-10-06', in: '09:05', out: '18:00' });

    const [a, b] = await Promise.all([
      reconcileLeaveForDays({ companyId: COMPANY, days: [{ employeeId: HIRA, dayKey: '2026-10-06' }] }),
      reconcileLeaveForDays({ companyId: COMPANY, days: [{ employeeId: HIRA, dayKey: '2026-10-06' }] }),
    ]);

    const results = [...a, ...b].map((o) => o.result).sort();
    expect(results).toEqual(['ALREADY_REVERSED', 'REVERSED']);
    expect(reversals('leave-range')).toHaveLength(1);
    expect(reversalAudits()).toHaveLength(1);
    expect(await annualBalance()).toMatchObject({ usedDays: 7 });
  });
});

describe('10. history stays auditable', () => {
  it('keeps the request, its figures and the punches, and writes a full audit entry', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });
    const p1 = punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '09:05' });
    const p2 = punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '18:02' });
    const rawBefore = structuredClone(T().attendanceRawPunch!.map(({ processedAt: _p, ...r }) => r));

    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });

    // Nothing deleted, nothing re-figured.
    const row = leaveRow('leave-hira');
    expect(row).toMatchObject({ totalDays: 1, reason: 'Family matter', approvalRequestId: 'approval-leave-hira' });
    expect(row.decidedAt).toEqual(new Date('2026-10-05T05:53:22.000Z'));
    expect(T().leaveRequest).toHaveLength(2);
    expect(T().attendanceRawPunch!.map(({ processedAt: _p, ...r }) => r)).toEqual(rawBefore);

    const audits = reversalAudits();
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit).toMatchObject({
      companyId: COMPANY,
      actorId: null,
      entityType: 'LeaveRequest',
      entityId: 'leave-hira',
    });
    expect(audit.summary).toContain('SYSTEM / Attendance Reconciliation');
    expect(audit.before).toMatchObject({
      status: 'APPROVED',
      employeeId: HIRA,
      leaveDate: '2026-10-06',
      usedDays: 6,
      availableDays: 9,
    });
    expect(audit.after).toMatchObject({
      status: 'CANCELLED',
      employeeId: HIRA,
      leaveDate: '2026-10-06',
      restoredDays: 1,
      usedDays: 5,
      availableDays: 10,
      attendanceSource: 'DEVICE',
      checkInAt: pkt('2026-10-06', '09:05').toISOString(),
      punchIds: [p1.id, p2.id],
      actor: 'SYSTEM / Attendance Reconciliation',
      reason: 'Automatically cancelled because attendance was recorded on 06-Oct-2026.',
    });
    expect((audit.after as Row).attendanceRecordId).toBe(T().attendanceRecord![0]!.id);
    expect(audit.createdAt ?? true).toBeTruthy();
  });
});

describe('11. the attendance engine still scores the day', () => {
  const cases: Array<[string, string, string, (d: Awaited<ReturnType<typeof derived>>) => void]> = [
    ['late', '09:40', '18:30', (d) => {
      expect(d.status).toBe('PRESENT');
      expect(d.lateMinutes).toBe(40);
      expect(d.flags).toContain('LATE');
    }],
    ['early departure', '09:00', '17:30', (d) => {
      expect(d.earlyLeaveMinutes).toBe(30);
      expect(d.flags).toContain('EARLY_LEAVE');
    }],
    ['half day', '09:00', '14:00', (d) => {
      expect(d.status).toBe('HALF_DAY');
    }],
    ['overtime', '09:00', '20:00', (d) => {
      expect(d.status).toBe('PRESENT');
      expect(d.overtimeMinutes).toBe(120);
      expect(d.flags).toContain('OVERTIME');
    }],
  ];

  it.each(cases)('%s', async (_name, inAt, outAt, check) => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });
    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: inAt });
    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: outAt });
    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });

    expect(leaveRow('leave-hira').status).toBe('CANCELLED');
    const d = await derived('2026-10-06');
    expect(d.leaveTypeName).toBeNull();
    check(d);
  });
});

describe('other triggers', () => {
  it('the nightly pass catches a day nothing else reconciled', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });
    record({ dayKey: '2026-10-06', in: '09:05', out: '18:00', source: 'ADMIN', status: 'PRESENT' });

    const outcomes = await reconcileRecentLeave({
      companyId: COMPANY,
      from: day('2026-10-05'),
      to: day('2026-10-07'),
    });

    expect(outcomes.filter((o) => o.result === 'REVERSED')).toHaveLength(1);
    expect(leaveRow('leave-hira').status).toBe('CANCELLED');
  });

  it('a leave withdrawn by a person keeps the status that person gave it', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });
    leaveRow('leave-hira').status = 'CANCELLED';
    record({ dayKey: '2026-10-06', in: '09:05', out: '18:00' });

    await reconcileLeaveForDays({ companyId: COMPANY, days: [{ employeeId: HIRA, dayKey: '2026-10-06' }] });

    expect(leaveRow('leave-hira').cancelledBySystem).toBe(false);
    expect(reversals('leave-hira')).toHaveLength(0);
  });
});

describe('12. a Super Admin cancels approved leave because the employee attended', () => {
  const SA = { userId: 'user-sa', name: 'Zohaib Saleem' };
  const cancelFor = (leaveRequestId: string) =>
    cancelLeaveForAttendanceConflict({ companyId: COMPANY, leaveRequestId, actor: SA });
  const conflictsOf = async (id: string) =>
    (await attendanceConflictsFor([leaveRow(id) as never])).get(id) ?? [];
  const manualAudits = () => T().auditLog!.filter((a) => a.action === 'leave.request.conflict_cancel');

  it('shows the conflict, cancels the leave, restores the quota and keeps the attendance', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });
    // Written straight to the table, as a record nothing reconciled yet.
    const rec = record({ dayKey: '2026-10-06', in: '09:05' });
    const recBefore = { ...rec };
    expect(await annualBalance()).toMatchObject({ usedDays: 6, availableDays: 9 });

    const conflicts = await conflictsOf('leave-hira');
    expect(conflicts).toEqual([
      { dayKey: '2026-10-06', checkInAt: pkt('2026-10-06', '09:05'), checkOutAt: null },
    ]);

    const result = await cancelFor('leave-hira');
    expect(result).toMatchObject({
      status: 'CANCELLED',
      restoredDays: 1,
      reversedDayKeys: ['2026-10-06'],
      alreadyResolved: false,
    });

    const row = leaveRow('leave-hira');
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelledBySystem).toBe(false);
    expect(row.cancellationReason).toBe(
      'Super Admin cancellation / attendance conflict: the employee attended work on 06-Oct-2026.',
    );
    // The request is kept with the figures it was approved on.
    expect(row).toMatchObject({ totalDays: 1, reason: 'Family matter', approvalRequestId: 'approval-leave-hira' });
    expect(reversals('leave-hira')).toHaveLength(1);
    expect(reversals('leave-hira')[0]).toMatchObject({ days: 1, reversedById: 'user-sa' });

    expect(await annualBalance()).toMatchObject({ usedDays: 5, availableDays: 10 });

    // The attendance record is untouched and the day scores as worked.
    expect(T().attendanceRecord).toHaveLength(1);
    expect(T().attendanceRecord![0]).toEqual(recBefore);
    const d = await derived('2026-10-06');
    expect(d.leaveTypeName).toBeNull();
    expect(d.checkInAt).toBe(pkt('2026-10-06', '09:05').toISOString());

    const audits = manualAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: 'user-sa', entityType: 'LeaveRequest', entityId: 'leave-hira' });
    expect(audits[0]!.summary).toContain('Super Admin Zohaib Saleem');
    expect(audits[0]!.after).toMatchObject({
      status: 'CANCELLED',
      restoredDays: 1,
      usedDays: 5,
      reason: 'Super Admin cancellation / attendance conflict: the employee attended work on 06-Oct-2026.',
    });
    expect(reversalAudits()).toHaveLength(0);
    expect(await conflictsOf('leave-hira')).toEqual([]);
  });

  it('is idempotent: a second click restores nothing and audits nothing', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });
    record({ dayKey: '2026-10-06', in: '09:05', out: '18:00' });

    await cancelFor('leave-hira');
    const again = await cancelFor('leave-hira');

    expect(again).toMatchObject({ alreadyResolved: true, restoredDays: 0, status: 'CANCELLED' });
    expect(reversals('leave-hira')).toHaveLength(1);
    expect(manualAudits()).toHaveLength(1);
    expect(await annualBalance()).toMatchObject({ usedDays: 5, availableDays: 10 });
  });

  it('two clicks racing restore the day once', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });
    record({ dayKey: '2026-10-06', in: '09:05', out: '18:00' });

    const [a, b] = await Promise.all([cancelFor('leave-hira'), cancelFor('leave-hira')]);

    expect([a.restoredDays, b.restoredDays].sort()).toEqual([0, 1]);
    expect(reversals('leave-hira')).toHaveLength(1);
    expect(await annualBalance()).toMatchObject({ usedDays: 5 });
  });

  it('after reconciliation already gave it back, there is nothing left to do', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });
    punch({ employeeId: HIRA, dayKey: '2026-10-06', at: '09:05' });
    await importDays({ employeeId: HIRA, dayKey: '2026-10-06' });
    expect(leaveRow('leave-hira').status).toBe('CANCELLED');

    const result = await cancelFor('leave-hira');
    expect(result.alreadyResolved).toBe(true);
    expect(reversals('leave-hira')).toHaveLength(1);
    expect(await annualBalance()).toMatchObject({ usedDays: 5, availableDays: 10 });
  });

  it('leave with no attendance on it is not a conflict and is left alone', async () => {
    leave({ id: 'leave-hira', start: '2026-10-06', totalDays: 1 });

    expect(await conflictsOf('leave-hira')).toEqual([]);
    const result = await cancelFor('leave-hira');
    expect(result).toMatchObject({ alreadyResolved: true, status: 'APPROVED' });
    expect(leaveRow('leave-hira').status).toBe('APPROVED');
    expect(await annualBalance()).toMatchObject({ usedDays: 6 });
  });

  it('on a multi-day request gives back only the day worked', async () => {
    leave({ id: 'leave-range', start: '2026-10-05', end: '2026-10-07', totalDays: 3 });
    record({ dayKey: '2026-10-06', in: '09:05', out: '18:00' });

    const result = await cancelFor('leave-range');
    expect(result).toMatchObject({ status: 'APPROVED', restoredDays: 1, reversedDayKeys: ['2026-10-06'] });
    expect(leaveRow('leave-range').status).toBe('APPROVED');
    expect(await annualBalance()).toMatchObject({ usedDays: 7, availableDays: 8 });
  });

  it('a weekend inside the range is not a leave day, so working it is no conflict', async () => {
    // Fri 9th - Mon 12th: two leave days, Saturday 10th worked.
    leave({ id: 'leave-wknd', start: '2026-10-09', end: '2026-10-12', totalDays: 2 });
    record({ dayKey: '2026-10-10', in: '10:00', out: '14:00' });

    expect(await conflictsOf('leave-wknd')).toEqual([]);
  });

  it('can give back a half day the automatic rule keeps', async () => {
    leave({ id: 'leave-half', start: '2026-10-06', totalDays: 0.5, dayPart: 'FIRST_HALF' });
    record({ dayKey: '2026-10-06', in: '13:00', out: '18:00' });
    await reconcileLeaveForDays({ companyId: COMPANY, days: [{ employeeId: HIRA, dayKey: '2026-10-06' }] });
    expect(leaveRow('leave-half').status).toBe('APPROVED');

    const result = await cancelFor('leave-half');
    expect(result).toMatchObject({ status: 'CANCELLED', restoredDays: 0.5 });
    expect(await annualBalance()).toMatchObject({ usedDays: 5 });
  });
});

