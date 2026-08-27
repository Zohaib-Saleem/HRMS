import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type DesignationRecord,
  designationInputSchema,
  designationQuerySchema,
  idParamSchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';

const SORTABLE = ['name', 'code', 'createdAt', 'updatedAt'] as const;

const INCLUDE = { _count: { select: { employees: true } } } satisfies Prisma.DesignationInclude;

type Row = Prisma.DesignationGetPayload<{ include: typeof INCLUDE }>;

function toRecord(row: Row): DesignationRecord {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    isActive: row.isActive,
    employeeCount: row._count.employees,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const designationRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/',
    { preHandler: requirePermission(PERMISSIONS.DESIGNATION_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const query = parseOrThrow(designationQuerySchema, request.query);

      const where: Prisma.DesignationWhereInput = {
        companyId: auth.companyId,
        ...(query.isActive ? { isActive: query.isActive === 'true' } : {}),
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { code: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      };

      const { skip, take } = toSkipTake(query.page, query.limit);
      const [total, rows] = await Promise.all([
        prisma.designation.count({ where }),
        prisma.designation.findMany({
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
    { preHandler: requirePermission(PERMISSIONS.DESIGNATION_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(designationInputSchema, request.body);

      const created = await prisma.designation.create({
        data: { ...input, companyId: auth.companyId },
        include: INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'designation.create',
        entityType: 'Designation',
        entityId: created.id,
        summary: `Created designation ${created.name}`,
        after: input as unknown as Record<string, unknown>,
        request,
      });

      return reply.status(201).send({ data: toRecord(created) });
    },
  );

  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.DESIGNATION_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(designationInputSchema, request.body);

      const before = await prisma.designation.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!before) throw new NotFoundError('Designation');

      const updated = await prisma.designation.update({
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
          action: 'designation.update',
          entityType: 'Designation',
          entityId: id,
          summary: `Updated designation ${updated.name} (${changes.changed.join(', ')})`,
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
    { preHandler: requirePermission(PERMISSIONS.DESIGNATION_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const existing = await prisma.designation.findFirst({
        where: { id, companyId: auth.companyId },
        include: INCLUDE,
      });
      if (!existing) throw new NotFoundError('Designation');

      if (existing._count.employees > 0) {
        throw new ConflictError(
          `${existing._count.employees} employee(s) still hold this designation. Reassign them first, or deactivate it instead.`,
        );
      }

      await prisma.designation.delete({ where: { id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'designation.delete',
        entityType: 'Designation',
        entityId: id,
        summary: `Deleted designation ${existing.name}`,
        before: { name: existing.name },
        request,
      });

      return reply.send({ data: { id } });
    },
  );
};
