import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type LocationRecord,
  idParamSchema,
  locationInputSchema,
  locationQuerySchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';

const SORTABLE = ['name', 'city', 'createdAt', 'updatedAt'] as const;

const INCLUDE = { _count: { select: { employees: true } } } satisfies Prisma.LocationInclude;

type Row = Prisma.LocationGetPayload<{ include: typeof INCLUDE }>;

function toRecord(row: Row): LocationRecord {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    country: row.country,
    timezone: row.timezone,
    isActive: row.isActive,
    employeeCount: row._count.employees,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const locationRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/',
    { preHandler: requirePermission(PERMISSIONS.LOCATION_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const query = parseOrThrow(locationQuerySchema, request.query);

      const where: Prisma.LocationWhereInput = {
        companyId: auth.companyId,
        ...(query.isActive ? { isActive: query.isActive === 'true' } : {}),
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { city: { contains: query.q, mode: 'insensitive' } },
                { country: { contains: query.q, mode: 'insensitive' } },
                { code: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      };

      const { skip, take } = toSkipTake(query.page, query.limit);
      const [total, rows] = await Promise.all([
        prisma.location.count({ where }),
        prisma.location.findMany({
          where,
          skip,
          take,
          orderBy: buildOrderBy(query.sort, query.order, SORTABLE, 'name'),
          include: INCLUDE,
        }),
      ]);

      return reply.send({
        data: rows.map(toRecord),
        meta: buildMeta(query.page, query.limit, total),
      });
    },
  );

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.LOCATION_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(locationInputSchema, request.body);

      const created = await prisma.location.create({
        data: { ...input, companyId: auth.companyId },
        include: INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'location.create',
        entityType: 'Location',
        entityId: created.id,
        summary: `Created location ${created.name}`,
        after: input as unknown as Record<string, unknown>,
        request,
      });

      return reply.status(201).send({ data: toRecord(created) });
    },
  );

  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.LOCATION_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(locationInputSchema, request.body);

      const before = await prisma.location.findFirst({ where: { id, companyId: auth.companyId } });
      if (!before) throw new NotFoundError('Location');

      const updated = await prisma.location.update({
        where: { id },
        data: input,
        include: INCLUDE,
      });

      const changes = diff(
        before as unknown as Record<string, unknown>,
        input as unknown as Record<string, unknown>,
      );
      if (changes.changed.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'location.update',
          entityType: 'Location',
          entityId: id,
          summary: `Updated location ${updated.name} (${changes.changed.join(', ')})`,
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
    { preHandler: requirePermission(PERMISSIONS.LOCATION_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const existing = await prisma.location.findFirst({
        where: { id, companyId: auth.companyId },
        include: INCLUDE,
      });
      if (!existing) throw new NotFoundError('Location');

      if (existing._count.employees > 0) {
        throw new ConflictError(
          `${existing._count.employees} employee(s) are still assigned to this location. Reassign them first, or deactivate it instead.`,
        );
      }

      await prisma.location.delete({ where: { id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'location.delete',
        entityType: 'Location',
        entityId: id,
        summary: `Deleted location ${existing.name}`,
        before: { name: existing.name },
        request,
      });

      return reply.send({ data: { id } });
    },
  );
};
