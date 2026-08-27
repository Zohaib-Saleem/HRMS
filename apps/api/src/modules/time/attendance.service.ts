import type { AttendanceStatus, WeekDay } from '@prisma/client';
import { prisma } from '../../core/db.js';
import { applicableHolidays, toDateOnly } from '../leave/leave.service.js';

/**
 * Daily attendance derivation.
 *
 * A day's status is not a free-text field someone types - it is decided by four
 * inputs, in this order of precedence:
 *
 *   1. weekend   - from the company's configured weekendDays
 *   2. holiday   - from the employee's location calendar plus company-wide days
 *   3. on leave  - from approved leave covering the date
 *   4. present / absent - from whether a check-in exists
 *
 * Weekend and holiday win over leave deliberately: booking leave across a
 * public holiday should not report the holiday as a day of leave, and the
 * working-day count in Phase 4 already excluded it from the balance.
 */

const WEEKDAY_BY_INDEX: readonly WeekDay[] = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];

export function isWeekendFor(date: Date, weekendDays: readonly WeekDay[]): boolean {
  const day = WEEKDAY_BY_INDEX[date.getUTCDay()];
  return day !== undefined && weekendDays.includes(day);
}

export interface DerivedDay {
  date: string;
  status: AttendanceStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  lateMinutes: number | null;
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
  const [company, employee, records, leave, holidayRows] = await Promise.all([
    prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { weekendDays: true },
    }),
    prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { locationId: true },
    }),
    prisma.attendanceRecord.findMany({
      where: { employeeId, date: { gte: from, lte: to } },
      include: { shift: { select: { name: true } } },
    }),
    prisma.leaveRequest.findMany({
      where: {
        employeeId,
        status: 'APPROVED',
        startDate: { lte: to },
        endDate: { gte: from },
      },
      include: { leaveType: { select: { name: true } } },
    }),
    prisma.holiday.findMany({
      where: {
        companyId,
        isActive: true,
        date: { gte: from, lte: to },
      },
      select: { date: true, name: true, locationId: true },
    }),
  ]);

  const recordByDate = new Map(
    records.map((r) => [r.date.toISOString().slice(0, 10), r] as const),
  );

  // Only holidays that apply to this employee: their location plus company-wide.
  const holidayByDate = new Map<string, string>();
  for (const h of holidayRows) {
    if (h.locationId !== null && h.locationId !== employee.locationId) continue;
    holidayByDate.set(h.date.toISOString().slice(0, 10), h.name);
  }

  const days: DerivedDay[] = [];

  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const record = recordByDate.get(key);
    const holidayName = holidayByDate.get(key) ?? null;

    const onLeave = leave.find(
      (l) =>
        l.startDate.toISOString().slice(0, 10) <= key &&
        l.endDate.toISOString().slice(0, 10) >= key,
    );

    let status: AttendanceStatus;
    if (isWeekendFor(d, company.weekendDays)) status = 'WEEKEND';
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
      mode: record?.mode ?? null,
      shiftName: record?.shift?.name ?? null,
      notes: record?.notes ?? null,
      leaveTypeName: onLeave?.leaveType.name ?? null,
      holidayName,
      hasRecord: record !== undefined,
    });
  }

  return days;
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

/**
 * Minutes late against the shift start. Returns null when no shift applies, so
 * "no shift assigned" stays distinguishable from "on time".
 */
export function lateMinutesAgainst(
  checkInAt: Date,
  shiftStart: string | null,
): number | null {
  if (!shiftStart) return null;

  const [h, m] = shiftStart.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return null;

  const expected = new Date(
    Date.UTC(
      checkInAt.getUTCFullYear(),
      checkInAt.getUTCMonth(),
      checkInAt.getUTCDate(),
      h,
      m,
    ),
  );

  const diff = Math.round((checkInAt.getTime() - expected.getTime()) / 60_000);
  return diff > 0 ? diff : 0;
}

/**
 * Applies an approved regularisation to the attendance record.
 *
 * Called by the approval engine's write-through. Without this an approved
 * correction would flip a status and change nothing that anyone actually reads,
 * which is worse than refusing the request outright.
 */
export async function applyRegularization(regularizationId: string): Promise<void> {
  const req = await prisma.attendanceRegularizationRequest.findUnique({
    where: { id: regularizationId },
  });
  if (!req || req.status !== 'APPROVED') return;

  const date = toDateOnly(req.attendanceDate);
  const existing = await prisma.attendanceRecord.findUnique({
    where: { employeeId_date: { employeeId: req.employeeId, date } },
  });

  const checkInAt = req.requestedCheckInAt ?? existing?.checkInAt ?? null;
  const checkOutAt = req.requestedCheckOutAt ?? existing?.checkOutAt ?? null;
  const workedMinutes =
    checkInAt && checkOutAt
      ? Math.max(0, Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60_000))
      : (existing?.workedMinutes ?? null);

  const status = req.requestedStatus ?? existing?.status ?? 'PRESENT';
  const note = `Corrected by approved request: ${req.reason}`;

  await prisma.attendanceRecord.upsert({
    where: { employeeId_date: { employeeId: req.employeeId, date } },
    create: {
      companyId: req.companyId,
      employeeId: req.employeeId,
      date,
      status,
      checkInAt,
      checkOutAt,
      workedMinutes,
      notes: note,
      // The value came from an approval decision, not from the person.
      source: 'ADMIN',
    },
    update: { status, checkInAt, checkOutAt, workedMinutes, notes: note, source: 'ADMIN' },
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
