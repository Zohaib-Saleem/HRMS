import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type ShiftAssignmentRecord,
  type ShiftRecord,
  idParamSchema,
  paginationQuerySchema,
  shiftAssignmentSchema,
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

const SORTABLE = ['name', 'startTime', 'createdAt'] as const;

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

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

    const data: ShiftRecord[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code,
      startTime: row.startTime,
      endTime: row.endTime,
      breakMinutes: row.breakMinutes,
      isActive: row.isActive,
      assignedCount: row._count.assignments,
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.SHIFT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(shiftInputSchema, request.body);

      const created = await prisma.shift.create({
        data: { ...input, companyId: auth.companyId },
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

      const updated = await prisma.shift.update({ where: { id }, data: input });

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
    const query = parseOrThrow(paginationQuerySchema, request.query);

    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    const where: Prisma.EmployeeShiftAssignmentWhereInput = {
      AND: [{ companyId: auth.companyId }, { employee: scopeFilter }],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.employeeShiftAssignment.count({ where }),
      prisma.employeeShiftAssignment.findMany({
        where,
        skip,
        take,
        orderBy: { effectiveFrom: 'desc' },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, displayName: true } },
          shift: { select: { id: true, name: true } },
        },
      }),
    ]);

    const data: ShiftAssignmentRecord[] = rows.map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      employeeName: displayName(row.employee),
      shiftId: row.shiftId,
      shiftName: row.shift.name,
      effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
      effectiveTo: row.effectiveTo?.toISOString().slice(0, 10) ?? null,
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

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
