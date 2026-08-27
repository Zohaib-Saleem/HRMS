import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type HolidayRecord,
  holidayInputSchema,
  holidayQuerySchema,
  idParamSchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { toDateOnly } from './leave.service.js';

const INCLUDE = { location: { select: { id: true, name: true } } } satisfies Prisma.HolidayInclude;
type Row = Prisma.HolidayGetPayload<{ include: typeof INCLUDE }>;

function toRecord(row: Row): HolidayRecord {
  return {
    id: row.id,
    name: row.name,
    date: row.date.toISOString().slice(0, 10),
    locationId: row.locationId,
    locationName: row.location?.name ?? null,
    isActive: row.isActive,
  };
}

/**
 * Postgres treats NULLs as distinct, so the unique index cannot stop two
 * company-wide holidays landing on the same date. That case is checked here.
 */
async function assertNoDuplicate(
  companyId: string,
  date: Date,
  locationId: string | null,
  excludeId?: string,
): Promise<void> {
  const clash = await prisma.holiday.findFirst({
    where: {
      companyId,
      date,
      locationId,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    select: { id: true, name: true },
  });

  if (clash) {
    throw new ConflictError(
      `${clash.name} is already recorded for that date and ${locationId ? 'location' : 'all locations'}.`,
    );
  }
}

export const holidayRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.HOLIDAY_READ));

  /**
   * Everyone with holiday.read sees the calendar. Employees are shown only what
   * applies to them - their own location plus company-wide entries - while
   * anyone holding holiday.manage sees every location so it can be maintained.
   */
  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(holidayQuerySchema, request.query);

    const canManage = auth.permissions.has(PERMISSIONS.HOLIDAY_MANAGE);

    let applicability: Prisma.HolidayWhereInput = {};
    if (!canManage) {
      const self = await prisma.employee.findFirst({
        where: { companyId: auth.companyId, userId: auth.userId },
        select: { locationId: true },
      });
      applicability = {
        OR: [{ locationId: null }, ...(self?.locationId ? [{ locationId: self.locationId }] : [])],
      };
    }

    const year = query.year;
    const where: Prisma.HolidayWhereInput = {
      AND: [
        { companyId: auth.companyId },
        applicability,
        query.locationId
          ? query.locationId === 'ALL'
            ? { locationId: null }
            : { locationId: query.locationId }
          : {},
        query.isActive ? { isActive: query.isActive === 'true' } : {},
        year
          ? {
              date: {
                gte: new Date(Date.UTC(year, 0, 1)),
                lte: new Date(Date.UTC(year, 11, 31)),
              },
            }
          : {},
        query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.holiday.count({ where }),
      prisma.holiday.findMany({ where, skip, take, orderBy: { date: 'asc' }, include: INCLUDE }),
    ]);

    return reply.send({
      data: rows.map(toRecord),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.HOLIDAY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(holidayInputSchema, request.body);

      if (input.locationId) {
        const location = await prisma.location.findFirst({
          where: { id: input.locationId, companyId: auth.companyId },
          select: { id: true },
        });
        if (!location) throw new ValidationError({ locationId: ['That location does not exist.'] });
      }

      const date = toDateOnly(input.date);
      await assertNoDuplicate(auth.companyId, date, input.locationId ?? null);

      const created = await prisma.holiday.create({
        data: {
          companyId: auth.companyId,
          name: input.name,
          date,
          locationId: input.locationId ?? null,
          isActive: input.isActive,
        },
        include: INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'holiday.create',
        entityType: 'Holiday',
        entityId: created.id,
        summary: `Created holiday ${created.name} on ${input.date} for ${created.location?.name ?? 'all locations'}`,
        after: input as unknown as Record<string, unknown>,
        request,
      });

      return reply.status(201).send({ data: toRecord(created) });
    },
  );

  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.HOLIDAY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(holidayInputSchema, request.body);

      const before = await prisma.holiday.findFirst({ where: { id, companyId: auth.companyId } });
      if (!before) throw new NotFoundError('Holiday');

      if (input.locationId) {
        const location = await prisma.location.findFirst({
          where: { id: input.locationId, companyId: auth.companyId },
          select: { id: true },
        });
        if (!location) throw new ValidationError({ locationId: ['That location does not exist.'] });
      }

      const date = toDateOnly(input.date);
      await assertNoDuplicate(auth.companyId, date, input.locationId ?? null, id);

      const updated = await prisma.holiday.update({
        where: { id },
        data: {
          name: input.name,
          date,
          locationId: input.locationId ?? null,
          isActive: input.isActive,
        },
        include: INCLUDE,
      });

      const changes = diff(
        before as unknown as Record<string, unknown>,
        { ...input, date } as unknown as Record<string, unknown>,
      );
      if (changes.changed.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'holiday.update',
          entityType: 'Holiday',
          entityId: id,
          summary: `Updated holiday ${updated.name} (${changes.changed.join(', ')})`,
          before: changes.before,
          after: changes.after,
          request,
        });
      }

      return reply.send({ data: toRecord(updated) });
    },
  );

  app.delete(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.HOLIDAY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const existing = await prisma.holiday.findFirst({
        where: { id, companyId: auth.companyId },
        include: INCLUDE,
      });
      if (!existing) throw new NotFoundError('Holiday');

      /*
       * Approved leave stores the working days it was granted for, so removing
       * a holiday cannot retrospectively change anyone's balance. Deleting is
       * therefore safe, and the audit entry keeps the record of what was there.
       */
      await prisma.holiday.delete({ where: { id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'holiday.delete',
        entityType: 'Holiday',
        entityId: id,
        summary: `Deleted holiday ${existing.name} on ${existing.date.toISOString().slice(0, 10)}`,
        before: { name: existing.name, date: existing.date.toISOString().slice(0, 10) },
        request,
      });

      return reply.send({ data: { id } });
    },
  );
};
