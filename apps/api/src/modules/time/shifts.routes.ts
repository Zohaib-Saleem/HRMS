import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type ShiftAssignmentRecord,
  type ShiftRecord,
  idParamSchema,
  paginationQuerySchema,
  shiftAssignmentQuerySchema,
  shiftAssignmentSchema,
  shiftAssignmentUpdateSchema,
  shiftChangeRequestSchema,
  shiftInputSchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import {
  createApprovalRequest,
  resolveDefaultApprovers,
} from '../../core/approvals/approval.service.js';
import { callerEmployeeOrThrow, toDateOnly } from './helpers.js';
import { isInvertedRange, overlappingAssignmentWhere } from './shift-assignment.js';
import { expectedMinutesFor, resolveAttendancePolicy } from './attendance-policy.js';
import { todayInZone } from '../../core/zoned-time.js';

const SORTABLE = ['name', 'startTime', 'createdAt'] as const;

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

/** An optional date-only input for a `@db.Date` column. */
const shiftDate = (value: string | null | undefined): Date | null =>
  value ? toDateOnly(value) : null;

/**
 * A shift as the screens read it.
 *
 * `effectiveExpectedMinutes` is resolved through the engine's own
 * `expectedMinutesFor`, so the figure a roster shows is the figure attendance
 * is scored against - not a second calculation that agrees today and drifts
 * the moment the break rule changes.
 */
function toShiftRecord(
  row: {
    id: string;
    name: string;
    code: string | null;
    description: string | null;
    startTime: string;
    endTime: string;
    breakMinutes: number;
    isActive: boolean;
    workingDays: ShiftRecord['workingDays'];
    expectedMinutes: number | null;
    graceMinutes: number | null;
    earlyLeaveGraceMinutes: number | null;
    lateTrackingEnabled: boolean | null;
    earlyDepartureTrackingEnabled: boolean | null;
    overtimeEnabled: boolean | null;
    overtimeDailyCapMinutes: number | null;
    overtimeMinimumMinutes: number | null;
    effectiveFrom: Date | null;
  },
  policy: { breakIncludedInWindow: boolean },
  assignedCount: number,
): ShiftRecord {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    startTime: row.startTime,
    endTime: row.endTime,
    breakMinutes: row.breakMinutes,
    isActive: row.isActive,
    workingDays: row.workingDays,
    expectedMinutes: row.expectedMinutes,
    effectiveExpectedMinutes: expectedMinutesFor(row, policy),
    graceMinutes: row.graceMinutes,
    earlyLeaveGraceMinutes: row.earlyLeaveGraceMinutes,
    lateTrackingEnabled: row.lateTrackingEnabled,
    earlyDepartureTrackingEnabled: row.earlyDepartureTrackingEnabled,
    overtimeEnabled: row.overtimeEnabled,
    overtimeDailyCapMinutes: row.overtimeDailyCapMinutes,
    overtimeMinimumMinutes: row.overtimeMinimumMinutes,
    effectiveFrom: row.effectiveFrom?.toISOString().slice(0, 10) ?? null,
    assignedCount,
  };
}

export const shiftRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.SHIFT_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(paginationQuerySchema, request.query);

    const where: Prisma.ShiftWhereInput = {
      companyId: auth.companyId,
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { code: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.shift.count({ where }),
      prisma.shift.findMany({
        where,
        skip,
        take,
        orderBy: buildOrderBy(query.sort, query.order, SORTABLE, 'name'),
        include: { _count: { select: { assignments: true } } },
      }),
    ]);

    // The rostered length a shift actually contributes, resolved the same way
    // the engine resolves it, so the screen and the scoring cannot disagree
    // about how long a nine-to-six day is.
    const policy = await resolveAttendancePolicy(auth.companyId);
    const data: ShiftRecord[] = rows.map((row) => toShiftRecord(row, policy, row._count.assignments));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.SHIFT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(shiftInputSchema, request.body);

      const created = await prisma.shift.create({
        data: { ...input, effectiveFrom: shiftDate(input.effectiveFrom), companyId: auth.companyId },
        include: { _count: { select: { assignments: true } } },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'shift.create',
        entityType: 'Shift',
        entityId: created.id,
        summary: `Created shift ${created.name} (${created.startTime}-${created.endTime})`,
        after: input as unknown as Record<string, unknown>,
        request,
      });

      return reply.status(201).send({ data: { id: created.id } });
    },
  );

  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.SHIFT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(shiftInputSchema, request.body);

      const before = await prisma.shift.findFirst({ where: { id, companyId: auth.companyId } });
      if (!before) throw new NotFoundError('Shift');

      const updated = await prisma.shift.update({
        where: { id },
        data: { ...input, effectiveFrom: shiftDate(input.effectiveFrom) },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'shift.update',
        entityType: 'Shift',
        entityId: id,
        summary: `Updated shift ${updated.name}`,
        before: { name: before.name, startTime: before.startTime, endTime: before.endTime },
        after: { name: updated.name, startTime: updated.startTime, endTime: updated.endTime },
        request,
      });

      return reply.send({ data: { id: updated.id } });
    },
  );

  app.delete(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.SHIFT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const existing = await prisma.shift.findFirst({
        where: { id, companyId: auth.companyId },
        include: { _count: { select: { assignments: true } } },
      });
      if (!existing) throw new NotFoundError('Shift');

      if (existing._count.assignments > 0) {
        throw new ConflictError(
          `${existing._count.assignments} employee(s) are assigned to this shift. Reassign them first, or deactivate it instead.`,
        );
      }

      await prisma.shift.delete({ where: { id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'shift.delete',
        entityType: 'Shift',
        entityId: id,
        summary: `Deleted shift ${existing.name}`,
        request,
      });

      return reply.send({ data: { id } });
    },
  );

  // --- assignments ---------------------------------------------------------

  app.get('/assignments', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(shiftAssignmentQuerySchema, request.query);

    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    const policy = await resolveAttendancePolicy(auth.companyId);
    const todayKey = todayInZone(policy.timeZone);
    const today = new Date(`${todayKey}T00:00:00.000Z`);

    const where: Prisma.EmployeeShiftAssignmentWhereInput = {
      AND: [
        { companyId: auth.companyId },
        { employee: scopeFilter },
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.shiftId ? { shiftId: query.shiftId } : {},
        // "Current" means in force today or starting later - the roster as it
        // stands, without the history of every shift someone has ever been on.
        query.currentOnly === 'true'
          ? { OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] }
          : {},
      ],
    };

    // Asking for one person still goes through the scope check, so a guessed
    // id cannot widen what the caller sees.
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.employeeShiftAssignment.count({ where }),
      prisma.employeeShiftAssignment.findMany({
        where,
        skip,
        take,
        orderBy: { effectiveFrom: 'desc' },
        include: {
          employee: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              displayName: true,
              employeeNumber: true,
            },
          },
          shift: { select: { id: true, name: true, startTime: true, endTime: true } },
        },
      }),
    ]);

    const data: ShiftAssignmentRecord[] = rows.map((row) => {
      const from = row.effectiveFrom.toISOString().slice(0, 10);
      const to = row.effectiveTo?.toISOString().slice(0, 10) ?? null;
      return {
        id: row.id,
        employeeId: row.employeeId,
        employeeName: displayName(row.employee),
        employeeNumber: row.employee.employeeNumber,
        shiftId: row.shiftId,
        shiftName: row.shift.name,
        shiftStartTime: row.shift.startTime,
        shiftEndTime: row.shift.endTime,
        effectiveFrom: from,
        effectiveTo: to,
        isCurrent: from <= todayKey && (to === null || to >= todayKey),
      };
    });

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  /**
   * Closes or re-dates an assignment.
   *
   * The shift itself is never changed here: moving somebody to a different
   * shift is a new assignment with its own start date, which is what keeps
   * the days already scored against the old one intact.
   */
  app.patch(
    '/assignments/:id',
    { preHandler: requirePermission(PERMISSIONS.SHIFT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(shiftAssignmentUpdateSchema, request.body);

      const existing = await prisma.employeeShiftAssignment.findFirst({
        where: { id, companyId: auth.companyId },
        include: { shift: { select: { name: true } } },
      });
      if (!existing) throw new NotFoundError('Shift assignment');
      await assertEmployeeInScope(auth, existing.employeeId);

      const range = {
        effectiveFrom:
          input.effectiveFrom === undefined
            ? existing.effectiveFrom
            : toDateOnly(input.effectiveFrom),
        effectiveTo:
          input.effectiveTo === undefined
            ? existing.effectiveTo
            : input.effectiveTo
              ? toDateOnly(input.effectiveTo)
              : null,
      };

      if (isInvertedRange(range)) {
        throw new ValidationError({
          effectiveTo: ['The end date cannot be before the start date.'],
        });
      }

      const clash = await prisma.employeeShiftAssignment.findFirst({
        where: {
          companyId: auth.companyId,
          id: { not: existing.id },
          ...overlappingAssignmentWhere(existing.employeeId, range),
        },
        include: { shift: { select: { name: true } } },
      });
      if (clash) {
        throw new ConflictError(
          `Those dates overlap the ${clash.shift.name} assignment starting ${clash.effectiveFrom.toISOString().slice(0, 10)}.`,
        );
      }

      const updated = await prisma.employeeShiftAssignment.update({
        where: { id: existing.id },
        data: range,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'shift.assignment.update',
        entityType: 'EmployeeShiftAssignment',
        entityId: updated.id,
        summary: `Re-dated the ${existing.shift.name} assignment`,
        before: {
          effectiveFrom: existing.effectiveFrom.toISOString().slice(0, 10),
          effectiveTo: existing.effectiveTo?.toISOString().slice(0, 10) ?? null,
        },
        after: {
          effectiveFrom: updated.effectiveFrom.toISOString().slice(0, 10),
          effectiveTo: updated.effectiveTo?.toISOString().slice(0, 10) ?? null,
        },
        request,
      });

      return reply.send({ data: { id: updated.id } });
    },
  );

  app.post(
    '/assignments',
    { preHandler: requirePermission(PERMISSIONS.SHIFT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(shiftAssignmentSchema, request.body);

      await assertEmployeeInScope(auth, input.employeeId);

      const shift = await prisma.shift.findFirst({
        where: { id: input.shiftId, companyId: auth.companyId },
        select: { id: true, name: true },
      });
      if (!shift) throw new ValidationError({ shiftId: ['That shift does not exist.'] });

      const range = {
        effectiveFrom: toDateOnly(input.effectiveFrom),
        effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null,
      };

      if (isInvertedRange(range)) {
        throw new ValidationError({
          effectiveTo: ['The end date cannot be before the start date.'],
        });
      }

      /**
       * Two assignments covering the same day do not error at read time -
       * `shiftOnDate` just takes one of them - so a duplicate would quietly
       * score attendance against whichever shift happened to sort first. There
       * is no database constraint for this; refuse it here.
       */
      const clash = await prisma.employeeShiftAssignment.findFirst({
        where: {
          companyId: auth.companyId,
          ...overlappingAssignmentWhere(input.employeeId, range),
        },
        include: { shift: { select: { name: true } } },
      });

      if (clash) {
        const until = clash.effectiveTo
          ? clash.effectiveTo.toISOString().slice(0, 10)
          : 'no end date';
        throw new ConflictError(
          `That employee is already on ${clash.shift.name} from ${clash.effectiveFrom.toISOString().slice(0, 10)} (${until}). End that assignment before starting another.`,
        );
      }

      const created = await prisma.employeeShiftAssignment.create({
        data: {
          companyId: auth.companyId,
          employeeId: input.employeeId,
          shiftId: input.shiftId,
          effectiveFrom: toDateOnly(input.effectiveFrom),
          effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null,
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'shift.assign',
        entityType: 'EmployeeShiftAssignment',
        entityId: created.id,
        summary: `Assigned shift ${shift.name} from ${input.effectiveFrom}`,
        after: input as unknown as Record<string, unknown>,
        request,
      });

      return reply.status(201).send({ data: { id: created.id } });
    },
  );

  // --- change requests -----------------------------------------------------

  app.get('/change-requests', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(paginationQuerySchema, request.query);

    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    const where: Prisma.ShiftChangeRequestWhereInput = {
      AND: [{ companyId: auth.companyId }, { employee: scopeFilter }],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.shiftChangeRequest.count({ where }),
      prisma.shiftChangeRequest.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, displayName: true } },
          currentShift: { select: { name: true } },
          requestedShift: { select: { name: true } },
        },
      }),
    ]);

    return reply.send({
      data: rows.map((row) => ({
        id: row.id,
        employeeId: row.employeeId,
        employeeName: displayName(row.employee),
        currentShiftName: row.currentShift?.name ?? null,
        requestedShiftName: row.requestedShift.name,
        effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
        reason: row.reason,
        status: row.status,
        approvalRequestId: row.approvalRequestId,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  /** Ask to move to a different shift. Routed through the approval engine. */
  app.post('/change-requests', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(shiftChangeRequestSchema, request.body);

    const self = await callerEmployeeOrThrow(auth);

    const requestedShift = await prisma.shift.findFirst({
      where: { id: input.requestedShiftId, companyId: auth.companyId, isActive: true },
      select: { id: true, name: true },
    });
    if (!requestedShift) {
      throw new ValidationError({ requestedShiftId: ['That shift does not exist or is inactive.'] });
    }

    const pending = await prisma.shiftChangeRequest.findFirst({
      where: { employeeId: self.id, status: 'PENDING' },
      select: { id: true },
    });
    if (pending) throw new ConflictError('You already have a pending shift change request.');

    const currentAssignment = await prisma.employeeShiftAssignment.findFirst({
      where: { employeeId: self.id },
      orderBy: { effectiveFrom: 'desc' },
      select: { shiftId: true },
    });

    const created = await prisma.shiftChangeRequest.create({
      data: {
        companyId: auth.companyId,
        employeeId: self.id,
        currentShiftId: currentAssignment?.shiftId ?? null,
        requestedShiftId: requestedShift.id,
        effectiveFrom: toDateOnly(input.effectiveFrom),
        reason: input.reason,
        status: 'PENDING',
      },
    });

    const approvers = await resolveDefaultApprovers(auth.companyId, self.id);
    const approval = await createApprovalRequest({
      companyId: auth.companyId,
      subjectType: 'SHIFT_CHANGE',
      subjectId: created.id,
      requesterEmployeeId: self.id,
      requesterUserId: auth.userId,
      title: `Shift change to ${requestedShift.name}`,
      summary: input.reason,
      approverEmployeeIds: approvers,
      request,
    });

    await prisma.shiftChangeRequest.update({
      where: { id: created.id },
      data: { approvalRequestId: approval.id },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'shift.change_request.create',
      entityType: 'ShiftChangeRequest',
      entityId: created.id,
      summary: `Requested shift change to ${requestedShift.name} from ${input.effectiveFrom}`,
      request,
    });

    return reply.status(201).send({ data: { id: created.id, approvalRequestId: approval.id } });
  });
};
