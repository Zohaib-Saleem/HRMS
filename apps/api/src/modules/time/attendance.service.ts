import type { AttendanceSource, WeekDay } from '@prisma/client';
import type { AttendanceFlag, DerivedAttendanceStatus } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { ForbiddenError, ValidationError } from '../../core/errors.js';
import { toDateOnly } from '../leave/leave.service.js';
import { todayInZone } from '../../core/zoned-time.js';
import {
  attendanceFlags,
  computeAttendance,
  effectiveShift,
  expectedMinutesFor,
  haversineMeters,
  isIpAllowed,
  isShiftWorkingDay,
  isWeekendFor,
  nonWorkingDayOvertime,
  policyResolverFor,
  resolveAttendancePolicy,
  resolvePolicyFor,
  type AttendanceIntegrity,
  type AttendancePolicy,
  type ShiftWindow,
} from './attendance-policy.js';

export { isWeekendFor } from './attendance-policy.js';

/**
 * Daily attendance derivation.
 *
 * A day's status is not a free-text field someone types - it is decided by
 * these inputs, in this order of precedence:
 *
 *   1. weekend / off day - from the company's weekendDays, or the working days
 *                          of the shift in force when the shift lists any
 *   2. holiday            - from the employee's location calendar plus company-wide days
 *   3. on leave           - from approved leave covering the date
 *   4. the stored record, or ABSENT when there is none
 *
 * Weekend and holiday win over leave deliberately: booking leave across a
 * public holiday should not report the holiday as a day of leave, and the
 * working-day count in Phase 4 already excluded it from the balance.
 *
 * Flags are computed here from the stored figures and the rules in force, so
 * a late day is reported PRESENT with a LATE flag rather than having its
 * status replaced.
 */

export interface DerivedDay {
  date: string;
  status: DerivedAttendanceStatus;
  flags: AttendanceFlag[];
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  /** Rostered minutes on a working day; null on a day nobody was rostered for. */
  expectedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  irregular: boolean;
  /**
   * How far the day's own times can be trusted. Carried so a caller can tell
   * "no hours because the punches do not add up" from "no hours because
   * nobody came", which the status alone cannot express.
   */
  integrity: AttendanceIntegrity;
  mode: string | null;
  shiftId: string | null;
  shiftName: string | null;
  notes: string | null;
  /** Set when the day is covered by approved leave. */
  leaveTypeName: string | null;
  /**
   * Whether that leave is paid.
   *
   * Read by payroll, which must tell a paid absence from an unpaid one and has
   * no business querying the leave tables itself. Null when the day is not
   * leave at all - deliberately not `false`, so "unpaid" and "not leave"
   * cannot be confused by a caller that forgets to check the status.
   */
  leaveIsPaid: boolean | null;
  /** FULL_DAY, FIRST_HALF or SECOND_HALF; null when the day is not leave. */
  leaveDayPart: string | null;
  /** Set when the day is a holiday that applies to this employee. */
  holidayName: string | null;
  source: AttendanceSource | null;
  recordId: string | null;
  /** True when a stored record exists; false when the status is inferred. */
  hasRecord: boolean;
}

const dateKey = (d: Date) => d.toISOString().slice(0, 10);

/** The shift fields the engine and the screens read. */
export const SHIFT_WINDOW_SELECT = {
  id: true,
  name: true,
  startTime: true,
  endTime: true,
  breakMinutes: true,
  expectedMinutes: true,
  workingDays: true,
  graceMinutes: true,
  earlyLeaveGraceMinutes: true,
  lateTrackingEnabled: true,
  earlyDepartureTrackingEnabled: true,
  overtimeEnabled: true,
  overtimeDailyCapMinutes: true,
  overtimeMinimumMinutes: true,
} as const;

export interface ResolvedShift extends ShiftWindow {
  id: string;
  name: string;
  breakMinutes: number;
  workingDays: WeekDay[];
}

/**
 * Every shift assignment touching a range, grouped by employee and ordered so
 * the latest-starting assignment comes first - the same tie-break
 * `shiftOnDate` uses, so a range and a single day can never disagree.
 */
export async function shiftAssignmentsForRange(
  employeeIds: readonly string[],
  from: Date,
  to: Date,
): Promise<Map<string, Array<{ effectiveFrom: Date; effectiveTo: Date | null; shift: ResolvedShift }>>> {
  const result = new Map<
    string,
    Array<{ effectiveFrom: Date; effectiveTo: Date | null; shift: ResolvedShift }>
  >();
  if (employeeIds.length === 0) return result;

  const rows = await prisma.employeeShiftAssignment.findMany({
    where: {
      employeeId: { in: [...employeeIds] },
      effectiveFrom: { lte: to },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
    },
    select: {
      employeeId: true,
      effectiveFrom: true,
      effectiveTo: true,
      shift: { select: SHIFT_WINDOW_SELECT },
    },
    orderBy: { effectiveFrom: 'desc' },
  });

  for (const row of rows) {
    const list = result.get(row.employeeId);
    const entry = { effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo, shift: row.shift };
    if (list) list.push(entry);
    else result.set(row.employeeId, [entry]);
  }
  return result;
}

/** The assignment covering one day, from a list ordered latest-first. */
export function assignmentOn<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(
  assignments: readonly T[],
  key: string,
): T | null {
  return (
    assignments.find(
      (a) => dateKey(a.effectiveFrom) <= key && (a.effectiveTo === null || dateKey(a.effectiveTo) >= key),
    ) ?? null
  );
}

/**
 * Derivation for several employees at once.
 *
 * The per-employee version delegates here so the team view does not fan out
 * into four queries per person - the whole range is fetched once and grouped in
 * memory. One implementation, so a team row and a personal row can never
 * disagree about the same day.
 */
export async function deriveRangeForEmployees(
  companyId: string,
  employees: ReadonlyArray<{ id: string; locationId: string | null }>,
  from: Date,
  to: Date,
): Promise<Map<string, DerivedDay[]>> {
  const result = new Map<string, DerivedDay[]>();
  if (employees.length === 0) return result;

  const employeeIds = employees.map((e) => e.id);

  const [policy, policyFor, records, leave, holidayRows, assignments] = await Promise.all([
    resolveAttendancePolicy(companyId),
    policyResolverFor(companyId, employeeIds, from, to),
    prisma.attendanceRecord.findMany({
      where: { employeeId: { in: employeeIds }, date: { gte: from, lte: to } },
      include: { shift: { select: { name: true } } },
    }),
    prisma.leaveRequest.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: 'APPROVED',
        startDate: { lte: to },
        endDate: { gte: from },
      },
      include: { leaveType: { select: { name: true, isPaid: true } } },
    }),
    prisma.holiday.findMany({
      where: { companyId, isActive: true, date: { gte: from, lte: to } },
      select: { date: true, name: true, locationId: true },
    }),
    shiftAssignmentsForRange(employeeIds, from, to),
  ]);

  const recordsByEmployee = new Map<string, Map<string, (typeof records)[number]>>();
  for (const r of records) {
    let byDate = recordsByEmployee.get(r.employeeId);
    if (!byDate) recordsByEmployee.set(r.employeeId, (byDate = new Map()));
    byDate.set(dateKey(r.date), r);
  }

  const leaveByEmployee = new Map<string, typeof leave>();
  for (const l of leave) {
    const list = leaveByEmployee.get(l.employeeId);
    if (list) list.push(l);
    else leaveByEmployee.set(l.employeeId, [l]);
  }

  // "Future" is relative to the company's own clock, not the server's: at
  // 02:00 UTC it is already the next working day in Karachi.
  const todayKey = todayInZone(policy.timeZone);

  for (const employee of employees) {
    const recordByDate = recordsByEmployee.get(employee.id) ?? new Map();
    const employeeLeave = leaveByEmployee.get(employee.id) ?? [];
    const employeeShifts = assignments.get(employee.id) ?? [];

    // Only holidays that apply to this employee: their location plus company-wide.
    const holidayByDate = new Map<string, string>();
    for (const h of holidayRows) {
      if (h.locationId !== null && h.locationId !== employee.locationId) continue;
      holidayByDate.set(dateKey(h.date), h.name);
    }

    const days: DerivedDay[] = [];

    for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = dateKey(d);
      const record = recordByDate.get(key);
      const holidayName = holidayByDate.get(key) ?? null;
      const assigned = assignmentOn(employeeShifts, key)?.shift ?? null;

      const onLeave = employeeLeave.find(
        (l) => dateKey(l.startDate) <= key && dateKey(l.endDate) >= key,
      );

      /**
       * Which calendar decides whether this is a working day.
       *
       * A shift that lists its working days decides for the people on it; a
       * shift that lists none follows the company weekend. A day the shift
       * does not work that is not a company weekend is an OFF_DAY: rostered
       * off, not a weekend and not an absence.
       */
      const companyWeekend = isWeekendFor(d, policy.weekendDays);
      const shiftDecides = (assigned?.workingDays.length ?? 0) > 0;
      const working = isShiftWorkingDay(d, assigned, policy.weekendDays);

      /**
       * Order matters. Weekend, off day, holiday and approved leave describe
       * the day itself and hold whether it is past or future. A stored record
       * is fact. Only then does the absence of a record mean anything - and it
       * means "absent" solely for a day that has already happened. A working
       * day in the future is UPCOMING: nobody has failed to attend a day that
       * has not arrived.
       */
      let status: DerivedAttendanceStatus;
      if (!working) status = companyWeekend || !shiftDecides ? 'WEEKEND' : 'OFF_DAY';
      else if (holidayName) status = 'HOLIDAY';
      else if (onLeave) status = 'ON_LEAVE';
      else if (record) status = record.status;
      else if (key > todayKey) status = 'UPCOMING';
      else status = 'ABSENT';

      /**
       * The figures, RECOMPUTED rather than read back.
       *
       * This is the single source of truth for what a day is worth. The stored
       * columns are a write-time cache of the same calculation, and a cache is
       * exactly what goes stale: every one of them was written under whatever
       * policy happened to be in force that night, so reading them back meant
       * a company could change its overtime rule and watch nothing change.
       *
       * The policy used is the one resolved for THIS employee on THIS date -
       * employee over team over department over company, effective-dated - so
       * an override no longer silently disagrees with the figure the import
       * stored under it.
       *
       * A record an administrator corrected is the exception and keeps its
       * stored figures. Those numbers are a human decision about what the day
       * was worth, and re-deriving them would quietly overrule the person who
       * made it.
       */
      const dayPolicy = policyFor(employee.id, d);
      const admin = record?.source === 'ADMIN';

      const computed =
        record && !admin
          ? computeAttendance({
              day: key,
              checkInAt: record.checkInAt,
              checkOutAt: record.checkOutAt,
              shift: assigned ? effectiveShift(assigned, dayPolicy) : null,
              policy: dayPolicy,
            })
          : null;

      const workedMinutes = computed ? computed.workedMinutes : (record?.workedMinutes ?? null);
      const lateMinutes = computed ? computed.lateMinutes : (record?.lateMinutes ?? null);
      const earlyLeaveMinutes = computed
        ? computed.earlyLeaveMinutes
        : (record?.earlyLeaveMinutes ?? null);
      const irregular = computed ? computed.irregular : (record?.irregular ?? false);
      const integrity: AttendanceIntegrity = computed
        ? computed.integrity
        : record
          ? record.checkInAt && record.checkOutAt
            ? 'COMPLETE'
            : record.checkInAt
              ? 'OPEN'
              : 'NONE'
          : 'NONE';

      /**
       * Overtime on a day nobody was rostered for follows the company rule;
       * an ordinary working day takes the recomputed figure.
       */
      const stored = {
        workedMinutes,
        overtimeMinutes: computed ? computed.overtimeMinutes : (record?.overtimeMinutes ?? null),
      };
      const overtimeMinutes = !record
        ? null
        : status === 'HOLIDAY'
          ? nonWorkingDayOvertime(dayPolicy.holidayWorkRule, stored, dayPolicy)
          : status === 'WEEKEND' || status === 'OFF_DAY'
            ? nonWorkingDayOvertime(dayPolicy.weekendWorkRule, stored, dayPolicy)
            : stored.overtimeMinutes;

      const expectedMinutes = working
        ? expectedMinutesFor(effectiveShift(assigned, dayPolicy), dayPolicy)
        : null;

      const base = {
        date: key,
        status,
        checkInAt: record?.checkInAt?.toISOString() ?? null,
        checkOutAt: record?.checkOutAt?.toISOString() ?? null,
        workedMinutes,
        expectedMinutes,
        lateMinutes,
        earlyLeaveMinutes,
        overtimeMinutes,
        irregular,
        integrity,
        mode: record?.mode ?? null,
        shiftId: record?.shiftId ?? assigned?.id ?? null,
        shiftName: record?.shift?.name ?? assigned?.name ?? null,
        notes: record?.notes ?? null,
        leaveTypeName: onLeave?.leaveType.name ?? null,
        leaveIsPaid: onLeave ? onLeave.leaveType.isPaid : null,
        leaveDayPart: onLeave ? onLeave.dayPart : null,
        holidayName,
        source: record?.source ?? null,
        recordId: record?.id ?? null,
        hasRecord: record !== undefined,
      };

      days.push({ ...base, flags: attendanceFlags(base, dayPolicy) });
    }

    result.set(employee.id, days);
  }

  return result;
}

/**
 * Builds one row per calendar day in the range, merging stored attendance with
 * the leave, holiday and weekend calendars. Days with no record are still
 * returned, classified rather than simply missing.
 */
export async function deriveRange(
  companyId: string,
  employeeId: string,
  from: Date,
  to: Date,
): Promise<DerivedDay[]> {
  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { id: true, locationId: true },
  });

  const byEmployee = await deriveRangeForEmployees(companyId, [employee], from, to);
  return byEmployee.get(employeeId) ?? [];
}

/**
 * The shift in force for an employee on a given date, if any.
 *
 * Returns the whole window including the shift's rule overrides, so the engine
 * scores the day against the shift's own grace and caps and not only its
 * times.
 */
export async function shiftOnDate(employeeId: string, date: Date): Promise<ResolvedShift | null> {
  const assignment = await prisma.employeeShiftAssignment.findFirst({
    where: {
      employeeId,
      effectiveFrom: { lte: date },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    include: { shift: { select: SHIFT_WINDOW_SELECT } },
  });

  return assignment?.shift ?? null;
}

// ------------------------------------------------------- location restriction

/**
 * Enforces the company check-in geofence, server side.
 *
 * Deliberately fail-closed. When the restriction is on, a check-in the server
 * cannot place is refused rather than waved through - an employee with no work
 * location, or a location with no coordinates, is a configuration gap that
 * should be visible, not a silent bypass. The rule applies to remote check-ins
 * too: exempting them would make the whole restriction one dropdown away from
 * being defeated.
 *
 * Does nothing at all when the restriction is off, which is the default, so
 * existing companies are unaffected.
 */
/**
 * Enforces the company check-in network allow-list, server side.
 *
 * Fails closed the same way the geofence does: with the restriction on and an
 * empty allow-list, nothing is permitted. An allow-list that silently means
 * "everything" would be a security control that does the opposite of what its
 * name says.
 *
 * The address comes from Fastify, which honours `trustProxy` when configured;
 * it is never taken from a client-supplied header here.
 */
export function assertCheckInIpAllowed(input: {
  policy: AttendancePolicy;
  ip: string | null;
}): void {
  const { policy, ip } = input;
  if (!policy.ipRestrictionEnabled) return;

  if (policy.allowedCheckInCidrs.length === 0) {
    throw new ForbiddenError(
      'Check-in is restricted to approved networks, but no networks have been configured. Ask an administrator to add one.',
    );
  }

  if (!isIpAllowed(ip, policy.allowedCheckInCidrs)) {
    // Deliberately does not echo the address or the allow-list back.
    throw new ForbiddenError(
      'You are not on a network approved for check-in. Connect to a company network and try again.',
    );
  }
}

export async function assertCheckInLocationAllowed(input: {
  employee: { locationId: string | null };
  policy: AttendancePolicy;
  latitude: number | null;
  longitude: number | null;
}): Promise<{ distanceMeters: number; radiusMeters: number } | null> {
  const { employee, policy, latitude, longitude } = input;
  if (!policy.locationRestrictionEnabled) return null;

  if (latitude === null || longitude === null) {
    throw new ValidationError({
      latitude: ['Your company requires check-in from an approved location. Share your location and try again.'],
    });
  }

  if (!employee.locationId) {
    throw new ForbiddenError(
      'Check-in is restricted to approved work locations, but you have no work location assigned. Ask HR to set one.',
    );
  }

  const site = await prisma.location.findUnique({
    where: { id: employee.locationId },
    select: { name: true, latitude: true, longitude: true, geofenceRadiusMeters: true },
  });

  if (!site || site.latitude === null || site.longitude === null) {
    throw new ForbiddenError(
      `Check-in is restricted to approved work locations, but ${site?.name ?? 'your location'} has no coordinates set. Ask HR to configure it.`,
    );
  }

  const radiusMeters = site.geofenceRadiusMeters ?? policy.defaultGeofenceRadiusM;
  const distanceMeters = haversineMeters(
    { latitude: site.latitude, longitude: site.longitude },
    { latitude, longitude },
  );

  if (distanceMeters > radiusMeters) {
    throw new ForbiddenError(
      `You appear to be ${distanceMeters}m from ${site.name}, outside the ${radiusMeters}m check-in area.`,
    );
  }

  return { distanceMeters, radiusMeters };
}

// ----------------------------------------------------- approval write-through

/**
 * Applies an approved regularisation to the attendance record.
 *
 * Called by the approval engine's write-through. Without this an approved
 * correction would flip a status and change nothing that anyone actually reads,
 * which is worse than refusing the request outright.
 *
 * The requested status wins when the approver named one - a human decision
 * beats the arithmetic. Everything else (worked, late, early, overtime) is
 * recomputed from the policy so a corrected day is scored exactly like a day
 * captured live.
 */
export async function applyRegularization(regularizationId: string): Promise<void> {
  const req = await prisma.attendanceRegularizationRequest.findUnique({
    where: { id: regularizationId },
  });
  if (!req || req.status !== 'APPROVED') return;

  const date = toDateOnly(req.attendanceDate);
  const [existing, policy, shift] = await Promise.all([
    prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId: req.employeeId, date } },
    }),
    resolvePolicyFor(req.companyId, req.employeeId, date),
    shiftOnDate(req.employeeId, date),
  ]);

  const checkInAt = req.requestedCheckInAt ?? existing?.checkInAt ?? null;
  const checkOutAt = req.requestedCheckOutAt ?? existing?.checkOutAt ?? null;

  const computed = computeAttendance({ day: date, checkInAt, checkOutAt, shift, policy });
  const status = req.requestedStatus ?? computed.status;
  const note = `Corrected by approved request: ${req.reason}`;

  const values = {
    status,
    checkInAt,
    checkOutAt,
    workedMinutes: computed.workedMinutes ?? existing?.workedMinutes ?? null,
    lateMinutes: computed.lateMinutes,
    earlyLeaveMinutes: computed.earlyLeaveMinutes,
    overtimeMinutes: computed.overtimeMinutes,
    irregular: computed.irregular,
    shiftId: shift?.id ?? existing?.shiftId ?? null,
    notes: note,
    // The value came from an approval decision, not from the person.
    source: 'ADMIN' as const,
  };

  await prisma.attendanceRecord.upsert({
    where: { employeeId_date: { employeeId: req.employeeId, date } },
    create: { companyId: req.companyId, employeeId: req.employeeId, date, ...values },
    update: values,
  });
}

/**
 * Applies an approved shift change by creating the assignment and closing off
 * whatever was in force before it.
 */
export async function applyShiftChange(shiftChangeId: string): Promise<void> {
  const req = await prisma.shiftChangeRequest.findUnique({ where: { id: shiftChangeId } });
  if (!req || req.status !== 'APPROVED') return;

  const from = toDateOnly(req.effectiveFrom);

  // Nothing to do if the assignment already exists - approval is idempotent.
  const already = await prisma.employeeShiftAssignment.findFirst({
    where: { employeeId: req.employeeId, shiftId: req.requestedShiftId, effectiveFrom: from },
    select: { id: true },
  });
  if (already) return;

  const dayBefore = new Date(from);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);

  await prisma.$transaction([
    // Close any open assignment so two shifts never overlap.
    prisma.employeeShiftAssignment.updateMany({
      where: { employeeId: req.employeeId, effectiveTo: null, effectiveFrom: { lt: from } },
      data: { effectiveTo: dayBefore },
    }),
    prisma.employeeShiftAssignment.create({
      data: {
        companyId: req.companyId,
        employeeId: req.employeeId,
        shiftId: req.requestedShiftId,
        effectiveFrom: from,
      },
    }),
  ]);
}
