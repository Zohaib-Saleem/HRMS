import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type AttendancePolicyAssignmentRecord,
  type AttendancePolicyRecord,
  type AttendancePolicyScope,
  type EffectivePolicyView,
  attendancePolicyAssignmentSchema,
  attendancePolicyInputSchema,
  effectivePolicyQuerySchema,
  idParamSchema,
  paginationQuerySchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope } from '../../auth/scope.js';
import { toDateOnly } from './helpers.js';
import { resolvePolicyFor } from './attendance-policy.js';

/**
 * Scoped attendance policies.
 *
 * These are overrides, not the source of truth. The Company row still carries
 * the baseline every employee falls back to, so a company that never creates a
 * policy behaves exactly as it did before this module existed. That is what
 * keeps the feature additive rather than a migration everyone has to perform.
 *
 * Managed under `company.manage`, the same permission that already guards the
 * baseline: a policy changes how time is scored company-wide, which is an
 * administrative decision rather than an attendance one. No new permission was
 * added, so the registry and every existing role are untouched.
 */

const toRecord = (
  row: Prisma.AttendancePolicyGetPayload<{ include: { _count: { select: { assignments: true } } } }>,
): AttendancePolicyRecord => ({
  id: row.id,
  name: row.name,
  description: row.description,
  graceMinutes: row.graceMinutes,
  halfDayMinutes: row.halfDayMinutes,
  fullDayMinutes: row.fullDayMinutes,
  earlyLeaveGraceMinutes: row.earlyLeaveGraceMinutes,
  overtimeEnabled: row.overtimeEnabled,
  overtimeAfterMinutes: row.overtimeAfterMinutes,
  overtimeDailyCapMinutes: row.overtimeDailyCapMinutes,
  isActive: row.isActive,
  assignmentCount: row._count.assignments,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** Confirms an assignment target exists and belongs to this company. */
async function assertTargetExists(
  companyId: string,
  scope: AttendancePolicyScope,
  targetId: string | null,
): Promise<void> {
  if (scope === 'COMPANY') return;
  if (!targetId) throw new ValidationError({ targetId: ['Choose who this applies to.'] });

  const found =
    scope === 'DEPARTMENT'
      ? await prisma.department.findFirst({ where: { id: targetId, companyId }, select: { id: true } })
      : scope === 'TEAM'
        ? await prisma.team.findFirst({ where: { id: targetId, companyId }, select: { id: true } })
        : await prisma.employee.findFirst({ where: { id: targetId, companyId }, select: { id: true } });

  if (!found) {
    throw new ValidationError({ targetId: ['That department, team or employee does not exist.'] });
  }
}

export const attendancePolicyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.COMPANY_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(paginationQuerySchema, request.query);

    const where: Prisma.AttendancePolicyWhereInput = {
      companyId: auth.companyId,
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.attendancePolicy.count({ where }),
      prisma.attendancePolicy.findMany({
        where,
        skip,
        take,
        orderBy: { name: 'asc' },
        include: { _count: { select: { assignments: true } } },
      }),
    ]);

    return reply.send({
      data: rows.map(toRecord),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(attendancePolicyInputSchema, request.body);

      const duplicate = await prisma.attendancePolicy.findFirst({
        where: { companyId: auth.companyId, name: input.name },
        select: { id: true },
      });
      if (duplicate) throw new ConflictError('A policy with that name already exists.');

      const created = await prisma.attendancePolicy.create({
        data: { companyId: auth.companyId, ...input },
        include: { _count: { select: { assignments: true } } },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'attendance.policy.create',
        entityType: 'AttendancePolicy',
        entityId: created.id,
        summary: `Created attendance policy "${created.name}"`,
        after: { ...input },
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
      const input = parseOrThrow(attendancePolicyInputSchema, request.body);

      const before = await prisma.attendancePolicy.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!before) throw new NotFoundError('Attendance policy');

      const clash = await prisma.attendancePolicy.findFirst({
        where: { companyId: auth.companyId, name: input.name, NOT: { id } },
        select: { id: true },
      });
      if (clash) throw new ConflictError('A policy with that name already exists.');

      const updated = await prisma.attendancePolicy.update({
        where: { id },
        data: input,
        include: { _count: { select: { assignments: true } } },
      });

      const changes = diff(
        before as unknown as Record<string, unknown>,
        input as unknown as Record<string, unknown>,
      );
      if (changes.changed.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'attendance.policy.update',
          entityType: 'AttendancePolicy',
          entityId: id,
          summary: `Updated attendance policy "${updated.name}" (${changes.changed.join(', ')})`,
          before: changes.before,
          after: changes.after,
          request,
        });
      }

      return reply.send({ data: toRecord(updated) });
    },
  );

  /**
   * Removing a policy removes its assignments with it, so anyone it covered
   * falls back to the company baseline. Stored attendance is never rewritten -
   * a day already scored keeps the numbers it was scored with.
   */
  app.delete(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const policy = await prisma.attendancePolicy.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!policy) throw new NotFoundError('Attendance policy');

      await prisma.attendancePolicy.delete({ where: { id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'attendance.policy.delete',
        entityType: 'AttendancePolicy',
        entityId: id,
        summary: `Deleted attendance policy "${policy.name}"`,
        before: { name: policy.name },
        request,
      });

      return reply.send({ data: { id } });
    },
  );

  // --- assignments ---------------------------------------------------------

  app.get('/assignments', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(paginationQuerySchema, request.query);

    const { skip, take } = toSkipTake(query.page, query.limit);
    const where: Prisma.AttendancePolicyAssignmentWhereInput = { companyId: auth.companyId };

    const [total, rows] = await Promise.all([
      prisma.attendancePolicyAssignment.count({ where }),
      prisma.attendancePolicyAssignment.findMany({
        where,
        skip,
        take,
        orderBy: [{ scope: 'asc' }, { effectiveFrom: 'desc' }],
        include: { policy: { select: { name: true } } },
      }),
    ]);

    // Target names come from three tables; resolved in one pass per kind
    // rather than a query per row.
    const ids = (scope: AttendancePolicyScope) =>
      rows.filter((r) => r.scope === scope && r.targetId).map((r) => r.targetId as string);

    const [departments, teams, employees] = await Promise.all([
      prisma.department.findMany({ where: { id: { in: ids('DEPARTMENT') } }, select: { id: true, name: true } }),
      prisma.team.findMany({ where: { id: { in: ids('TEAM') } }, select: { id: true, name: true } }),
      prisma.employee.findMany({
        where: { id: { in: ids('EMPLOYEE') } },
        select: { id: true, firstName: true, lastName: true, displayName: true },
      }),
    ]);

    const names = new Map<string, string>();
    for (const d of departments) names.set(d.id, d.name);
    for (const t of teams) names.set(t.id, t.name);
    for (const e of employees) {
      names.set(e.id, e.displayName ?? `${e.firstName} ${e.lastName}`.trim());
    }

    const data: AttendancePolicyAssignmentRecord[] = rows.map((row) => ({
      id: row.id,
      policyId: row.policyId,
      policyName: row.policy.name,
      scope: row.scope as AttendancePolicyScope,
      targetId: row.targetId,
      targetName: row.targetId ? (names.get(row.targetId) ?? null) : null,
      effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
      effectiveTo: row.effectiveTo?.toISOString().slice(0, 10) ?? null,
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  app.post(
    '/assignments',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(attendancePolicyAssignmentSchema, request.body);

      const policy = await prisma.attendancePolicy.findFirst({
        where: { id: input.policyId, companyId: auth.companyId },
        select: { id: true, name: true },
      });
      if (!policy) throw new ValidationError({ policyId: ['That policy does not exist.'] });

      const targetId = input.scope === 'COMPANY' ? null : (input.targetId ?? null);
      await assertTargetExists(auth.companyId, input.scope, targetId);

      const created = await prisma.attendancePolicyAssignment.create({
        data: {
          companyId: auth.companyId,
          policyId: input.policyId,
          scope: input.scope,
          targetId,
          effectiveFrom: toDateOnly(input.effectiveFrom),
          effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null,
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'attendance.policy.assign',
        entityType: 'AttendancePolicyAssignment',
        entityId: created.id,
        summary: `Applied "${policy.name}" at ${input.scope.toLowerCase()} scope from ${input.effectiveFrom.slice(0, 10)}`,
        after: { scope: input.scope, targetId, effectiveFrom: input.effectiveFrom },
        request,
      });

      return reply.status(201).send({ data: { id: created.id } });
    },
  );

  app.delete(
    '/assignments/:id',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const assignment = await prisma.attendancePolicyAssignment.findFirst({
        where: { id, companyId: auth.companyId },
        include: { policy: { select: { name: true } } },
      });
      if (!assignment) throw new NotFoundError('Policy assignment');

      await prisma.attendancePolicyAssignment.delete({ where: { id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'attendance.policy.unassign',
        entityType: 'AttendancePolicyAssignment',
        entityId: id,
        summary: `Removed "${assignment.policy.name}" from ${assignment.scope.toLowerCase()} scope`,
        request,
      });

      return reply.send({ data: { id } });
    },
  );

  /**
   * What actually applies to one person on one day.
   *
   * Answers "why was this day scored that way?" without anyone having to
   * reproduce the precedence rules by hand. Scope-checked, so it cannot be used
   * to read the arrangements of someone the caller may not see.
   */
  app.get('/effective', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(effectivePolicyQuerySchema, request.query);

    const employeeId = query.employeeId;
    await assertEmployeeInScope(auth, employeeId);

    const date = toDateOnly(query.on ?? new Date().toISOString());
    const resolved = await resolvePolicyFor(auth.companyId, employeeId, date);

    const view: EffectivePolicyView = {
      employeeId,
      date: date.toISOString().slice(0, 10),
      policyId: resolved.policyId,
      policyName: resolved.policyName,
      scope: resolved.scope as AttendancePolicyScope | null,
      graceMinutes: resolved.graceMinutes,
      halfDayMinutes: resolved.halfDayMinutes,
      fullDayMinutes: resolved.fullDayMinutes,
      earlyLeaveGraceMinutes: resolved.earlyLeaveGraceMinutes,
      overtimeEnabled: resolved.overtimeEnabled,
      overtimeAfterMinutes: resolved.overtimeAfterMinutes,
      overtimeDailyCapMinutes: resolved.overtimeDailyCapMinutes,
    };

    return reply.send({ data: view });
  });
};
