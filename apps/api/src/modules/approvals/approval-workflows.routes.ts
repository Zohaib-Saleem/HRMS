import type { FastifyPluginAsync } from 'fastify';
import {
  APPROVAL_STAGE_LABELS,
  APPROVAL_SUBJECT_LABELS,
  APPROVAL_SUBJECT_TYPES,
  DEFAULT_APPROVAL_STAGES,
  PERMISSIONS,
  approvalStageAssigneeSchema,
  approvalWorkflowUpdateSchema,
  idParamSchema,
  type ApprovalHierarchySettings,
  type ApprovalStage,
  type ApprovalStageAssigneeRecord,
  type ApprovalStageMode,
  type ApprovalSubjectType,
  type ApprovalWorkflowRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { stageCoverage, workflowStagesFor } from '../../core/approvals/hierarchy.service.js';

/**
 * Configuring the approval hierarchy.
 *
 * Two things live behind one screen: the CHAIN (which rungs a kind of request
 * passes through, and whether a rung needs one approver or all of them) and
 * the PEOPLE who fill the company-wide rungs.
 *
 * `TEAM_MANAGER` is deliberately not configurable here. Who manages a team is
 * a row on the Teams screen, and accepting an answer here as well would create
 * a second, disagreeing source of truth for the single question this whole
 * feature exists to answer explicitly.
 *
 * Reading is `approval.workflow.read`, which HR and every manager holds -
 * "who has to sign this" is a fair question for anybody raising a request.
 * Writing is `approval.workflow.manage`, which Super Admin holds alone by
 * default, because it decides who decides every future request.
 */

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

const ASSIGNEE_INCLUDE = {
  employee: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      displayName: true,
      employeeNumber: true,
      status: true,
      designation: { select: { name: true } },
    },
  },
} as const;

type AssigneeRow = {
  id: string;
  stage: string;
  employeeId: string;
  isActive: boolean;
  assignedAt: Date;
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    displayName: string | null;
    employeeNumber: string;
    status: string;
    designation: { name: string } | null;
  };
};

function toAssignee(row: AssigneeRow): ApprovalStageAssigneeRecord {
  return {
    id: row.id,
    stage: row.stage as ApprovalStage,
    employeeId: row.employeeId,
    employeeName: displayName(row.employee),
    employeeNumber: row.employee.employeeNumber,
    designation: row.employee.designation?.name ?? null,
    isActive: row.isActive,
    isEmployed: row.employee.status === 'ACTIVE',
    assignedAt: row.assignedAt.toISOString(),
  };
}

export const approvalWorkflowRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.APPROVAL_WORKFLOW_READ));

  /** The whole hierarchy, in one response. */
  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);

    const coverage = await stageCoverage(auth.companyId);

    const workflows: ApprovalWorkflowRecord[] = [];
    for (const subjectType of APPROVAL_SUBJECT_TYPES) {
      const { stages, isDefault } = await workflowStagesFor(auth.companyId, subjectType);
      workflows.push({
        subjectType,
        subjectLabel: APPROVAL_SUBJECT_LABELS[subjectType],
        isDefault,
        stages: stages.map((stage, index) => ({
          stageOrder: index + 1,
          stage: stage.stage,
          mode: stage.mode,
          /*
           * How many people this rung would resolve to RIGHT NOW. Null for the
           * rungs whose answer depends on whose request it is - the team
           * manager stage resolves per requester, and a single number there
           * would be a fiction.
           */
          resolvedApproverCount:
            stage.stage === 'HR_MANAGER'
              ? coverage.HR_MANAGER
              : stage.stage === 'CEO'
                ? coverage.CEO
                : null,
        })),
      });
    }

    const assigneeRows = (await prisma.approvalStageAssignee.findMany({
      where: { companyId: auth.companyId },
      include: ASSIGNEE_INCLUDE,
      orderBy: [{ stage: 'asc' }, { assignedAt: 'asc' }],
    })) as unknown as AssigneeRow[];

    /*
     * Warnings rather than errors, for the reason the resolver skips rather
     * than refuses: a company that has not named a CEO can still approve
     * leave, and ought to be told that the CEO rung is being skipped rather
     * than discovering it from a request that sailed through.
     */
    const warnings: string[] = [];
    const configured = new Set(workflows.flatMap((w) => w.stages.map((s) => s.stage)));
    if (configured.has('HR_MANAGER') && coverage.HR_MANAGER === 0) {
      warnings.push(
        'No active employee is named as HR Manager, so that stage is being skipped on every request.',
      );
    }
    if (configured.has('CEO') && coverage.CEO === 0) {
      warnings.push('No active employee is named as CEO, so that stage is being skipped on every request.');
    }
    if (configured.has('TEAM_MANAGER') && coverage.teamsWithoutManager > 0) {
      warnings.push(
        `${coverage.teamsWithoutManager} team(s) have no active manager. Requests from those teams skip the Team Manager stage.`,
      );
    }
    for (const row of assigneeRows) {
      if (row.isActive && row.employee.status !== 'ACTIVE') {
        warnings.push(
          `${displayName(row.employee)} is named as ${APPROVAL_STAGE_LABELS[row.stage as ApprovalStage]} but is ${row.employee.status.toLowerCase()}, so they are never asked.`,
        );
      }
    }

    const data: ApprovalHierarchySettings = {
      workflows,
      assignees: assigneeRows.map(toAssignee),
      warnings,
      canManage: auth.permissions.has(PERMISSIONS.APPROVAL_WORKFLOW_MANAGE),
    };

    return reply.send({ data });
  });

  /**
   * Replace the chain for one kind of request.
   *
   * An empty `stages` array DELETES the company's override and returns that
   * subject type to the built-in default - the escape hatch for an
   * administrator who has made a mess and does not know what the default was.
   */
  app.put(
    '/',
    { preHandler: requirePermission(PERMISSIONS.APPROVAL_WORKFLOW_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(approvalWorkflowUpdateSchema, request.body);

      const before = await workflowStagesFor(auth.companyId, input.subjectType);

      if (input.stages.length === 0) {
        await prisma.approvalWorkflow.deleteMany({
          where: { companyId: auth.companyId, subjectType: input.subjectType },
        });

        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'approval.workflow.reset',
          entityType: 'ApprovalWorkflow',
          summary: `Reset the ${APPROVAL_SUBJECT_LABELS[input.subjectType]} approval chain to the default`,
          before: { stages: before.stages },
          after: { stages: DEFAULT_APPROVAL_STAGES[input.subjectType] },
          request,
        });

        return reply.send({ data: { subjectType: input.subjectType, isDefault: true } });
      }

      await prisma.$transaction(async (tx) => {
        const workflow = await tx.approvalWorkflow.upsert({
          where: {
            companyId_subjectType: { companyId: auth.companyId, subjectType: input.subjectType },
          },
          create: {
            companyId: auth.companyId,
            subjectType: input.subjectType,
            name: `${APPROVAL_SUBJECT_LABELS[input.subjectType]} approval chain`,
            isActive: true,
          },
          update: { isActive: true },
        });

        /*
         * The stages are REPLACED, not merged. A chain is an ordered list and
         * the order is the meaning of it; reconciling row by row would leave
         * an administrator who removed the middle rung with a chain whose
         * stageOrder values no longer describe the sequence they saw.
         */
        await tx.approvalWorkflowStage.deleteMany({ where: { workflowId: workflow.id } });
        await tx.approvalWorkflowStage.createMany({
          data: input.stages.map((stage, index) => ({
            workflowId: workflow.id,
            stageOrder: index + 1,
            stage: stage.stage,
            mode: stage.mode,
            isActive: true,
          })),
        });
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'approval.workflow.update',
        entityType: 'ApprovalWorkflow',
        summary: `Changed the ${APPROVAL_SUBJECT_LABELS[input.subjectType]} approval chain to ${input.stages
          .map((s) => APPROVAL_STAGE_LABELS[s.stage])
          .join(' -> ')}`,
        before: { stages: before.stages, wasDefault: before.isDefault },
        after: { stages: input.stages },
        request,
      });

      return reply.send({ data: { subjectType: input.subjectType, isDefault: false } });
    },
  );

  /** Name somebody as HR Manager or CEO. */
  app.post(
    '/assignees',
    { preHandler: requirePermission(PERMISSIONS.APPROVAL_WORKFLOW_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(approvalStageAssigneeSchema, request.body);

      const employee = await prisma.employee.findFirst({
        where: { id: input.employeeId, companyId: auth.companyId },
        select: { id: true, firstName: true, lastName: true, displayName: true, status: true },
      });
      if (!employee) throw new ValidationError({ employeeId: ['That employee does not exist.'] });

      // Same rule as a team manager: somebody who has left cannot hold a seat.
      if (employee.status !== 'ACTIVE') {
        throw new ValidationError({
          employeeId: [
            `${displayName(employee)} is ${employee.status.toLowerCase()} and cannot be an approver.`,
          ],
        });
      }

      const saved = await prisma.approvalStageAssignee.upsert({
        where: {
          companyId_stage_employeeId: {
            companyId: auth.companyId,
            stage: input.stage,
            employeeId: employee.id,
          },
        },
        create: {
          companyId: auth.companyId,
          stage: input.stage,
          employeeId: employee.id,
          isActive: true,
          assignedByUserId: auth.userId,
        },
        update: { isActive: true, assignedAt: new Date(), assignedByUserId: auth.userId },
        include: ASSIGNEE_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'approval.stage.assignee.add',
        entityType: 'ApprovalStageAssignee',
        entityId: saved.id,
        summary: `Named ${displayName(employee)} as ${APPROVAL_STAGE_LABELS[input.stage]}`,
        after: { stage: input.stage, employeeId: employee.id },
        request,
      });

      return reply.status(201).send({ data: toAssignee(saved as unknown as AssigneeRow) });
    },
  );

  /**
   * Take somebody off a stage.
   *
   * The row is deactivated rather than deleted, for the reason a team
   * appointment is: requests already in flight were routed to this person, and
   * the history of who was asked must survive the roster changing.
   */
  app.delete(
    '/assignees/:id',
    { preHandler: requirePermission(PERMISSIONS.APPROVAL_WORKFLOW_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const existing = (await prisma.approvalStageAssignee.findFirst({
        where: { id, companyId: auth.companyId },
        include: ASSIGNEE_INCLUDE,
      })) as unknown as AssigneeRow | null;
      if (!existing) throw new NotFoundError('Approval stage assignee');

      await prisma.approvalStageAssignee.update({ where: { id }, data: { isActive: false } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'approval.stage.assignee.remove',
        entityType: 'ApprovalStageAssignee',
        entityId: id,
        summary: `${displayName(existing.employee)} is no longer ${APPROVAL_STAGE_LABELS[existing.stage as ApprovalStage]}`,
        before: { stage: existing.stage, employeeId: existing.employeeId },
        request,
      });

      return reply.send({ data: { id } });
    },
  );
};

/** Exported for the settings screen's type narrowing and for tests. */
export type { ApprovalStageMode, ApprovalSubjectType };
