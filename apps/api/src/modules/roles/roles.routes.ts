import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ALL_PERMISSIONS, PERMISSIONS } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { ForbiddenError, NotFoundError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';

const updateRolePermissionsSchema = z.object({
  permissions: z.array(z.enum(ALL_PERMISSIONS as unknown as [string, ...string[]])),
});

export const rolesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: requirePermission(PERMISSIONS.ROLE_READ) }, async (request, reply) => {
    const auth = requireAuthContext(request);

    const roles = await prisma.role.findMany({
      where: { companyId: auth.companyId },
      orderBy: [{ isProtected: 'desc' }, { name: 'asc' }],
      include: {
        rolePermissions: { select: { permission: { select: { key: true } } } },
        _count: { select: { userRoles: true } },
      },
    });

    return reply.send({
      data: roles.map((role) => ({
        id: role.id,
        key: role.key,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        isProtected: role.isProtected,
        userCount: role._count.userRoles,
        permissions: role.rolePermissions.map((rp) => rp.permission.key).sort(),
      })),
    });
  });

  app.put(
    '/:id/permissions',
    { preHandler: requirePermission(PERMISSIONS.ROLE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(z.object({ id: z.string().min(1) }), request.params);
      const { permissions } = parseOrThrow(updateRolePermissionsSchema, request.body);

      const role = await prisma.role.findFirst({
        where: { id, companyId: auth.companyId },
        include: { rolePermissions: { select: { permission: { select: { key: true } } } } },
      });
      if (!role) throw new NotFoundError('Role');

      // Guard rail: the protected super-admin role always keeps every
      // permission, so nobody can lock the whole company out of settings.
      if (role.isProtected) {
        throw new ForbiddenError(`The ${role.name} role always has full access and cannot be edited.`);
      }

      const permissionRows = await prisma.permission.findMany({
        where: { key: { in: permissions } },
        select: { id: true, key: true },
      });

      const previous = role.rolePermissions.map((rp) => rp.permission.key).sort();

      await prisma.$transaction([
        prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
        prisma.rolePermission.createMany({
          data: permissionRows.map((p) => ({ roleId: role.id, permissionId: p.id })),
        }),
      ]);

      const next = permissionRows.map((p) => p.key).sort();

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'role.permissions.update',
        entityType: 'Role',
        entityId: role.id,
        summary: `Updated permissions for ${role.name} (${previous.length} to ${next.length})`,
        before: { permissions: previous },
        after: { permissions: next },
        request,
      });

      return reply.send({ data: { id: role.id, permissions: next } });
    },
  );

  /** The permission catalogue, for rendering the role editor. */
  app.get(
    '/permissions',
    { preHandler: requirePermission(PERMISSIONS.ROLE_READ) },
    async (_request, reply) => {
      const permissions = await prisma.permission.findMany({ orderBy: { key: 'asc' } });
      return reply.send({ data: permissions });
    },
  );
};
