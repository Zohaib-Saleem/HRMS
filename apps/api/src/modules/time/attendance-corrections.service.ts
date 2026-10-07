import type { Prisma } from '@prisma/client';
import type {
  AttendanceDayDetail,
  AttendanceDayPunch,
  AttendanceDayRules,
  AttendanceAdjustmentRecord,
  AttendanceCorrectionInput,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { dayKeyToDateColumn, dateColumnToDayKey, dayBoundsInZone } from '../../core/zoned-time.js';
import { pairPunches } from '../attendance-device/attendance-import.service.js';
import { reconcileAfterAttendanceWrite } from '../leave/leave-reconciliation.service.js';
import {
  attendanceFlags,
  computeAttendance,
  effectiveShift,
  expectedMinutesFor,
  resolvePolicyFor,
  withShiftRules,
} from './attendance-policy.js';
import { deriveRange, shiftOnDate, type ResolvedShift } from './attendance.service.js';

/**
 * The Attendance Correction Centre.
 *
 * Correcting a day is not editing a number. Three things have to stay true no
 * matter what an administrator types:
 *
 *   - The raw punch is evidence and is never touched. Not the instant, not the
 *     PIN, not the direction. A correction changes what the *processed* day
 *     says; the punches underneath it stay exactly as the terminal reported
 *     them, and the screen shows both side by side.
 *   - Nothing else is recalculated. One employee, one day. No other day, no
 *     other person, and no historical rescoring of anything the correction did
 *     not name.
 *   - Every change is written down before it is applied: old value, new value,
 *     who, why, when. `attendance_adjustments` is append-only and nothing in
 *     this file deletes from it.
 *
 * The record is marked ADMIN, which is what stops the next device sync from
 * quietly undoing the correction - `recalculateFromPunches` refuses to
 * overwrite an ADMIN record.
 */

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

/** The correctable fields, in the order the screen shows them. */
export const CORRECTABLE_FIELDS = [
  'checkInAt',
  'checkOutAt',
  'shiftId',
  'status',
  'workedMinutes',
  'lateMinutes',
  'earlyLeaveMinutes',
  'overtimeMinutes',
  'notes',
] as const;

export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

/** How far back a correction may reach. A ceiling, not a policy. */
const MAX_CORRECTION_AGE_DAYS = 3660;

interface DayShift {
  shift: ResolvedShift | null;
  /** True when a shift assignment covered the day. */
  assigned: boolean;
}

/** The shift to score a day against: the correction's, else the assignment. */
async function shiftForDay(
  companyId: string,
  employeeId: string,
  date: Date,
  overrideShiftId: string | null | undefined,
): Promise<DayShift> {
  if (overrideShiftId === undefined) {
    const assigned = await shiftOnDate(employeeId, date);
    return { shift: assigned, assigned: assigned !== null };
  }
  if (overrideShiftId === null) return { shift: null, assigned: false };

  const shift = await prisma.shift.findFirst({
    where: { id: overrideShiftId, companyId },
    select: {
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
    },
  });
  if (!shift) throw new ValidationError({ shiftId: ['That shift does not exist.'] });
  return { shift, assigned: true };
}

/** The rules that decided a day, and which of them came from the shift. */
function ruleView(
  policy: Awaited<ReturnType<typeof resolvePolicyFor>>,
  shift: ResolvedShift | null,
): AttendanceDayRules {
  const merged = withShiftRules(policy, shift);
  return {
    policyName: policy.policyName,
    graceMinutes: merged.graceMinutes,
    lateThresholdMinutes: merged.lateThresholdMinutes,
    earlyLeaveGraceMinutes: merged.earlyLeaveGraceMinutes,
    earlyLeaveThresholdMinutes: merged.earlyLeaveThresholdMinutes,
    halfDayMinutes: merged.halfDayMinutes,
    fullDayMinutes: merged.fullDayMinutes,
    fullDayToleranceMinutes: merged.fullDayToleranceMinutes,
    overtimeEnabled: merged.overtimeEnabled,
    overtimeFromShiftEnd: merged.overtimeFromShiftEnd,
    overtimeDailyCapMinutes: merged.overtimeDailyCapMinutes,
    overtimeMinimumMinutes: merged.overtimeMinimumMinutes,
    breakIncludedInWindow: merged.breakIncludedInWindow,
    irregularCheckInEnabled: merged.irregularCheckInEnabled,
    irregularCheckInCutoff: merged.irregularCheckInCutoff,
    irregularCheckInMode: merged.irregularCheckInMode,
    missingCheckInStatus: merged.missingCheckInStatus,
    missingCheckOutStatus: merged.missingCheckOutStatus,
    fromShift: merged.shiftRuleKeys,
  };
}

/**
 * Every punch that belongs to an employee-day.
 *
 * Matched on `localDayKey`, which the ingest set from the device's own zone
 * when the punch arrived. That decision is not repeated here: re-deriving the
 * day from the timestamp would move punches between days whenever a company
 * changed its timezone, which is precisely the kind of silent historical
 * rewrite this module exists to prevent.
 */
async function punchesForDay(
  companyId: string,
  employeeId: string,
  dayKey: string,
): Promise<
  Array<{
    id: string;
    deviceId: string;
    deviceUserId: string;
    punchedAt: Date;
    rawTimestamp: string;
    punchState: string | null;
    verifyMode: string | null;
    importedAt: Date;
    processedAt: Date | null;
    device: { name: string; serialNumber: string | null };
  }>
> {
  return prisma.attendanceRawPunch.findMany({
    where: { companyId, employeeId, localDayKey: dayKey },
    orderBy: { punchedAt: 'asc' },
    select: {
      id: true,
      deviceId: true,
      deviceUserId: true,
      punchedAt: true,
      rawTimestamp: true,
      punchState: true,
      verifyMode: true,
      importedAt: true,
      processedAt: true,
      device: { select: { name: true, serialNumber: true } },
    },
  });
}

function toAdjustmentRecord(row: {
  id: string;
  employeeId: string;
  date: Date;
  kind: string;
  changedFields: string[];
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
  reason: string;
  actorId: string | null;
  createdAt: Date;
  employee: { firstName: string; lastName: string; displayName: string | null };
  actor: { email: string; employee: { firstName: string; lastName: string; displayName: string | null } | null } | null;
}): AttendanceAdjustmentRecord {
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: displayName(row.employee),
    date: dateColumnToDayKey(row.date),
    kind: row.kind as AttendanceAdjustmentRecord['kind'],
    changedFields: row.changedFields,
    before: (row.before ?? {}) as Record<string, unknown>,
    after: (row.after ?? {}) as Record<string, unknown>,
    reason: row.reason,
    actorId: row.actorId,
    actorName: row.actor
      ? row.actor.employee
        ? displayName(row.actor.employee)
        : row.actor.email
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const ADJUSTMENT_INCLUDE = {
  employee: { select: { firstName: true, lastName: true, displayName: true } },
  actor: {
    select: {
      email: true,
      employee: { select: { firstName: true, lastName: true, displayName: true } },
    },
  },
} as const;

export { toAdjustmentRecord };

/**
 * One employee-day, in full.
 *
 * The screen that answers "why does this day say that?": the stored figures,
 * the rules that produced them, the punches underneath, what those punches
 * would score today, and every change anyone has made. Read-only - nothing
 * here writes, and the recomputation is shown, never stored.
 */
export async function attendanceDayDetail(input: {
  companyId: string;
  employeeId: string;
  dayKey: string;
}): Promise<AttendanceDayDetail> {
  const { companyId, employeeId, dayKey } = input;
  const date = dayKeyToDateColumn(dayKey);

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, companyId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      displayName: true,
      employeeNumber: true,
      department: { select: { name: true } },
      team: { select: { name: true } },
      designation: { select: { name: true } },
    },
  });
  if (!employee) throw new NotFoundError('Employee');

  const [policy, assignedShift, punches, adjustments, mappings, derived] = await Promise.all([
    resolvePolicyFor(companyId, employeeId, date),
    shiftOnDate(employeeId, date),
    punchesForDay(companyId, employeeId, dayKey),
    prisma.attendanceAdjustment.findMany({
      where: { companyId, employeeId, date },
      orderBy: { createdAt: 'desc' },
      include: ADJUSTMENT_INCLUDE,
    }),
    prisma.attendanceDeviceUserMapping.findMany({
      where: { companyId, employeeId, isActive: true },
      select: {
        deviceUserId: true,
        effectiveFrom: true,
        effectiveTo: true,
        device: { select: { id: true, name: true } },
      },
    }),
    deriveRange(companyId, employeeId, date, date),
  ]);

  /**
   * A day outside the employment is not a day this person has.
   *
   * The deriver declines to classify one - see `isEmployeeInAttendancePopulation`
   * - so there is nothing to explain, correct or adjust. The correction centre
   * only ever lists days it derived, so this is reachable by hand-typed date
   * alone; answering "not found" is the truth, and is what keeps the
   * non-null assertion below honest.
   */
  const processed = derived[0];
  if (!processed) {
    throw new NotFoundError(
      `Attendance for ${dayKey}: that employee was not employed on that date`,
    );
  }

  const window = effectiveShift(assignedShift, policy);

  /**
   * What the punches would produce under today's rules.
   *
   * Deliberately recomputed rather than read: a difference between this and
   * the stored day is the single most useful thing the screen can show, and
   * it is only visible if both are present. Nothing writes it.
   */
  const fromPunches =
    punches.length === 0
      ? null
      : (() => {
          const paired = pairPunches(punches, 'FIRST_IN_LAST_OUT');
          const computed = computeAttendance({
            day: dayKey,
            checkInAt: paired.checkInAt,
            checkOutAt: paired.checkOutAt,
            shift: assignedShift,
            policy,
          });
          return {
            checkInAt: paired.checkInAt?.toISOString() ?? null,
            checkOutAt: paired.checkOutAt?.toISOString() ?? null,
            workedMinutes: computed.workedMinutes,
            lateMinutes: computed.lateMinutes,
            earlyLeaveMinutes: computed.earlyLeaveMinutes,
            overtimeMinutes: computed.overtimeMinutes,
            status: computed.status,
            irregular: computed.irregular,
          };
        })();

  // Which punch was chosen as the arrival and which as the departure, so the
  // list explains the figures rather than merely accompanying them.
  const chosen = pairPunches(punches, 'FIRST_IN_LAST_OUT');
  const rawPunches: AttendanceDayPunch[] = punches.map((p) => ({
    id: p.id,
    deviceId: p.deviceId,
    deviceName: p.device.name,
    deviceSerial: p.device.serialNumber,
    deviceUserId: p.deviceUserId,
    rawTimestamp: p.rawTimestamp,
    punchedAt: p.punchedAt.toISOString(),
    punchState: p.punchState,
    verifyMode: p.verifyMode,
    importedAt: p.importedAt.toISOString(),
    processedAt: p.processedAt?.toISOString() ?? null,
    role:
      chosen.checkInAt && p.punchedAt.getTime() === chosen.checkInAt.getTime()
        ? 'IN'
        : chosen.checkOutAt && p.punchedAt.getTime() === chosen.checkOutAt.getTime()
          ? 'OUT'
          : null,
  }));

  const punchCodes = mappings
    .filter((m) => {
      const from = m.effectiveFrom ? dateColumnToDayKey(m.effectiveFrom) : null;
      const to = m.effectiveTo ? dateColumnToDayKey(m.effectiveTo) : null;
      if (from !== null && dayKey < from) return false;
      if (to !== null && dayKey > to) return false;
      return true;
    })
    .map((m) => ({
      deviceId: m.device.id,
      deviceName: m.device.name,
      deviceUserId: m.deviceUserId,
    }));

  return {
    date: dayKey,
    employee: {
      id: employee.id,
      name: displayName(employee),
      employeeNumber: employee.employeeNumber,
      departmentName: employee.department?.name ?? null,
      teamName: employee.team?.name ?? null,
      designationName: employee.designation?.name ?? null,
      punchCodes,
    },
    shift: {
      id: assignedShift?.id ?? null,
      name: assignedShift?.name ?? null,
      startTime: window.startTime,
      endTime: window.endTime,
      breakMinutes: window.breakMinutes ?? 0,
      expectedMinutes: expectedMinutesFor(window, policy),
      assigned: assignedShift !== null,
    },
    rules: ruleView(policy, assignedShift),
    processed,
    fromPunches,
    rawPunches,
    adjustments: adjustments.map(toAdjustmentRecord),
  };
}

export interface CorrectionOutcome {
  recordId: string;
  adjustmentId: string;
  changedFields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Human-readable, for the audit summary and the toast. */
  summary: string;
}

const isoOrNull = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

/**
 * Parses a correction's time input.
 *
 * Accepts a full instant. A bare `HH:mm` would have to be resolved against a
 * zone, and guessing which one is how a correction ends up five hours out.
 */
function parseInstant(value: string | null | undefined, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError({ [field]: ['Enter a valid date and time.'] });
  }
  return parsed;
}

/**
 * Applies one correction to one employee-day.
 *
 * The shape of the decision:
 *
 *   1. Read what is stored (or nothing, for a day with no record).
 *   2. Lay the correction's times and shift over it.
 *   3. Re-score the day from those times under the rules in force *on that
 *      date* - not today's rules, so correcting a day in March does not
 *      regrade it against a rule introduced in September.
 *   4. Let any explicit minute override win over the re-scored figure. That is
 *      the escape hatch for when the arithmetic is right and the world is
 *      wrong, e.g. a terminal whose clock drifted.
 *   5. Write the record, the ledger entry and nothing else.
 *
 * A correction that changes nothing is refused rather than written: an
 * audit trail full of empty entries is an audit trail nobody reads.
 */
export async function applyCorrection(input: {
  companyId: string;
  actorId: string | null;
  correction: AttendanceCorrectionInput;
}): Promise<CorrectionOutcome> {
  const { companyId, actorId, correction } = input;
  const dayKey = correction.date;
  const date = dayKeyToDateColumn(dayKey);

  const employee = await prisma.employee.findFirst({
    where: { id: correction.employeeId, companyId },
    select: { id: true, firstName: true, lastName: true, displayName: true, employeeNumber: true },
  });
  if (!employee) throw new NotFoundError('Employee');

  const ageDays = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (ageDays > MAX_CORRECTION_AGE_DAYS) {
    throw new ValidationError({ date: ['That date is too far in the past to correct.'] });
  }

  const existing = await prisma.attendanceRecord.findUnique({
    where: { employeeId_date: { employeeId: employee.id, date } },
  });

  const checkInAt = parseInstant(correction.checkInAt, 'checkInAt');
  const checkOutAt = parseInstant(correction.checkOutAt, 'checkOutAt');

  const nextCheckIn = checkInAt === undefined ? (existing?.checkInAt ?? null) : checkInAt;
  const nextCheckOut = checkOutAt === undefined ? (existing?.checkOutAt ?? null) : checkOutAt;

  if (nextCheckIn && nextCheckOut && nextCheckOut.getTime() <= nextCheckIn.getTime()) {
    throw new ValidationError({ checkOutAt: ['Check-out must be after check-in.'] });
  }

  const { shift } = await shiftForDay(
    companyId,
    employee.id,
    date,
    correction.shiftId === undefined ? undefined : correction.shiftId,
  );
  const policy = await resolvePolicyFor(companyId, employee.id, date);

  const computed = computeAttendance({
    day: dayKey,
    checkInAt: nextCheckIn,
    checkOutAt: nextCheckOut,
    shift,
    policy,
  });

  /** An explicit override wins; otherwise the day is re-scored from its times. */
  const pick = (override: number | null | undefined, derivedValue: number | null): number | null =>
    override === undefined ? derivedValue : override;

  const after = {
    checkInAt: nextCheckIn,
    checkOutAt: nextCheckOut,
    shiftId: correction.shiftId === undefined ? (existing?.shiftId ?? shift?.id ?? null) : (shift?.id ?? null),
    status: correction.status ?? computed.status,
    workedMinutes: pick(correction.workedMinutes, computed.workedMinutes),
    lateMinutes: pick(correction.lateMinutes, computed.lateMinutes),
    earlyLeaveMinutes: pick(correction.earlyLeaveMinutes, computed.earlyLeaveMinutes),
    overtimeMinutes: pick(correction.overtimeMinutes, computed.overtimeMinutes),
    notes: correction.notes === undefined ? (existing?.notes ?? null) : (correction.notes || null),
    irregular: computed.irregular,
  };

  const before = {
    checkInAt: existing?.checkInAt ?? null,
    checkOutAt: existing?.checkOutAt ?? null,
    shiftId: existing?.shiftId ?? null,
    status: existing?.status ?? null,
    workedMinutes: existing?.workedMinutes ?? null,
    lateMinutes: existing?.lateMinutes ?? null,
    earlyLeaveMinutes: existing?.earlyLeaveMinutes ?? null,
    overtimeMinutes: existing?.overtimeMinutes ?? null,
    notes: existing?.notes ?? null,
    irregular: existing?.irregular ?? false,
  };

  const serialise = (value: typeof before): Record<string, unknown> => ({
    ...value,
    checkInAt: isoOrNull(value.checkInAt),
    checkOutAt: isoOrNull(value.checkOutAt),
  });

  const beforeJson = serialise(before);
  const afterJson = serialise(after);

  const changedFields = CORRECTABLE_FIELDS.filter(
    (field) => beforeJson[field] !== afterJson[field],
  );
  // `irregular` is derived rather than typed, so it is recorded but never on
  // its own the reason a correction is considered a change.
  if (changedFields.length === 0) {
    throw new ConflictError('Nothing in that correction differs from what is already recorded.');
  }

  const written = await prisma.$transaction(async (tx) => {
    const values = {
      status: after.status,
      checkInAt: after.checkInAt,
      checkOutAt: after.checkOutAt,
      workedMinutes: after.workedMinutes,
      lateMinutes: after.lateMinutes,
      earlyLeaveMinutes: after.earlyLeaveMinutes,
      overtimeMinutes: after.overtimeMinutes,
      irregular: after.irregular,
      shiftId: after.shiftId,
      notes: after.notes,
      // ADMIN is what makes the correction stick: the device import refuses to
      // overwrite an ADMIN record, so tonight's sync cannot undo this.
      source: 'ADMIN' as const,
    };

    const record = await tx.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId: employee.id, date } },
      create: { companyId, employeeId: employee.id, date, ...values },
      update: values,
    });

    const adjustment = await tx.attendanceAdjustment.create({
      data: {
        companyId,
        employeeId: employee.id,
        date,
        recordId: record.id,
        kind: 'CORRECTION',
        changedFields: [...changedFields],
        before: beforeJson as Prisma.InputJsonValue,
        after: afterJson as Prisma.InputJsonValue,
        reason: correction.reason,
        actorId,
      },
    });

    return { record, adjustment };
  });

  // A corrected day that now shows the person at work gives back any approved
  // leave on it. Runs after the commit; never fails the correction.
  await reconcileAfterAttendanceWrite({ companyId, employeeId: employee.id, dayKey });

  return {
    recordId: written.record.id,
    adjustmentId: written.adjustment.id,
    changedFields: [...changedFields],
    before: beforeJson,
    after: afterJson,
    summary:
      `Corrected ${displayName(employee)} (${employee.employeeNumber}) on ${dayKey}: ` +
      `${changedFields.join(', ')}`,
  };
}

/**
 * Flags for one stored day, for the screens that read records directly rather
 * than through the derivation. One implementation, so a corrected day is
 * flagged the same way everywhere.
 */
export function flagsForRecord(
  record: {
    status: string;
    checkInAt: Date | null;
    checkOutAt: Date | null;
    lateMinutes: number | null;
    earlyLeaveMinutes: number | null;
    overtimeMinutes: number | null;
    irregular: boolean;
    source: string | null;
  },
  policy: { lateThresholdMinutes: number; earlyLeaveThresholdMinutes: number },
) {
  return attendanceFlags({ ...record, hasRecord: true }, policy);
}

/** The instants that bound a local day, for punch queries by day. */
export function localDayBounds(dayKey: string, timeZone: string) {
  return dayBoundsInZone(dayKey, timeZone);
}
