import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type LeaveTypeRecord,
  idParamSchema,
  leaveTypeInputSchema,
  leaveTypeQuerySchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { toNumber } from './leave.service.js';

const SORTABLE = ['name', 'createdAt', 'annualEntitlementDays'] as const;

const INCLUDE = { _count: { select: { requests: true } } } satisfies Prisma.LeaveTypeInclude;
type Row = Prisma.LeaveTypeGetPayload<{ include: typeof INCLUDE }>;

function toRecord(row: Row): LeaveTypeRecord {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    annualEntitlementDays: toNumber(row.annualEntitlementDays),
    monthlyAccrualDays: toNumber(row.monthlyAccrualDays),
    carryForwardEnabled: row.carryForwardEnabled,
    carryForwardCapDays: row.carryForwardCapDays === null ? null : toNumber(row.carryForwardCapDays),
    isPaid: row.isPaid,
    isActive: row.isActive,
    requestCount: row._count.requests,
  };
}

export const leaveTypeRoutes: FastifyPluginAsync = async (app) => {
  // Anyone who can see leave needs the catalogue to read a request or balance.
  app.addHook('preHandler', requirePermission(PERMISSIONS.LEAVE_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(leaveTypeQuerySchema, request.query);

    const where: Prisma.LeaveTypeWhereInput = {
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
      prisma.leaveType.count({ where }),
      prisma.leaveType.findMany({
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
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.LEAVE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(leaveTypeInputSchema, request.body);

      const created = await prisma.leaveType.create({
        data: {
          companyId: auth.companyId,
          name: input.name,
          code: input.code,
          description: input.description,
          annualEntitlementDays: input.annualEntitlementDays,
          monthlyAccrualDays: input.monthlyAccrualDays,
          carryForwardEnabled: input.carryForwardEnabled,
          // An uncapped policy stores null rather than a sentinel number.
          carryForwardCapDays: input.carryForwardEnabled ? (input.carryForwardCapDays ?? null) : null,
          isPaid: input.isPaid,
          isActive: input.isActive,
        },
        include: INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'leave_type.create',
        entityType: 'LeaveType',
        entityId: created.id,
        summary: `Created leave type ${created.name} (${toNumber(created.annualEntitlementDays)} days/year)`,
        after: input as unknown as Record<string, unknown>,
        request,
      });

      return reply.status(201).send({ data: toRecord(created) });
    },
  );

  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.LEAVE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(leaveTypeInputSchema, request.body);

      const before = await prisma.leaveType.findFirst({ where: { id, companyId: auth.companyId } });
      if (!before) throw new NotFoundError('Leave type');

      const updated = await prisma.leaveType.update({
        where: { id },
        data: {
          name: input.name,
          code: input.code,
          description: input.description,
          annualEntitlementDays: input.annualEntitlementDays,
          monthlyAccrualDays: input.monthlyAccrualDays,
          carryForwardEnabled: input.carryForwardEnabled,
          carryForwardCapDays: input.carryForwardEnabled ? (input.carryForwardCapDays ?? null) : null,
          isPaid: input.isPaid,
          isActive: input.isActive,
        },
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
          action: 'leave_type.update',
          entityType: 'LeaveType',
          entityId: id,
          summary: `Updated leave type ${updated.name} (${changes.changed.join(', ')})`,
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
    { preHandler: requirePermission(PERMISSIONS.LEAVE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const existing = await prisma.leaveType.findFirst({
        where: { id, companyId: auth.companyId },
        include: INCLUDE,
      });
      if (!existing) throw new NotFoundError('Leave type');

      // Deleting would take the history of every request with it.
      if (existing._count.requests > 0) {
        throw new ConflictError(
          `${existing._count.requests} leave request(s) use this type. Deactivate it instead so the history is kept.`,
        );
      }

      await prisma.leaveType.delete({ where: { id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'leave_type.delete',
        entityType: 'LeaveType',
        entityId: id,
        summary: `Deleted leave type ${existing.name}`,
        request,
      });

      return reply.send({ data: { id } });
    },
  );
};
