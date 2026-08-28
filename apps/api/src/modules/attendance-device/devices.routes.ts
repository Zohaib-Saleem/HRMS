import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  deviceInputSchema,
  deviceMappingSchema,
  idParamSchema,
  paginationQuerySchema,
  punchQuerySchema,
  reprocessSchema,
  type DeviceRecord,
  type DeviceSyncRecord,
  type DeviceTestResult,
  type DeviceUserRecord,
  type RawPunchRecord,
  type ReprocessResult,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { encryptSecret } from '../../core/secrets.js';
import { isValidTimeZone } from '../../core/zoned-time.js';
import { adapterFor, isPollable } from './registry.js';
import { SyncInProgressError, connectionFor, syncDevice } from './sync.service.js';
import { recalculateDays } from './attendance-import.service.js';

/**
 * Attendance terminal management.
 *
 * Everything here is behind `device.read` / `device.manage`, which only the
 * administrator roles hold. A terminal's address is a piece of network
 * infrastructure and its punch log is other people's movements, so neither is
 * readable through the ordinary attendance permissions.
 *
 * The comm key is write-only throughout: it goes in encrypted and never comes
 * back out, and no endpoint returns it in any form.
 */

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

type DeviceRow = Prisma.AttendanceDeviceGetPayload<{
  include: {
    location: { select: { name: true } };
    _count: { select: { mappings: true } };
  };
}>;

function toRecord(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    serialNumber: row.serialNumber,
    timeZone: row.timeZone,
    locationId: row.locationId,
    locationName: row.location?.name ?? null,
    isEnabled: row.isEnabled,
    syncIntervalMinutes: row.syncIntervalMinutes,
    punchPairing: row.punchPairing,
    status: row.status,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastPunchAt: row.lastPunchAt?.toISOString() ?? null,
    lastError: row.lastError,
    syncCursorAt: row.syncCursorAt?.toISOString() ?? null,
    isSyncing: row.syncLockedAt !== null,
    // Whether one is set, never what it is.
    hasCommKey: row.commKeyCipher !== null,
    mappedUsers: row._count.mappings,
    createdAt: row.createdAt.toISOString(),
  };
}

const INCLUDE = {
  location: { select: { name: true } },
  _count: { select: { mappings: true } },
} satisfies Prisma.AttendanceDeviceInclude;

export const attendanceDeviceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.DEVICE_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(paginationQuerySchema, request.query);

    const where: Prisma.AttendanceDeviceWhereInput = {
      companyId: auth.companyId,
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.attendanceDevice.count({ where }),
      prisma.attendanceDevice.findMany({
        where,
        skip,
        take,
        orderBy: { name: 'asc' },
        include: INCLUDE,
      }),
    ]);

    return reply.send({
      data: rows.map(toRecord),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.DEVICE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(deviceInputSchema, request.body);

      if (!isValidTimeZone(input.timeZone)) {
        throw new ValidationError({ timeZone: ['That is not a timezone this server recognises.'] });
      }

      const duplicate = await prisma.attendanceDevice.findFirst({
        where: { companyId: auth.companyId, name: input.name },
        select: { id: true },
      });
      if (duplicate) throw new ConflictError('A device with that name already exists.');

      const { commKey, ...rest } = input;
      const created = await prisma.attendanceDevice.create({
        data: {
          companyId: auth.companyId,
          ...rest,
          commKeyCipher: commKey ? encryptSecret(commKey) : null,
        },
        include: INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'device.create',
        entityType: 'AttendanceDevice',
        entityId: created.id,
        summary: `Added attendance device "${created.name}" at ${created.host}:${created.port}`,
        // Deliberately excludes the comm key.
        after: { name: created.name, host: created.host, port: created.port, protocol: created.protocol },
        request,
      });

      return reply.status(201).send({ data: toRecord(created) });
    },
  );

  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.DEVICE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(deviceInputSchema, request.body);

      if (!isValidTimeZone(input.timeZone)) {
        throw new ValidationError({ timeZone: ['That is not a timezone this server recognises.'] });
      }

      const before = await prisma.attendanceDevice.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!before) throw new NotFoundError('Attendance device');

      const clash = await prisma.attendanceDevice.findFirst({
        where: { companyId: auth.companyId, name: input.name, NOT: { id } },
        select: { id: true },
      });
      if (clash) throw new ConflictError('A device with that name already exists.');

      const { commKey, ...rest } = input;
      const updated = await prisma.attendanceDevice.update({
        where: { id },
        data: {
          ...rest,
          // Omitted leaves the stored key alone; explicit null clears it. An
          // edit of the port must not silently drop authentication.
          ...(commKey === undefined
            ? {}
            : { commKeyCipher: commKey === null || commKey === '' ? null : encryptSecret(commKey) }),
        },
        include: INCLUDE,
      });

      const changes = diff(
        before as unknown as Record<string, unknown>,
        rest as unknown as Record<string, unknown>,
      );

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'device.update',
        entityType: 'AttendanceDevice',
        entityId: id,
        summary: `Updated device "${updated.name}"${commKey !== undefined ? ' (comm key changed)' : ''}${changes.changed.length ? ` (${changes.changed.join(', ')})` : ''}`,
        before: changes.before,
        after: changes.after,
        request,
      });

      return reply.send({ data: toRecord(updated) });
    },
  );

  app.delete(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.DEVICE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const device = await prisma.attendanceDevice.findFirst({
        where: { id, companyId: auth.companyId },
        include: { _count: { select: { punches: true } } },
      });
      if (!device) throw new NotFoundError('Attendance device');

      // Punches are HR evidence. Removing a terminal must not erase what it
      // recorded, so a device that has reported anything is disabled instead.
      if (device._count.punches > 0) {
        throw new ConflictError(
          `That device has recorded ${device._count.punches} punch(es). Disable it instead - removing it would delete attendance evidence.`,
        );
      }

      await prisma.attendanceDevice.delete({ where: { id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'device.delete',
        entityType: 'AttendanceDevice',
        entityId: id,
        summary: `Removed attendance device "${device.name}"`,
        request,
      });

      return reply.send({ data: { id } });
    },
  );

  /** Actually opens a connection. Never reports success from configuration. */
  app.post(
    '/:id/test',
    { preHandler: requirePermission(PERMISSIONS.DEVICE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const device = await prisma.attendanceDevice.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!device) throw new NotFoundError('Attendance device');

      if (!isPollable(device.protocol)) {
        throw new ValidationError({
          protocol: ['ADMS devices push to this server; there is nothing to connect to.'],
        });
      }

      const outcome = await adapterFor(device.protocol).testConnection(connectionFor(device));

      await prisma.attendanceDevice.update({
        where: { id },
        data: {
          status: outcome.reachable ? 'ONLINE' : 'OFFLINE',
          lastError: outcome.error,
          ...(outcome.reachable ? { lastSeenAt: new Date() } : {}),
          // A device that names itself is worth recording.
          ...(outcome.info?.serialNumber && !device.serialNumber
            ? { serialNumber: outcome.info.serialNumber }
            : {}),
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'device.test',
        entityType: 'AttendanceDevice',
        entityId: id,
        summary: outcome.reachable
          ? `Connection test to "${device.name}" succeeded in ${outcome.latencyMs}ms`
          : `Connection test to "${device.name}" failed: ${outcome.error}`,
        request,
      });

      const result: DeviceTestResult = {
        reachable: outcome.reachable,
        latencyMs: outcome.latencyMs,
        serialNumber: outcome.info?.serialNumber ?? null,
        deviceName: outcome.info?.deviceName ?? null,
        firmwareVersion: outcome.info?.firmwareVersion ?? null,
        platform: outcome.info?.platform ?? null,
        userCount: outcome.info?.userCount ?? null,
        transactionCount: outcome.info?.transactionCount ?? null,
        error: outcome.error,
      };

      return reply.send({ data: result });
    },
  );

  app.post(
    '/:id/sync',
    { preHandler: requirePermission(PERMISSIONS.DEVICE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const device = await prisma.attendanceDevice.findFirst({
        where: { id, companyId: auth.companyId },
        select: { id: true, name: true },
      });
      if (!device) throw new NotFoundError('Attendance device');

      try {
        const outcome = await syncDevice(id, 'MANUAL');

        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'device.sync',
          entityType: 'AttendanceDevice',
          entityId: id,
          summary: `Synced "${device.name}": ${outcome.fetched} fetched, ${outcome.inserted} new, ${outcome.duplicates} duplicate, ${outcome.unmapped} unmapped`,
          after: { status: outcome.status, inserted: outcome.inserted },
          request,
        });

        return reply.send({ data: outcome });
      } catch (error) {
        if (error instanceof SyncInProgressError) throw new ConflictError(error.message);
        throw error;
      }
    },
  );

  app.get('/:id/sync-history', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const query = parseOrThrow(paginationQuerySchema, request.query);

    const device = await prisma.attendanceDevice.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true, name: true },
    });
    if (!device) throw new NotFoundError('Attendance device');

    const { skip, take } = toSkipTake(query.page, query.limit);
    const where = { deviceId: id };

    const [total, rows] = await Promise.all([
      prisma.attendanceDeviceSync.count({ where }),
      prisma.attendanceDeviceSync.findMany({
        where,
        skip,
        take,
        orderBy: { startedAt: 'desc' },
      }),
    ]);

    const data: DeviceSyncRecord[] = rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      deviceName: device.name,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      status: row.status,
      trigger: row.trigger,
      fetched: row.fetched,
      inserted: row.inserted,
      duplicates: row.duplicates,
      unmapped: row.unmapped,
      rejected: row.rejected,
      cursorFrom: row.cursorFrom?.toISOString() ?? null,
      cursorTo: row.cursorTo?.toISOString() ?? null,
      error: row.error,
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  /**
   * Users held on the device, joined to their mappings.
   *
   * Reads the terminal when it can be reached, and falls back to the mappings
   * already stored when it cannot, so the screen still works while a device is
   * offline. Nothing here creates an employee: an unknown biometric user is
   * shown as unmapped and waits for a person to decide.
   */
  app.get('/:id/users', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const device = await prisma.attendanceDevice.findFirst({
      where: { id, companyId: auth.companyId },
    });
    if (!device) throw new NotFoundError('Attendance device');

    const mappings = await prisma.attendanceDeviceUserMapping.findMany({
      where: { deviceId: id },
      include: {
        employee: {
          select: { id: true, firstName: true, lastName: true, displayName: true, status: true },
        },
      },
    });
    const byDeviceUser = new Map(mappings.map((m) => [m.deviceUserId, m]));

    let deviceUsers: Array<{ deviceUserId: string; name: string | null; privilege: number | null; cardNumber: string | null }> = [];
    let reachable = true;
    let error: string | null = null;

    if (isPollable(device.protocol)) {
      try {
        deviceUsers = await adapterFor(device.protocol).getUsers(connectionFor(device));
      } catch (err) {
        reachable = false;
        error = err instanceof Error ? err.message : 'The device could not be reached.';
      }
    }

    // Anything mapped but not returned by the device still belongs on screen.
    const seen = new Set(deviceUsers.map((u) => u.deviceUserId));
    for (const mapping of mappings) {
      if (!seen.has(mapping.deviceUserId)) {
        deviceUsers.push({
          deviceUserId: mapping.deviceUserId,
          name: mapping.deviceUserName,
          privilege: null,
          cardNumber: null,
        });
      }
    }

    const data: DeviceUserRecord[] = deviceUsers
      .sort((a, b) => a.deviceUserId.localeCompare(b.deviceUserId, undefined, { numeric: true }))
      .map((user) => {
        const mapping = byDeviceUser.get(user.deviceUserId);
        return {
          deviceUserId: user.deviceUserId,
          name: user.name ?? mapping?.deviceUserName ?? null,
          privilege: user.privilege,
          cardNumber: user.cardNumber,
          employeeId: mapping?.employeeId ?? null,
          employeeName: mapping ? displayName(mapping.employee) : null,
          employeeInactive: mapping ? mapping.employee.status === 'TERMINATED' : false,
          mappingId: mapping?.id ?? null,
        };
      });

    return reply.send({ data, meta: { reachable, error } });
  });

  /** Creates or updates one device-user mapping. */
  app.post(
    '/:id/mappings',
    { preHandler: requirePermission(PERMISSIONS.DEVICE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(deviceMappingSchema, request.body);

      const [device, employee] = await Promise.all([
        prisma.attendanceDevice.findFirst({
          where: { id, companyId: auth.companyId },
          select: { id: true, name: true },
        }),
        prisma.employee.findFirst({
          where: { id: input.employeeId, companyId: auth.companyId },
          select: { id: true, firstName: true, lastName: true, displayName: true },
        }),
      ]);
      if (!device) throw new NotFoundError('Attendance device');
      if (!employee) throw new ValidationError({ employeeId: ['That employee does not exist.'] });

      const mapping = await prisma.attendanceDeviceUserMapping.upsert({
        where: { deviceId_deviceUserId: { deviceId: id, deviceUserId: input.deviceUserId } },
        create: {
          companyId: auth.companyId,
          deviceId: id,
          deviceUserId: input.deviceUserId,
          deviceUserName: input.deviceUserName ?? null,
          employeeId: input.employeeId,
          isActive: input.isActive,
        },
        update: {
          employeeId: input.employeeId,
          deviceUserName: input.deviceUserName ?? null,
          isActive: input.isActive,
        },
      });

      // Attribute anything already imported under this device user, so a
      // mapping added after the fact rescues the punches rather than leaving
      // them stranded.
      const attributed = await prisma.attendanceRawPunch.updateMany({
        where: { deviceId: id, deviceUserId: input.deviceUserId, employeeId: null },
        data: { employeeId: input.employeeId },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'device.mapping.set',
        entityType: 'AttendanceDeviceUserMapping',
        entityId: mapping.id,
        summary: `Mapped device user ${input.deviceUserId} on "${device.name}" to ${displayName(employee)}${attributed.count ? `, attributing ${attributed.count} existing punch(es)` : ''}`,
        after: { deviceUserId: input.deviceUserId, employeeId: input.employeeId },
        request,
      });

      return reply.status(201).send({
        data: { id: mapping.id, attributedPunches: attributed.count },
      });
    },
  );

  app.delete(
    '/:id/mappings/:mappingId',
    { preHandler: requirePermission(PERMISSIONS.DEVICE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const mappingId = String((request.params as Record<string, string>).mappingId ?? '');

      const mapping = await prisma.attendanceDeviceUserMapping.findFirst({
        where: { id: mappingId, deviceId: id, companyId: auth.companyId },
      });
      if (!mapping) throw new NotFoundError('Device user mapping');

      await prisma.attendanceDeviceUserMapping.delete({ where: { id: mappingId } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'device.mapping.remove',
        entityType: 'AttendanceDeviceUserMapping',
        entityId: mappingId,
        summary: `Unmapped device user ${mapping.deviceUserId}`,
        request,
      });

      return reply.send({ data: { id: mappingId } });
    },
  );
};

/** Raw punches, mounted separately so the path reads as attendance data. */
export const attendancePunchRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.DEVICE_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(punchQuerySchema, request.query);

    const where: Prisma.AttendanceRawPunchWhereInput = {
      AND: [
        { companyId: auth.companyId },
        query.deviceId ? { deviceId: query.deviceId } : {},
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.unmappedOnly === 'true' ? { employeeId: null } : {},
        query.from ? { punchedAt: { gte: new Date(query.from) } } : {},
        query.to ? { punchedAt: { lte: new Date(query.to) } } : {},
        query.q ? { deviceUserId: { contains: query.q, mode: 'insensitive' } } : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.attendanceRawPunch.count({ where }),
      prisma.attendanceRawPunch.findMany({
        where,
        skip,
        take,
        orderBy: { punchedAt: 'desc' },
        include: {
          device: { select: { name: true } },
          employee: { select: { firstName: true, lastName: true, displayName: true } },
        },
      }),
    ]);

    const data: RawPunchRecord[] = rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      deviceName: row.device.name,
      deviceUserId: row.deviceUserId,
      employeeId: row.employeeId,
      employeeName: row.employee ? displayName(row.employee) : null,
      rawTimestamp: row.rawTimestamp,
      deviceTimeZone: row.deviceTimeZone,
      punchedAt: row.punchedAt.toISOString(),
      localDayKey: row.localDayKey,
      punchState: row.punchState,
      verifyMode: row.verifyMode,
      importedAt: row.importedAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  /**
   * Re-runs the attendance calculation over punches that now have an employee.
   *
   * The step that makes mapping a fix rather than a note: once an unmapped
   * punch is attributed, its days still need scoring.
   */
  app.post(
    '/reprocess',
    { preHandler: requirePermission(PERMISSIONS.DEVICE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(reprocessSchema, request.body ?? {});

      const punches = await prisma.attendanceRawPunch.findMany({
        where: {
          companyId: auth.companyId,
          employeeId: input.employeeId ? input.employeeId : { not: null },
          ...(input.deviceId ? { deviceId: input.deviceId } : {}),
          processedAt: null,
        },
        select: { employeeId: true, localDayKey: true, device: { select: { punchPairing: true } } },
      });

      const days = new Map<string, { employeeId: string; dayKey: string }>();
      for (const punch of punches) {
        if (!punch.employeeId) continue;
        days.set(`${punch.employeeId}:${punch.localDayKey}`, {
          employeeId: punch.employeeId,
          dayKey: punch.localDayKey,
        });
      }

      const pairing = punches[0]?.device.punchPairing ?? 'FIRST_IN_LAST_OUT';
      const outcome = await recalculateDays({
        companyId: auth.companyId,
        pairing,
        days: [...days.values()],
      });

      if (outcome.recalculated > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'device.punches.reprocess',
          entityType: 'AttendanceRawPunch',
          entityId: input.deviceId ?? 'all',
          summary: `Reprocessed device punches: ${outcome.recalculated} day(s) recalculated`,
          request,
        });
      }

      const result: ReprocessResult = {
        punchesConsidered: punches.length,
        daysRecalculated: outcome.recalculated,
        daysSkipped: outcome.skipped,
        daysFailed: outcome.failed,
      };

      return reply.send({ data: result });
    },
  );
};
