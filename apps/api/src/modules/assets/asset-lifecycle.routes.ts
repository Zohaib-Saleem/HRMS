import type { FastifyPluginAsync } from 'fastify';
import {
  ASSET_CONDITION_LABELS,
  ASSET_DISPOSAL_METHOD_LABELS,
  ASSET_INCIDENT_KIND_LABELS,
  PERMISSIONS,
  assetAssignSchema,
  assetDisposeSchema,
  assetIncidentSchema,
  assetRepairCompleteSchema,
  assetRepairSendSchema,
  assetRetireSchema,
  assetReturnSchema,
  assetTransferSchema,
  idParamSchema,
  type AssetCondition,
  type AssetStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { notify } from '../../core/notifications/notification.service.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { ASSET_ASSIGNMENT_INCLUDE, toAssetAssignmentRecord } from './assets.service.js';
import {
  ASSET_INCIDENT_INCLUDE,
  ASSET_REPAIR_INCLUDE,
  RACE_LOST_MESSAGE,
  activeAssignmentOrThrow,
  assertAssignable,
  assetForWrite,
  claimAssetForAssignment,
  closeAssignment,
  dayColumn,
  employeeForAssignment,
  resolveMissing,
  toAssetIncidentRecord,
  toAssetRepairRecord,
} from './asset-lifecycle.service.js';

/**
 * The asset lifecycle: assign, return, transfer, repair, lose, break, retire,
 * dispose.
 *
 * Seven verbs, seven grants, one plugin. They are together because they all
 * mutate the same two rows in the same two ways and the invariant between them
 * has to be read in one place; they are gated INDIVIDUALLY, so holding
 * `asset.assign` buys nothing towards disposing of anything.
 *
 * Every one of them is a transaction, and every transaction begins with a
 * conditional write rather than a read - see the note at the top of
 * `asset-lifecycle.service.ts`. That is what makes "one active assignment per
 * asset" true under a race rather than true when nobody is looking.
 *
 * And every one of them APPENDS. A transfer does not edit the previous
 * handover's employee; a return does not delete the assignment; marking
 * something lost does not remove it from the register. The history is the
 * product here - an asset register that cannot say who had the laptop before
 * the screen got cracked is a spreadsheet with extra steps.
 */

export const assetLifecycleRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  // --------------------------------------------------------------- assign

  /**
   * Handing an asset to somebody.
   *
   * The order inside the transaction matters and is the whole point: the asset
   * is CLAIMED first, by a conditional update that only matches an assignable
   * asset, and the assignment row is written only if that claim won. Writing
   * the assignment first and updating the asset afterwards would let two
   * concurrent calls both write an assignment and then both write the same
   * status, which is exactly the state this module exists to prevent.
   */
  app.post(
    '/:id/assign',
    { preHandler: requirePermission(PERMISSIONS.ASSET_ASSIGN) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(assetAssignSchema, request.body);

      const asset = await assetForWrite(auth, id);
      assertAssignable(asset.status as AssetStatus);

      const employee = await employeeForAssignment(
        auth.companyId,
        input.employeeId,
        'employeeId',
      );

      const assignment = await prisma.$transaction(async (tx) => {
        const won = await claimAssetForAssignment(
          tx,
          auth.companyId,
          asset.id,
          input.conditionAtAssignment,
        );
        if (!won) throw new ConflictError(RACE_LOST_MESSAGE);

        return tx.assetAssignment.create({
          data: {
            companyId: auth.companyId,
            assetId: asset.id,
            employeeId: employee.id,
            assignedAt: dayColumn(input.assignedOn),
            assignedById: auth.userId,
            conditionAtAssignment: input.conditionAtAssignment,
            accessoriesIssued: input.accessories,
            accessoriesReturned: [],
            accessoriesMissing: [],
            notes: input.notes,
            status: 'ACTIVE',
            acknowledgementStatus: 'PENDING',
          },
          include: ASSET_ASSIGNMENT_INCLUDE,
        });
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.assigned',
        entityType: 'Asset',
        entityId: asset.id,
        summary: `Assigned ${asset.assetTag} - ${asset.name} to ${employee.firstName} ${employee.lastName} in ${ASSET_CONDITION_LABELS[input.conditionAtAssignment]} condition`,
        after: {
          assignmentId: assignment.id,
          employeeId: employee.id,
          assignedOn: input.assignedOn,
          conditionAtAssignment: input.conditionAtAssignment,
          accessories: input.accessories,
        },
        request,
      });

      /*
       * Tell the person they have it, so the acknowledgement in section 7 has
       * somewhere to start. Best-effort by construction: `notify` never throws,
       * and an employee with no login is simply skipped - an asset issued to
       * somebody without an account is still issued.
       */
      if (employee.userId) {
        await notify({
          companyId: auth.companyId,
          userId: employee.userId,
          type: 'SYSTEM',
          title: 'You have received a company asset',
          message: `${asset.name} (${asset.assetTag}) has been issued to you. Please confirm you have it.`,
          entityType: 'Asset',
          entityId: asset.id,
          logger: request.log,
        });
      }

      return reply.code(201).send({ data: toAssetAssignmentRecord(assignment) });
    },
  );

  // --------------------------------------------------------------- return

  /**
   * Taking one back.
   *
   * The assignment is CLOSED by a conditional update on the active row, which
   * is the lock, and the asset's new status is written only if that won. The
   * row is never deleted: section 4 asks for exactly this, and the returned
   * handover - with what came back, what did not, and what state it was in - is
   * the thing somebody reads six months later.
   */
  app.post(
    '/:id/return',
    { preHandler: requirePermission(PERMISSIONS.ASSET_RETURN) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(assetReturnSchema, request.body);

      const asset = await assetForWrite(auth, id);
      const active = await activeAssignmentOrThrow(auth.companyId, asset.id);

      const missing = resolveMissing(
        active.accessoriesIssued,
        input.accessoriesReturned,
        input.additionalMissing,
      );

      /*
       * "Checked and back in stock" is a positive claim, and a missing charger
       * contradicts it. The schema already refuses that outcome for a damaged
       * asset; this is the half the schema cannot see, because what was ISSUED
       * lives in the database rather than in the payload.
       */
      if (input.outcome === 'AVAILABLE' && missing.length > 0) {
        throw new ValidationError({
          outcome: [
            `Not everything came back - ${missing.join(', ')}. Record it as returned and check it in once that is settled.`,
          ],
        });
      }

      const assignment = await prisma.$transaction(async (tx) => {
        const won = await closeAssignment(tx, active.id, {
          status: 'RETURNED',
          returnedAt: dayColumn(input.returnedOn),
          returnedById: auth.userId,
          conditionAtReturn: input.conditionAtReturn,
          accessoriesReturned: input.accessoriesReturned,
          accessoriesMissing: missing,
          damageDescription: input.damageDescription,
          returnNotes: input.notes,
        });
        if (!won) throw new ConflictError(RACE_LOST_MESSAGE);

        await tx.asset.update({
          where: { id: asset.id },
          data: { status: input.outcome, condition: input.conditionAtReturn },
        });

        return tx.assetAssignment.findUniqueOrThrow({
          where: { id: active.id },
          include: ASSET_ASSIGNMENT_INCLUDE,
        });
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.returned',
        entityType: 'Asset',
        entityId: asset.id,
        summary:
          `${asset.assetTag} - ${asset.name} returned by ${active.employee.firstName} ${active.employee.lastName}` +
          ` in ${ASSET_CONDITION_LABELS[input.conditionAtReturn]} condition` +
          (missing.length > 0 ? `; missing ${missing.join(', ')}` : ''),
        before: { status: asset.status, condition: asset.condition },
        after: {
          status: input.outcome,
          condition: input.conditionAtReturn,
          returnedOn: input.returnedOn,
          accessoriesReturned: input.accessoriesReturned,
          accessoriesMissing: missing,
        },
        request,
      });

      return reply.send({ data: toAssetAssignmentRecord(assignment) });
    },
  );

  // ------------------------------------------------------------- transfer

  /**
   * Moving an asset straight from one person to another.
   *
   * Two rows, never one edit. The previous handover is closed as TRANSFERRED
   * and keeps its employee, its dates and its condition; a new one is inserted
   * carrying `previousAssignmentId`, which is unique - so the chain is a chain
   * and cannot fork. Section 5 asks that history not be overwritten, and the
   * shape of this endpoint is that instruction rather than a promise to honour
   * it.
   *
   * The asset never leaves ASSIGNED, which is also true in the room: it does
   * not come back to the store on the way.
   */
  app.post(
    '/:id/transfer',
    { preHandler: requirePermission(PERMISSIONS.ASSET_TRANSFER) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(assetTransferSchema, request.body);

      const asset = await assetForWrite(auth, id);
      const active = await activeAssignmentOrThrow(auth.companyId, asset.id);

      if (active.employeeId === input.toEmployeeId) {
        throw new ValidationError({
          toEmployeeId: ['That is the person who already has it.'],
        });
      }

      const recipient = await employeeForAssignment(
        auth.companyId,
        input.toEmployeeId,
        'toEmployeeId',
      );

      const created = await prisma.$transaction(async (tx) => {
        const won = await closeAssignment(tx, active.id, {
          status: 'TRANSFERRED',
          returnedAt: dayColumn(input.transferredOn),
          returnedById: auth.userId,
          conditionAtReturn: input.conditionAtTransfer,
          reason: input.reason,
        });
        if (!won) throw new ConflictError(RACE_LOST_MESSAGE);

        const next = await tx.assetAssignment.create({
          data: {
            companyId: auth.companyId,
            assetId: asset.id,
            employeeId: recipient.id,
            assignedAt: dayColumn(input.transferredOn),
            assignedById: auth.userId,
            conditionAtAssignment: input.conditionAtTransfer,
            accessoriesIssued: input.accessories,
            accessoriesReturned: [],
            accessoriesMissing: [],
            notes: input.notes,
            reason: input.reason,
            previousAssignmentId: active.id,
            status: 'ACTIVE',
            acknowledgementStatus: 'PENDING',
          },
          include: ASSET_ASSIGNMENT_INCLUDE,
        });

        // The asset stays ASSIGNED; only the condition moves with the handover.
        await tx.asset.update({
          where: { id: asset.id },
          data: { status: 'ASSIGNED', condition: input.conditionAtTransfer },
        });

        return next;
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.transferred',
        entityType: 'Asset',
        entityId: asset.id,
        summary: `${asset.assetTag} - ${asset.name} transferred from ${active.employee.firstName} ${active.employee.lastName} to ${recipient.firstName} ${recipient.lastName}: ${input.reason}`,
        before: { employeeId: active.employeeId, assignmentId: active.id },
        after: {
          employeeId: recipient.id,
          assignmentId: created.id,
          transferredOn: input.transferredOn,
          reason: input.reason,
        },
        request,
      });

      if (recipient.userId) {
        await notify({
          companyId: auth.companyId,
          userId: recipient.userId,
          type: 'SYSTEM',
          title: 'You have received a company asset',
          message: `${asset.name} (${asset.assetTag}) has been transferred to you. Please confirm you have it.`,
          entityType: 'Asset',
          entityId: asset.id,
          logger: request.log,
        });
      }

      return reply.code(201).send({ data: toAssetAssignmentRecord(created) });
    },
  );

  // --------------------------------------------------------------- repair

  app.get(
    '/:id/repairs',
    { preHandler: requirePermission(PERMISSIONS.ASSET_READ_ALL) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const asset = await assetForWrite(auth, id);

      const rows = await prisma.assetRepair.findMany({
        where: { assetId: asset.id, companyId: auth.companyId },
        orderBy: { sentOn: 'desc' },
        include: ASSET_REPAIR_INCLUDE,
      });

      return reply.send({ data: rows.map(toAssetRepairRecord) });
    },
  );

  /**
   * Sending an asset away to be fixed.
   *
   * `statusBeforeRepair` is written here and read when the repair ends, which
   * is how section 8's two paths both hold: AVAILABLE goes back to AVAILABLE
   * and ASSIGNED goes back to ASSIGNED. The assignment row is NOT closed - the
   * employee still has the asset on paper while it is at the repairer, which is
   * both true and what "do not lose the employee assignment history" means.
   */
  app.post(
    '/:id/repairs',
    { preHandler: requirePermission(PERMISSIONS.ASSET_REPAIR) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(assetRepairSendSchema, request.body);

      const asset = await assetForWrite(auth, id);
      const status = asset.status as AssetStatus;

      if (status === 'UNDER_REPAIR') {
        throw new ValidationError({ assetId: ['That asset is already away being repaired.'] });
      }
      if (!['AVAILABLE', 'ASSIGNED', 'RETURNED', 'DAMAGED'].includes(status)) {
        throw new ValidationError({
          assetId: [`An asset that is ${status.toLowerCase().replace('_', ' ')} cannot be sent for repair.`],
        });
      }

      const repair = await prisma.$transaction(async (tx) => {
        /*
         * Conditional again, and on the same status we just read: two people
         * sending the same machine to two repairers produce one repair record
         * and one 409, rather than two open repairs with different vendors.
         */
        const moved = await tx.asset.updateMany({
          where: { id: asset.id, companyId: auth.companyId, status },
          data: { status: 'UNDER_REPAIR' },
        });
        if (moved.count !== 1) throw new ConflictError(RACE_LOST_MESSAGE);

        return tx.assetRepair.create({
          data: {
            companyId: auth.companyId,
            assetId: asset.id,
            problem: input.problem,
            reportedOn: dayColumn(input.reportedOn),
            sentOn: dayColumn(input.sentOn),
            expectedReturnOn: input.expectedReturnOn
              ? dayColumn(input.expectedReturnOn)
              : null,
            vendor: input.vendor,
            estimatedCost: input.estimatedCost,
            notes: input.notes,
            status: 'IN_PROGRESS',
            // The column the whole of section 8 turns on.
            statusBeforeRepair: status,
            sentById: auth.userId,
          },
          include: ASSET_REPAIR_INCLUDE,
        });
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.repair.sent',
        entityType: 'Asset',
        entityId: asset.id,
        summary: `${asset.assetTag} - ${asset.name} sent for repair${input.vendor ? ` to ${input.vendor}` : ''}: ${input.problem}`,
        before: { status },
        after: {
          status: 'UNDER_REPAIR',
          repairId: repair.id,
          sentOn: input.sentOn,
          vendor: input.vendor,
          estimatedCost: input.estimatedCost,
        },
        request,
      });

      return reply.code(201).send({ data: toAssetRepairRecord(repair) });
    },
  );

  /**
   * Recording what happened to it.
   *
   * Puts the asset back where it was before it left. CANCELLED does the same as
   * COMPLETED in that respect on purpose: a repair that never happened must not
   * strand the asset in UNDER_REPAIR forever, which is the one way this
   * workflow could quietly lose a laptop.
   */
  app.patch(
    '/:id/repairs/:repairId',
    { preHandler: requirePermission(PERMISSIONS.ASSET_REPAIR) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id, repairId } = parseOrThrow(
        idParamSchema.extend({ repairId: idParamSchema.shape.id }),
        request.params,
      );
      const input = parseOrThrow(assetRepairCompleteSchema, request.body);

      const asset = await assetForWrite(auth, id);
      const repair = await prisma.assetRepair.findFirst({
        where: { id: repairId, assetId: asset.id, companyId: auth.companyId },
      });
      if (!repair) throw new NotFoundError('Repair');
      if (repair.status !== 'IN_PROGRESS') {
        throw new ValidationError({ status: ['That repair has already been closed.'] });
      }

      const restored = repair.statusBeforeRepair as AssetStatus;

      const updated = await prisma.$transaction(async (tx) => {
        const closed = await tx.assetRepair.updateMany({
          where: { id: repair.id, status: 'IN_PROGRESS' },
          data: {
            status: input.status,
            returnedOn: dayColumn(input.returnedOn),
            actualCost: input.actualCost,
            completionNotes: input.completionNotes,
            completedById: auth.userId,
          },
        });
        if (closed.count !== 1) throw new ConflictError(RACE_LOST_MESSAGE);

        await tx.asset.update({
          where: { id: asset.id },
          data: {
            status: restored,
            ...(input.condition !== undefined ? { condition: input.condition } : {}),
          },
        });

        return tx.assetRepair.findUniqueOrThrow({
          where: { id: repair.id },
          include: ASSET_REPAIR_INCLUDE,
        });
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: input.status === 'COMPLETED' ? 'asset.repaired' : 'asset.repair.cancelled',
        entityType: 'Asset',
        entityId: asset.id,
        summary:
          input.status === 'COMPLETED'
            ? `${asset.assetTag} - ${asset.name} back from repair; now ${restored.toLowerCase().replace('_', ' ')}`
            : `Repair of ${asset.assetTag} - ${asset.name} called off; back to ${restored.toLowerCase().replace('_', ' ')}`,
        before: { status: 'UNDER_REPAIR' },
        after: {
          status: restored,
          repairId: repair.id,
          returnedOn: input.returnedOn,
          actualCost: input.actualCost,
          condition: input.condition,
        },
        request,
      });

      return reply.send({ data: toAssetRepairRecord(updated) });
    },
  );

  // ------------------------------------------------------------ incidents

  app.get(
    '/:id/incidents',
    { preHandler: requirePermission(PERMISSIONS.ASSET_READ_ALL) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const asset = await assetForWrite(auth, id);

      const rows = await prisma.assetIncident.findMany({
        where: { assetId: asset.id, companyId: auth.companyId },
        orderBy: { occurredOn: 'desc' },
        include: ASSET_INCIDENT_INCLUDE,
      });

      return reply.send({ data: rows.map(toAssetIncidentRecord) });
    },
  );

  /**
   * Marking an asset lost or damaged.
   *
   * Never a delete, which is section 9's whole instruction. The asset stays on
   * the register with a status that says what happened and a row that says why;
   * "we lost eleven laptops last year" is a fact about the company, and a tidy
   * table is not worth losing it.
   *
   * The assignment is left ACTIVE. A laptop that went missing while Ahmed had
   * it is still Ahmed's problem to account for, and closing the handover here
   * would quietly clear him. HR closes it through the return endpoint when the
   * matter is settled.
   */
  app.post(
    '/:id/incidents',
    { preHandler: requirePermission(PERMISSIONS.ASSET_UPDATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(assetIncidentSchema, request.body);

      const asset = await assetForWrite(auth, id);
      const status = asset.status as AssetStatus;

      if (status === 'DISPOSED') {
        throw new ValidationError({ assetId: ['That asset has already been disposed of.'] });
      }

      const active = await prisma.assetAssignment.findFirst({
        where: { assetId: asset.id, companyId: auth.companyId, status: 'ACTIVE' },
        select: { id: true },
      });

      const incident = await prisma.$transaction(async (tx) => {
        const created = await tx.assetIncident.create({
          data: {
            companyId: auth.companyId,
            assetId: asset.id,
            assignmentId: active?.id ?? null,
            kind: input.kind,
            occurredOn: dayColumn(input.occurredOn),
            reason: input.reason,
            description: input.description,
            notes: input.notes,
            reportedById: auth.userId,
          },
          include: ASSET_INCIDENT_INCLUDE,
        });

        await tx.asset.update({
          where: { id: asset.id },
          data: {
            status: input.kind,
            // A lost asset's condition is unknown, not damaged - only the
            // DAMAGED report is a statement about the state of the thing.
            ...(input.kind === 'DAMAGED' ? { condition: 'DAMAGED' as AssetCondition } : {}),
          },
        });

        return created;
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: input.kind === 'LOST' ? 'asset.lost' : 'asset.damaged',
        entityType: 'Asset',
        entityId: asset.id,
        summary: `${asset.assetTag} - ${asset.name}: ${ASSET_INCIDENT_KIND_LABELS[input.kind].toLowerCase()} - ${input.reason}`,
        before: { status, condition: asset.condition },
        after: {
          status: input.kind,
          incidentId: incident.id,
          occurredOn: input.occurredOn,
          reason: input.reason,
        },
        request,
      });

      return reply.code(201).send({ data: toAssetIncidentRecord(incident) });
    },
  );

  // ---------------------------------------------------- retire and dispose

  /**
   * Taking an asset out of service.
   *
   * Refused while somebody is holding it: retiring a laptop that is on a desk
   * would produce a register saying the company has stopped using a thing an
   * employee is typing on. Get it back first.
   */
  app.post(
    '/:id/retire',
    { preHandler: requirePermission(PERMISSIONS.ASSET_RETIRE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(assetRetireSchema, request.body);

      const asset = await assetForWrite(auth, id);
      const status = asset.status as AssetStatus;

      if (status === 'DISPOSED') {
        throw new ValidationError({ assetId: ['That asset has already been disposed of.'] });
      }
      if (status === 'RETIRED') {
        throw new ValidationError({ assetId: ['That asset is already retired.'] });
      }

      const active = await prisma.assetAssignment.findFirst({
        where: { assetId: asset.id, companyId: auth.companyId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (active) {
        throw new ValidationError({
          assetId: ['Somebody is still holding that asset. Take it back before retiring it.'],
        });
      }

      await prisma.asset.update({
        where: { id: asset.id },
        data: {
          status: 'RETIRED',
          retiredOn: dayColumn(input.retiredOn),
          retiredReason: input.reason,
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.retired',
        entityType: 'Asset',
        entityId: asset.id,
        summary: `${asset.assetTag} - ${asset.name} retired: ${input.reason}`,
        before: { status },
        after: { status: 'RETIRED', retiredOn: input.retiredOn, reason: input.reason },
        request,
      });

      return reply.send({ data: { id: asset.id, status: 'RETIRED' } });
    },
  );

  /**
   * Writing one off for good.
   *
   * The end of the record and the narrowest grant in the module, because
   * nothing comes back from DISPOSED - `ASSET_STATUS_TRANSITIONS` gives it no
   * exits and `ASSET_ASSIGNABLE_STATUSES` does not include it, so section 14's
   * "disposed assets cannot be assigned again" is enforced in two independent
   * places rather than remembered in one.
   *
   * The asset row stays. It is a disposed asset, not a deleted one: last year's
   * asset register has to keep adding up.
   */
  app.post(
    '/:id/dispose',
    { preHandler: requirePermission(PERMISSIONS.ASSET_DISPOSE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(assetDisposeSchema, request.body);

      const asset = await assetForWrite(auth, id);
      const status = asset.status as AssetStatus;

      if (status === 'DISPOSED') {
        throw new ValidationError({ assetId: ['That asset has already been disposed of.'] });
      }

      const active = await prisma.assetAssignment.findFirst({
        where: { assetId: asset.id, companyId: auth.companyId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (active) {
        throw new ValidationError({
          assetId: ['Somebody is still holding that asset. Take it back before disposing of it.'],
        });
      }

      if (input.approvedByEmployeeId) {
        await employeeForAssignment(
          auth.companyId,
          input.approvedByEmployeeId,
          'approvedByEmployeeId',
        );
      }

      await prisma.asset.update({
        where: { id: asset.id },
        data: {
          status: 'DISPOSED',
          disposedOn: dayColumn(input.disposedOn),
          disposalMethod: input.method,
          disposalReason: input.reason,
          disposalFinalValue: input.finalValue,
          disposalApprovedById: input.approvedByEmployeeId,
          disposalNotes: input.notes,
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.disposed',
        entityType: 'Asset',
        entityId: asset.id,
        summary: `${asset.assetTag} - ${asset.name} disposed of (${ASSET_DISPOSAL_METHOD_LABELS[input.method].toLowerCase()}): ${input.reason}`,
        before: { status },
        after: {
          status: 'DISPOSED',
          disposedOn: input.disposedOn,
          method: input.method,
          finalValue: input.finalValue,
          reason: input.reason,
        },
        request,
      });

      return reply.send({ data: { id: asset.id, status: 'DISPOSED' } });
    },
  );
};
