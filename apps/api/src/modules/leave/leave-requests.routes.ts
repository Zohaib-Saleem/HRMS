import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  PERMISSIONS,
  type ApprovalStatus,
  type LeaveBalanceRecord,
  type LeaveDayPart,
  type LeaveRequestRecord,
  balanceAdjustmentSchema,
  idParamSchema,
  leaveCancelSchema,
  leaveRequestCreateSchema,
  leaveRequestQuerySchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import {
  cancel as cancelApproval,
  createApprovalRequest,
  resolveDefaultApprovers,
  syncSubjectStatus,
} from '../../core/approvals/approval.service.js';
import { callerEmployeeOrThrow } from '../time/helpers.js';
import {
  assertNoOverlap,
  balancesForEmployee,
  carryForwardYear,
  countWorkingDays,
  toDateOnly,
  toNumber,
} from './leave.service.js';

const INCLUDE = {
  employee: { select: { id: true, firstName: true, lastName: true, displayName: true } },
  leaveType: { select: { id: true, name: true, isPaid: true } },
} satisfies Prisma.LeaveRequestInclude;

type Row = Prisma.LeaveRequestGetPayload<{ include: typeof INCLUDE }>;

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

function toRecord(row: Row, callerEmployeeId: string | null, isAdmin: boolean): LeaveRequestRecord {
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: displayName(row.employee),
    leaveTypeId: row.leaveTypeId,
    leaveTypeName: row.leaveType.name,
    isPaid: row.leaveType.isPaid,
    startDate: row.startDate.toISOString().slice(0, 10),
    endDate: row.endDate.toISOString().slice(0, 10),
    dayPart: row.dayPart as LeaveDayPart,
    totalDays: toNumber(row.totalDays),
    reason: row.reason,
    status: row.status as ApprovalStatus,
    approvalRequestId: row.approvalRequestId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    // Only a live request can be withdrawn, and only by its owner or an admin.
    canCancel:
      row.status === 'PENDING' && (isAdmin || (callerEmployeeId !== null && row.employeeId === callerEmployeeId)),
  };
}

export const leaveRequestRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.LEAVE_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(leaveRequestQuerySchema, request.query);

    // Leave inherits the employee data scope exactly.
    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    const self = await prisma.employee.findFirst({
      where: { companyId: auth.companyId, userId: auth.userId },
      select: { id: true },
    });

    const where: Prisma.LeaveRequestWhereInput = {
      AND: [
        { companyId: auth.companyId },
        { employee: scopeFilter },
        query.view === 'mine' && self ? { employeeId: self.id } : {},
        query.status ? { status: query.status } : {},
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.leaveTypeId ? { leaveTypeId: query.leaveTypeId } : {},
        query.from ? { endDate: { gte: toDateOnly(query.from) } } : {},
        query.to ? { startDate: { lte: toDateOnly(query.to) } } : {},
        query.q
          ? {
              OR: [
                { reason: { contains: query.q, mode: 'insensitive' } },
                { employee: { firstName: { contains: query.q, mode: 'insensitive' } } },
                { employee: { lastName: { contains: query.q, mode: 'insensitive' } } },
                { leaveType: { name: { contains: query.q, mode: 'insensitive' } } },
              ],
            }
          : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.leaveRequest.count({ where }),
      prisma.leaveRequest.findMany({
        where,
        skip,
        take,
        orderBy: { startDate: 'desc' },
        include: INCLUDE,
      }),
    ]);

    const isAdmin = auth.permissions.has(PERMISSIONS.LEAVE_MANAGE);
    return reply.send({
      data: rows.map((row) => toRecord(row, self?.id ?? null, isAdmin)),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await prisma.leaveRequest.findFirst({
      where: { id, companyId: auth.companyId },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundError('Leave request');

    await assertEmployeeInScope(auth, row.employeeId);

    const self = await prisma.employee.findFirst({
      where: { companyId: auth.companyId, userId: auth.userId },
      select: { id: true },
    });

    return reply.send({
      data: toRecord(row, self?.id ?? null, auth.permissions.has(PERMISSIONS.LEAVE_MANAGE)),
    });
  });

  /**
   * Raise leave for yourself.
   *
   * Validation order matters: dates, then overlap, then working-day count, then
   * balance. Counting days before checking the balance is what makes "you only
   * have 2.5 days left" possible instead of a vague rejection.
   */
  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.LEAVE_REQUEST) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(leaveRequestCreateSchema, request.body);

      const self = await callerEmployeeOrThrow(auth);

      const employee = await prisma.employee.findUniqueOrThrow({
        where: { id: self.id },
        select: { locationId: true },
      });

      const leaveType = await prisma.leaveType.findFirst({
        where: { id: input.leaveTypeId, companyId: auth.companyId, isActive: true },
      });
      if (!leaveType) {
        throw new ValidationError({ leaveTypeId: ['That leave type does not exist or is inactive.'] });
      }

      const start = toDateOnly(input.startDate);
      const end = toDateOnly(input.endDate);

      await assertNoOverlap(self.id, start, end);

      const totalDays = await countWorkingDays(
        auth.companyId,
        employee.locationId,
        start,
        end,
        input.dayPart,
      );

      if (totalDays <= 0) {
        throw new ValidationError({
          startDate: ['That range contains no working days - it is all weekend or holiday.'],
        });
      }

      // Pending requests are already deducted inside availableDays, so stacking
      // requests before anyone approves them cannot overspend the balance.
      const balances = await balancesForEmployee(auth.companyId, self.id, start.getUTCFullYear());
      const balance = balances.find((b) => b.leaveTypeId === leaveType.id);
      const available = balance?.availableDays ?? 0;

      if (totalDays > available) {
        throw new ValidationError({
          leaveTypeId: [
            `That is ${totalDays} day(s) but only ${available} day(s) of ${leaveType.name} remain, counting leave already awaiting approval.`,
          ],
        });
      }

      const created = await prisma.leaveRequest.create({
        data: {
          companyId: auth.companyId,
          employeeId: self.id,
          leaveTypeId: leaveType.id,
          startDate: start,
          endDate: end,
          dayPart: input.dayPart,
          totalDays,
          reason: input.reason,
          status: 'PENDING',
        },
      });

      // Same engine as attendance, shifts and timesheets - no second workflow.
      const approvers = await resolveDefaultApprovers(auth.companyId, self.id);
      const approval = await createApprovalRequest({
        companyId: auth.companyId,
        subjectType: 'LEAVE_REQUEST',
        subjectId: created.id,
        requesterEmployeeId: self.id,
        requesterUserId: auth.userId,
        title: `${leaveType.name}: ${input.startDate} to ${input.endDate} (${totalDays} day${totalDays === 1 ? '' : 's'})`,
        summary: input.reason,
        approverEmployeeIds: approvers,
        request,
      });

      await prisma.leaveRequest.update({
        where: { id: created.id },
        data: { approvalRequestId: approval.id },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'leave.request.create',
        entityType: 'LeaveRequest',
        entityId: created.id,
        summary: `Requested ${totalDays} day(s) of ${leaveType.name} from ${input.startDate}`,
        after: { leaveType: leaveType.name, totalDays, startDate: input.startDate, endDate: input.endDate },
        request,
      });

      return reply.status(201).send({
        data: { id: created.id, approvalRequestId: approval.id, totalDays },
      });
    },
  );

  /**
   * Withdraw a request. Delegates to the approval engine so the cancellation is
   * recorded in the same history as every other transition, then mirrors back.
   */
  app.post(
    '/:id/cancel',
    { preHandler: requirePermission(PERMISSIONS.LEAVE_REQUEST) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const body = parseOrThrow(leaveCancelSchema, request.body ?? {});

      const leave = await prisma.leaveRequest.findFirst({
        where: { id, companyId: auth.companyId },
        include: INCLUDE,
      });
      if (!leave) throw new NotFoundError('Leave request');

      const self = await prisma.employee.findFirst({
        where: { companyId: auth.companyId, userId: auth.userId },
        select: { id: true },
      });
      const isOwner = Boolean(self && leave.employeeId === self.id);
      const isAdmin = auth.permissions.has(PERMISSIONS.LEAVE_MANAGE);

      if (!isOwner && !isAdmin) {
        throw new ForbiddenError('Only the person who requested leave can cancel it.');
      }

      if (!leave.approvalRequestId) {
        throw new NotFoundError('Approval record for this leave request');
      }

      const updated = await cancelApproval(auth, leave.approvalRequestId, body.reason ?? null, request);
      await syncSubjectStatus('LEAVE_REQUEST', leave.id, updated.status);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'leave.request.cancel',
        entityType: 'LeaveRequest',
        entityId: leave.id,
        summary: `Cancelled ${toNumber(leave.totalDays)} day(s) of ${leave.leaveType.name}`,
        request,
      });

      return reply.send({ data: { id: leave.id, status: updated.status } });
    },
  );
};

/** Balances and the carry-forward run. */
export const leaveBalanceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.LEAVE_READ));

  /** The caller's own balances. Needs no scope check - it is always self. */
  app.get('/me', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(
      z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }),
      request.query,
    );

    const self = await callerEmployeeOrThrow(auth);
    const year = query.year ?? new Date().getUTCFullYear();
    const data: LeaveBalanceRecord[] = await balancesForEmployee(auth.companyId, self.id, year);

    return reply.send({ data });
  });

  /** Someone else's balances, gated by the employee data scope. */
  app.get('/employee/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const query = parseOrThrow(
      z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }),
      request.query,
    );

    await assertEmployeeInScope(auth, id);

    const year = query.year ?? new Date().getUTCFullYear();
    const data: LeaveBalanceRecord[] = await balancesForEmployee(auth.companyId, id, year);

    return reply.send({ data });
  });

  app.post(
    '/adjust',
    { preHandler: requirePermission(PERMISSIONS.LEAVE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(balanceAdjustmentSchema, request.body);

      await assertEmployeeInScope(auth, input.employeeId);

      const leaveType = await prisma.leaveType.findFirst({
        where: { id: input.leaveTypeId, companyId: auth.companyId },
        select: { id: true, name: true },
      });
      if (!leaveType) throw new ValidationError({ leaveTypeId: ['That leave type does not exist.'] });

      const saved = await prisma.leaveBalance.upsert({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: input.employeeId,
            leaveTypeId: input.leaveTypeId,
            year: input.year,
          },
        },
        create: {
          companyId: auth.companyId,
          employeeId: input.employeeId,
          leaveTypeId: input.leaveTypeId,
          year: input.year,
          adjustmentDays: input.adjustmentDays,
          adjustmentNote: input.adjustmentNote ?? null,
        },
        update: {
          adjustmentDays: input.adjustmentDays,
          adjustmentNote: input.adjustmentNote ?? null,
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'leave.balance.adjust',
        entityType: 'LeaveBalance',
        entityId: saved.id,
        summary: `Adjusted ${leaveType.name} balance by ${input.adjustmentDays} day(s) for ${input.year}`,
        after: { adjustmentDays: input.adjustmentDays, note: input.adjustmentNote ?? null },
        request,
      });

      return reply.send({ data: { id: saved.id } });
    },
  );

  /**
   * Year-end carry-forward. Deliberately an explicit administrative action
   * rather than a hidden scheduled job, so the year it ran for is a decision
   * someone made and can be seen in the audit log.
   */
  app.post(
    '/carry-forward',
    { preHandler: requirePermission(PERMISSIONS.LEAVE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(
        z.object({ fromYear: z.coerce.number().int().min(2000).max(2100) }),
        request.body,
      );

      const result = await carryForwardYear(auth.companyId, input.fromYear);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'leave.carry_forward',
        entityType: 'LeaveBalance',
        summary: `Carried leave forward from ${input.fromYear} to ${input.fromYear + 1} (${result.processed} balance record(s))`,
        request,
      });

      return reply.send({ data: result });
    },
  );
};
