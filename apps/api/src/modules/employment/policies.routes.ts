import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  idParamSchema,
  policyAcknowledgeSchema,
  policyAssignSchema,
  policyAssignmentQuerySchema,
  policyInputSchema,
  policyPatchSchema,
  policyQuerySchema,
  type PolicyAssignmentRecord,
  type PolicyRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import { toDateOnly } from '../time/helpers.js';

/**
 * Company policies and who has acknowledged them.
 *
 * The rule that shapes everything here: a policy version is immutable text
 * once anybody has acknowledged it. Changing what a policy says means
 * publishing a new version - a new row that points back at the one it
 * replaces - because an acknowledgement is an acknowledgement of a particular
 * wording, and editing the wording underneath a signature turns the record
 * into a claim nobody actually made.
 *
 * Assignments are never deleted and never moved to a different version. The
 * next version is assigned as a new row, so the trail shows each version in
 * turn and what each employee said about it.
 */

const day = (value: Date | null): string | null =>
  value ? value.toISOString().slice(0, 10) : null;

const employeeName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

const ASSIGNMENT_INCLUDE = {
  policy: {
    select: {
      id: true,
      name: true,
      version: true,
      category: true,
      effectiveDate: true,
      documentUrl: true,
      documentName: true,
    },
  },
  employee: {
    select: { id: true, firstName: true, lastName: true, displayName: true, employeeNumber: true },
  },
} satisfies Prisma.EmployeePolicyAssignmentInclude;

type AssignmentRow = Prisma.EmployeePolicyAssignmentGetPayload<{
  include: typeof ASSIGNMENT_INCLUDE;
}>;

function toAssignmentRecord(
  row: AssignmentRow,
  callerEmployeeId: string | null,
): PolicyAssignmentRecord {
  return {
    id: row.id,
    policyId: row.policyId,
    policyName: row.policy.name,
    policyVersion: row.policy.version,
    policyCategory: row.policy.category,
    effectiveDate: day(row.policy.effectiveDate)!,
    documentUrl: row.policy.documentUrl,
    documentName: row.policy.documentName,
    employeeId: row.employeeId,
    employeeName: employeeName(row.employee),
    employeeNumber: row.employee.employeeNumber,
    status: row.status,
    assignedAt: row.assignedAt.toISOString(),
    dueDate: day(row.dueDate),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    note: row.note,
    // Only the person the policy was assigned to can sign it off, and only
    // while it is still outstanding. Nobody acknowledges on somebody's behalf.
    canAcknowledge: row.status === 'PENDING' && callerEmployeeId === row.employeeId,
  };
}

// ------------------------------------------------------------------- policies

export const policyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.POLICY_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(policyQuerySchema, request.query);

    const where: Prisma.CompanyPolicyWhereInput = {
      AND: [
        { companyId: auth.companyId },
        query.isActive === undefined ? {} : { isActive: query.isActive === 'true' },
        query.category ? { category: query.category } : {},
        query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { description: { contains: query.q, mode: 'insensitive' } },
                { version: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.companyPolicy.count({ where }),
      prisma.companyPolicy.findMany({
        where,
        skip,
        take,
        orderBy: [{ effectiveDate: 'desc' }, { name: 'asc' }],
        include: {
          _count: { select: { assignments: true } },
          assignments: { where: { status: 'ACKNOWLEDGED' }, select: { id: true } },
        },
      }),
    ]);

    const data: PolicyRecord[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      category: row.category,
      description: row.description,
      effectiveDate: day(row.effectiveDate)!,
      documentUrl: row.documentUrl,
      documentName: row.documentName,
      isActive: row.isActive,
      supersedesId: row.supersedesId,
      assignedCount: row._count.assignments,
      acknowledgedCount: row.assignments.length,
      createdAt: row.createdAt.toISOString(),
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(policyInputSchema, request.body);

      const duplicate = await prisma.companyPolicy.findFirst({
        where: { companyId: auth.companyId, name: input.name, version: input.version },
        select: { id: true },
      });
      if (duplicate) {
        throw new ValidationError({
          version: [`Version ${input.version} of “${input.name}” already exists.`],
        });
      }

      let supersedes: { id: string; name: string; version: string } | null = null;
      if (input.supersedesId) {
        supersedes = await prisma.companyPolicy.findFirst({
          where: { id: input.supersedesId, companyId: auth.companyId },
          select: { id: true, name: true, version: true },
        });
        if (!supersedes) {
          throw new ValidationError({ supersedesId: ['That policy version does not exist.'] });
        }

        const alreadyReplaced = await prisma.companyPolicy.findFirst({
          where: { supersedesId: supersedes.id },
          select: { id: true, version: true },
        });
        if (alreadyReplaced) {
          throw new ValidationError({
            supersedesId: [
              `That version has already been replaced by version ${alreadyReplaced.version}.`,
            ],
          });
        }
      }

      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.companyPolicy.create({
          data: {
            companyId: auth.companyId,
            name: input.name,
            version: input.version,
            category: input.category,
            description: input.description,
            effectiveDate: toDateOnly(input.effectiveDate),
            documentUrl: input.documentUrl,
            documentName: input.documentName,
            isActive: input.isActive,
            supersedesId: supersedes?.id ?? null,
            createdBy: auth.userId,
          },
        });

        // The replaced version stops being assignable. Its acknowledgements
        // are untouched: they record what was true when they were given.
        if (supersedes) {
          await tx.companyPolicy.update({
            where: { id: supersedes.id },
            data: { isActive: false },
          });
        }

        return row;
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'policy.create',
        entityType: 'CompanyPolicy',
        entityId: created.id,
        summary: supersedes
          ? `Published ${input.name} version ${input.version}, replacing version ${supersedes.version}`
          : `Published ${input.name} version ${input.version}`,
        after: { name: input.name, version: input.version, effectiveDate: input.effectiveDate },
        request,
      });

      return reply.status(201).send({ data: { id: created.id } });
    },
  );

  /**
   * Corrections only.
   *
   * The version label and the text-bearing document are deliberately editable
   * ONLY while nobody has acknowledged the policy. Once somebody has, the only
   * honest way to change what it says is a new version.
   */
  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(policyPatchSchema, request.body);

      const before = await prisma.companyPolicy.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!before) throw new NotFoundError('Policy');

      const acknowledged = await prisma.employeePolicyAssignment.count({
        where: { policyId: id, status: { not: 'PENDING' } },
      });

      const changesText =
        input.documentUrl !== undefined ||
        input.documentName !== undefined ||
        input.effectiveDate !== undefined;

      if (acknowledged > 0 && changesText) {
        throw new ValidationError({
          documentUrl: [
            `${acknowledged} employee(s) have already responded to this version. Publish a new version instead of changing this one.`,
          ],
        });
      }

      const updated = await prisma.companyPolicy.update({
        where: { id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.effectiveDate === undefined
            ? {}
            : { effectiveDate: toDateOnly(input.effectiveDate) }),
          ...(input.documentUrl === undefined ? {} : { documentUrl: input.documentUrl }),
          ...(input.documentName === undefined ? {} : { documentName: input.documentName }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'policy.update',
        entityType: 'CompanyPolicy',
        entityId: id,
        summary: `Updated ${updated.name} version ${updated.version}`,
        after: input as unknown as Record<string, unknown>,
        request,
      });

      return reply.send({ data: { id } });
    },
  );

  /** Assign a policy to named employees, or to everyone currently employed. */
  app.post(
    '/assign',
    { preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(policyAssignSchema, request.body);

      const policy = await prisma.companyPolicy.findFirst({
        where: { id: input.policyId, companyId: auth.companyId },
      });
      if (!policy) throw new ValidationError({ policyId: ['That policy does not exist.'] });
      if (!policy.isActive) {
        throw new ValidationError({
          policyId: ['That version has been withdrawn. Assign the current version instead.'],
        });
      }

      const scopeFilter = await employeeScopeFilter(auth);
      if (scopeFilter === null) throw new ForbiddenError('You do not have access to those employees.');

      const targets = await prisma.employee.findMany({
        where: {
          AND: [
            { companyId: auth.companyId },
            scopeFilter,
            input.employeeIds.length > 0
              ? { id: { in: input.employeeIds } }
              : // "Everyone" means everyone still employed. Assigning a policy
                // to someone who left is paperwork nobody can complete.
                { status: { notIn: ['TERMINATED', 'RESIGNED'] } },
          ],
        },
        select: { id: true },
      });

      if (targets.length === 0) {
        throw new ValidationError({ employeeIds: ['No employees matched.'] });
      }

      const dueDate = input.dueDate ? toDateOnly(input.dueDate) : null;

      // skipDuplicates rather than upsert: an employee who already holds this
      // version keeps the assignment - and the acknowledgement - they have.
      // Re-assigning must never reset somebody's signature to pending.
      const result = await prisma.employeePolicyAssignment.createMany({
        data: targets.map((employee) => ({
          companyId: auth.companyId,
          policyId: policy.id,
          employeeId: employee.id,
          assignedBy: auth.userId,
          dueDate,
        })),
        skipDuplicates: true,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'policy.assign',
        entityType: 'CompanyPolicy',
        entityId: policy.id,
        summary: `Assigned ${policy.name} version ${policy.version} to ${result.count} employee(s)`,
        after: { assigned: result.count, considered: targets.length, dueDate: input.dueDate ?? null },
        request,
      });

      return reply.status(201).send({
        data: { assigned: result.count, alreadyAssigned: targets.length - result.count },
      });
    },
  );
};

// ---------------------------------------------------------------- assignments

export const policyAssignmentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.POLICY_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(policyAssignmentQuerySchema, request.query);

    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const self = await prisma.employee.findFirst({
      where: { companyId: auth.companyId, userId: auth.userId },
      select: { id: true },
    });

    const where: Prisma.EmployeePolicyAssignmentWhereInput = {
      AND: [
        { companyId: auth.companyId },
        { employee: scopeFilter },
        query.view === 'mine' ? { employeeId: self?.id ?? '__none__' } : {},
        query.policyId ? { policyId: query.policyId } : {},
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.status ? { status: query.status } : {},
        query.q
          ? {
              OR: [
                { policy: { name: { contains: query.q, mode: 'insensitive' } } },
                { employee: { firstName: { contains: query.q, mode: 'insensitive' } } },
                { employee: { lastName: { contains: query.q, mode: 'insensitive' } } },
              ],
            }
          : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.employeePolicyAssignment.count({ where }),
      prisma.employeePolicyAssignment.findMany({
        where,
        skip,
        take,
        orderBy: [{ status: 'asc' }, { assignedAt: 'desc' }],
        include: ASSIGNMENT_INCLUDE,
      }),
    ]);

    return reply.send({
      data: rows.map((row) => toAssignmentRecord(row, self?.id ?? null)),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  /**
   * Acknowledge, or decline, a policy assigned to you.
   *
   * No permission of its own beyond policy.read: the gate is that the
   * assignment has to be yours. An acknowledgement is a statement about
   * yourself, and one made on somebody's behalf is worthless.
   */
  app.post('/:id/acknowledge', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const input = parseOrThrow(policyAcknowledgeSchema, request.body ?? {});

    const assignment = await prisma.employeePolicyAssignment.findFirst({
      where: { id, companyId: auth.companyId },
      include: ASSIGNMENT_INCLUDE,
    });
    if (!assignment) throw new NotFoundError('Policy assignment');

    const self = await prisma.employee.findFirst({
      where: { companyId: auth.companyId, userId: auth.userId },
      select: { id: true },
    });
    if (!self || self.id !== assignment.employeeId) {
      throw new ForbiddenError('Only the employee a policy was assigned to can acknowledge it.');
    }

    if (assignment.status !== 'PENDING') {
      throw new ValidationError({
        status: ['You have already responded to this policy.'],
      });
    }

    const updated = await prisma.employeePolicyAssignment.update({
      where: { id },
      data: {
        status: input.status,
        acknowledgedAt: new Date(),
        note: input.note,
      },
      include: ASSIGNMENT_INCLUDE,
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: input.status === 'ACKNOWLEDGED' ? 'policy.acknowledge' : 'policy.decline',
      entityType: 'EmployeePolicyAssignment',
      entityId: id,
      summary: `${input.status === 'ACKNOWLEDGED' ? 'Acknowledged' : 'Declined'} ${assignment.policy.name} version ${assignment.policy.version}`,
      after: { status: input.status, note: input.note ?? null },
      request,
    });

    return reply.send({ data: toAssignmentRecord(updated, self.id) });
  });

  /**
   * Deliberately absent: DELETE.
   *
   * An assignment is the record that somebody was asked to read a policy, and
   * an acknowledgement is the record that they did. Neither is removable; a
   * policy that no longer applies is withdrawn by deactivating the version.
   */
  app.delete('/:id', async () => {
    throw new ForbiddenError(
      'Policy assignments cannot be deleted. Withdraw the policy version instead so the acknowledgement history is retained.',
    );
  });
};
