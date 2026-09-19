import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  roleCreateSchema,
  roleKeyFromName,
  roleUpdateSchema,
  updateRolePermissionsSchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';

const idParam = z.object({ id: z.string().min(1) });

/**
 * Turns a display name into a key nobody else in the company holds.
 *
 * Collisions are resolved by suffixing rather than refused, because the clash
 * is on a DERIVED value the caller never typed: "IT Manager" and "I.T. Manager"
 * both want `IT_MANAGER`, and telling somebody their role name is taken when
 * the visible names differ is a puzzle rather than an error. The display name
 * IS refused when it collides - see the create route - because that one the
 * caller chose.
 */
async function uniqueRoleKey(companyId: string, name: string): Promise<string> {
  const base = roleKeyFromName(name);
  const taken = new Set(
    (
      await prisma.role.findMany({
        where: { companyId, key: { startsWith: base } },
        select: { key: true },
      })
    ).map((r) => r.key),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ConflictError('Too many roles with similar names. Choose a different name.');
}

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
        dataScope: role.dataScope,
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
      const { id } = parseOrThrow(idParam, request.params);
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

  /**
   * Creating a role.
   *
   * `role.manage` and nothing more, which is the same grant that can already
   * give any unprotected role every permission in the catalogue. Creation
   * therefore adds no privilege that did not exist - it adds a place to put
   * one. The escalation ceiling is `role.manage` itself, and that is why no
   * default role but SUPER_ADMIN holds it.
   *
   * The KEY is derived, never supplied. Callers name roles, not identifiers,
   * and a key typed by hand is a key that eventually collides with a system
   * one - `EMPLOYEE` created by a company would shadow the seeded role that
   * `syncPermissionCatalogue` writes to on every boot.
   */
  app.post('/', { preHandler: requirePermission(PERMISSIONS.ROLE_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(roleCreateSchema, request.body);

    /*
     * The display NAME is held unique, case-insensitively, even though the
     * database only constrains the key. Two roles both reading "IT Manager" in
     * the picker are indistinguishable to the person assigning one, and the
     * derived key would silently make the second `IT_MANAGER_2`.
     */
    const clash = await prisma.role.findFirst({
      where: { companyId: auth.companyId, name: { equals: input.name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) {
      throw new ValidationError({ name: ['A role with that name already exists.'] });
    }

    const key = await uniqueRoleKey(auth.companyId, input.name);

    const permissionRows = input.permissions?.length
      ? await prisma.permission.findMany({
          where: { key: { in: input.permissions } },
          select: { id: true, key: true },
        })
      : [];

    const role = await prisma.role.create({
      data: {
        companyId: auth.companyId,
        key,
        name: input.name,
        description: input.description ?? null,
        dataScope: input.dataScope,
        // Never on a role a company made: `isSystem` means the catalogue
        // recreates it, and `isProtected` means it cannot be edited. Neither is
        // true of this one, and both would be a lie the delete guard believes.
        isSystem: false,
        isProtected: false,
        rolePermissions: {
          createMany: { data: permissionRows.map((p) => ({ permissionId: p.id })) },
        },
      },
    });

    const granted = permissionRows.map((p) => p.key).sort();

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'role.create',
      entityType: 'Role',
      entityId: role.id,
      summary: `Created the ${role.name} role (${key}, scope ${role.dataScope}) with ${granted.length} permission${
        granted.length === 1 ? '' : 's'
      }`,
      after: { key, name: role.name, dataScope: role.dataScope, permissions: granted },
      request,
    });

    return reply.status(201).send({
      data: {
        id: role.id,
        key: role.key,
        name: role.name,
        description: role.description,
        dataScope: role.dataScope,
        isSystem: role.isSystem,
        isProtected: role.isProtected,
        userCount: 0,
        permissions: granted,
      },
    });
  });

  /**
   * Renaming, re-describing and re-scoping.
   *
   * The key is absent from the schema and from this handler, deliberately: a
   * system role's key is how the permission catalogue and every seed find it,
   * and a company role's key is already referenced by whatever the company
   * wrote down. A name is a label and changes freely; an identifier does not.
   *
   * A SYSTEM role can be renamed and re-scoped here - "Office Boy" is a name a
   * company may well want to change - but never deleted. The protected role is
   * refused outright, because narrowing SUPER_ADMIN's scope is a lock-out with
   * extra steps.
   */
  app.patch('/:id', { preHandler: requirePermission(PERMISSIONS.ROLE_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParam, request.params);
    const input = parseOrThrow(roleUpdateSchema, request.body);

    const role = await prisma.role.findFirst({ where: { id, companyId: auth.companyId } });
    if (!role) throw new NotFoundError('Role');

    if (role.isProtected) {
      throw new ForbiddenError(
        `The ${role.name} role always has full access to the whole company and cannot be edited.`,
      );
    }

    const clash = await prisma.role.findFirst({
      where: {
        companyId: auth.companyId,
        name: { equals: input.name, mode: 'insensitive' },
        NOT: { id },
      },
      select: { id: true },
    });
    if (clash) {
      throw new ValidationError({ name: ['A role with that name already exists.'] });
    }

    const before = { name: role.name, description: role.description, dataScope: role.dataScope };

    const updated = await prisma.role.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description ?? null,
        dataScope: input.dataScope,
      },
    });

    const after = {
      name: updated.name,
      description: updated.description,
      dataScope: updated.dataScope,
    };

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'role.update',
      entityType: 'Role',
      entityId: role.id,
      summary:
        before.dataScope === after.dataScope
          ? `Updated the ${updated.name} role`
          : `Updated the ${updated.name} role; scope ${before.dataScope} to ${after.dataScope}`,
      before,
      after,
      request,
    });

    return reply.send({
      data: {
        id: updated.id,
        key: updated.key,
        name: updated.name,
        description: updated.description,
        dataScope: updated.dataScope,
        isSystem: updated.isSystem,
        isProtected: updated.isProtected,
      },
    });
  });

  /**
   * Deleting a role.
   *
   * Two refusals, and both are about leaving somebody stranded rather than
   * about tidiness:
   *
   *   - a SYSTEM role is refused because `syncPermissionCatalogue` recreates it
   *     on the next boot, so the delete would appear to work and then silently
   *     undo itself, minus the permissions the company had customised;
   *   - a role somebody still HOLDS is refused because `users.routes.ts` will
   *     not let an account exist with no role, so deleting out from under the
   *     last one produces exactly the state the rest of the module forbids.
   *
   * The second is a refusal rather than a cascade on purpose. Reassigning
   * people is a decision with names attached, and doing it as a side effect of
   * a delete is how somebody loses access nobody remembers granting.
   */
  app.delete('/:id', { preHandler: requirePermission(PERMISSIONS.ROLE_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParam, request.params);

    const role = await prisma.role.findFirst({
      where: { id, companyId: auth.companyId },
      include: { _count: { select: { userRoles: true } } },
    });
    if (!role) throw new NotFoundError('Role');

    if (role.isSystem || role.isProtected) {
      throw new ForbiddenError(
        `${role.name} is a built-in role and cannot be deleted. You can rename it or change what it may do.`,
      );
    }

    if (role._count.userRoles > 0) {
      const count = role._count.userRoles;
      throw new ConflictError(
        `${count} account${count === 1 ? ' still holds' : 's still hold'} the ${role.name} role. Move ${
          count === 1 ? 'them' : 'them all'
        } to another role first.`,
      );
    }

    await prisma.role.delete({ where: { id } });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'role.delete',
      entityType: 'Role',
      entityId: role.id,
      summary: `Deleted the ${role.name} role (${role.key})`,
      before: { key: role.key, name: role.name, dataScope: role.dataScope },
      request,
    });

    return reply.send({ data: { id: role.id, deleted: true } });
  });

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
