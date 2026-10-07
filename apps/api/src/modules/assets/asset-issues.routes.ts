import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  assetIssueQuerySchema,
  assetIssueResolveSchema,
  idParamSchema,
  type AssetIssueQueueItem,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { ASSET_INCIDENT_INCLUDE, toAssetIncidentRecord } from './asset-lifecycle.service.js';

/**
 * The asset issue queue: what employees have reported about the kit they hold.
 *
 * Reading it is `asset.read.all` - the register's own gate, because an issue is
 * a fact about an asset somebody else is holding. Closing one is
 * `asset.update`, the same grant that decides what the register says, so the
 * person told about an issue (see `assetIssueRecipients`) is the person who can
 * close it. Neither is a new permission.
 *
 * Only employee reports (ISSUE_REPORTED) are queued. Lost and damaged are
 * recorded BY the asset manager, so they are already in the right hands.
 */

const INCLUDE = {
  ...ASSET_INCIDENT_INCLUDE,
  asset: { select: { id: true, assetTag: true, name: true } },
  resolvedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.AssetIncidentInclude;

type Row = Prisma.AssetIncidentGetPayload<{ include: typeof INCLUDE }>;

function toQueueItem(row: Row): AssetIssueQueueItem {
  return {
    ...toAssetIncidentRecord(row),
    status: row.resolvedAt ? 'RESOLVED' : 'OPEN',
    asset: row.asset,
    resolvedBy: row.resolvedBy
      ? {
          id: row.resolvedBy.id,
          fullName: `${row.resolvedBy.firstName} ${row.resolvedBy.lastName}`.trim(),
        }
      : null,
  };
}

export const assetIssueRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get(
    '/issues',
    { preHandler: requirePermission(PERMISSIONS.ASSET_READ_ALL) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const query = parseOrThrow(assetIssueQuerySchema, request.query ?? {});

      const rows = await prisma.assetIncident.findMany({
        where: {
          companyId: auth.companyId,
          kind: 'ISSUE_REPORTED',
          ...(query.status === 'OPEN' ? { resolvedAt: null } : {}),
          ...(query.status === 'RESOLVED' ? { resolvedAt: { not: null } } : {}),
        },
        // Oldest open first is the order work is done in; but a queue that
        // also shows resolved ones reads newest first.
        orderBy: { createdAt: query.status === 'OPEN' ? 'asc' : 'desc' },
        take: 500,
        include: INCLUDE,
      });

      return reply.send({ data: rows.map(toQueueItem) });
    },
  );

  app.get(
    '/issues/:id',
    { preHandler: requirePermission(PERMISSIONS.ASSET_READ_ALL) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const row = await prisma.assetIncident.findFirst({
        where: { id, companyId: auth.companyId, kind: 'ISSUE_REPORTED' },
        include: INCLUDE,
      });
      if (!row) throw new NotFoundError('Asset issue');
      return reply.send({ data: toQueueItem(row) });
    },
  );

  /**
   * Closing an issue, with what was done about it.
   *
   * Conditional on the row still being open, so two people closing the same
   * issue at once produce one resolution and one refusal - never a second
   * note written over the first.
   */
  app.post(
    '/issues/:id/resolve',
    { preHandler: requirePermission(PERMISSIONS.ASSET_UPDATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(assetIssueResolveSchema, request.body);

      const existing = await prisma.assetIncident.findFirst({
        where: { id, companyId: auth.companyId, kind: 'ISSUE_REPORTED' },
        include: INCLUDE,
      });
      if (!existing) throw new NotFoundError('Asset issue');

      const result = await prisma.assetIncident.updateMany({
        where: { id: existing.id, resolvedAt: null },
        data: {
          resolvedAt: new Date(),
          resolvedById: auth.userId,
          resolutionNotes: input.resolutionNotes,
        },
      });
      if (result.count === 0) {
        throw new ValidationError({ id: ['That issue has already been resolved.'] });
      }

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.issue.resolved',
        entityType: 'Asset',
        entityId: existing.asset.id,
        summary: `${existing.asset.assetTag} - ${existing.asset.name}: reported issue "${existing.reason}" resolved`,
        before: { incidentId: existing.id, status: 'OPEN' },
        after: { incidentId: existing.id, status: 'RESOLVED', resolutionNotes: input.resolutionNotes },
        request,
      });

      const row = await prisma.assetIncident.findFirstOrThrow({
        where: { id: existing.id },
        include: INCLUDE,
      });
      return reply.send({ data: toQueueItem(row) });
    },
  );
};
