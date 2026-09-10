import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  deviceMappingCreateSchema,
  deviceMappingHistoryQuerySchema,
  deviceMappingQuerySchema,
  deviceMappingUpdateSchema,
  type DeviceMappingHistoryEntry,
  type DeviceMappingRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { dateColumnToDayKey, todayInZone } from '../../core/zoned-time.js';
import { resolveAttendancePolicy } from '../time/attendance-policy.js';
import { coversDay, mappingDate, periodsOverlap, setMapping } from './mapping.service.js';

/**
 * Device User Mapping management.
 *
 * Settings -> Attendance -> Device User Mapping. One screen, one question:
 * which employee does PunchCode 42 on this terminal belong to, and since when?
 *
 * Everything that makes this safe lives in `mapping.service`: periods that
 * cannot overlap, a correction that moves the future rather than the past, and
 * raw punches whose only writable columns are the attribution and the
 * processed flag. These routes are the permission gate, the audit trail and
 * the shape of the reply.
 */

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

const dayOf = (d: Date | null): string | null => (d ? dateColumnToDayKey(d) : null);

const MAPPING_INCLUDE = {
  device: { select: { id: true, name: true, serialNumber: true } },
  employee: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      displayName: true,
      employeeNumber: true,
    },
  },
} as const;

type MappingRow = Prisma.AttendanceDeviceUserMappingGetPayload<{ include: typeof MAPPING_INCLUDE }>;

function toRecord(row: MappingRow, todayKey: string, punchCount: number): DeviceMappingRecord {
  return {
    id: row.id,
    deviceId: row.deviceId,
    deviceName: row.device.name,
    deviceSerial: row.device.serialNumber,
    deviceUserId: row.deviceUserId,
    deviceUserName: row.deviceUserName,
    employeeId: row.employeeId,
    employeeName: displayName(row.employee),
    employeeNumber: row.employee.employeeNumber,
    isActive: row.isActive,
    effectiveFrom: dayOf(row.effectiveFrom),
    effectiveTo: dayOf(row.effectiveTo),
    notes: row.notes,
    isCurrent: coversDay(row, todayKey),
    punchCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const deviceMappingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.DEVICE_READ));

  /**
   * Every mapping, current and historical.
   *
   * Inactive and closed mappings are included on request rather than by
   * default: they are the audit trail of who held a PIN before, and hiding
   * them would make a correction look like a deletion.
   */
  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(deviceMappingQuerySchema, request.query);

    const where: Prisma.AttendanceDeviceUserMappingWhereInput = {
      AND: [
        { companyId: auth.companyId },
        query.deviceId ? { deviceId: query.deviceId } : {},
        query.deviceUserId ? { deviceUserId: query.deviceUserId } : {},
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.includeInactive === 'true' ? {} : { isActive: true },
      ],
    };

    const [rows, policy] = await Promise.all([
      prisma.attendanceDeviceUserMapping.findMany({
        where,
        include: MAPPING_INCLUDE,
        orderBy: [{ deviceId: 'asc' }, { deviceUserId: 'asc' }, { effectiveFrom: 'desc' }],
        take: 2000,
      }),
      resolveAttendancePolicy(auth.companyId),
    ]);

    // One grouped count rather than a query per row: a company with a thousand
    // mappings would otherwise open a thousand connections to fill a column.
    const counts = await prisma.attendanceRawPunch.groupBy({
      by: ['deviceId', 'deviceUserId', 'employeeId'],
      where: {
        companyId: auth.companyId,
        deviceId: { in: [...new Set(rows.map((r) => r.deviceId))] },
      },
      _count: { _all: true },
    });
    const countKey = (deviceId: string, deviceUserId: string, employeeId: string) =>
      `${deviceId}|${deviceUserId}|${employeeId}`;
    const countBy = new Map(
      counts
        .filter((c) => c.employeeId !== null)
        .map((c) => [countKey(c.deviceId, c.deviceUserId, c.employeeId!), c._count._all]),
    );

    const todayKey = todayInZone(policy.timeZone);
    const data = rows.map((row) =>
      toRecord(
        row,
        todayKey,
        countBy.get(countKey(row.deviceId, row.deviceUserId, row.employeeId)) ?? 0,
      ),
    );

    return reply.send({ data });
  });

  /**
   * Every mapping change, from the audit log.
   *
   * "View history" on the screen. Reading the audit trail rather than keeping
   * a private copy means the history panel and the audit log can never tell
   * two different stories about the same change.
   */
  app.get('/history', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(deviceMappingHistoryQuerySchema, request.query);

    // Narrowed to the mappings that match, so "history for PunchCode 42"
    // does not return the whole company's mapping trail.
    const ids =
      query.deviceId || query.deviceUserId || query.employeeId
        ? (
            await prisma.attendanceDeviceUserMapping.findMany({
              where: {
                companyId: auth.companyId,
                ...(query.deviceId ? { deviceId: query.deviceId } : {}),
                ...(query.deviceUserId ? { deviceUserId: query.deviceUserId } : {}),
                ...(query.employeeId ? { employeeId: query.employeeId } : {}),
              },
              select: { id: true },
            })
          ).map((m) => m.id)
        : null;

    const rows = await prisma.auditLog.findMany({
      where: {
        companyId: auth.companyId,
        entityType: 'AttendanceDeviceUserMapping',
        ...(ids ? { entityId: { in: ids } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: {
        actor: {
          select: {
            email: true,
            employee: { select: { firstName: true, lastName: true, displayName: true } },
          },
        },
      },
    });

    const data: DeviceMappingHistoryEntry[] = rows.map((row) => ({
      id: row.id,
      action: row.action,
      summary: row.summary,
      actorName: row.actor
        ? row.actor.employee
          ? displayName(row.actor.employee)
          : row.actor.email
        : null,
      before: (row.before ?? null) as Record<string, unknown> | null,
      after: (row.after ?? null) as Record<string, unknown> | null,
      createdAt: row.createdAt.toISOString(),
    }));

    return reply.send({ data });
  });

  /**
   * Adds or corrects a mapping.
   *
   * The conflict rule lives in the service and is deliberately loud: the same
   * PunchCode on the same device cannot belong to two employees over the same
   * dates, and taking one over requires explicit consent plus a start date.
   */
  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.DEVICE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(deviceMappingCreateSchema, request.body);

      const result = await setMapping({
        companyId: auth.companyId,
        deviceId: input.deviceId,
        deviceUserId: input.deviceUserId,
        employeeId: input.employeeId,
        deviceUserName: input.deviceUserName ?? null,
        isActive: input.isActive,
        effectiveFrom: mappingDate(input.effectiveFrom),
        effectiveTo: mappingDate(input.effectiveTo),
        notes: input.notes ?? null,
        closeConflicting: input.closeConflicting,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: result.before ? 'device.mapping.correct' : 'device.mapping.set',
        entityType: 'AttendanceDeviceUserMapping',
        entityId: result.id,
        summary: result.summary,
        before: result.before ?? undefined,
        after: result.after,
        request,
      });

      return reply.status(201).send({
        data: {
          id: result.id,
          reattributedPunches: result.reattributedPunches,
          affectedDays: result.affectedDays,
          closedMappingId: result.closedMappingId,
        },
      });
    },
  );

  /**
   * Edits an existing mapping's period, name, notes or active flag.
   *
   * The PunchCode and the employee are deliberately not editable here: moving
   * a PIN to a different person is a new mapping with its own effective date,
   * which is what keeps the old employee's punches theirs.
   */
  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.DEVICE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const id = String((request.params as Record<string, string>).id ?? '');
      const input = parseOrThrow(deviceMappingUpdateSchema, request.body);

      const existing = await prisma.attendanceDeviceUserMapping.findFirst({
        where: { id, companyId: auth.companyId },
        include: MAPPING_INCLUDE,
      });
      if (!existing) throw new NotFoundError('Device user mapping');

      const effectiveFrom =
        input.effectiveFrom === undefined
          ? existing.effectiveFrom
          : mappingDate(input.effectiveFrom);
      const effectiveTo =
        input.effectiveTo === undefined ? existing.effectiveTo : mappingDate(input.effectiveTo);

      if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
        throw new ValidationError({ effectiveTo: ['The end date cannot be before the start date.'] });
      }

      const isActive = input.isActive ?? existing.isActive;

      // Re-dating a mapping can walk it into another employee's period. The
      // same rule as creation applies, checked against the new dates.
      if (isActive) {
        const siblings = await prisma.attendanceDeviceUserMapping.findMany({
          where: {
            deviceId: existing.deviceId,
            deviceUserId: existing.deviceUserId,
            isActive: true,
            id: { not: existing.id },
          },
          include: MAPPING_INCLUDE,
        });
        const clash = siblings.find(
          (s) =>
            s.employeeId !== existing.employeeId && periodsOverlap(s, { effectiveFrom, effectiveTo }),
        );
        if (clash) {
          throw new ValidationError({
            effectiveFrom: [
              `Those dates overlap ${displayName(clash.employee)} (${clash.employee.employeeNumber}), who holds PunchCode ${existing.deviceUserId} from ${dayOf(clash.effectiveFrom) ?? 'the beginning'} to ${dayOf(clash.effectiveTo) ?? 'no end date'}.`,
            ],
          });
        }
      }

      const updated = await prisma.attendanceDeviceUserMapping.update({
        where: { id: existing.id },
        data: {
          isActive,
          effectiveFrom,
          effectiveTo,
          deviceUserName:
            input.deviceUserName === undefined ? existing.deviceUserName : input.deviceUserName,
          notes: input.notes === undefined ? existing.notes : input.notes,
        },
        include: MAPPING_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'device.mapping.update',
        entityType: 'AttendanceDeviceUserMapping',
        entityId: updated.id,
        summary: `Updated the mapping of PunchCode ${updated.deviceUserId} on "${updated.device.name}" for ${displayName(updated.employee)}`,
        before: {
          isActive: existing.isActive,
          effectiveFrom: dayOf(existing.effectiveFrom),
          effectiveTo: dayOf(existing.effectiveTo),
          deviceUserName: existing.deviceUserName,
          notes: existing.notes,
        },
        after: {
          isActive: updated.isActive,
          effectiveFrom: dayOf(updated.effectiveFrom),
          effectiveTo: dayOf(updated.effectiveTo),
          deviceUserName: updated.deviceUserName,
          notes: updated.notes,
        },
        request,
      });

      const policy = await resolveAttendancePolicy(auth.companyId);
      return reply.send({ data: toRecord(updated, todayInZone(policy.timeZone), 0) });
    },
  );

  /**
   * Disables a mapping.
   *
   * Deliberately not a delete. The punches attributed under it stay attributed
   * and the row stays readable, so the history of who held the PIN survives.
   * Deleting would leave the attribution with nothing behind it.
   */
  app.post(
    '/:id/disable',
    { preHandler: requirePermission(PERMISSIONS.DEVICE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const id = String((request.params as Record<string, string>).id ?? '');

      const existing = await prisma.attendanceDeviceUserMapping.findFirst({
        where: { id, companyId: auth.companyId },
        include: MAPPING_INCLUDE,
      });
      if (!existing) throw new NotFoundError('Device user mapping');

      const updated = await prisma.attendanceDeviceUserMapping.update({
        where: { id: existing.id },
        data: { isActive: false },
        include: MAPPING_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'device.mapping.disable',
        entityType: 'AttendanceDeviceUserMapping',
        entityId: updated.id,
        summary: `Disabled the mapping of PunchCode ${updated.deviceUserId} on "${updated.device.name}" to ${displayName(updated.employee)}`,
        before: { isActive: true },
        after: { isActive: false },
        request,
      });

      const policy = await resolveAttendancePolicy(auth.companyId);
      return reply.send({ data: toRecord(updated, todayInZone(policy.timeZone), 0) });
    },
  );
};
