import { Prisma, type AttendanceSource, type AttendanceStatus, type LeaveDayPart } from '@prisma/client';
import { prisma } from '../../core/db.js';
import { recordAudit } from '../../core/audit.js';
import { NotFoundError } from '../../core/errors.js';
import { dateColumnToDayKey, dayKeyToDateColumn } from '../../core/zoned-time.js';
import { computeAttendance, resolvePolicyFor } from '../time/attendance-policy.js';
import { shiftOnDate } from '../time/attendance.service.js';
import { balancesForEmployee, countWorkingDays, toNumber } from './leave.service.js';

/**
 * Leave and attendance reconciliation.
 *
 * Approved leave on a day somebody turned out to work is leave they did not
 * take. This gives that day back: a `LeaveReversal` row per leave request and
 * date, which the balance subtracts from the request's `totalDays` and the
 * attendance deriver reads as "this day is not leave". The leave request itself
 * is never edited or deleted, except that a request with every day given back
 * is marked CANCELLED by the system, with the reason on it.
 *
 * Three rules, in the order they are applied:
 *
 *   1. Only real attendance counts. A stored record for the employee, with a
 *      check-in, that the attendance engine wrote or a person confirmed. An
 *      unmapped punch never reaches a record, and a duplicate or a punch the
 *      pairing could not read as an arrival never produces a check-in, so
 *      neither can cancel anybody's leave. The absence marker (SYSTEM) has no
 *      check-in, and an administrator's record counts only when its status
 *      says the person worked.
 *
 *   2. A full day of leave is given back on any qualifying check-in. The day
 *      is then scored by the engine like any other - present, late, half day
 *      or absent - by the derivation, not here.
 *
 *   3. A half day of leave is given back only when the attendance covers the
 *      whole day: the day is closed (a check-out exists) and the engine,
 *      under the policy in force for that person and date, scores it PRESENT.
 *      Working the other half is what a half day of leave means and changes
 *      nothing. Working the half that was booked off but not the other one
 *      also consumes half a day either way, so the leave stands.
 *
 * Idempotency is the database's job, not this process's: the unique key on
 * (leaveRequestId, date) means a second run - or two racing runs - inserts
 * nothing, restores nothing and audits nothing.
 */

export const RECONCILIATION_ACTOR = 'SYSTEM / Attendance Reconciliation';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-10-06 -> 06-Oct-2026, the way the company writes dates. */
export function formatDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split('-');
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
}

export function reversalReason(dayKey: string): string {
  return `Automatically reversed because attendance was recorded on ${formatDayKey(dayKey)}.`;
}

export function cancellationReason(dayKeys: readonly string[]): string {
  const sorted = [...dayKeys].sort();
  const list = sorted.map(formatDayKey).join(', ');
  return `Automatically cancelled because attendance was recorded on ${list}.`;
}

/** The reason a Super Admin's cancellation carries, on the day and on the request. */
export const MANUAL_REASON_PREFIX = 'Super Admin cancellation / attendance conflict';

export function manualReversalReason(dayKey: string): string {
  return `${MANUAL_REASON_PREFIX}: the employee attended work on ${formatDayKey(dayKey)}.`;
}

export function manualCancellationReason(dayKeys: readonly string[]): string {
  const list = [...dayKeys].sort().map(formatDayKey).join(', ');
  return `${MANUAL_REASON_PREFIX}: the employee attended work on ${list}.`;
}

/** A person resolving the conflict, as against reconciliation doing it. */
export interface ManualReversalActor {
  userId: string;
  name: string;
}

/** What the reconciliation reads of an attendance record. */
export interface AttendanceEvidence {
  id: string;
  source: AttendanceSource;
  status: AttendanceStatus;
  checkInAt: Date | null;
  checkOutAt: Date | null;
}

/**
 * Whether a stored record is evidence that the person worked.
 *
 * The engine-written sources (DEVICE, SELF) qualify on a check-in alone: the
 * check-in only exists because a punch was mapped to this employee and read as
 * an arrival. An administrator's record carries a status somebody chose, and
 * one that says ABSENT or ON_LEAVE is not attendance whatever times it holds.
 */
export function isQualifyingAttendance(record: AttendanceEvidence | null | undefined): boolean {
  if (!record || !record.checkInAt) return false;
  if (record.source === 'SYSTEM') return false;
  if (record.source === 'ADMIN') return record.status === 'PRESENT' || record.status === 'HALF_DAY';
  return true;
}

export type ReversalDecision =
  | { reverse: true; days: number }
  | {
      reverse: false;
      why:
        | 'NO_QUALIFYING_ATTENDANCE'
        | 'NOT_A_LEAVE_DAY'
        | 'HALF_DAY_NOT_CLOSED'
        | 'HALF_DAY_NOT_CONFLICTING'
        | 'NOTHING_LEFT_TO_REVERSE';
    };

/**
 * The decision for one leave request on one date, with every fact it needs
 * handed in. Pure, so the rules above are tested without a database.
 */
export function decideReversal(input: {
  dayPart: LeaveDayPart;
  totalDays: number;
  /** Days of this request already given back, on other dates. */
  alreadyReversedDays: number;
  /** What the date contributed to `totalDays`: 1, 0.5, or 0 for a weekend or holiday. */
  countedDays: number;
  attendance: AttendanceEvidence | null;
  /**
   * The engine's verdict on the day, under the policy in force for the person
   * and the date. Only read for a half day of leave.
   */
  scoredStatus: AttendanceStatus | null;
  /**
   * A Super Admin's decision. Skips the half-day rule: the person resolving
   * the conflict has looked at the day and decided the leave was not taken.
   * Every other rule - real attendance, a counted leave day, something left to
   * give back - still applies.
   */
  manual?: boolean;
}): ReversalDecision {
  if (!isQualifyingAttendance(input.attendance)) {
    return { reverse: false, why: 'NO_QUALIFYING_ATTENDANCE' };
  }
  if (input.countedDays <= 0) return { reverse: false, why: 'NOT_A_LEAVE_DAY' };

  if (input.dayPart !== 'FULL_DAY' && !input.manual) {
    // An open day says nothing yet about the half that was booked off.
    if (!input.attendance!.checkOutAt) return { reverse: false, why: 'HALF_DAY_NOT_CLOSED' };
    if (input.scoredStatus !== 'PRESENT') return { reverse: false, why: 'HALF_DAY_NOT_CONFLICTING' };
  }

  const remaining = round2(input.totalDays - input.alreadyReversedDays);
  const days = round2(Math.min(input.countedDays, remaining));
  if (days <= 0) return { reverse: false, why: 'NOTHING_LEFT_TO_REVERSE' };

  return { reverse: true, days };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ReconcileOutcome {
  leaveRequestId: string;
  employeeId: string;
  dayKey: string;
  result: 'REVERSED' | 'ALREADY_REVERSED' | 'KEPT';
  why?: string;
  restoredDays: number;
  /** True when this reversal gave back the request's last day. */
  cancelled: boolean;
}

/**
 * Reconciles every approved leave request covering the given employee-days.
 *
 * Called with the days an import or a recalculation has just written. A day
 * with no approved leave costs one query and does nothing. Failures are per
 * day and never thrown: reconciliation follows attendance, and a fault here
 * must not cost the import that triggered it.
 */
export async function reconcileLeaveForDays(input: {
  companyId: string;
  days: ReadonlyArray<{ employeeId: string; dayKey: string }>;
}): Promise<ReconcileOutcome[]> {
  const outcomes: ReconcileOutcome[] = [];
  if (input.days.length === 0) return outcomes;

  const dates = input.days.map((d) => dayKeyToDateColumn(d.dayKey));
  const from = new Date(Math.min(...dates.map((d) => d.getTime())));
  const to = new Date(Math.max(...dates.map((d) => d.getTime())));
  const employeeIds = [...new Set(input.days.map((d) => d.employeeId))];

  const leave = await prisma.leaveRequest.findMany({
    where: {
      companyId: input.companyId,
      employeeId: { in: employeeIds },
      status: 'APPROVED',
      startDate: { lte: to },
      endDate: { gte: from },
    },
    select: { id: true, employeeId: true, startDate: true, endDate: true },
  });
  if (leave.length === 0) return outcomes;

  for (const day of input.days) {
    const covering = leave.filter(
      (l) =>
        l.employeeId === day.employeeId &&
        dateColumnToDayKey(l.startDate) <= day.dayKey &&
        dateColumnToDayKey(l.endDate) >= day.dayKey,
    );
    for (const l of covering) {
      try {
        outcomes.push(await reconcileOne(l.id, day.dayKey));
      } catch (error) {
        // Logged and left: the next import, recalculation or nightly pass
        // tries the same day again, and the key keeps that retry harmless.
        console.error('leave reconciliation failed', { leaveRequestId: l.id, dayKey: day.dayKey, error });
      }
    }
  }
  return outcomes;
}

/**
 * The hook every attendance write calls once its record is stored.
 *
 * Never throws. The write that called it has already happened and is right on
 * its own; a reconciliation that fails is retried by the next trigger for the
 * same day, and the nightly pass sweeps up what nothing else retried.
 */
export async function reconcileAfterAttendanceWrite(input: {
  companyId: string;
  employeeId: string;
  dayKey: string;
}): Promise<ReconcileOutcome[]> {
  try {
    return await reconcileLeaveForDays({
      companyId: input.companyId,
      days: [{ employeeId: input.employeeId, dayKey: input.dayKey }],
    });
  } catch (error) {
    console.error('leave reconciliation failed', { ...input, error });
    return [];
  }
}

/**
 * Reconciles one leave request across every date it covers.
 *
 * Run when a request is approved, so leave approved after the person has
 * already been seen at work is caught at the moment of approval rather than
 * waiting for the next import.
 */
export async function reconcileLeaveRequest(leaveRequestId: string): Promise<ReconcileOutcome[]> {
  const leave = await prisma.leaveRequest.findUnique({
    where: { id: leaveRequestId },
    select: { id: true, companyId: true, employeeId: true, startDate: true, endDate: true, status: true },
  });
  if (!leave || leave.status !== 'APPROVED') return [];

  const records = await prisma.attendanceRecord.findMany({
    where: {
      employeeId: leave.employeeId,
      date: { gte: leave.startDate, lte: leave.endDate },
      checkInAt: { not: null },
    },
    select: { date: true },
  });

  return reconcileLeaveForDays({
    companyId: leave.companyId,
    days: records.map((r) => ({ employeeId: leave.employeeId, dayKey: dateColumnToDayKey(r.date) })),
  });
}

/**
 * The daily pass: every approved leave day in the window that has attendance.
 *
 * Catches whatever no other trigger saw - a record an administrator entered by
 * hand, or a request approved while an import was running. Bounded to a short
 * recent window on purpose: historical conflicts are a decision for a person,
 * not something a scheduled job should rewrite.
 */
export async function reconcileRecentLeave(input: {
  companyId: string;
  from: Date;
  to: Date;
}): Promise<ReconcileOutcome[]> {
  const leave = await prisma.leaveRequest.findMany({
    where: {
      companyId: input.companyId,
      status: 'APPROVED',
      startDate: { lte: input.to },
      endDate: { gte: input.from },
    },
    select: { employeeId: true, startDate: true, endDate: true },
  });
  if (leave.length === 0) return [];

  const records = await prisma.attendanceRecord.findMany({
    where: {
      employeeId: { in: [...new Set(leave.map((l) => l.employeeId))] },
      date: { gte: input.from, lte: input.to },
      checkInAt: { not: null },
    },
    select: { employeeId: true, date: true },
  });

  return reconcileLeaveForDays({
    companyId: input.companyId,
    days: records.map((r) => ({ employeeId: r.employeeId, dayKey: dateColumnToDayKey(r.date) })),
  });
}

async function reconcileOne(
  leaveRequestId: string,
  dayKey: string,
  actor: ManualReversalActor | null = null,
): Promise<ReconcileOutcome> {
  const date = dayKeyToDateColumn(dayKey);

  const leave = await prisma.leaveRequest.findUniqueOrThrow({
    where: { id: leaveRequestId },
    select: {
      id: true,
      companyId: true,
      employeeId: true,
      leaveTypeId: true,
      startDate: true,
      endDate: true,
      dayPart: true,
      totalDays: true,
      status: true,
      leaveType: { select: { name: true } },
      employee: { select: { locationId: true, firstName: true, lastName: true, displayName: true } },
      reversals: { select: { date: true, days: true } },
    },
  });

  const base = { leaveRequestId, employeeId: leave.employeeId, dayKey, restoredDays: 0, cancelled: false };

  if (leave.status !== 'APPROVED') return { ...base, result: 'KEPT', why: 'NOT_APPROVED' };
  if (leave.reversals.some((r) => dateColumnToDayKey(r.date) === dayKey)) {
    return { ...base, result: 'ALREADY_REVERSED' };
  }

  const attendance = await prisma.attendanceRecord.findUnique({
    where: { employeeId_date: { employeeId: leave.employeeId, date } },
    select: { id: true, source: true, status: true, checkInAt: true, checkOutAt: true, shiftId: true },
  });

  const countedDays = isQualifyingAttendance(attendance)
    ? await countWorkingDays(leave.companyId, leave.employee.locationId, date, date, leave.dayPart)
    : 0;

  /*
   * The engine's verdict, for a half day only - computed exactly as the import
   * computes it, under the policy for this person and date. An administrator's
   * record keeps the status they gave it, as everywhere else.
   */
  let scoredStatus: AttendanceStatus | null = null;
  if (!actor && attendance && leave.dayPart !== 'FULL_DAY' && attendance.checkInAt && attendance.checkOutAt) {
    if (attendance.source === 'ADMIN') {
      scoredStatus = attendance.status;
    } else {
      const [policy, shift] = await Promise.all([
        resolvePolicyFor(leave.companyId, leave.employeeId, date),
        shiftOnDate(leave.employeeId, date),
      ]);
      scoredStatus = computeAttendance({
        day: dayKey,
        checkInAt: attendance.checkInAt,
        checkOutAt: attendance.checkOutAt,
        shift,
        policy,
      }).status;
    }
  }

  const totalDays = toNumber(leave.totalDays);
  const alreadyReversedDays = round2(leave.reversals.reduce((s, r) => s + toNumber(r.days), 0));

  const decision = decideReversal({
    dayPart: leave.dayPart,
    totalDays,
    alreadyReversedDays,
    countedDays,
    attendance,
    scoredStatus,
    manual: actor !== null,
  });
  if (!decision.reverse) return { ...base, result: 'KEPT', why: decision.why };

  const year = leave.startDate.getUTCFullYear();
  const balanceBefore = (await balancesForEmployee(leave.companyId, leave.employeeId, year)).find(
    (b) => b.leaveTypeId === leave.leaveTypeId,
  );

  const reason = actor ? manualReversalReason(dayKey) : reversalReason(dayKey);
  const reversedDayKeys = [...leave.reversals.map((r) => dateColumnToDayKey(r.date)), dayKey];
  const fullyReversed = round2(alreadyReversedDays + decision.days) >= totalDays;
  const cancelReason = fullyReversed
    ? actor
      ? manualCancellationReason(reversedDayKeys)
      : cancellationReason(reversedDayKeys)
    : null;

  const created = await prisma
    .$transaction(async (tx) => {
      const reversal = await tx.leaveReversal.create({
        data: {
          companyId: leave.companyId,
          employeeId: leave.employeeId,
          leaveRequestId: leave.id,
          date,
          days: decision.days,
          reason,
          reversedById: actor?.userId ?? null,
          attendanceRecordId: attendance!.id,
          attendanceSource: attendance!.source,
          checkInAt: attendance!.checkInAt!,
          checkOutAt: attendance!.checkOutAt,
        },
      });

      if (fullyReversed) {
        // Guarded on APPROVED so a request withdrawn in the meantime keeps the
        // status a person gave it.
        await tx.leaveRequest.updateMany({
          where: { id: leave.id, status: 'APPROVED' },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledBySystem: actor === null,
            cancellationReason: cancelReason,
          },
        });
      }
      return reversal;
    })
    .catch((error: unknown) => {
      // The key already holds this day: another run got there first.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      throw error;
    });

  if (!created) return { ...base, result: 'ALREADY_REVERSED' };

  const balanceAfter = (await balancesForEmployee(leave.companyId, leave.employeeId, year)).find(
    (b) => b.leaveTypeId === leave.leaveTypeId,
  );

  const punches =
    attendance!.source === 'DEVICE'
      ? await prisma.attendanceRawPunch.findMany({
          where: { companyId: leave.companyId, employeeId: leave.employeeId, localDayKey: dayKey },
          select: { id: true, punchedAt: true, deviceId: true, punchState: true },
          orderBy: { punchedAt: 'asc' },
        })
      : [];

  const name =
    leave.employee.displayName ?? `${leave.employee.firstName} ${leave.employee.lastName}`.trim();

  const actorLabel = actor ? `Super Admin ${actor.name}` : RECONCILIATION_ACTOR;

  await recordAudit({
    companyId: leave.companyId,
    actorId: actor?.userId ?? null,
    action: actor ? 'leave.request.conflict_cancel' : 'leave.request.auto_reverse',
    entityType: 'LeaveRequest',
    entityId: leave.id,
    summary: `${actorLabel}: ${decision.days} day(s) of ${leave.leaveType.name} for ${name} on ${formatDayKey(dayKey)} restored${fullyReversed ? ' and the request cancelled' : ''}. ${reason}`,
    before: {
      status: 'APPROVED',
      employeeId: leave.employeeId,
      leaveDate: dayKey,
      reversedDays: alreadyReversedDays,
      usedDays: balanceBefore?.usedDays ?? null,
      availableDays: balanceBefore?.availableDays ?? null,
    },
    after: {
      status: fullyReversed ? 'CANCELLED' : 'APPROVED',
      employeeId: leave.employeeId,
      leaveDate: dayKey,
      restoredDays: decision.days,
      reversedDays: round2(alreadyReversedDays + decision.days),
      usedDays: balanceAfter?.usedDays ?? null,
      availableDays: balanceAfter?.availableDays ?? null,
      reversalId: created.id,
      attendanceRecordId: attendance!.id,
      attendanceSource: attendance!.source,
      checkInAt: attendance!.checkInAt!.toISOString(),
      checkOutAt: attendance!.checkOutAt?.toISOString() ?? null,
      punchIds: punches.map((p) => p.id),
      actor: actorLabel,
      reason: cancelReason ?? reason,
    },
  });

  return { ...base, result: 'REVERSED', restoredDays: decision.days, cancelled: fullyReversed };
}

/**
 * The scheduled pass for every company: yesterday and today, with a day of
 * margin either side so no company's zone falls outside it.
 */
export async function reconcileRecentLeaveForAllCompanies(now = new Date()): Promise<ReconcileOutcome[]> {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - 2);
  const to = new Date(today);
  to.setUTCDate(to.getUTCDate() + 1);

  const companies = await prisma.company.findMany({ select: { id: true } });
  const outcomes: ReconcileOutcome[] = [];
  for (const company of companies) {
    outcomes.push(...(await reconcileRecentLeave({ companyId: company.id, from, to })));
  }
  return outcomes;
}

// ------------------------------------------------------------ the conflict

/** One day of approved leave the employee was nonetheless at work. */
export interface AttendanceConflictDay {
  dayKey: string;
  checkInAt: Date;
  checkOutAt: Date | null;
}

/**
 * The days of each APPROVED request that still conflict with attendance:
 * real attendance on a counted leave day that has not been given back.
 *
 * The same tests the reversal applies, so a day listed here is a day a
 * Super Admin's cancellation will actually give back - except the half-day
 * rule, which a person resolving the conflict may override. Weekends and
 * holidays inside a request are not leave days and are never listed.
 */
export async function attendanceConflictsFor(
  leave: ReadonlyArray<{
    id: string;
    companyId: string;
    employeeId: string;
    status: string;
    startDate: Date;
    endDate: Date;
    dayPart: LeaveDayPart;
    reversals?: ReadonlyArray<{ date: Date }>;
  }>,
): Promise<Map<string, AttendanceConflictDay[]>> {
  const result = new Map<string, AttendanceConflictDay[]>();
  const approved = leave.filter((l) => l.status === 'APPROVED');
  if (approved.length === 0) return result;

  // Each request's own employee and dates, so a page of requests spread over
  // a year reads the handful of days they cover and not the year.
  const records = await prisma.attendanceRecord.findMany({
    where: {
      OR: approved.map((l) => ({ employeeId: l.employeeId, date: { gte: l.startDate, lte: l.endDate } })),
      checkInAt: { not: null },
    },
    select: { id: true, employeeId: true, date: true, source: true, status: true, checkInAt: true, checkOutAt: true },
  });
  if (records.length === 0) return result;

  const locations = new Map(
    (
      await prisma.employee.findMany({
        where: { id: { in: [...new Set(records.map((r) => r.employeeId))] } },
        select: { id: true, locationId: true },
      })
    ).map((e) => [e.id, e.locationId]),
  );

  for (const l of approved) {
    const start = dateColumnToDayKey(l.startDate);
    const end = dateColumnToDayKey(l.endDate);
    const reversed = new Set((l.reversals ?? []).map((r) => dateColumnToDayKey(r.date)));
    const days: AttendanceConflictDay[] = [];
    for (const r of records) {
      const key = dateColumnToDayKey(r.date);
      if (r.employeeId !== l.employeeId || key < start || key > end || reversed.has(key)) continue;
      if (!isQualifyingAttendance(r)) continue;
      const counted = await countWorkingDays(l.companyId, locations.get(r.employeeId) ?? null, r.date, r.date, l.dayPart);
      if (counted <= 0) continue;
      days.push({ dayKey: key, checkInAt: r.checkInAt!, checkOutAt: r.checkOutAt });
    }
    if (days.length > 0) result.set(l.id, days.sort((a, b) => a.dayKey.localeCompare(b.dayKey)));
  }
  return result;
}

export interface ConflictCancellation {
  leaveRequestId: string;
  /** The request's status afterwards. */
  status: string;
  restoredDays: number;
  /** Days given back by THIS call. Empty when there was nothing left to do. */
  reversedDayKeys: string[];
  /** True when the call changed nothing: already cancelled or already given back. */
  alreadyResolved: boolean;
}

/**
 * A Super Admin cancels approved leave because the employee attended work.
 *
 * Every conflicting day is given back through `reconcileOne` - the same ledger
 * row, the same unique key, the same balance arithmetic as the automatic path -
 * so this cannot restore a day twice, whether it is clicked twice, raced, or
 * run after reconciliation already did it. The leave request and the
 * attendance records are never deleted; a request with every day given back is
 * CANCELLED with the Super Admin's reason on it.
 */
export async function cancelLeaveForAttendanceConflict(input: {
  companyId: string;
  leaveRequestId: string;
  actor: ManualReversalActor;
}): Promise<ConflictCancellation> {
  const leave = await prisma.leaveRequest.findFirst({
    where: { id: input.leaveRequestId, companyId: input.companyId },
    select: {
      id: true,
      companyId: true,
      employeeId: true,
      status: true,
      startDate: true,
      endDate: true,
      dayPart: true,
      reversals: { select: { date: true } },
    },
  });
  if (!leave) throw new NotFoundError('Leave request');

  const unchanged = (status: string): ConflictCancellation => ({
    leaveRequestId: leave.id,
    status,
    restoredDays: 0,
    reversedDayKeys: [],
    alreadyResolved: true,
  });

  if (leave.status !== 'APPROVED') return unchanged(leave.status);

  const conflicts = (await attendanceConflictsFor([leave])).get(leave.id) ?? [];
  if (conflicts.length === 0) return unchanged(leave.status);

  const outcomes: ReconcileOutcome[] = [];
  for (const day of conflicts) {
    outcomes.push(await reconcileOne(leave.id, day.dayKey, input.actor));
  }

  const reversed = outcomes.filter((o) => o.result === 'REVERSED');
  const after = await prisma.leaveRequest.findUniqueOrThrow({
    where: { id: leave.id },
    select: { status: true },
  });

  return {
    leaveRequestId: leave.id,
    status: after.status,
    restoredDays: round2(reversed.reduce((sum, o) => sum + o.restoredDays, 0)),
    reversedDayKeys: reversed.map((o) => o.dayKey),
    alreadyResolved: reversed.length === 0,
  };
}

