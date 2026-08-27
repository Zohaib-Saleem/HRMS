import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PERMISSIONS, paginationQuerySchema } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';

const SORTABLE = ['createdAt', 'action', 'entityType'] as const;

const auditQuerySchema = paginationQuerySchema.extend({
  entityType: z.string().trim().max(64).optional(),
  action: z.string().trim().max(64).optional(),
  actorId: z.string().trim().max(64).optional(),
});

export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.AUDIT_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(auditQuerySchema, request.query);

    const where: Prisma.AuditLogWhereInput = {
      companyId: auth.companyId,
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.q
        ? {
            OR: [
              { summary: { contains: query.q, mode: 'insensitive' } },
              { action: { contains: query.q, mode: 'insensitive' } },
              { entityType: { contains: query.q, mode: 'insensitive' } },
              { actor: { firstName: { contains: query.q, mode: 'insensitive' } } },
              { actor: { lastName: { contains: query.q, mode: 'insensitive' } } },
              { actor: { email: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const { skip, take } = toSkipTake(query.page, query.limit);

    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        skip,
        take,
        orderBy: buildOrderBy(query.sort, query.order, SORTABLE, 'createdAt'),
        include: {
          actor: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
    ]);

    return reply.send({
      data: rows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        summary: row.summary,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt.toISOString(),
        actor: row.actor
          ? {
              id: row.actor.id,
              fullName: `${row.actor.firstName} ${row.actor.lastName}`.trim(),
              email: row.actor.email,
            }
          : null,
      })),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  /** Distinct values, so the filter dropdowns reflect what actually exists. */
  app.get('/filters', async (request, reply) => {
    const auth = requireAuthContext(request);

    const [entityTypes, actions] = await Promise.all([
      prisma.auditLog.findMany({
        where: { companyId: auth.companyId },
        distinct: ['entityType'],
        select: { entityType: true },
        orderBy: { entityType: 'asc' },
      }),
      prisma.auditLog.findMany({
        where: { companyId: auth.companyId },
        distinct: ['action'],
        select: { action: true },
        orderBy: { action: 'asc' },
      }),
    ]);

    return reply.send({
      data: {
        entityTypes: entityTypes.map((e) => e.entityType),
        actions: actions.map((a) => a.action),
      },
    });
  });
};
