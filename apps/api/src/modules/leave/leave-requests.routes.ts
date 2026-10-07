import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  PERMISSIONS,
  type ApprovalStatus,
  type LeaveBalanceRecord,
  type LeaveConflictCancellationResult,
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
import {
  assertEmployeeInScope,
  assertEmployeeInTeamScope,
  teamScopeFilter,
} from '../../auth/scope.js';
import {
  assertChainUsable,
  cancel as cancelApproval,
  createApprovalRequest,
  notifyApprover,
  resolveChain,
  syncSubjectStatus,
} from '../../core/approvals/approval.service.js';
import { callerEmployeeOrThrow } from '../time/helpers.js';
import {
  assertNoOverlap,
  balancesForEmployee,
  carryForwardYear,
  countWorkingDays,
  reversedDays,
  toDateOnly,
  toNumber,
} from './leave.service.js';
import {
  attendanceConflictsFor,
  cancelLeaveForAttendanceConflict,
  type AttendanceConflictDay,
} from './leave-reconciliation.service.js';

const INCLUDE = {
  employee: { select: { id: true, firstName: true, lastName: true, displayName: true } },
  leaveType: { select: { id: true, name: true, isPaid: true, isDeductible: true } },
  reversals: {
    select: {
      date: true,
      days: true,
      reason: true,
      checkInAt: true,
      checkOutAt: true,
      createdAt: true,
      reversedById: true,
    },
    orderBy: { date: 'asc' },
  },
} satisfies Prisma.LeaveRequestInclude;

type Row = Prisma.LeaveRequestGetPayload<{ include: typeof INCLUDE }>;

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

interface RecordContext {
  callerEmployeeId: string | null;
  isAdmin: boolean;
  /** `leave.conflict.resolve`: may cancel approved leave on a worked day. */
  canResolveConflicts: boolean;
  conflicts: Map<string, AttendanceConflictDay[]>;
}

function toRecord(row: Row, ctx: RecordContext): LeaveRequestRecord {
  const { callerEmployeeId, isAdmin } = ctx;
  const conflicts = ctx.conflicts.get(row.id) ?? [];
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: displayName(row.employee),
    leaveTypeId: row.leaveTypeId,
    leaveTypeName: row.leaveType.name,
    isPaid: row.leaveType.isPaid,
    isDeductible: row.leaveType.isDeductible,
    startDate: row.startDate.toISOString().slice(0, 10),
    endDate: row.endDate.toISOString().slice(0, 10),
    dayPart: row.dayPart as LeaveDayPart,
    totalDays: toNumber(row.totalDays),
    reason: row.reason,
    documentUrl: row.documentUrl,
    documentName: row.documentName,
    status: row.status as ApprovalStatus,
    approvalRequestId: row.approvalRequestId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledBySystem: row.cancelledBySystem ?? false,
    cancellationReason: row.cancellationReason ?? null,
    reversedDays: reversedDays(row),
    reversals: (row.reversals ?? []).map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      days: toNumber(r.days),
      reason: r.reason,
      checkInAt: r.checkInAt.toISOString(),
      checkOutAt: r.checkOutAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      manual: r.reversedById !== null,
    })),
    attendanceConflicts: conflicts.map((c) => ({
      date: c.dayKey,
      checkInAt: c.checkInAt.toISOString(),
      checkOutAt: c.checkOutAt?.toISOString() ?? null,
    })),
    createdAt: row.createdAt.toISOString(),
    // Only a live request can be withdrawn, and only by its owner or an admin.
    canCancel:
      row.status === 'PENDING' && (isAdmin || (callerEmployeeId !== null && row.employeeId === callerEmployeeId)),
    canResolveConflict: ctx.canResolveConflicts && row.status === 'APPROVED' && conflicts.length > 0,
  };
}

export const leaveRequestRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.LEAVE_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(leaveRequestQuerySchema, request.query);

    /*
     * Leave inherits the employee data scope, widened by the teams the caller
     * manages. A team manager opens their team's leave; nobody else's list
     * changes, because `teamScopeFilter` is the ordinary scope until an active
     * appointment says otherwise.
     */
    const scopeFilter = await teamScopeFilter(auth);
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

    const ctx: RecordContext = {
      callerEmployeeId: self?.id ?? null,
      isAdmin: auth.permissions.has(PERMISSIONS.LEAVE_MANAGE),
      canResolveConflicts: auth.permissions.has(PERMISSIONS.LEAVE_CONFLICT_RESOLVE),
      conflicts: await attendanceConflictsFor(rows),
    };
    return reply.send({
      data: rows.map((row) => toRecord(row, ctx)),
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

    await assertEmployeeInTeamScope(auth, row.employeeId);

    const self = await prisma.employee.findFirst({
      where: { companyId: auth.companyId, userId: auth.userId },
      select: { id: true },
    });

    return reply.send({
      data: toRecord(row, {
        callerEmployeeId: self?.id ?? null,
        isAdmin: auth.permissions.has(PERMISSIONS.LEAVE_MANAGE),
        canResolveConflicts: auth.permissions.has(PERMISSIONS.LEAVE_CONFLICT_RESOLVE),
        conflicts: await attendanceConflictsFor([row]),
      }),
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

      /**
       * Approvers are resolved and validated BEFORE anything is written.
       *
       * This used to happen after the leave request had already been inserted,
       * so an employee with no manager and no department head got a 422 and a
       * committed PENDING row with a null approvalRequestId: it consumed their
       * balance, blocked those dates against re-submission, and could not be
       * cancelled because the cancel path looks up the (missing) approval
       * record. Validating first means that failure now writes nothing at all.
       */
      const chain = await resolveChain(auth.companyId, 'LEAVE_REQUEST', self.id);
      assertChainUsable(chain, self.id);

      /**
       * The row and its approval record are one atomic unit. If either insert
       * fails - or the link-back update does - the whole thing rolls back and
       * the employee's balance is untouched.
       */
      const { created, approval } = await prisma.$transaction(async (tx) => {
        const created = await tx.leaveRequest.create({
          data: {
            companyId: auth.companyId,
            employeeId: self.id,
            leaveTypeId: leaveType.id,
            startDate: start,
            endDate: end,
            dayPart: input.dayPart,
            totalDays,
            reason: input.reason,
            documentUrl: input.documentUrl,
            documentName: input.documentName,
            status: 'PENDING',
          },
        });

        // Same engine as attendance, shifts and timesheets - no second workflow.
        const approval = await createApprovalRequest({
          companyId: auth.companyId,
          subjectType: 'LEAVE_REQUEST',
          subjectId: created.id,
          requesterEmployeeId: self.id,
          requesterUserId: auth.userId,
          title: `${leaveType.name}: ${input.startDate} to ${input.endDate} (${totalDays} day${totalDays === 1 ? '' : 's'})`,
          summary: input.reason,
          chain,
          request,
          client: tx,
          // Audit and notification are side effects; they run below, once the
          // transaction has actually committed.
          deferAudit: true,
        });

        await tx.leaveRequest.update({
          where: { id: created.id },
          data: { approvalRequestId: approval.id },
        });

        return { created, approval };
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'approval.submit',
        entityType: 'ApprovalRequest',
        entityId: approval.id,
        summary: `Submitted for approval: ${leaveType.name}`,
        after: { subjectType: 'LEAVE_REQUEST', subjectId: created.id, steps: chain.stages.length },
        request,
      });
      await notifyApprover(approval.id, 1, request);

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

  /**
   * Cancel approved leave because the employee attended work.
   *
   * Super Admin only (`leave.conflict.resolve`). Nothing is deleted: the leave
   * request keeps its history and the attendance keeps its punches. Each
   * conflicting day is given back through the leave reversal ledger - the same
   * row automatic reconciliation writes, keyed on (request, date) - so the
   * quota is restored by the balance arithmetic rather than by editing a
   * balance, and a second click, a race or an earlier automatic reversal
   * restores nothing more. The audit row is written per day by the service,
   * with the Super Admin as the actor.
   */
  app.post(
    '/:id/cancel-for-attendance',
    { preHandler: requirePermission(PERMISSIONS.LEAVE_CONFLICT_RESOLVE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const leave = await prisma.leaveRequest.findFirst({
        where: { id, companyId: auth.companyId },
        select: { id: true, employeeId: true },
      });
      if (!leave) throw new NotFoundError('Leave request');
      await assertEmployeeInTeamScope(auth, leave.employeeId);

      const actor = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: { firstName: true, lastName: true },
      });

      const result = await cancelLeaveForAttendanceConflict({
        companyId: auth.companyId,
        leaveRequestId: leave.id,
        actor: {
          userId: auth.userId,
          name: actor ? `${actor.firstName} ${actor.lastName}`.trim() : 'unknown',
        },
      });

      const data: LeaveConflictCancellationResult = {
        id: result.leaveRequestId,
        status: result.status as ApprovalStatus,
        restoredDays: result.restoredDays,
        reversedDates: result.reversedDayKeys,
        alreadyResolved: result.alreadyResolved,
      };
      return reply.send({ data });
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

      const key = {
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        year: input.year,
      };

      /**
       * What is being replaced, read before the write so the audit entry can
       * say what the figure was. Only the two stored columns are touched:
       * opening days belong to the carry-forward run, and used, pending and
       * available are derived from the leave requests, which this never edits.
       */
      const existing = await prisma.leaveBalance.findUnique({
        where: { employeeId_leaveTypeId_year: key },
        select: { adjustmentDays: true, adjustmentNote: true },
      });
      const oldAdjustment = existing ? Number(existing.adjustmentDays) : 0;

      /*
       * The balance as it stands, computed by the same service the profile
       * reads, so the checks below and the allocation the audit quotes are the
       * figures somebody saw on screen. Absent for an inactive leave type,
       * which has no balance to protect.
       */
      const current = (
        await balancesForEmployee(auth.companyId, input.employeeId, input.year)
      ).find((b) => b.leaveTypeId === input.leaveTypeId);

      const r2 = (n: number) => Math.round(n * 100) / 100;
      const delta = input.adjustmentDays - oldAdjustment;
      const allocation = current
        ? {
            before: r2(current.annualEntitlementDays + current.openingDays + oldAdjustment),
            after: r2(current.annualEntitlementDays + current.openingDays + input.adjustmentDays),
          }
        : null;

      if (current && allocation) {
        if (allocation.after < 0) {
          throw new ValidationError({
            adjustmentDays: [
              `That would take the ${input.year} allocation below zero (${allocation.after} days).`,
            ],
          });
        }
        /*
         * Never cut a balance below what has already been taken or booked.
         * The leave requests stay as they are, so a lower figure would leave a
         * negative balance that nothing can explain. Raising a balance that is
         * already short is still allowed - it is a correction in the right
         * direction.
         */
        const remainingAfter = r2(current.availableDays + delta);
        if (delta < 0 && remainingAfter < 0) {
          const committed = r2(current.usedDays + current.pendingDays);
          throw new ValidationError({
            adjustmentDays: [
              `That would leave ${remainingAfter} days, below the ${committed} day(s) already taken or pending. Lower it by at most ${Math.max(0, current.availableDays)}.`,
            ],
          });
        }
      }

      const before = {
        adjustmentDays: oldAdjustment,
        adjustmentNote: existing?.adjustmentNote ?? null,
        ...(allocation ? { allocationDays: allocation.before } : {}),
      };
      const after = {
        adjustmentDays: input.adjustmentDays,
        adjustmentNote: input.adjustmentNote,
      };

      const saved = await prisma.leaveBalance.upsert({
        where: { employeeId_leaveTypeId_year: key },
        create: { companyId: auth.companyId, ...key, ...after },
        update: after,
      });

      // Who and when are the audit row's own actor and timestamp columns.
      const auditAfter = {
        ...after,
        ...(allocation ? { allocationDays: allocation.after } : {}),
      };

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'leave.balance.adjust',
        entityType: 'LeaveBalance',
        entityId: saved.id,
        summary: allocation
          ? `${leaveType.name} ${input.year} allocation ${allocation.before} → ${allocation.after} day(s) (adjustment ${before.adjustmentDays} → ${input.adjustmentDays}): ${input.adjustmentNote}`
          : `Set the ${leaveType.name} adjustment for ${input.year} to ${input.adjustmentDays} day(s), from ${before.adjustmentDays}: ${input.adjustmentNote}`,
        before,
        after: auditAfter,
        request,
      });

      return reply.send({ data: { id: saved.id, ...after } });
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
