import type { AttendancePunchPairing } from '@prisma/client';
import { prisma } from '../../core/db.js';
import { dayKeyToDateColumn } from '../../core/zoned-time.js';
import { computeAttendance, resolvePolicyFor } from '../time/attendance-policy.js';
import { shiftOnDate } from '../time/attendance.service.js';

/**
 * Turning raw punches into attendance.
 *
 * This is the only place device data meets the attendance engine, and it holds
 * exactly one rule of its own: which punch is the arrival and which is the
 * departure. Everything after that - lateness, half days, overtime, weekends,
 * holidays, leave - is the existing engine's job and is not reimplemented here.
 * A punch does not make someone present; the policy decides that.
 */

export interface RecalculationResult {
  employeeId: string;
  dayKey: string;
  /** Null when nothing was written, with the reason recorded below. */
  status: string | null;
  skipped: 'MANUAL_RECORD' | 'NO_USABLE_PUNCH' | null;
}

/**
 * Chooses the arrival and departure from a day's punches.
 *
 * FIRST_IN_LAST_OUT is the default because it is the only rule that is right
 * when a terminal reports no direction at all, which is common. A single punch
 * yields an arrival and no departure: inventing a departure would manufacture
 * worked hours nobody recorded, and the engine already handles a day that is
 * still open.
 */
export function pairPunches(
  punches: ReadonlyArray<{ punchedAt: Date; punchState: string | null }>,
  strategy: AttendancePunchPairing,
): { checkInAt: Date | null; checkOutAt: Date | null } {
  if (punches.length === 0) return { checkInAt: null, checkOutAt: null };

  const ordered = [...punches].sort((a, b) => a.punchedAt.getTime() - b.punchedAt.getTime());

  if (strategy === 'DEVICE_STATE') {
    const ins = ordered.filter((p) => p.punchState === 'IN' || p.punchState === 'OVERTIME_IN');
    const outs = ordered.filter((p) => p.punchState === 'OUT' || p.punchState === 'OVERTIME_OUT');

    // A device configured to report direction, that then reports none, is a
    // configuration problem. Falling back silently would hide it; returning
    // nothing surfaces the day as unresolved instead of inventing times.
    return {
      checkInAt: ins[0]?.punchedAt ?? null,
      checkOutAt: outs.length > 0 ? outs[outs.length - 1]!.punchedAt : null,
    };
  }

  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  return {
    checkInAt: first.punchedAt,
    // One punch is an arrival, not an arrival and a departure at the same
    // instant. Zero worked minutes would otherwise be reported as fact.
    checkOutAt: ordered.length > 1 ? last.punchedAt : null,
  };
}

/**
 * Recalculates one employee-day from its punches.
 *
 * A record an administrator has corrected is never overwritten. The device is
 * the source of raw events; a human decision about what a day means outranks
 * it, and the punches remain underneath either way.
 */
export async function recalculateFromPunches(input: {
  companyId: string;
  employeeId: string;
  dayKey: string;
  pairing: AttendancePunchPairing;
}): Promise<RecalculationResult> {
  const { companyId, employeeId, dayKey, pairing } = input;
  const date = dayKeyToDateColumn(dayKey);

  const [punches, existing] = await Promise.all([
    prisma.attendanceRawPunch.findMany({
      where: { companyId, employeeId, localDayKey: dayKey },
      select: { id: true, punchedAt: true, punchState: true },
      orderBy: { punchedAt: 'asc' },
    }),
    prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId, date } },
      select: { id: true, source: true },
    }),
  ]);

  if (punches.length === 0) {
    return { employeeId, dayKey, status: null, skipped: 'NO_USABLE_PUNCH' };
  }

  // A correction that a device sync could undo is not a correction.
  if (existing && existing.source === 'ADMIN') {
    await markProcessed(punches.map((p) => p.id));
    return { employeeId, dayKey, status: null, skipped: 'MANUAL_RECORD' };
  }

  const { checkInAt, checkOutAt } = pairPunches(punches, pairing);
  if (!checkInAt) {
    await markProcessed(punches.map((p) => p.id));
    return { employeeId, dayKey, status: null, skipped: 'NO_USABLE_PUNCH' };
  }

  const [policy, shift] = await Promise.all([
    resolvePolicyFor(companyId, employeeId, date),
    shiftOnDate(employeeId, date),
  ]);

  const computed = computeAttendance({ day: dayKey, checkInAt, checkOutAt, shift, policy });

  const values = {
    status: computed.status,
    checkInAt,
    checkOutAt,
    workedMinutes: computed.workedMinutes,
    lateMinutes: computed.lateMinutes,
    earlyLeaveMinutes: computed.earlyLeaveMinutes,
    overtimeMinutes: computed.overtimeMinutes,
    shiftId: shift?.id ?? null,
    source: 'DEVICE' as const,
  };

  await prisma.attendanceRecord.upsert({
    where: { employeeId_date: { employeeId, date } },
    create: { companyId, employeeId, date, ...values },
    update: values,
  });

  await markProcessed(punches.map((p) => p.id));
  return { employeeId, dayKey, status: computed.status, skipped: null };
}

async function markProcessed(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.attendanceRawPunch.updateMany({
    where: { id: { in: [...ids] } },
    data: { processedAt: new Date() },
  });
}

/**
 * Recalculates every employee-day a batch of punches touched.
 *
 * Failures are per-day: one employee whose recalculation throws must not stop
 * the rest of a night's import from landing.
 */
export async function recalculateDays(input: {
  companyId: string;
  pairing: AttendancePunchPairing;
  days: ReadonlyArray<{ employeeId: string; dayKey: string }>;
}): Promise<{ recalculated: number; skipped: number; failed: number }> {
  let recalculated = 0;
  let skipped = 0;
  let failed = 0;

  for (const day of input.days) {
    try {
      const result = await recalculateFromPunches({
        companyId: input.companyId,
        employeeId: day.employeeId,
        dayKey: day.dayKey,
        pairing: input.pairing,
      });
      if (result.skipped) skipped += 1;
      else recalculated += 1;
    } catch {
      failed += 1;
    }
  }

  return { recalculated, skipped, failed };
}
