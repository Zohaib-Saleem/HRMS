import type { FastifyPluginAsync } from 'fastify';
import {
  PERMISSIONS,
  assetCategoryCreateSchema,
  assetCategoryUpdateSchema,
  idParamSchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { diff, recordAudit } from '../../core/audit.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { toAssetCategoryRecord, toCategoryTree } from './assets.service.js';

/**
 * The asset category catalogue: what kinds of thing this company owns.
 *
 * Company configuration, like a leave type or a helpdesk queue, and held behind
 * its own grant for the reason those are: a category is what every asset report
 * is grouped by, and the person who records a laptop is not automatically the
 * person who decides that "laptop" is a thing.
 *
 * Categories are RETIRED rather than deleted, which is why there is no DELETE
 * here at all. Assets point at categories, and the foreign key is ON DELETE
 * RESTRICT, so a delete endpoint could only ever fail for exactly the rows
 * somebody would want to remove - and succeed for the ones that cost nothing to
 * keep. Retiring takes a category off the create form and leaves every asset
 * already filed under it exactly where it is, which is what makes last year's
 * report still add up.
 *
 * Reading the catalogue needs `asset.read`, not the manage grant: the create
 * form on the assets screen is built from this list, and somebody who may add an
 * asset must be able to see the categories to file it under.
 */

/**
 * Refuses a name this company already uses at the same level.
 *
 * The unique index holds for TYPES, whose parent is set. It cannot hold for
 * GROUPS, whose parent is null and which PostgreSQL therefore treats as all
 * distinct - so for those this check is the only thing standing between a
 * company and two categories called "Vehicles". Stated here rather than hidden,
 * the same way `CaseCategory` states it.
 */
async function assertNameIsFree(
  companyId: string,
  parentCategoryId: string | null,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await prisma.assetCategory.findFirst({
    where: {
      companyId,
      parentCategoryId,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  });

  if (clash) {
    throw new ValidationError({ name: ['There is already a category with that name.'] });
  }
}

export const assetCategoryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.ASSET_READ));

  /**
   * The whole catalogue as a tree, retired categories included.
   *
   * Retired ones are here on purpose: the person maintaining this needs to see
   * the retired "Fax Machine" in order to bring it back rather than create a
   * second row called "Fax machine". Screens that offer a category to file
   * something under filter on `isActive` themselves.
   */
  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);

    const rows = await prisma.assetCategory.findMany({
      where: { companyId: auth.companyId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        parent: { select: { name: true } },
        _count: { select: { assets: true } },
      },
    });

    return reply.send({ data: toCategoryTree(rows) });
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.ASSET_CATEGORY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(assetCategoryCreateSchema, request.body);

      /*
       * A type is created UNDER a group, and the group has to be this company's
       * and has to be a group. Two levels is the shape; a type of a type would
       * be a tree nobody asked for and every report would have to walk it.
       */
      if (input.parentCategoryId) {
        const parent = await prisma.assetCategory.findFirst({
          where: { id: input.parentCategoryId, companyId: auth.companyId },
          select: { id: true, parentCategoryId: true },
        });
        if (!parent) {
          throw new ValidationError({ parentCategoryId: ['That category does not exist.'] });
        }
        if (parent.parentCategoryId) {
          throw new ValidationError({
            parentCategoryId: ['Categories go two levels deep: a group and the types under it.'],
          });
        }
      }

      await assertNameIsFree(auth.companyId, input.parentCategoryId, input.name, null);

      const created = await prisma.assetCategory.create({
        data: {
          companyId: auth.companyId,
          parentCategoryId: input.parentCategoryId,
          name: input.name,
          description: input.description,
          sortOrder: input.sortOrder,
          isActive: input.isActive,
        },
        include: {
          parent: { select: { name: true } },
          _count: { select: { assets: true } },
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.category.created',
        entityType: 'AssetCategory',
        entityId: created.id,
        summary: created.parent
          ? `Added asset category ${created.parent.name} › ${created.name}`
          : `Added asset category ${created.name}`,
        after: {
          name: created.name,
          parentCategoryId: created.parentCategoryId,
          isActive: created.isActive,
        },
        request,
      });

      return reply.code(201).send({ data: toAssetCategoryRecord(created) });
    },
  );

  /**
   * Renaming, reordering or retiring a category.
   *
   * `isActive: false` is the retirement, and it is the only removal this module
   * offers. The parent is deliberately not editable: re-parenting a category
   * would silently move every asset filed under it into a different group, and
   * therefore into a different line of every report that has ever been run.
   */
  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.ASSET_CATEGORY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(assetCategoryUpdateSchema, request.body);

      const existing = await prisma.assetCategory.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!existing) throw new NotFoundError('Asset category');

      if (input.name !== undefined) {
        await assertNameIsFree(
          auth.companyId,
          existing.parentCategoryId,
          input.name,
          existing.id,
        );
      }

      const updated = await prisma.assetCategory.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description ?? null } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
        include: {
          parent: { select: { name: true } },
          _count: { select: { assets: true } },
        },
      });

      const changes = diff(
        {
          name: existing.name,
          description: existing.description,
          sortOrder: existing.sortOrder,
          isActive: existing.isActive,
        },
        {
          name: updated.name,
          description: updated.description,
          sortOrder: updated.sortOrder,
          isActive: updated.isActive,
        },
      );

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.category.updated',
        entityType: 'AssetCategory',
        entityId: updated.id,
        summary:
          existing.isActive && !updated.isActive
            ? `Retired asset category ${updated.name}`
            : `Updated asset category ${updated.name}`,
        before: changes.before,
        after: changes.after,
        request,
      });

      return reply.send({ data: toAssetCategoryRecord(updated) });
    },
  );
};
