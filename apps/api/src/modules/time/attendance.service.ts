import type { AttendanceStatus } from '@prisma/client';
import { prisma } from '../../core/db.js';
import { ForbiddenError, ValidationError } from '../../core/errors.js';
import { toDateOnly } from '../leave/leave.service.js';
import {
  computeAttendance,
  haversineMeters,
  isIpAllowed,
  isWeekendFor,
  resolveAttendancePolicy,
  resolvePolicyFor,
  type AttendancePolicy,
} from './attendance-policy.js';

export { isWeekendFor } from './attendance-policy.js';

/**
 * Daily attendance derivation.
 *
 * A day's status is not a free-text field someone types - it is decided by four
 * inputs, in this order of precedence:
 *
 *   1. weekend   - from the company's configured weekendDays
 *   2. holiday   - from the employee's location calendar plus company-wide days
 *   3. on leave  - from approved leave covering the date
 *   4. the stored record, or ABSENT when there is none
 *
 * Weekend and holiday win over leave deliberately: booking leave across a
 * public holiday should not report the holiday as a day of leave, and the
 * working-day count in Phase 4 already excluded it from the balance.
 */

export interface DerivedDay {
  date: string;
  status: AttendanceStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  mode: string | null;
  shiftName: string | null;
  notes: string | null;
  /** Set when the day is covered by approved leave. */
  leaveTypeName: string | null;
  /** Set when the day is a holiday that applies to this employee. */
  holidayName: string | null;
  /** True when a stored record exists; false when the status is inferred. */
  hasRecord: boolean;
}

const dateKey = (d: Date) => d.toISOString().slice(0, 10);

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

  const [policy, records, leave, holidayRows] = await Promise.all([
    resolveAttendancePolicy(companyId),
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
      include: { leaveType: { select: { name: true } } },
    }),
    prisma.holiday.findMany({
      where: { companyId, isActive: true, date: { gte: from, lte: to } },
      select: { date: true, name: true, locationId: true },
    }),
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

  for (const employee of employees) {
    const recordByDate = recordsByEmployee.get(employee.id) ?? new Map();
    const employeeLeave = leaveByEmployee.get(employee.id) ?? [];

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

      const onLeave = employeeLeave.find(
        (l) => dateKey(l.startDate) <= key && dateKey(l.endDate) >= key,
      );

      let status: AttendanceStatus;
      if (isWeekendFor(d, policy.weekendDays)) status = 'WEEKEND';
      else if (holidayName) status = 'HOLIDAY';
      else if (onLeave) status = 'ON_LEAVE';
      else if (record) status = record.status;
      else status = 'ABSENT';

      days.push({
        date: key,
        status,
        checkInAt: record?.checkInAt?.toISOString() ?? null,
        checkOutAt: record?.checkOutAt?.toISOString() ?? null,
        workedMinutes: record?.workedMinutes ?? null,
        lateMinutes: record?.lateMinutes ?? null,
        earlyLeaveMinutes: record?.earlyLeaveMinutes ?? null,
        overtimeMinutes: record?.overtimeMinutes ?? null,
        mode: record?.mode ?? null,
        shiftName: record?.shift?.name ?? null,
        notes: record?.notes ?? null,
        leaveTypeName: onLeave?.leaveType.name ?? null,
        holidayName,
        hasRecord: record !== undefined,
      });
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

/** The shift in force for an employee on a given date, if any. */
export async function shiftOnDate(
  employeeId: string,
  date: Date,
): Promise<{ id: string; name: string; startTime: string; endTime: string } | null> {
  const assignment = await prisma.employeeShiftAssignment.findFirst({
    where: {
      employeeId,
      effectiveFrom: { lte: date },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    include: { shift: { select: { id: true, name: true, startTime: true, endTime: true } } },
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

  const computed = computeAttendance({ checkInAt, checkOutAt, shift, policy });
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
