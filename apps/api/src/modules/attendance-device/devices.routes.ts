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
  reattributeRangeSchema,
  type DeviceRecord,
  type DeviceSyncRecord,
  type DeviceTestResult,
  type DeviceUserRecord,
  type RawPunchRecord,
  type SyncErrorDetail,
  type ReprocessResult,
  type ReattributeRangeResult,
  type ReattributedDay,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { env } from '../../config/env.js';
import { dayKeyToDateColumn, isValidTimeZone } from '../../core/zoned-time.js';
import { adapterFor, isPollable } from './registry.js';
import { SyncInProgressError, connectionFor, syncDevice } from './sync.service.js';
import { recalculateDays } from './attendance-import.service.js';
import { reattributeDateRange } from './overnight-attribution.js';
import { resolvePolicyFor } from '../time/attendance-policy.js';
import { mappingDate, setMapping } from './mapping.service.js';

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

/**
 * Rejects an allow-list entry that could never match anything.
 *
 * An allow-list is a security control, and a typo in one fails open in the
 * worst way: the administrator believes the device is restricted to a network,
 * while the entry silently matches nothing and the device is simply blocked -
 * or, worse, the list is dropped and everything is allowed. Better to refuse
 * the value than to store a rule nobody can rely on.
 */
function assertUsableCidrs(entries: readonly string[]): void {
  const problems: string[] = [];

  for (const raw of entries) {
    const entry = raw.trim();
    const [address, bitsRaw] = entry.split('/');
    const octets = (address ?? '').split('.');

    const validAddress =
      octets.length === 4 &&
      octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);

    // IPv4 only, matching what ipMatches can actually apply a prefix to. A v6
    // entry would be compared literally and never match a real client.
    if (!validAddress) {
      problems.push(`"${entry}" is not an IPv4 address or range.`);
      continue;
    }

    if (bitsRaw !== undefined) {
      const bits = Number(bitsRaw);
      if (!/^\d{1,2}$/.test(bitsRaw) || !Number.isInteger(bits) || bits < 0 || bits > 32) {
        problems.push(`"${entry}" does not have a prefix length between 0 and 32.`);
      }
    }
  }

  if (problems.length > 0) throw new ValidationError({ allowedPushCidrs: problems });
}

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

type DeviceRow = Prisma.AttendanceDeviceGetPayload<{
  include: {
    location: { select: { name: true } };
    _count: { select: { mappings: true } };
  };
}>;

/**
 * The server address to type into the device.
 *
 * Only built for pushing devices, and only when an origin is configured: a URL
 * pointing at 127.0.0.1 would be worse than none, because it looks like an
 * answer and no terminal on the network can use it.
 *
 * The token appears here and nowhere else. It has to: it is write-only
 * everywhere, so an administrator who cannot read it back has no way to
 * configure the device with it. That is why it is limited to callers holding
 * `device.manage`.
 */
function pushUrlFor(row: DeviceRow, includeToken: boolean): string | null {
  if (row.protocol !== 'ZKTECO_ADMS') return null;
  const origin = env.DEVICE_PUSH_ORIGIN;
  if (!origin) return null;

  const base = origin.replace(/[/]+$/, '');
  if (!row.pushTokenCipher) return `${base}/iclock`;

  // Reading the list is not the same as being allowed to configure a terminal,
  // so the token only comes back to a caller who could set it in the first
  // place. Everyone else sees that a token exists, not what it is.
  if (!includeToken) return null;

  const token = decryptSecret(row.pushTokenCipher);
  return token ? `${base}/iclock/${encodeURIComponent(token)}` : null;
}

/**
 * The base URL a local connector is pointed at.
 *
 * No token in it, and no `canManage` gate either, because the two go together:
 * a connector holds its credential in a config file rather than in a URL, so
 * this string is not a secret and there is nothing here to withhold. Setting
 * the token is still `device.manage`; reading an address is not.
 */
function connectorUrlFor(row: DeviceRow): string | null {
  if (row.protocol !== 'ZKTECO_LAN_CONNECTOR') return null;
  const origin = env.DEVICE_PUSH_ORIGIN;
  if (!origin) return null;
  return `${origin.replace(/[/]+$/, '')}/connector`;
}

function toRecord(row: DeviceRow, canManage: boolean): DeviceRecord {
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
    hasPushToken: row.pushTokenCipher !== null,
    allowedPushCidrs: row.allowedPushCidrs,
    lastPushAt: row.lastPushAt?.toISOString() ?? null,
    pushUrl: pushUrlFor(row, canManage),
    connectorUrl: connectorUrlFor(row),
    connectorVersion: row.connectorVersion,
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
      data: rows.map((row) => toRecord(row, auth.permissions.has(PERMISSIONS.DEVICE_MANAGE))),
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

      const { commKey, pushToken, ...rest } = input;
      assertUsableCidrs(rest.allowedPushCidrs);
      const created = await prisma.attendanceDevice.create({
        data: {
          companyId: auth.companyId,
          ...rest,
          commKeyCipher: commKey ? encryptSecret(commKey) : null,
          pushTokenCipher: pushToken ? encryptSecret(pushToken) : null,
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

      return reply.status(201).send({ data: toRecord(created, true) });
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

      const { commKey, pushToken, ...rest } = input;
      assertUsableCidrs(rest.allowedPushCidrs);
      const updated = await prisma.attendanceDevice.update({
        where: { id },
        data: {
          ...rest,
          // Omitted leaves the stored key alone; explicit null clears it. An
          // edit of the port must not silently drop authentication.
          ...(commKey === undefined
            ? {}
            : { commKeyCipher: commKey === null || commKey === '' ? null : encryptSecret(commKey) }),
          ...(pushToken === undefined
            ? {}
            : {
                pushTokenCipher:
                  pushToken === null || pushToken === '' ? null : encryptSecret(pushToken),
              }),
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
        summary: `Updated device "${updated.name}"${commKey !== undefined ? ' (comm key changed)' : ''}${pushToken !== undefined ? ' (push token changed)' : ''}${changes.changed.length ? ` (${changes.changed.join(', ')})` : ''}`,
        before: changes.before,
        after: changes.after,
        request,
      });

      return reply.send({ data: toRecord(updated, true) });
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
          summary: `Synced "${device.name}": ${outcome.recordsFetched} fetched, ${outcome.recordsImported} new, ${outcome.duplicatesIgnored} duplicate, ${outcome.unmappedRecords} unmapped, ${outcome.errors} error(s)`,
          after: { status: outcome.status, imported: outcome.recordsImported, errors: outcome.errors },
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
      completedAt: row.finishedAt?.toISOString() ?? null,
      status: row.status,
      trigger: row.trigger,
      recordsFetched: row.fetched,
      recordsImported: row.inserted,
      duplicatesIgnored: row.duplicates,
      unmappedRecords: row.unmapped,
      errors: row.rejected,
      attempts: row.attempts,
      cursorBefore: row.cursorFrom?.toISOString() ?? null,
      cursorAfter: row.cursorTo?.toISOString() ?? null,
      error: row.error,
      // Stored as JSON; narrowed here so a malformed column cannot break the
      // whole history screen.
      errorDetails: Array.isArray(row.errorDetails)
        ? (row.errorDetails as unknown as SyncErrorDetail[])
        : [],
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
   *
   * A connector device is never dialled - this server has no route to it, which
   * is the whole point of the protocol - so its roster comes from whatever the
   * connector last reported. That cache is the only thing standing between an
   * administrator and a trip to the terminal to read PINs off its screen, so an
   * empty one says which side is missing rather than showing a bare list.
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
    } else if (device.protocol === 'ZKTECO_LAN_CONNECTOR') {
      const roster = await prisma.attendanceDeviceEnrolledUser.findMany({
        where: { deviceId: id },
        select: { deviceUserId: true, name: true, privilege: true, cardNumber: true },
      });
      deviceUsers = roster;
      if (roster.length === 0) {
        reachable = false;
        error =
          'The connector has not sent this device\u2019s user list yet. Only users already mapped are shown.';
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

  /**
   * Creates or corrects one device-user mapping, nested under its device.
   *
   * The same service the Device User Mapping screen uses, so the two paths
   * cannot drift: effective-dated periods, no two employees on one PunchCode
   * at once, and punches re-attributed only from the effective date onward.
   */
  app.post(
    '/:id/mappings',
    { preHandler: requirePermission(PERMISSIONS.DEVICE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(deviceMappingSchema, request.body);

      const result = await setMapping({
        companyId: auth.companyId,
        deviceId: id,
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
          attributedPunches: result.reattributedPunches,
          reattributedPunches: result.reattributedPunches,
          affectedDays: result.affectedDays,
          closedMappingId: result.closedMappingId,
        },
      });
    },
  );

  /**
   * Retires a mapping.
   *
   * Deactivates rather than deletes. The punches it attributed keep their
   * employee, and the row stays as the record of who held that PunchCode -
   * deleting it would leave attributed punches with nothing behind them.
   */
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

      await prisma.attendanceDeviceUserMapping.update({
        where: { id: mappingId },
        data: { isActive: false },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'device.mapping.disable',
        entityType: 'AttendanceDeviceUserMapping',
        entityId: mappingId,
        summary: `Unmapped device user ${mapping.deviceUserId}`,
        before: { isActive: mapping.isActive },
        after: { isActive: false },
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
        // Where the punch is in the pipeline. UNMAPPED has no employee at all;
        // PENDING has one but has not been scored; PROCESSED has been.
        query.processing === 'UNMAPPED' ? { employeeId: null } : {},
        query.processing === 'PENDING' ? { employeeId: { not: null }, processedAt: null } : {},
        query.processing === 'PROCESSED' ? { processedAt: { not: null } } : {},
        // The company-local day the ingest assigned, not a UTC range: those
        // are the same thing only for a company sitting on the meridian.
        query.day ? { localDayKey: query.day } : {},
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
          device: { select: { name: true, serialNumber: true } },
          employee: {
            select: {
              firstName: true,
              lastName: true,
              displayName: true,
              employeeNumber: true,
            },
          },
          sync: { select: { trigger: true } },
        },
      }),
    ]);

    const data: RawPunchRecord[] = rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      deviceName: row.device.name,
      deviceSerial: row.device.serialNumber,
      deviceUserId: row.deviceUserId,
      employeeId: row.employeeId,
      employeeName: row.employee ? displayName(row.employee) : null,
      employeeNumber: row.employee?.employeeNumber ?? null,
      rawTimestamp: row.rawTimestamp,
      deviceTimeZone: row.deviceTimeZone,
      punchedAt: row.punchedAt.toISOString(),
      localDayKey: row.localDayKey,
      punchState: row.punchState,
      verifyMode: row.verifyMode,
      source: row.sync?.trigger ?? null,
      importedAt: row.importedAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
      processingStatus:
        row.employeeId === null ? 'UNMAPPED' : row.processedAt === null ? 'PENDING' : 'PROCESSED',
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

  /**
   * Re-reads a window of history against the overnight rule.
   *
   * The companion to `/reprocess`, for the opposite problem. Reprocessing
   * rescues punches that were never scored; this one revisits punches that
   * WERE scored, on the wrong side of midnight, because they landed before
   * the rule existed or before the window was set to its present value.
   *
   * Only the days where a punch actually changed sides are rescored. The
   * alternative - re-deriving the range - re-reads days nothing was wrong
   * with under today's policy and quietly restates them, which is a much
   * larger and less honest change than the one being asked for.
   */
  app.post(
    '/reattribute-range',
    { preHandler: requirePermission(PERMISSIONS.DEVICE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(reattributeRangeSchema, request.body ?? {});
      if (input.to < input.from) {
        throw new ValidationError({ to: ['The end of the range is before its start.'] });
      }

      const dryRun = input.dryRun === true;

      /*
       * Pairing comes from a device that actually reported in the range, the
       * same way `/reprocess` takes it: the strategy is a property of the
       * terminal, and reading it from the data keeps the two routes agreeing.
       */
      const sample = await prisma.attendanceRawPunch.findFirst({
        where: {
          companyId: auth.companyId,
          employeeId: input.employeeId ? input.employeeId : { not: null },
          localDayKey: { gte: input.from, lte: input.to },
        },
        select: { device: { select: { punchPairing: true } } },
      });
      const pairing = sample?.device.punchPairing ?? 'FIRST_IN_LAST_OUT';

      const scan = await reattributeDateRange({
        companyId: auth.companyId,
        from: input.from,
        to: input.to,
        employeeId: input.employeeId,
        dryRun,
        settingsFor: async (employeeId, dayKey) => {
          try {
            const policy = await resolvePolicyFor(
              auth.companyId,
              employeeId,
              dayKeyToDateColumn(dayKey),
            );
            return {
              windowMinutes: policy.overnightCheckOutWindowMinutes,
              cutoff: policy.overnightCheckOutCutoff,
              timeZone: policy.timeZone,
              pairing,
              duplicateWindowSeconds: policy.duplicatePunchWindowSeconds,
            };
          } catch {
            // An employee whose policy will not resolve is skipped, not fatal:
            // the rest of the range is still worth fixing.
            return null;
          }
        },
      });

      /*
       * Score exactly the days that changed - both sides of every move, since
       * a punch leaving one day and joining another makes two days wrong.
       */
      const touched = new Map<string, { employeeId: string; dayKey: string }>();
      for (const move of scan.moved) {
        for (const dayKey of [move.fromDayKey, move.toDayKey]) {
          touched.set(`${move.employeeId}:${dayKey}`, { employeeId: move.employeeId, dayKey });
        }
      }

      const outcome =
        dryRun || touched.size === 0
          ? { recalculated: 0, skipped: 0, failed: 0 }
          : await recalculateDays({
              companyId: auth.companyId,
              pairing,
              days: [...touched.values()],
            });

      const names = new Map(
        (
          await prisma.employee.findMany({
            where: { companyId: auth.companyId, id: { in: [...new Set(scan.moved.map((m) => m.employeeId))] } },
            select: { id: true, firstName: true, lastName: true, displayName: true },
          })
        ).map((e) => [e.id, displayName(e)]),
      );

      const moved: ReattributedDay[] = scan.moved.map((move) => ({
        employeeId: move.employeeId,
        employeeName: names.get(move.employeeId) ?? null,
        fromDayKey: move.fromDayKey,
        toDayKey: move.toDayKey,
        punchesMoved: move.punchesMoved,
      }));

      if (!dryRun && scan.moved.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'device.punches.reattribute',
          entityType: 'AttendanceRawPunch',
          entityId: `${input.from}..${input.to}`,
          summary: `Overnight re-attribution ${input.from} to ${input.to}: ${scan.moved.length} day(s) moved, ${outcome.recalculated} day(s) rescored`,
          request,
        });
      }

      const result: ReattributeRangeResult = {
        dryRun,
        employeesScanned: scan.employeesScanned,
        daysScanned: scan.daysScanned,
        moved,
        daysRecalculated: outcome.recalculated,
        daysSkipped: outcome.skipped,
        daysFailed: outcome.failed,
      };

      return reply.send({ data: result });
    },
  );
};
