import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  ASSET_SORT_FIELDS,
  ASSET_STATUS_LABELS,
  EMPTY_ASSET_SUMMARY,
  PERMISSIONS,
  assetCreateSchema,
  assetQuerySchema,
  assetUpdateSchema,
  idParamSchema,
  isAssignmentDrivenStatus,
  type AssetActivityEvent,
  type AssetDetailRecord,
  type AssetDisposalMethod,
  type AssetStatus,
  type AssetSummary,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import {
  ASSET_INCIDENT_INCLUDE,
  ASSET_REPAIR_INCLUDE,
  assetActions,
  toAssetIncidentRecord,
  toAssetRepairRecord,
} from './asset-lifecycle.service.js';
import {
  ASSET_ASSIGNMENT_INCLUDE,
  ASSET_INCLUDE,
  assetFilterClauses,
  assetToday,
  assertAssetReferences,
  assertAssetTagIsFree,
  assertSerialIsFree,
  assertStatusTransition,
  assertWarrantyOrder,
  assetOrThrow,
  assetScopeFilter,
  dateColumn,
  forAssetReader,
  resolveAssetActor,
  toAssetAssignmentRecord,
  toAssetRecord,
} from './assets.service.js';

/**
 * The asset register.
 *
 * Two grants and a deliberate gap between them. `asset.read` opens this plugin,
 * and on its own it returns the assets currently out with the people the
 * caller's DATA SCOPE reaches - for an ordinary member of staff, the laptop on
 * their own desk. `asset.read.all` widens it to every asset the company owns,
 * held or not. The narrowing is a WHERE clause built by `assetScopeFilter`, so
 * an asset that is not theirs is absent from the query rather than fetched and
 * then hidden, and a guessed id answers 404 rather than 403.
 *
 * Nothing here assigns an asset to anybody. That is the next step, and the
 * reason it is not quietly possible from this file is `assertStatusTransition`:
 * ASSIGNED and RETURNED are refused as edits, because an asset becomes assigned
 * by writing the assignment row that says whose desk it is on.
 *
 * Assets are never deleted either. RETIRED and DISPOSED are statuses, they keep
 * every assignment filed against the asset, and a DELETE would quietly dispose
 * of the answer to "who had the laptop that went missing".
 */

/**
 * The caller's own handovers of one asset, for a reader who may not see the
 * whole register.
 *
 * Bound to the employee record behind the session, never to anything in the
 * request: an employee sees when THEY were given this asset and in what state,
 * and not which colleague had it before them. A login with no employee record
 * has held nothing, and a manager opening a report's laptop sees no history -
 * the same answer that reader got before this existed.
 */
async function ownHandovers(auth: { companyId: string; userId: string }, assetId: string) {
  const self = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true },
  });
  if (!self) return [];

  return prisma.assetAssignment.findMany({
    where: { assetId, companyId: auth.companyId, employeeId: self.id },
    orderBy: { assignedAt: 'desc' },
    include: ASSET_ASSIGNMENT_INCLUDE,
  });
}

export const assetRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.ASSET_READ));

  /**
   * The tiles above the register.
   *
   * One grouped query over the same narrowed WHERE the list uses, so the
   * numbers describe the whole register this reader may see and cannot
   * disagree with the table underneath them. Counting the current page would
   * produce tiles that change when somebody pages.
   *
   * Step 3 added the two money figures to the same grouped query rather than to
   * a second one, for the same reason the counts are grouped: the value and the
   * count must describe the same set of rows, and two round trips to the same
   * table is two answers taken a moment apart.
   */
  app.get('/summary', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = resolveAssetActor(auth);

    const scope = await assetScopeFilter(actor);
    if (scope === null) return reply.send({ data: EMPTY_ASSET_SUMMARY });

    const grouped = await prisma.asset.groupBy({
      by: ['status'],
      where: { AND: [{ companyId: auth.companyId }, scope] },
      _count: { _all: true },
      _sum: { purchasePrice: true, currentValue: true },
    });

    const summary: AssetSummary = {
      total: 0,
      totalPurchaseValue: 0,
      totalCurrentValue: 0,
      byStatus: { ...EMPTY_ASSET_SUMMARY.byStatus },
    };
    for (const row of grouped) {
      const status = row.status as AssetStatus;
      summary.byStatus[status] = row._count._all;
      summary.total += row._count._all;
      summary.totalPurchaseValue += Number(row._sum?.purchasePrice ?? 0);
      summary.totalCurrentValue += Number(row._sum?.currentValue ?? 0);
    }

    return reply.send({ data: summary });
  });

  /**
   * The list.
   *
   * EVERY FILTER IS APPLIED BY THE DATABASE, AND THE PAGE IS CUT AFTERWARDS.
   * That ordering is the claim section 11 makes and it is worth being explicit
   * about, because getting it wrong is invisible until somebody reads the
   * footer: `count` and `findMany` are handed the SAME `where` object - not two
   * objects built the same way, the same one - so "showing 1 to 20 of 80"
   * describes the rows underneath it. Nothing is filtered after it arrives, and
   * there is nowhere in this file it could be.
   *
   * The clauses themselves live in the service, shared with the dashboard and
   * both reports, so an export cannot quietly interpret "category" differently
   * from the screen it was exported from.
   */
  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = resolveAssetActor(auth);
    const query = parseOrThrow(assetQuerySchema, request.query);

    const scope = await assetScopeFilter(actor);
    if (scope === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    const today = await assetToday(auth.companyId);

    const where: Prisma.AssetWhereInput = {
      AND: [{ companyId: auth.companyId }, scope, ...assetFilterClauses(query, today)],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.asset.count({ where }),
      prisma.asset.findMany({
        where,
        skip,
        take,
        include: ASSET_INCLUDE,
        orderBy: buildOrderBy(query.sort, query.order, ASSET_SORT_FIELDS, 'createdAt'),
      }),
    ]);

    return reply.send({
      data: rows.map((row) => forAssetReader(toAssetRecord(row), actor)),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  /**
   * One asset, with its handover history.
   *
   * The history is served only to a reader who may see the whole register, and
   * the restriction is the point rather than caution: an employee holding a
   * laptop has no business reading which colleague had it before them, what
   * state that colleague handed it back in, or the note somebody wrote about
   * why. Section 12 asks for exactly this, and it is a separate query rather
   * than an include so a narrow reader's request never fetches the rows at all.
   */
  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = resolveAssetActor(auth);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await assetOrThrow(actor, id);

    /*
     * The history, the repairs and the incidents are served only to a reader
     * who may see the whole register, and the restriction is the point rather
     * than caution: an employee holding a laptop has no business reading which
     * colleague had it before them, what state that colleague handed it back
     * in, or what the repair cost. Three separate queries rather than includes,
     * so a narrow reader's request never fetches the rows at all.
     *
     * A narrow reader gets their OWN handovers of this asset instead: when they
     * were given it, in what condition, with what, and whether they confirmed
     * it. Never a colleague's.
     */
    const [assignments, repairs, incidents, approver] = actor.canReadAll
      ? await Promise.all([
          prisma.assetAssignment.findMany({
            where: { assetId: row.id, companyId: auth.companyId },
            orderBy: { assignedAt: 'desc' },
            include: ASSET_ASSIGNMENT_INCLUDE,
          }),
          prisma.assetRepair.findMany({
            where: { assetId: row.id, companyId: auth.companyId },
            orderBy: { sentOn: 'desc' },
            include: ASSET_REPAIR_INCLUDE,
          }),
          prisma.assetIncident.findMany({
            where: { assetId: row.id, companyId: auth.companyId },
            orderBy: { occurredOn: 'desc' },
            include: ASSET_INCIDENT_INCLUDE,
          }),
          row.disposalApprovedById
            ? prisma.employee.findFirst({
                where: { id: row.disposalApprovedById, companyId: auth.companyId },
                select: { id: true, firstName: true, lastName: true },
              })
            : Promise.resolve(null),
        ])
      : [await ownHandovers(auth, row.id), [], [], null];

    const base = forAssetReader(toAssetRecord(row), actor);

    const detail: AssetDetailRecord = {
      ...base,
      assignments: assignments.map(toAssetAssignmentRecord),
      repairs: repairs.map(toAssetRepairRecord),
      incidents: incidents.map(toAssetIncidentRecord),
      retiredOn: row.retiredOn ? row.retiredOn.toISOString().slice(0, 10) : null,
      retiredReason: row.retiredReason,
      disposal: row.disposedOn
        ? {
            disposedOn: row.disposedOn.toISOString().slice(0, 10),
            method: row.disposalMethod as AssetDisposalMethod,
            reason: row.disposalReason ?? '',
            finalValue:
              row.disposalFinalValue === null ? null : Number(row.disposalFinalValue),
            approvedBy: approver
              ? {
                  id: approver.id,
                  fullName: `${approver.firstName} ${approver.lastName}`.trim(),
                }
              : null,
            notes: row.disposalNotes,
          }
        : null,
      /*
       * What this reader may DO with it, decided here from the grant and the
       * asset's state together. The browser never reasons about statuses: two
       * copies of that rule eventually disagree, and the copy a person sees is
       * the wrong one.
       */
      can: assetActions(auth, { status: base.status }, base.holder !== null),
    };

    return reply.send({ data: detail });
  });

  /**
   * The asset's story, in order.
   *
   * Read back from `audit_logs` rather than from a table of its own - the step
   * 1 migration records why there is no `asset_events` table, and this endpoint
   * is the other half of that decision. Every lifecycle action already writes
   * one audit row with a summary written for a person, and
   * `@@index([companyId, entityType, entityId])` makes reading them back an
   * index lookup. A second history table would be a second thing to keep in
   * step with the first.
   */
  app.get(
    '/:id/activity',
    { preHandler: requirePermission(PERMISSIONS.ASSET_READ_ALL) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const asset = await prisma.asset.findFirst({
        where: { id, companyId: auth.companyId },
        select: { id: true },
      });
      if (!asset) throw new NotFoundError('Asset');

      const rows = await prisma.auditLog.findMany({
        where: { companyId: auth.companyId, entityType: 'Asset', entityId: asset.id },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          id: true,
          action: true,
          summary: true,
          createdAt: true,
          actor: { select: { firstName: true, lastName: true } },
        },
      });

      const data: AssetActivityEvent[] = rows.map((entry) => ({
        id: entry.id,
        action: entry.action,
        summary: entry.summary ?? entry.action,
        actorName: entry.actor
          ? `${entry.actor.firstName} ${entry.actor.lastName}`.trim()
          : null,
        at: entry.createdAt.toISOString(),
      }));

      return reply.send({ data });
    },
  );

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.ASSET_CREATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(assetCreateSchema, request.body);

      /*
       * An asset cannot be BORN assigned. There is nobody to assign it to in
       * this payload, and a status saying otherwise would be a claim with no
       * assignment row behind it.
       */
      if (isAssignmentDrivenStatus(input.status)) {
        throw new ValidationError({
          status: ['A new asset cannot start assigned. Add it, then assign it to somebody.'],
        });
      }

      await assertAssetReferences(auth.companyId, input, { requireActiveCategory: true });
      await assertAssetTagIsFree(auth.companyId, input.assetTag, null);
      await assertSerialIsFree(auth.companyId, input.serialNumber, null);

      const created = await prisma.asset.create({
        data: {
          companyId: auth.companyId,
          assetTag: input.assetTag,
          name: input.name,
          categoryId: input.categoryId,
          brand: input.brand,
          model: input.model,
          serialNumber: input.serialNumber,
          purchaseDate: dateColumn(input.purchaseDate),
          purchasePrice: input.purchasePrice,
          currentValue: input.currentValue,
          vendor: input.vendor,
          warrantyStart: dateColumn(input.warrantyStart),
          warrantyEnd: dateColumn(input.warrantyEnd),
          locationId: input.locationId,
          location: input.location,
          departmentId: input.departmentId,
          condition: input.condition,
          status: input.status,
          notes: input.notes,
        },
        include: ASSET_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.created',
        entityType: 'Asset',
        entityId: created.id,
        summary: `Added asset ${created.assetTag} - ${created.name} (${ASSET_STATUS_LABELS[created.status as AssetStatus]})`,
        after: {
          assetTag: created.assetTag,
          name: created.name,
          categoryId: created.categoryId,
          serialNumber: created.serialNumber,
          status: created.status,
          condition: created.condition,
        },
        request,
      });

      return reply.code(201).send({ data: toAssetRecord(created) });
    },
  );

  /**
   * Editing an asset.
   *
   * Reached through `assetOrThrow`, so a reader narrowed to their own kit gets
   * a 404 for somebody else's asset rather than a 403 - and would be refused by
   * the grant above in any case, since an employee holds none of the write
   * permissions.
   */
  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.ASSET_UPDATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const actor = resolveAssetActor(auth);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(assetUpdateSchema, request.body);

      const existing = await assetOrThrow(actor, id);

      await assertAssetReferences(auth.companyId, input, {
        // An asset already filed under a retired category keeps it - editing
        // its notes must not force somebody to re-file it. Only a MOVE to a
        // retired category is refused, and that is what `categoryId !==
        // undefined` means here.
        requireActiveCategory: input.categoryId !== undefined,
      });

      if (input.assetTag !== undefined) {
        await assertAssetTagIsFree(auth.companyId, input.assetTag, existing.id);
      }
      if (input.serialNumber !== undefined) {
        await assertSerialIsFree(auth.companyId, input.serialNumber, existing.id);
      }

      const warrantyStart =
        input.warrantyStart !== undefined
          ? dateColumn(input.warrantyStart)
          : existing.warrantyStart;
      const warrantyEnd =
        input.warrantyEnd !== undefined ? dateColumn(input.warrantyEnd) : existing.warrantyEnd;
      assertWarrantyOrder(warrantyStart, warrantyEnd);

      if (input.status !== undefined) {
        assertStatusTransition(existing.status as AssetStatus, input.status);
      }

      const updated = await prisma.asset.update({
        where: { id: existing.id },
        data: {
          ...(input.assetTag !== undefined ? { assetTag: input.assetTag } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.brand !== undefined ? { brand: input.brand } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.serialNumber !== undefined ? { serialNumber: input.serialNumber } : {}),
          ...(input.purchaseDate !== undefined
            ? { purchaseDate: dateColumn(input.purchaseDate) }
            : {}),
          ...(input.purchasePrice !== undefined ? { purchasePrice: input.purchasePrice } : {}),
          ...(input.currentValue !== undefined ? { currentValue: input.currentValue } : {}),
          ...(input.vendor !== undefined ? { vendor: input.vendor } : {}),
          ...(input.warrantyStart !== undefined ? { warrantyStart } : {}),
          ...(input.warrantyEnd !== undefined ? { warrantyEnd } : {}),
          ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
          ...(input.condition !== undefined ? { condition: input.condition } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
        include: ASSET_INCLUDE,
      });

      const changes = diff(
        {
          assetTag: existing.assetTag,
          name: existing.name,
          categoryId: existing.categoryId,
          brand: existing.brand,
          model: existing.model,
          serialNumber: existing.serialNumber,
          vendor: existing.vendor,
          location: existing.location,
          locationId: existing.locationId,
          departmentId: existing.departmentId,
          condition: existing.condition,
          status: existing.status,
        },
        {
          assetTag: updated.assetTag,
          name: updated.name,
          categoryId: updated.categoryId,
          brand: updated.brand,
          model: updated.model,
          serialNumber: updated.serialNumber,
          vendor: updated.vendor,
          location: updated.location,
          locationId: updated.locationId,
          departmentId: updated.departmentId,
          condition: updated.condition,
          status: updated.status,
        },
      );

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.updated',
        entityType: 'Asset',
        entityId: updated.id,
        summary: `Updated asset ${updated.assetTag} - ${updated.name}`,
        before: changes.before,
        after: changes.after,
        request,
      });

      return reply.send({ data: toAssetRecord(updated) });
    },
  );
};
