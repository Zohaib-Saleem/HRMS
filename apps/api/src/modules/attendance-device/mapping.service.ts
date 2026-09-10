import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/db.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { dayKeyToDateColumn, dateColumnToDayKey } from '../../core/zoned-time.js';

/**
 * PunchCode (device user / PIN) to employee attribution.
 *
 * This is the one place a punch becomes somebody's. Three rules hold the
 * history together:
 *
 *   - A mapping is a period. `effectiveFrom` null means "since the beginning",
 *     `effectiveTo` null means "still in force". Two mappings of the same PIN
 *     on the same device never overlap, so any day resolves to at most one
 *     employee.
 *   - Raw punches are never edited. The device's own fields - PIN, reading,
 *     instant, direction, verification, fingerprint - are immutable. The only
 *     writable columns are `employeeId`, which is this module's attribution,
 *     and `processedAt`, which says whether that attribution has been scored.
 *   - A correction moves the future, not the past. Re-attribution starts at
 *     the mapping's effective date; punches before it keep the employee they
 *     had. Nothing here recalculates an attendance record: the affected days
 *     are counted and reported, and scoring them is an explicit reprocess.
 */

export interface MappingPeriod {
  deviceUserId: string;
  employeeId: string;
  isActive: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}

const dayOf = (d: Date | null): string | null => (d ? dateColumnToDayKey(d) : null);

/** Whether a mapping period covers a local day. */
export function coversDay(mapping: MappingPeriod, dayKey: string): boolean {
  if (!mapping.isActive) return false;
  const from = dayOf(mapping.effectiveFrom);
  const to = dayOf(mapping.effectiveTo);
  if (from !== null && dayKey < from) return false;
  if (to !== null && dayKey > to) return false;
  return true;
}

/**
 * The employee a PIN belongs to on a given day, from a device's mappings.
 *
 * Pure, so the three ingest paths (poll, push, connector) and the tests all
 * resolve identically. Ties cannot happen when periods do not overlap; if one
 * ever did, the later-starting period wins, which is the newer decision.
 */
export function resolveEmployeeOnDay(
  mappings: readonly MappingPeriod[],
  deviceUserId: string,
  dayKey: string,
): string | null {
  let best: MappingPeriod | null = null;
  for (const m of mappings) {
    if (m.deviceUserId !== deviceUserId || !coversDay(m, dayKey)) continue;
    if (!best) best = m;
    else if ((dayOf(m.effectiveFrom) ?? '') > (dayOf(best.effectiveFrom) ?? '')) best = m;
  }
  return best?.employeeId ?? null;
}

/** What the ingest paths hold: every mapping of a device, resolved per punch. */
export interface MappingResolver {
  resolve(deviceUserId: string, dayKey: string): string | null;
}

export function resolverFor(mappings: readonly MappingPeriod[]): MappingResolver {
  return { resolve: (deviceUserId, dayKey) => resolveEmployeeOnDay(mappings, deviceUserId, dayKey) };
}

/** Loads a device's mappings and returns a resolver over them. */
export async function mappingResolverForDevice(deviceId: string): Promise<MappingResolver> {
  const rows = await prisma.attendanceDeviceUserMapping.findMany({
    where: { deviceId },
    select: {
      deviceUserId: true,
      employeeId: true,
      isActive: true,
      effectiveFrom: true,
      effectiveTo: true,
    },
  });
  return resolverFor(rows);
}

/** Whether two periods share a day. Null bounds are open. */
export function periodsOverlap(
  a: { effectiveFrom: Date | null; effectiveTo: Date | null },
  b: { effectiveFrom: Date | null; effectiveTo: Date | null },
): boolean {
  const aFrom = dayOf(a.effectiveFrom);
  const aTo = dayOf(a.effectiveTo);
  const bFrom = dayOf(b.effectiveFrom);
  const bTo = dayOf(b.effectiveTo);
  const aBeforeB = aTo !== null && bFrom !== null && aTo < bFrom;
  const bBeforeA = bTo !== null && aFrom !== null && bTo < aFrom;
  return !aBeforeB && !bBeforeA;
}

const dayBefore = (date: Date): Date => {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
};

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

export interface SetMappingInput {
  companyId: string;
  deviceId: string;
  deviceUserId: string;
  employeeId: string;
  deviceUserName?: string | null;
  isActive: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  notes?: string | null;
  /** Consent to close another employee's open-ended mapping of the same PIN. */
  closeConflicting: boolean;
}

export interface SetMappingResult {
  id: string;
  reattributedPunches: number;
  affectedDays: number;
  closedMappingId: string | null;
  /** For the audit entry. */
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}

/**
 * Creates or corrects a mapping.
 *
 * The same PIN for the same employee is an edit of the existing period. The
 * same PIN for a different employee over an overlapping period is a conflict,
 * named in full, unless the caller consented to close the other mapping the
 * day before this one begins - and even then only an open-ended one can be
 * closed that way, because an explicitly bounded mapping is a decision
 * someone already made.
 */
export async function setMapping(input: SetMappingInput): Promise<SetMappingResult> {
  const { companyId, deviceId, deviceUserId, employeeId } = input;

  if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    throw new ValidationError({ effectiveTo: ['The end date cannot be before the start date.'] });
  }

  const [device, employee, existing] = await Promise.all([
    prisma.attendanceDevice.findFirst({
      where: { id: deviceId, companyId },
      select: { id: true, name: true },
    }),
    prisma.employee.findFirst({
      where: { id: employeeId, companyId },
      select: { id: true, firstName: true, lastName: true, displayName: true, employeeNumber: true },
    }),
    prisma.attendanceDeviceUserMapping.findMany({
      where: { deviceId, deviceUserId },
      include: {
        employee: {
          select: { id: true, firstName: true, lastName: true, displayName: true, employeeNumber: true },
        },
      },
    }),
  ]);
  if (!device) throw new NotFoundError('Attendance device');
  if (!employee) throw new ValidationError({ employeeId: ['That employee does not exist.'] });

  const period = { effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo };

  // The same person already holds this PIN: this is an edit, not a conflict.
  const own = existing.find((m) => m.employeeId === employeeId && periodsOverlap(m, period));

  const others = existing.filter(
    (m) => m.employeeId !== employeeId && m.isActive && periodsOverlap(m, period),
  );

  let closedMappingId: string | null = null;

  if (others.length > 0) {
    const other = others[0]!;
    const who = `${displayName(other.employee)} (${other.employee.employeeNumber})`;
    const since = dayOf(other.effectiveFrom) ?? 'the beginning';
    const until = dayOf(other.effectiveTo) ?? 'no end date';

    const canTakeOver =
      input.closeConflicting &&
      others.length === 1 &&
      other.effectiveTo === null &&
      input.effectiveFrom !== null &&
      (other.effectiveFrom === null || other.effectiveFrom < input.effectiveFrom);

    if (!canTakeOver) {
      throw new ConflictError(
        `PunchCode ${deviceUserId} on "${device.name}" is already assigned to ${who} from ${since} (${until}). ` +
          (input.effectiveFrom === null
            ? 'Set an effective date to take it over from that day, or end the other mapping first.'
            : other.effectiveTo !== null
              ? 'That mapping has an explicit end date. Edit it first so the two periods do not overlap.'
              : 'Confirm the takeover to close that mapping the day before this one starts.'),
      );
    }

    await prisma.attendanceDeviceUserMapping.update({
      where: { id: other.id },
      data: { effectiveTo: dayBefore(input.effectiveFrom!) },
    });
    closedMappingId = other.id;
  }

  const values = {
    deviceUserName: input.deviceUserName ?? null,
    isActive: input.isActive,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    notes: input.notes ?? null,
  };

  const mapping = own
    ? await prisma.attendanceDeviceUserMapping.update({ where: { id: own.id }, data: values })
    : await prisma.attendanceDeviceUserMapping.create({
        data: { companyId, deviceId, deviceUserId, employeeId, ...values },
      });

  /**
   * Attribution, from the effective date onward.
   *
   * Punches already attributed to this employee are left alone. Punches with
   * no employee, or with the employee whose mapping was just closed, move.
   * Anything before the effective date is history and stays exactly as it is.
   * `processedAt` is cleared on what moved so an explicit reprocess can score
   * it; nothing is recalculated here.
   */
  let reattributedPunches = 0;
  let affectedDays = 0;
  if (input.isActive) {
    const fromKey = input.effectiveFrom ? dateColumnToDayKey(input.effectiveFrom) : null;
    const toKey = input.effectiveTo ? dateColumnToDayKey(input.effectiveTo) : null;

    const where: Prisma.AttendanceRawPunchWhereInput = {
      deviceId,
      deviceUserId,
      ...(fromKey || toKey
        ? { localDayKey: { ...(fromKey ? { gte: fromKey } : {}), ...(toKey ? { lte: toKey } : {}) } }
        : {}),
      OR: [
        { employeeId: null },
        ...(closedMappingId ? [{ employeeId: others[0]!.employeeId }] : []),
      ],
    };

    const moving = await prisma.attendanceRawPunch.findMany({
      where,
      select: { id: true, localDayKey: true },
    });

    if (moving.length > 0) {
      const updated = await prisma.attendanceRawPunch.updateMany({
        where: { id: { in: moving.map((p) => p.id) } },
        // The only two columns this module may ever write on a raw punch.
        data: { employeeId, processedAt: null },
      });
      reattributedPunches = updated.count;
      affectedDays = new Set(moving.map((p) => p.localDayKey)).size;
    }
  }

  const who = `${displayName(employee)} (${employee.employeeNumber})`;
  const summary =
    `Mapped PunchCode ${deviceUserId} on "${device.name}" to ${who}` +
    (input.effectiveFrom ? ` from ${dateColumnToDayKey(input.effectiveFrom)}` : '') +
    (closedMappingId ? `, closing the previous mapping` : '') +
    (reattributedPunches ? `, re-attributing ${reattributedPunches} punch(es) over ${affectedDays} day(s)` : '');

  return {
    id: mapping.id,
    reattributedPunches,
    affectedDays,
    closedMappingId,
    summary,
    before: own
      ? {
          employeeId: own.employeeId,
          isActive: own.isActive,
          effectiveFrom: dayOf(own.effectiveFrom),
          effectiveTo: dayOf(own.effectiveTo),
        }
      : null,
    after: {
      deviceUserId,
      employeeId,
      isActive: input.isActive,
      effectiveFrom: dayOf(input.effectiveFrom),
      effectiveTo: dayOf(input.effectiveTo),
      closedMappingId,
      reattributedPunches,
    },
  };
}

/** Parses an optional date-only input into a `@db.Date` value. */
export function mappingDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  return dayKeyToDateColumn(new Date(value).toISOString().slice(0, 10));
}
