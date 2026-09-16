import type { FastifyPluginAsync } from 'fastify';
import {
  PERMISSIONS,
  idParamSchema,
  lunchMenuItemCreateSchema,
  lunchMenuItemUpdateSchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit, diff } from '../../core/audit.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { toMenuItemRecord } from './lunch.service.js';

/**
 * The lunch menu: what can be ordered, and what it costs.
 *
 * Company configuration, like a leave type or a case category, and held behind
 * its own grant for the reason those are: a price is what an employee will be
 * charged, and the person who collects the money is not automatically the
 * person who sets it.
 *
 * Items are RETIRED rather than deleted, which is why there is no DELETE here.
 * Orders point at menu items, and more importantly orders point at what an item
 * was CALLED and what it COST on the day - those are copied onto the order
 * line, so a price rise cannot rewrite last Tuesday's collection, and removing
 * an item cannot remove the record of having sold it. A dead row that once had
 * a price is worth more than a tidy list.
 */

/**
 * Refuses a name this company already uses.
 *
 * The unique index is what actually holds, and this exists so the answer is a
 * field error on the form rather than a 500 from a constraint. Case-insensitive
 * on purpose: "Biryani" and "biryani" at two prices is an ordering mistake
 * waiting to happen on a dropdown sixty people use every day.
 */
async function assertNameIsFree(
  companyId: string,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await prisma.lunchMenuItem.findFirst({
    where: {
      companyId,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  });

  if (clash) {
    throw new ValidationError({ name: ['There is already an item with that name.'] });
  }
}

export const lunchMenuRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.LUNCH_MENU_MANAGE));

  /**
   * The whole menu, retired items included.
   *
   * Deliberately not the same list the order form gets. That one is what is on
   * offer today; this one is what the company has ever put on offer, because
   * the person maintaining it needs to see the retired chapati in order to
   * bring it back rather than create a second row called "Chapati".
   */
  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);

    const rows = await prisma.lunchMenuItem.findMany({
      where: { companyId: auth.companyId },
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });

    return reply.send({ data: rows.map(toMenuItemRecord) });
  });

  app.post('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(lunchMenuItemCreateSchema, request.body);

    await assertNameIsFree(auth.companyId, input.name, null);

    const created = await prisma.lunchMenuItem.create({
      data: {
        companyId: auth.companyId,
        name: input.name,
        description: input.description ?? null,
        price: input.price,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'lunch.menu.create',
      entityType: 'LunchMenuItem',
      entityId: created.id,
      summary: `Added ${created.name} to the lunch menu at ${input.price}`,
      after: { name: input.name, price: input.price, isActive: input.isActive },
      request,
    });

    return reply.code(201).send({ data: toMenuItemRecord(created) });
  });

  /**
   * Re-pricing, renaming or retiring an item.
   *
   * A price change applies from now on and to nothing already ordered: order
   * lines carry their own price. That is worth knowing while editing this
   * field, because it is the difference between putting the karahi up by fifty
   * rupees and silently changing what fifty people already owe.
   */
  app.patch('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const input = parseOrThrow(lunchMenuItemUpdateSchema, request.body);

    const existing = await prisma.lunchMenuItem.findFirst({
      where: { id, companyId: auth.companyId },
    });
    if (!existing) throw new NotFoundError('Menu item');

    if (input.name !== undefined) {
      await assertNameIsFree(auth.companyId, input.name, existing.id);
    }

    const updated = await prisma.lunchMenuItem.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.price !== undefined ? { price: input.price } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });

    const changes = diff(
      {
        name: existing.name,
        description: existing.description,
        price: Number(existing.price),
        sortOrder: existing.sortOrder,
        isActive: existing.isActive,
      },
      {
        name: updated.name,
        description: updated.description,
        price: Number(updated.price),
        sortOrder: updated.sortOrder,
        isActive: updated.isActive,
      },
    );

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'lunch.menu.update',
      entityType: 'LunchMenuItem',
      entityId: updated.id,
      summary: `Updated lunch menu item ${updated.name}`,
      before: changes.before,
      after: changes.after,
      request,
    });

    return reply.send({ data: toMenuItemRecord(updated) });
  });
};
