import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  PERMISSIONS,
  type DepartmentRecord,
  type DepartmentTreeNode,
  departmentInputSchema,
  departmentQuerySchema,
  idParamSchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { organisationLookups } from './lookup.js';

const SORTABLE = ['name', 'code', 'createdAt', 'updatedAt'] as const;

type DepartmentWithCounts = Prisma.DepartmentGetPayload<{
  include: {
    parentDepartment: { select: { id: true; name: true } };
    headEmployee: { select: { id: true; firstName: true; lastName: true } };
    _count: { select: { employees: true; teams: true } };
  };
}>;

const INCLUDE = {
  parentDepartment: { select: { id: true, name: true } },
  headEmployee: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { employees: true, teams: true } },
} satisfies Prisma.DepartmentInclude;

function toRecord(row: DepartmentWithCounts): DepartmentRecord {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    isActive: row.isActive,
    parentDepartmentId: row.parentDepartmentId,
    parentDepartmentName: row.parentDepartment?.name ?? null,
    headEmployeeId: row.headEmployeeId,
    headEmployeeName: row.headEmployee
      ? `${row.headEmployee.firstName} ${row.headEmployee.lastName}`.trim()
      : null,
    employeeCount: row._count.employees,
    teamCount: row._count.teams,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Walks up the parent chain to prove `candidateParentId` is not the department
 * itself or one of its own descendants. The database cannot express this, so it
 * is enforced here - without it a cycle would make the tree endpoint recurse
 * forever.
 */
async function assertNoCycle(
  companyId: string,
  departmentId: string,
  candidateParentId: string,
): Promise<void> {
  if (departmentId === candidateParentId) {
    throw new ValidationError({
      parentDepartmentId: ['A department cannot be its own parent.'],
    });
  }

  let cursor: string | null = candidateParentId;
  const seen = new Set<string>();

  while (cursor) {
    if (cursor === departmentId) {
      throw new ValidationError({
        parentDepartmentId: ['That would create a loop in the department hierarchy.'],
      });
    }
    if (seen.has(cursor)) break; // pre-existing loop; do not spin
    seen.add(cursor);

    const parent: { parentDepartmentId: string | null } | null =
      await prisma.department.findFirst({
        where: { id: cursor, companyId },
        select: { parentDepartmentId: true },
      });
    cursor = parent?.parentDepartmentId ?? null;
  }
}

export const departmentRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/',
    { preHandler: requirePermission(PERMISSIONS.DEPARTMENT_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const query = parseOrThrow(departmentQuerySchema, request.query);

      const where: Prisma.DepartmentWhereInput = {
        companyId: auth.companyId,
        ...(query.isActive ? { isActive: query.isActive === 'true' } : {}),
        ...(query.parentDepartmentId ? { parentDepartmentId: query.parentDepartmentId } : {}),
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { code: { contains: query.q, mode: 'insensitive' } },
                { description: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      };

      const { skip, take } = toSkipTake(query.page, query.limit);
      const [total, rows] = await Promise.all([
        prisma.department.count({ where }),
        prisma.department.findMany({
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

  /** Hierarchy for the department tree view. */
  app.get(
    '/tree',
    { preHandler: requirePermission(PERMISSIONS.DEPARTMENT_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);

      const rows = await prisma.department.findMany({
        where: { companyId: auth.companyId },
        orderBy: { name: 'asc' },
        include: {
          headEmployee: { select: { firstName: true, lastName: true } },
          _count: { select: { employees: true } },
        },
      });

      const nodes = new Map<string, DepartmentTreeNode>();
      for (const row of rows) {
        nodes.set(row.id, {
          id: row.id,
          name: row.name,
          code: row.code,
          isActive: row.isActive,
          headEmployeeName: row.headEmployee
            ? `${row.headEmployee.firstName} ${row.headEmployee.lastName}`.trim()
            : null,
          employeeCount: row._count.employees,
          children: [],
        });
      }

      const roots: DepartmentTreeNode[] = [];
      for (const row of rows) {
        const node = nodes.get(row.id);
        if (!node) continue;
        const parent = row.parentDepartmentId ? nodes.get(row.parentDepartmentId) : undefined;
        // An orphaned parent reference surfaces at the root rather than vanishing.
        if (parent && parent !== node) parent.children.push(node);
        else roots.push(node);
      }

      return reply.send({ data: roots });
    },
  );

  /** Shared dropdown data for every organisation and employee form. */
  app.get(
    '/lookups',
    { preHandler: requirePermission(PERMISSIONS.DEPARTMENT_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      return reply.send({ data: await organisationLookups(auth.companyId) });
    },
  );

  app.get(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.DEPARTMENT_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const row = await prisma.department.findFirst({
        where: { id, companyId: auth.companyId },
        include: INCLUDE,
      });
      if (!row) throw new NotFoundError('Department');

      return reply.send({ data: toRecord(row) });
    },
  );

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.DEPARTMENT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(departmentInputSchema, request.body);

      if (input.parentDepartmentId) {
        const parent = await prisma.department.findFirst({
          where: { id: input.parentDepartmentId, companyId: auth.companyId },
          select: { id: true },
        });
        if (!parent) {
          throw new ValidationError({ parentDepartmentId: ['That department does not exist.'] });
        }
      }

      const created = await prisma.department.create({
        data: { ...input, companyId: auth.companyId },
        include: INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'department.create',
        entityType: 'Department',
        entityId: created.id,
        summary: `Created department ${created.name}`,
        after: input as unknown as Record<string, unknown>,
        request,
      });

      return reply.status(201).send({ data: toRecord(created) });
    },
  );

  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.DEPARTMENT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(departmentInputSchema, request.body);

      const before = await prisma.department.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!before) throw new NotFoundError('Department');

      if (input.parentDepartmentId) {
        await assertNoCycle(auth.companyId, id, input.parentDepartmentId);
      }

      const updated = await prisma.department.update({
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
          action: 'department.update',
          entityType: 'Department',
          entityId: id,
          summary: `Updated department ${updated.name} (${changes.changed.join(', ')})`,
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
    { preHandler: requirePermission(PERMISSIONS.DEPARTMENT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const existing = await prisma.department.findFirst({
        where: { id, companyId: auth.companyId },
        include: { _count: { select: { employees: true, teams: true, childDepartments: true } } },
      });
      if (!existing) throw new NotFoundError('Department');

      // Refuse rather than cascade - deleting would orphan or destroy records
      // the caller probably did not intend to touch.
      const blockers: string[] = [];
      if (existing._count.employees > 0) blockers.push(`${existing._count.employees} employee(s)`);
      if (existing._count.teams > 0) blockers.push(`${existing._count.teams} team(s)`);
      if (existing._count.childDepartments > 0) {
        blockers.push(`${existing._count.childDepartments} sub-department(s)`);
      }

      if (blockers.length > 0) {
        throw new ConflictError(
          `This department still has ${blockers.join(' and ')}. Reassign them first, or deactivate the department instead.`,
        );
      }

      await prisma.department.delete({ where: { id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'department.delete',
        entityType: 'Department',
        entityId: id,
        summary: `Deleted department ${existing.name}`,
        before: { name: existing.name, code: existing.code },
        request,
      });

      return reply.status(200).send({ data: { id } });
    },
  );
};

export const departmentIdParamSchema = z.object({ id: z.string().min(1) });
