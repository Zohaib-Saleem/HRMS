import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type AttendanceDay,
  type AttendanceRecordItem,
  type AttendanceStatus,
  type AttendanceTodayState,
  attendanceQuerySchema,
  attendanceSummaryQuerySchema,
  attendanceUpsertSchema,
  checkInSchema,
  checkOutSchema,
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
import { deriveRange, lateMinutesAgainst, shiftOnDate } from './attendance.service.js';

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

    // Free-text search matches the person the record belongs to, plus notes.
    const terms = query.q ? query.q.split(/\s+/).filter(Boolean) : [];
    const searchClauses: Prisma.AttendanceRecordWhereInput[] = terms.map((term) => ({
      OR: [
        { employee: { firstName: { contains: term, mode: 'insensitive' } } },
        { employee: { lastName: { contains: term, mode: 'insensitive' } } },
        { employee: { displayName: { contains: term, mode: 'insensitive' } } },
        { employee: { employeeNumber: { contains: term, mode: 'insensitive' } } },
        { notes: { contains: term, mode: 'insensitive' } },
      ],
    }));

    const where: Prisma.AttendanceRecordWhereInput = {
      AND: [
        { companyId: auth.companyId },
        { employee: scopeFilter },
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.status ? { status: query.status } : {},
        query.from ? { date: { gte: toDateOnly(query.from) } } : {},
        query.to ? { date: { lte: toDateOnly(query.to) } } : {},
        ...searchClauses,
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

  // --- self-service capture ------------------------------------------------

  /**
   * Today's state for the caller. Drives the check-in widget: it says whether
   * today is even a working day before offering a button.
   */
  app.get('/today', async (request, reply) => {
    const auth = requireAuthContext(request);
    const self = await callerEmployeeOrThrow(auth);

    const today = toDateOnly(new Date().toISOString());
    const [day] = await deriveRange(auth.companyId, self.id, today, today);
    const shift = await shiftOnDate(self.id, today);

    const workingDay =
      day !== undefined && day.status !== 'WEEKEND' && day.status !== 'HOLIDAY' && day.status !== 'ON_LEAVE';

    const state: AttendanceTodayState = {
      date: today.toISOString().slice(0, 10),
      status: day?.status ?? 'ABSENT',
      checkedIn: Boolean(day?.checkInAt),
      checkedOut: Boolean(day?.checkOutAt),
      checkInAt: day?.checkInAt ?? null,
      checkOutAt: day?.checkOutAt ?? null,
      workedMinutes: day?.workedMinutes ?? null,
      lateMinutes: day?.lateMinutes ?? null,
      mode: day?.mode ?? null,
      shiftName: shift?.name ?? null,
      shiftStartTime: shift?.startTime ?? null,
      shiftEndTime: shift?.endTime ?? null,
      isWorkingDay: workingDay,
      reason: day?.holidayName ?? day?.leaveTypeName ?? (day?.status === 'WEEKEND' ? 'Weekend' : null),
    };

    return reply.send({ data: state });
  });

  app.post('/check-in', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(checkInSchema, request.body ?? {});
    const self = await callerEmployeeOrThrow(auth);

    const today = toDateOnly(new Date().toISOString());
    const [day] = await deriveRange(auth.companyId, self.id, today, today);

    // Refuse rather than quietly record a day the calendar says is not worked.
    if (day && (day.status === 'WEEKEND' || day.status === 'HOLIDAY' || day.status === 'ON_LEAVE')) {
      throw new ConflictError(
        `Today is recorded as ${day.status.toLowerCase().replace('_', ' ')}${day.holidayName ? ` (${day.holidayName})` : ''}, so there is nothing to check in to.`,
      );
    }

    const existing = await prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId: self.id, date: today } },
    });
    if (existing?.checkInAt) {
      throw new ConflictError('You have already checked in today.');
    }

    const now = new Date();
    const shift = await shiftOnDate(self.id, today);

    const record = await prisma.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId: self.id, date: today } },
      create: {
        companyId: auth.companyId,
        employeeId: self.id,
        date: today,
        status: 'PRESENT',
        checkInAt: now,
        mode: input.mode,
        notes: input.notes ?? null,
        source: 'SELF',
        shiftId: shift?.id ?? null,
        lateMinutes: lateMinutesAgainst(now, shift?.startTime ?? null),
      },
      update: {
        status: 'PRESENT',
        checkInAt: now,
        mode: input.mode,
        notes: input.notes ?? null,
        source: 'SELF',
        shiftId: shift?.id ?? null,
        lateMinutes: lateMinutesAgainst(now, shift?.startTime ?? null),
      },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'attendance.check_in',
      entityType: 'AttendanceRecord',
      entityId: record.id,
      summary: `Checked in (${input.mode.toLowerCase()})${record.lateMinutes ? `, ${record.lateMinutes} minute(s) late` : ''}`,
      request,
    });

    return reply.status(201).send({
      data: {
        id: record.id,
        checkInAt: record.checkInAt?.toISOString() ?? null,
        lateMinutes: record.lateMinutes,
      },
    });
  });

  app.post('/check-out', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(checkOutSchema, request.body ?? {});
    const self = await callerEmployeeOrThrow(auth);

    const today = toDateOnly(new Date().toISOString());
    const existing = await prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId: self.id, date: today } },
    });

    if (!existing?.checkInAt) throw new ConflictError('You have not checked in today.');
    if (existing.checkOutAt) throw new ConflictError('You have already checked out today.');

    const now = new Date();
    const workedMinutes = Math.max(
      0,
      Math.round((now.getTime() - existing.checkInAt.getTime()) / 60_000),
    );

    const record = await prisma.attendanceRecord.update({
      where: { id: existing.id },
      data: {
        checkOutAt: now,
        workedMinutes,
        notes: input.notes ?? existing.notes,
      },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'attendance.check_out',
      entityType: 'AttendanceRecord',
      entityId: record.id,
      summary: `Checked out after ${(workedMinutes / 60).toFixed(1)} hour(s)`,
      request,
    });

    return reply.send({
      data: { id: record.id, checkOutAt: now.toISOString(), workedMinutes },
    });
  });

  /**
   * Day-by-day view over a range. Days without a record are still returned,
   * classified as weekend, holiday, leave or absent rather than simply missing.
   */
  app.get('/summary', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(attendanceSummaryQuerySchema, request.query);

    let employeeId = query.employeeId;
    if (employeeId) {
      await assertEmployeeInScope(auth, employeeId);
    } else {
      const self = await callerEmployeeOrThrow(auth);
      employeeId = self.id;
    }

    const now = new Date();
    const from = toDateOnly(
      query.from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    );
    const to = toDateOnly(
      query.to ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString(),
    );

    const days: AttendanceDay[] = await deriveRange(auth.companyId, employeeId, from, to);

    const totals = days.reduce(
      (acc, d) => ({
        present: acc.present + (d.status === 'PRESENT' ? 1 : 0),
        absent: acc.absent + (d.status === 'ABSENT' ? 1 : 0),
        onLeave: acc.onLeave + (d.status === 'ON_LEAVE' ? 1 : 0),
        holiday: acc.holiday + (d.status === 'HOLIDAY' ? 1 : 0),
        weekend: acc.weekend + (d.status === 'WEEKEND' ? 1 : 0),
        workedMinutes: acc.workedMinutes + (d.workedMinutes ?? 0),
        lateMinutes: acc.lateMinutes + (d.lateMinutes ?? 0),
      }),
      { present: 0, absent: 0, onLeave: 0, holiday: 0, weekend: 0, workedMinutes: 0, lateMinutes: 0 },
    );

    return reply.send({ data: { days, totals } });
  });

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
