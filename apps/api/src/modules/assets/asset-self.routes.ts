import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  assetAcknowledgeSchema,
  assetIssueReportSchema,
  type MyAssetsRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import {
  ASSET_INCIDENT_INCLUDE,
  callerEmployeeOrThrow,
  dayColumn,
  toAssetIncidentRecord,
} from './asset-lifecycle.service.js';
import { EMPLOYEE_ASSET_INCLUDE, toEmployeeAssetRow } from './asset-people.service.js';
import { notifyAssetIssue } from './asset-issues.service.js';

/**
 * The employee's own asset screen, and the two things they may write.
 *
 * EVERY QUERY AND EVERY WRITE IN THIS PLUGIN IS BOUND TO THE CALLER'S OWN
 * EMPLOYEE RECORD, resolved from the session rather than read from the request.
 * There is no employee id in any of these paths, which is the point: an
 * endpoint that took one would need a check, and a check is a thing that can be
 * got wrong. Here there is nothing to get wrong - the only person these routes
 * can describe is whoever is signed in.
 *
 * What an employee may write is two sentences and no more: "I have it", and
 * "something is wrong with it". Neither touches the asset. Section 14 asks that
 * employees cannot change an asset's condition or its value, and the reason
 * this plugin cannot is not that it declines to - it is that nothing here
 * writes to the `assets` table at all.
 */

const assignmentParams = z.object({ assignmentId: z.string().min(1) });

export const assetSelfRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  /**
   * What I have been issued, and what is waiting on me.
   *
   * `asset.read` is the gate, and the caller's own employee id is the WHERE
   * clause - not their data scope. A manager on REPORTS_AND_OWN opening their
   * own dashboard card wants their own laptop, not their team's six.
   */
  app.get(
    '/my',
    { preHandler: requirePermission(PERMISSIONS.ASSET_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);

      const employee = await prisma.employee.findFirst({
        where: { companyId: auth.companyId, userId: auth.userId },
        select: { id: true },
      });

      // A login with no employee record holds nobody's asset. An empty answer
      // rather than an error: the dashboard card renders itself away.
      if (!employee) {
        const empty: MyAssetsRecord = {
          assigned: [],
          awaitingAcknowledgement: [],
          totalAssigned: 0,
        };
        return reply.send({ data: empty });
      }

      const rows = await prisma.assetAssignment.findMany({
        where: { companyId: auth.companyId, employeeId: employee.id, status: 'ACTIVE' },
        orderBy: { assignedAt: 'desc' },
        include: EMPLOYEE_ASSET_INCLUDE,
      });

      // What the kit is worth is the asset manager's figure, not the holder's.
      const canReadAll = auth.permissions.has(PERMISSIONS.ASSET_READ_ALL);
      const assigned = rows
        .map(toEmployeeAssetRow)
        .map((row) => (canReadAll ? row : { ...row, currentValue: null }));
      const data: MyAssetsRecord = {
        assigned,
        awaitingAcknowledgement: assigned.filter(
          (row) => row.acknowledgementStatus === 'PENDING',
        ),
        totalAssigned: assigned.length,
      };

      return reply.send({ data });
    },
  );

  /**
   * The caller's own handover, or a 404.
   *
   * A 404 rather than a 403 for somebody else's assignment: an employee poking
   * at ids must not be able to learn that a handover exists, let alone whose.
   */
  async function ownAssignmentOrThrow(
    companyId: string,
    employeeId: string,
    assignmentId: string,
  ) {
    const assignment = await prisma.assetAssignment.findFirst({
      where: { id: assignmentId, companyId, employeeId },
      include: { asset: { select: { id: true, assetTag: true, name: true } } },
    });
    if (!assignment) throw new NotFoundError('Assignment');
    return assignment;
  }

  /**
   * "Yes, I have it."
   *
   * Writes three columns on one row and nothing else. The asset's condition,
   * value and status are untouched - an employee saying they received a laptop
   * is not an employee grading it.
   */
  app.post(
    '/assignments/:assignmentId/acknowledge',
    { preHandler: requirePermission(PERMISSIONS.ASSET_ACKNOWLEDGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const employeeId = await callerEmployeeOrThrow(auth);
      const { assignmentId } = parseOrThrow(assignmentParams, request.params);
      const input = parseOrThrow(assetAcknowledgeSchema, request.body ?? {});

      const assignment = await ownAssignmentOrThrow(auth.companyId, employeeId, assignmentId);

      if (assignment.acknowledgementStatus === 'ACKNOWLEDGED') {
        throw new ValidationError({
          acknowledgement: ['You have already confirmed you received this.'],
        });
      }

      await prisma.assetAssignment.update({
        where: { id: assignment.id },
        data: {
          acknowledgementStatus: 'ACKNOWLEDGED',
          acknowledgedAt: new Date(),
          acknowledgedById: auth.userId,
          // Appended to the handover note rather than replacing it: the note
          // written at issue is somebody else's and must survive.
          ...(input.notes
            ? { notes: [assignment.notes, `Employee: ${input.notes}`].filter(Boolean).join('\n') }
            : {}),
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.acknowledged',
        entityType: 'Asset',
        entityId: assignment.asset.id,
        summary: `${assignment.asset.assetTag} - ${assignment.asset.name} acknowledged by the employee holding it`,
        after: { assignmentId: assignment.id, acknowledgementStatus: 'ACKNOWLEDGED' },
        request,
      });

      return reply.send({ data: { assignmentId: assignment.id, status: 'ACKNOWLEDGED' } });
    },
  );

  /**
   * "Something is wrong with it."
   *
   * Files an auditable incident and flags the handover; it does NOT move the
   * asset's status or condition. Section 7 asks for an auditable issue record
   * and section 14 asks that employees cannot change an asset's condition, and
   * those two together are exactly this shape: the employee reports what they
   * see, and somebody holding `asset.update` decides what the register says.
   */
  app.post(
    '/assignments/:assignmentId/report-issue',
    { preHandler: requirePermission(PERMISSIONS.ASSET_ACKNOWLEDGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const employeeId = await callerEmployeeOrThrow(auth);
      const { assignmentId } = parseOrThrow(assignmentParams, request.params);
      const input = parseOrThrow(assetIssueReportSchema, request.body);

      const assignment = await ownAssignmentOrThrow(auth.companyId, employeeId, assignmentId);

      // Only what they are holding now. A laptop handed back last month is the
      // register's to look at, not the former holder's to report on.
      if (assignment.status !== 'ACTIVE') {
        throw new ValidationError({
          assignmentId: ['You can only report a problem with an asset you currently hold.'],
        });
      }

      const incident = await prisma.$transaction(async (tx) => {
        const created = await tx.assetIncident.create({
          data: {
            companyId: auth.companyId,
            assetId: assignment.asset.id,
            assignmentId: assignment.id,
            kind: 'ISSUE_REPORTED',
            occurredOn: dayColumn(new Date().toISOString()),
            reason: input.reason,
            description: input.description,
            reportedById: auth.userId,
            reportedByEmployeeId: employeeId,
          },
          include: ASSET_INCIDENT_INCLUDE,
        });

        await tx.assetAssignment.update({
          where: { id: assignment.id },
          data: { acknowledgementStatus: 'ISSUE_REPORTED' },
        });

        return created;
      });

      /*
       * The people who act on it, told now. Before this the report was written
       * and nobody heard about it: the incident sat on the asset's own page
       * until somebody happened to open that asset.
       */
      const reporter = incident.reportedByEmployee;
      const notified = await notifyAssetIssue({
        companyId: auth.companyId,
        reporterUserId: auth.userId,
        incidentId: incident.id,
        employeeName: reporter ? `${reporter.firstName} ${reporter.lastName}`.trim() : 'An employee',
        assetName: assignment.asset.name,
        assetTag: assignment.asset.assetTag,
        reason: input.reason,
        description: input.description ?? null,
        logger: request.log,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.issue.reported',
        entityType: 'Asset',
        entityId: assignment.asset.id,
        summary: `${assignment.asset.assetTag} - ${assignment.asset.name}: the employee holding it reported "${input.reason}"`,
        after: {
          assignmentId: assignment.id,
          incidentId: incident.id,
          reason: input.reason,
          status: 'OPEN',
          notifiedUserIds: notified,
        },
        request,
      });

      return reply.code(201).send({ data: toAssetIncidentRecord(incident) });
    },
  );
};
