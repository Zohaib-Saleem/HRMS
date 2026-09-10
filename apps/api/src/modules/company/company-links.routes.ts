import type { FastifyPluginAsync } from 'fastify';
import {
  PERMISSIONS,
  companyLinkPatchSchema,
  companyLinkSchema,
  idParamSchema,
  type CompanyLinkRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';

/**
 * The company's official online platforms.
 *
 * Readable by anyone signed in - a link to the company website is not
 * sensitive, and the point of holding them here is that the app can show them
 * - and writable only with `company.manage`, alongside every other fact about
 * how the company presents itself.
 *
 * Nothing is seeded and no address is assumed. Every link is one an
 * administrator typed, which is the only way this can be correct for any
 * particular company.
 */

const toRecord = (row: {
  id: string;
  kind: string;
  label: string;
  url: string;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): CompanyLinkRecord => ({
  id: row.id,
  kind: row.kind as CompanyLinkRecord['kind'],
  label: row.label,
  url: row.url,
  description: row.description,
  displayOrder: row.displayOrder,
  isActive: row.isActive,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const companyLinkRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.COMPANY_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const canManage = auth.permissions.has(PERMISSIONS.COMPANY_MANAGE);

    const rows = await prisma.companyLink.findMany({
      where: {
        companyId: auth.companyId,
        // A link switched off is a link nobody should be following. It stays
        // visible to whoever can switch it back on, and to nobody else.
        ...(canManage ? {} : { isActive: true }),
      },
      orderBy: [{ displayOrder: 'asc' }, { label: 'asc' }],
    });

    return reply.send({ data: rows.map(toRecord) });
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(companyLinkSchema, request.body);

      const duplicate = await prisma.companyLink.findFirst({
        where: { companyId: auth.companyId, label: input.label },
        select: { id: true },
      });
      if (duplicate) throw new ConflictError(`A link called “${input.label}” already exists.`);

      const created = await prisma.companyLink.create({
        data: { ...input, companyId: auth.companyId },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'company.link.create',
        entityType: 'CompanyLink',
        entityId: created.id,
        summary: `Added the ${input.label} link`,
        after: { label: input.label, url: input.url, kind: input.kind },
        request,
      });

      return reply.status(201).send({ data: toRecord(created) });
    },
  );

  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(companyLinkPatchSchema, request.body);

      const before = await prisma.companyLink.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!before) throw new NotFoundError('Link');

      if (input.label && input.label !== before.label) {
        const duplicate = await prisma.companyLink.findFirst({
          where: { companyId: auth.companyId, label: input.label, NOT: { id } },
          select: { id: true },
        });
        if (duplicate) throw new ConflictError(`A link called “${input.label}” already exists.`);
      }

      const updated = await prisma.companyLink.update({ where: { id }, data: input });

      const changes = diff(
        before as unknown as Record<string, unknown>,
        input as Record<string, unknown>,
      );
      if (changes.changed.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'company.link.update',
          entityType: 'CompanyLink',
          entityId: id,
          summary: `Updated the ${updated.label} link (${changes.changed.join(', ')})`,
          before: changes.before,
          after: changes.after,
          request,
        });
      }

      return reply.send({ data: toRecord(updated) });
    },
  );

  /**
   * Removable, unlike most things in this system.
   *
   * A link carries no history: it is a pointer to somewhere else, and a wrong
   * one has no value worth retaining. Switching it off is still the gentler
   * option and the form offers it first.
   */
  app.delete(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const link = await prisma.companyLink.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!link) throw new NotFoundError('Link');

      await prisma.companyLink.delete({ where: { id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'company.link.delete',
        entityType: 'CompanyLink',
        entityId: id,
        summary: `Removed the ${link.label} link`,
        before: { label: link.label, url: link.url },
        request,
      });

      return reply.send({ data: { id } });
    },
  );
};
