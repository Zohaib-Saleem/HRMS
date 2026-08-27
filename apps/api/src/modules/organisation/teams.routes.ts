import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type TeamRecord,
  idParamSchema,
  teamInputSchema,
  teamQuerySchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';

const SORTABLE = ['name', 'createdAt', 'updatedAt'] as const;

const INCLUDE = {
  department: { select: { id: true, name: true } },
  leadEmployee: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { employees: true } },
} satisfies Prisma.TeamInclude;

type TeamWithRelations = Prisma.TeamGetPayload<{ include: typeof INCLUDE }>;

function toRecord(row: TeamWithRelations): TeamRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    departmentId: row.departmentId,
    departmentName: row.department.name,
    leadEmployeeId: row.leadEmployeeId,
    leadEmployeeName: row.leadEmployee
      ? `${row.leadEmployee.firstName} ${row.leadEmployee.lastName}`.trim()
      : null,
    employeeCount: row._count.employees,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A team's department must belong to the caller's company. */
async function assertDepartment(companyId: string, departmentId: string): Promise<void> {
  const department = await prisma.department.findFirst({
    where: { id: departmentId, companyId },
    select: { id: true },
  });
  if (!department) {
    throw new ValidationError({ departmentId: ['That department does not exist.'] });
  }
}

export const teamRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: requirePermission(PERMISSIONS.TEAM_READ) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(teamQuerySchema, request.query);

    const where: Prisma.TeamWhereInput = {
      companyId: auth.companyId,
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.isActive ? { isActive: query.isActive === 'true' } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { description: { contains: query.q, mode: 'insensitive' } },
              { department: { name: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.team.count({ where }),
      prisma.team.findMany({
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

  app.get('/:id', { preHandler: requirePermission(PERMISSIONS.TEAM_READ) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await prisma.team.findFirst({
      where: { id, companyId: auth.companyId },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundError('Team');

    return reply.send({ data: toRecord(row) });
  });

  app.post('/', { preHandler: requirePermission(PERMISSIONS.TEAM_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(teamInputSchema, request.body);

    await assertDepartment(auth.companyId, input.departmentId);

    const created = await prisma.team.create({
      data: { ...input, companyId: auth.companyId },
      include: INCLUDE,
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'team.create',
      entityType: 'Team',
      entityId: created.id,
      summary: `Created team ${created.name} in ${created.department.name}`,
      after: input as unknown as Record<string, unknown>,
      request,
    });

    return reply.status(201).send({ data: toRecord(created) });
  });

  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.TEAM_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(teamInputSchema, request.body);

      const before = await prisma.team.findFirst({ where: { id, companyId: auth.companyId } });
      if (!before) throw new NotFoundError('Team');

      await assertDepartment(auth.companyId, input.departmentId);

      const updated = await prisma.team.update({
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
          action: 'team.update',
          entityType: 'Team',
          entityId: id,
          summary: `Updated team ${updated.name} (${changes.changed.join(', ')})`,
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
    { preHandler: requirePermission(PERMISSIONS.TEAM_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const existing = await prisma.team.findFirst({
        where: { id, companyId: auth.companyId },
        include: { _count: { select: { employees: true } } },
      });
      if (!existing) throw new NotFoundError('Team');

      if (existing._count.employees > 0) {
        throw new ConflictError(
          `This team still has ${existing._count.employees} employee(s). Reassign them first, or deactivate the team instead.`,
        );
      }

      await prisma.team.delete({ where: { id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'team.delete',
        entityType: 'Team',
        entityId: id,
        summary: `Deleted team ${existing.name}`,
        before: { name: existing.name },
        request,
      });

      return reply.send({ data: { id } });
    },
  );
};
