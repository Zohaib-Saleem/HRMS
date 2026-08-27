import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type AttendanceRecordItem,
  type AttendanceStatus,
  attendanceQuerySchema,
  attendanceUpsertSchema,
  regularizationCreateSchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import {
  createApprovalRequest,
  resolveDefaultApprovers,
} from '../../core/approvals/approval.service.js';
import { callerEmployeeOrThrow, toDateOnly } from './helpers.js';

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

export const attendanceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.ATTENDANCE_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(attendanceQuerySchema, request.query);

    // Attendance rows inherit the employee data scope exactly.
    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    const where: Prisma.AttendanceRecordWhereInput = {
      AND: [
        { companyId: auth.companyId },
        { employee: scopeFilter },
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.status ? { status: query.status } : {},
        query.from ? { date: { gte: toDateOnly(query.from) } } : {},
        query.to ? { date: { lte: toDateOnly(query.to) } } : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.attendanceRecord.count({ where }),
      prisma.attendanceRecord.findMany({
        where,
        skip,
        take,
        orderBy: [{ date: 'desc' }],
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, displayName: true } },
        },
      }),
    ]);

    const data: AttendanceRecordItem[] = rows.map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      employeeName: displayName(row.employee),
      date: row.date.toISOString().slice(0, 10),
      status: row.status as AttendanceStatus,
      checkInAt: row.checkInAt?.toISOString() ?? null,
      checkOutAt: row.checkOutAt?.toISOString() ?? null,
      workedMinutes: row.workedMinutes,
      notes: row.notes,
      source: row.source,
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  /** Record or correct a day directly. Requires manage, and stays in scope. */
  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.ATTENDANCE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(attendanceUpsertSchema, request.body);

      await assertEmployeeInScope(auth, input.employeeId);

      const date = toDateOnly(input.date);
      const checkInAt = input.checkInAt ? new Date(input.checkInAt) : null;
      const checkOutAt = input.checkOutAt ? new Date(input.checkOutAt) : null;

      if (checkInAt && checkOutAt && checkOutAt <= checkInAt) {
        throw new ValidationError({ checkOutAt: ['Check-out must be after check-in.'] });
      }

      const workedMinutes =
        checkInAt && checkOutAt
          ? Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60000)
          : null;

      const before = await prisma.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId: input.employeeId, date } },
      });

      const record = await prisma.attendanceRecord.upsert({
        where: { employeeId_date: { employeeId: input.employeeId, date } },
        create: {
          companyId: auth.companyId,
          employeeId: input.employeeId,
          date,
          status: input.status,
          checkInAt,
          checkOutAt,
          workedMinutes,
          notes: input.notes ?? null,
          source: 'ADMIN',
        },
        update: {
          status: input.status,
          checkInAt,
          checkOutAt,
          workedMinutes,
          notes: input.notes ?? null,
          source: 'ADMIN',
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: before ? 'attendance.update' : 'attendance.create',
        entityType: 'AttendanceRecord',
        entityId: record.id,
        summary: `${before ? 'Updated' : 'Recorded'} attendance for ${input.date}`,
        before: before ? { status: before.status, workedMinutes: before.workedMinutes } : undefined,
        after: { status: record.status, workedMinutes: record.workedMinutes },
        request,
      });

      return reply.status(before ? 200 : 201).send({ data: { id: record.id } });
    },
  );

  // --- regularisation requests --------------------------------------------

  app.get('/regularizations', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(attendanceQuerySchema, request.query);

    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    const where: Prisma.AttendanceRegularizationRequestWhereInput = {
      AND: [
        { companyId: auth.companyId },
        { employee: scopeFilter },
        query.employeeId ? { employeeId: query.employeeId } : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.attendanceRegularizationRequest.count({ where }),
      prisma.attendanceRegularizationRequest.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, displayName: true } },
        },
      }),
    ]);

    return reply.send({
      data: rows.map((row) => ({
        id: row.id,
        employeeId: row.employeeId,
        employeeName: displayName(row.employee),
        attendanceDate: row.attendanceDate.toISOString().slice(0, 10),
        requestedStatus: row.requestedStatus,
        reason: row.reason,
        status: row.status,
        approvalRequestId: row.approvalRequestId,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  /**
   * Raise a correction request for your own attendance. Always goes through the
   * shared approval engine rather than editing the record directly.
   */
  app.post('/regularizations', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(regularizationCreateSchema, request.body);

    const self = await callerEmployeeOrThrow(auth);
    const attendanceDate = toDateOnly(input.attendanceDate);

    const duplicate = await prisma.attendanceRegularizationRequest.findFirst({
      where: { employeeId: self.id, attendanceDate, status: 'PENDING' },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictError('You already have a pending correction for that date.');
    }

    const created = await prisma.attendanceRegularizationRequest.create({
      data: {
        companyId: auth.companyId,
        employeeId: self.id,
        attendanceDate,
        requestedCheckInAt: input.requestedCheckInAt ? new Date(input.requestedCheckInAt) : null,
        requestedCheckOutAt: input.requestedCheckOutAt ? new Date(input.requestedCheckOutAt) : null,
        requestedStatus: input.requestedStatus ?? null,
        reason: input.reason,
        status: 'PENDING',
      },
    });

    const approvers = await resolveDefaultApprovers(auth.companyId, self.id);
    const approval = await createApprovalRequest({
      companyId: auth.companyId,
      subjectType: 'ATTENDANCE_REGULARIZATION',
      subjectId: created.id,
      requesterEmployeeId: self.id,
      requesterUserId: auth.userId,
      title: `Attendance correction for ${input.attendanceDate}`,
      summary: input.reason,
      approverEmployeeIds: approvers,
      request,
    });

    await prisma.attendanceRegularizationRequest.update({
      where: { id: created.id },
      data: { approvalRequestId: approval.id },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'attendance.regularization.create',
      entityType: 'AttendanceRegularizationRequest',
      entityId: created.id,
      summary: `Requested attendance correction for ${input.attendanceDate}`,
      request,
    });

    return reply.status(201).send({ data: { id: created.id, approvalRequestId: approval.id } });
  });
};
