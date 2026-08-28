import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type AttendanceDay,
  type AttendanceMode,
  type AttendanceRecordItem,
  type AttendanceStatus,
  type AttendanceTodayState,
  type AttendanceTotals,
  type MarkAbsencesResult,
  type PayPeriodRow,
  type PayPeriodSummary,
  type TeamAttendanceRow,
  attendanceQuerySchema,
  attendanceSummaryQuerySchema,
  attendanceUpsertSchema,
  checkInSchema,
  checkOutSchema,
  markAbsencesSchema,
  payPeriodQuerySchema,
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
import { dayKeyToDateColumn, todayInZone } from '../../core/zoned-time.js';
import {
  assertCheckInIpAllowed,
  assertCheckInLocationAllowed,
  deriveRange,
  deriveRangeForEmployees,
  shiftOnDate,
} from './attendance.service.js';
import {
  computeAttendance,
  resolveAttendancePolicy,
  resolvePolicyFor,
} from './attendance-policy.js';
import { markAbsencesForDate } from './absence.service.js';

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

const emptyTotals = (): AttendanceTotals => ({
  present: 0,
  halfDay: 0,
  absent: 0,
  onLeave: 0,
  holiday: 0,
  weekend: 0,
  workedMinutes: 0,
  lateMinutes: 0,
  overtimeMinutes: 0,
});

/** One place that turns derived days into headline numbers. */
function tally(days: readonly AttendanceDay[]): AttendanceTotals {
  return days.reduce<AttendanceTotals>((acc, d) => {
    if (d.status === 'PRESENT') acc.present += 1;
    else if (d.status === 'HALF_DAY') acc.halfDay += 1;
    else if (d.status === 'ABSENT') acc.absent += 1;
    else if (d.status === 'ON_LEAVE') acc.onLeave += 1;
    else if (d.status === 'HOLIDAY') acc.holiday += 1;
    else if (d.status === 'WEEKEND') acc.weekend += 1;

    acc.workedMinutes += d.workedMinutes ?? 0;
    acc.lateMinutes += d.lateMinutes ?? 0;
    acc.overtimeMinutes += d.overtimeMinutes ?? 0;
    return acc;
  }, emptyTotals());
}

/** A range longer than this is a report, not a screen. */
const MAX_RANGE_DAYS = 62;

function assertUsableRange(from: Date, to: Date): void {
  if (to < from) {
    throw new ValidationError({ to: ['The end of the range cannot be before the start.'] });
  }
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new ValidationError({
      to: [`Ask for at most ${MAX_RANGE_DAYS} days at a time; this range is ${days}.`],
    });
  }
}

export const attendanceRoutes: FastifyPluginAsync = async (app) => {
  /** Today in the company zone. UTC midnight is not midnight in Karachi. */
  const localToday = async (companyId: string): Promise<Date> => {
    const { timeZone } = await resolveAttendancePolicy(companyId);
    return dayKeyToDateColumn(todayInZone(timeZone));
  };

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
          shift: { select: { name: true } },
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
      lateMinutes: row.lateMinutes,
      earlyLeaveMinutes: row.earlyLeaveMinutes,
      overtimeMinutes: row.overtimeMinutes,
      mode: (row.mode as AttendanceMode | null) ?? null,
      shiftName: row.shift?.name ?? null,
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

      // The status an administrator typed is honoured; the derived numbers are
      // still computed from the policy, so a hand-entered day is measured the
      // same way as a captured one.
      const [policy, shift] = await Promise.all([
        resolvePolicyFor(auth.companyId, input.employeeId, date),
        shiftOnDate(input.employeeId, date),
      ]);
      const computed = computeAttendance({ day: date, checkInAt, checkOutAt, shift, policy });

      const before = await prisma.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId: input.employeeId, date } },
      });

      const values = {
        // A status the administrator chose is honoured; otherwise the policy
        // decides, so a hand-entered short day is scored like any other.
        status: input.status ?? computed.status,
        checkInAt,
        checkOutAt,
        workedMinutes: computed.workedMinutes,
        lateMinutes: computed.lateMinutes,
        earlyLeaveMinutes: computed.earlyLeaveMinutes,
        overtimeMinutes: computed.overtimeMinutes,
        shiftId: shift?.id ?? null,
        notes: input.notes ?? null,
        source: 'ADMIN' as const,
      };

      const record = await prisma.attendanceRecord.upsert({
        where: { employeeId_date: { employeeId: input.employeeId, date } },
        create: { companyId: auth.companyId, employeeId: input.employeeId, date, ...values },
        update: values,
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
   * today is even a working day before offering a button, and whether the
   * browser needs to ask for coordinates first.
   */
  app.get('/today', async (request, reply) => {
    const auth = requireAuthContext(request);
    const self = await callerEmployeeOrThrow(auth);

    const today = await localToday(auth.companyId);
    const [[day], shift, policy] = await Promise.all([
      deriveRange(auth.companyId, self.id, today, today),
      shiftOnDate(self.id, today),
      resolvePolicyFor(auth.companyId, self.id, today),
    ]);

    const workingDay =
      day !== undefined &&
      day.status !== 'WEEKEND' &&
      day.status !== 'HOLIDAY' &&
      day.status !== 'ON_LEAVE';

    const state: AttendanceTodayState = {
      date: today.toISOString().slice(0, 10),
      status: day?.status ?? 'ABSENT',
      checkedIn: Boolean(day?.checkInAt),
      checkedOut: Boolean(day?.checkOutAt),
      checkInAt: day?.checkInAt ?? null,
      checkOutAt: day?.checkOutAt ?? null,
      workedMinutes: day?.workedMinutes ?? null,
      lateMinutes: day?.lateMinutes ?? null,
      earlyLeaveMinutes: day?.earlyLeaveMinutes ?? null,
      overtimeMinutes: day?.overtimeMinutes ?? null,
      mode: day?.mode ?? null,
      shiftName: shift?.name ?? null,
      shiftStartTime: shift?.startTime ?? null,
      shiftEndTime: shift?.endTime ?? null,
      isWorkingDay: workingDay,
      reason:
        day?.holidayName ?? day?.leaveTypeName ?? (day?.status === 'WEEKEND' ? 'Weekend' : null),
      locationRequired: policy.locationRestrictionEnabled,
      // The allow-list itself is never sent to the browser; only whether one
      // applies, so the widget can explain a refusal without publishing the
      // company network layout.
      networkRestricted: policy.ipRestrictionEnabled,
      policyName: policy.policyName,
    };

    return reply.send({ data: state });
  });

  app.post('/check-in', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(checkInSchema, request.body ?? {});
    const self = await callerEmployeeOrThrow(auth);

    const today = await localToday(auth.companyId);
    const [[day], policy] = await Promise.all([
      deriveRange(auth.companyId, self.id, today, today),
      resolvePolicyFor(auth.companyId, self.id, today),
    ]);

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

    // Both restrictions are enforced here, on the server. The network check
    // runs first: it needs nothing from the client, so a request from an
    // unapproved network is refused before any coordinates are considered.
    assertCheckInIpAllowed({ policy, ip: request.ip ?? null });

    const geo = await assertCheckInLocationAllowed({
      employee: self,
      policy,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
    });

    const now = new Date();
    const shift = await shiftOnDate(self.id, today);
    const computed = computeAttendance({ day: today, checkInAt: now, checkOutAt: null, shift, policy });

    const values = {
      status: 'PRESENT' as const,
      checkInAt: now,
      mode: input.mode,
      notes: input.notes ?? null,
      source: 'SELF' as const,
      shiftId: shift?.id ?? null,
      lateMinutes: computed.lateMinutes,
      checkInLatitude: input.latitude ?? null,
      checkInLongitude: input.longitude ?? null,
    };

    const record = await prisma.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId: self.id, date: today } },
      create: { companyId: auth.companyId, employeeId: self.id, date: today, ...values },
      update: values,
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'attendance.check_in',
      entityType: 'AttendanceRecord',
      entityId: record.id,
      summary: `Checked in (${input.mode.toLowerCase()})${record.lateMinutes ? `, ${record.lateMinutes} minute(s) late` : ''}${geo ? `, ${geo.distanceMeters}m from the work location` : ''}`,
      request,
    });

    return reply.status(201).send({
      data: {
        id: record.id,
        checkInAt: record.checkInAt?.toISOString() ?? null,
        lateMinutes: record.lateMinutes,
        distanceMeters: geo?.distanceMeters ?? null,
      },
    });
  });

  app.post('/check-out', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(checkOutSchema, request.body ?? {});
    const self = await callerEmployeeOrThrow(auth);

    const today = await localToday(auth.companyId);
    const existing = await prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId: self.id, date: today } },
    });

    if (!existing?.checkInAt) throw new ConflictError('You have not checked in today.');
    if (existing.checkOutAt) throw new ConflictError('You have already checked out today.');

    const now = new Date();
    const policy = await resolvePolicyFor(auth.companyId, self.id, today);

    // The shift captured at check-in is the one scored, so a shift reassignment
    // made during the day cannot change how the day is measured after the fact.
    const shift = existing.shiftId
      ? await prisma.shift.findUnique({
          where: { id: existing.shiftId },
          select: { startTime: true, endTime: true },
        })
      : await shiftOnDate(self.id, today);

    const computed = computeAttendance({
      // The record's own day, not today's: an overnight shift checks out after
      // local midnight and still belongs to the day it started.
      day: existing.date,
      checkInAt: existing.checkInAt,
      checkOutAt: now,
      shift,
      policy,
    });

    const record = await prisma.attendanceRecord.update({
      where: { id: existing.id },
      data: {
        checkOutAt: now,
        workedMinutes: computed.workedMinutes,
        lateMinutes: computed.lateMinutes,
        earlyLeaveMinutes: computed.earlyLeaveMinutes,
        overtimeMinutes: computed.overtimeMinutes,
        status: computed.status,
        notes: input.notes ?? existing.notes,
      },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'attendance.check_out',
      entityType: 'AttendanceRecord',
      entityId: record.id,
      summary: `Checked out after ${((computed.workedMinutes ?? 0) / 60).toFixed(1)} hour(s), scored ${computed.status}`,
      request,
    });

    return reply.send({
      data: {
        id: record.id,
        checkOutAt: now.toISOString(),
        workedMinutes: computed.workedMinutes ?? 0,
        overtimeMinutes: computed.overtimeMinutes,
        earlyLeaveMinutes: computed.earlyLeaveMinutes,
        status: computed.status,
      },
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
    assertUsableRange(from, to);

    const days: AttendanceDay[] = await deriveRange(auth.companyId, employeeId, from, to);

    return reply.send({ data: { days, totals: tally(days) } });
  });

  /**
   * Team attendance for everyone the caller may see.
   *
   * Same derivation, same scope rules, one row per employee. There is no
   * separate manager permission: `employeeScopeFilter` already answers "which
   * people?", so a manager sees their reports, HR sees the company, and an
   * employee with OWN scope sees exactly themselves - which is not a leak, just
   * a very small team.
   */
  app.get('/team', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(attendanceQuerySchema, request.query);

    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      return reply.send({
        data: [],
        meta: buildMeta(query.page, query.limit, 0),
        totals: emptyTotals(),
      });
    }

    const todayIso = new Date().toISOString();
    const from = toDateOnly(query.from ?? todayIso);
    const to = toDateOnly(query.to ?? query.from ?? todayIso);
    assertUsableRange(from, to);

    // Asking for one specific person still goes through the scope check, so a
    // guessed id cannot widen what the caller sees.
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const terms = query.q ? query.q.split(/\s+/).filter(Boolean) : [];
    const searchClauses: Prisma.EmployeeWhereInput[] = terms.map((term) => ({
      OR: [
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
        { displayName: { contains: term, mode: 'insensitive' } },
        { employeeNumber: { contains: term, mode: 'insensitive' } },
      ],
    }));

    const where: Prisma.EmployeeWhereInput = {
      AND: [
        { companyId: auth.companyId },
        // The scope filter comes first and is never optional; the team and
        // department filters narrow inside it and can only ever remove rows.
        scopeFilter,
        query.employeeId ? { id: query.employeeId } : {},
        query.teamId ? { teamId: query.teamId } : {},
        query.departmentId ? { departmentId: query.departmentId } : {},
        ...searchClauses,
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, employees] = await Promise.all([
      prisma.employee.count({ where }),
      prisma.employee.findMany({
        where,
        skip,
        take,
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        select: {
          id: true,
          firstName: true,
          lastName: true,
          displayName: true,
          employeeNumber: true,
          locationId: true,
          department: { select: { name: true } },
        },
      }),
    ]);

    const derived = await deriveRangeForEmployees(auth.companyId, employees, from, to);

    // The shift each person is on at the end of the range, for the roster column.
    const shifts = await Promise.all(employees.map((e) => shiftOnDate(e.id, to)));

    const rows: TeamAttendanceRow[] = employees.map((employee, index) => {
      const days = derived.get(employee.id) ?? [];
      return {
        employeeId: employee.id,
        employeeName: displayName(employee),
        employeeNumber: employee.employeeNumber,
        departmentName: employee.department?.name ?? null,
        shiftName: shifts[index]?.name ?? null,
        days: query.status ? days.filter((d) => d.status === query.status) : days,
        totals: tally(days),
      };
    });

    // A status filter is about finding people, so drop anyone with no match.
    const data = query.status ? rows.filter((r) => r.days.length > 0) : rows;
    const totals = tally(rows.flatMap((r) => r.days));

    return reply.send({
      data,
      meta: buildMeta(query.page, query.limit, total),
      totals,
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    });
  });

  /**
   * Attendance summarised for a pay period.
   *
   * Deliberately figures and not money. This is the clean input a payroll run
   * would consume - worked and overtime minutes, day counts, exceptions - and
   * nothing here decides what anyone is paid. Building the calculation itself
   * would be inventing a module nobody has specified.
   *
   * Same scope rules as everything else, so a manager gets their team and an
   * employee gets one row.
   */
  app.get('/pay-period', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(payPeriodQuerySchema, request.query);

    const scopeFilter = await employeeScopeFilter(auth);
    const from = toDateOnly(query.from);
    const to = toDateOnly(query.to);
    assertUsableRange(from, to);

    if (scopeFilter === null) {
      const empty: PayPeriodSummary = {
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        rows: [],
        totals: {
          employees: 0,
          workedMinutes: 0,
          overtimeMinutes: 0,
          absentDays: 0,
          leaveDays: 0,
          incompleteDays: 0,
        },
      };
      return reply.send({ data: empty });
    }

    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const employees = await prisma.employee.findMany({
      where: {
        AND: [
          { companyId: auth.companyId },
          scopeFilter,
          query.employeeId ? { id: query.employeeId } : {},
          { status: { not: 'TERMINATED' } },
        ],
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        employeeNumber: true,
        locationId: true,
        department: { select: { name: true } },
      },
    });

    const derived = await deriveRangeForEmployees(auth.companyId, employees, from, to);

    // Sources tell a payroll reviewer which days a human touched.
    const adjusted = await prisma.attendanceRecord.groupBy({
      by: ['employeeId'],
      where: {
        employeeId: { in: employees.map((e) => e.id) },
        date: { gte: from, lte: to },
        source: 'ADMIN',
      },
      _count: { _all: true },
    });
    const adjustedByEmployee = new Map(adjusted.map((a) => [a.employeeId, a._count._all]));

    const rows: PayPeriodRow[] = employees.map((employee) => {
      const days = derived.get(employee.id) ?? [];
      const totals = tally(days);

      const earlyLeaveMinutes = days.reduce((sum, d) => sum + (d.earlyLeaveMinutes ?? 0), 0);
      // Checked in but never out: worked minutes are unknown, and guessing them
      // is exactly what this system refuses to do.
      const incompleteDays = days.filter((d) => d.checkInAt !== null && d.checkOutAt === null).length;

      return {
        employeeId: employee.id,
        employeeName: displayName(employee),
        employeeNumber: employee.employeeNumber,
        departmentName: employee.department?.name ?? null,
        workedMinutes: totals.workedMinutes,
        overtimeMinutes: totals.overtimeMinutes,
        // Overtime is a portion of worked, never an addition, so the regular
        // part is what is left after it.
        regularMinutes: Math.max(0, totals.workedMinutes - totals.overtimeMinutes),
        presentDays: totals.present,
        halfDays: totals.halfDay,
        absentDays: totals.absent,
        leaveDays: totals.onLeave,
        holidayDays: totals.holiday,
        weekendDays: totals.weekend,
        lateMinutes: totals.lateMinutes,
        earlyLeaveMinutes,
        incompleteDays,
        adjustedDays: adjustedByEmployee.get(employee.id) ?? 0,
      };
    });

    const summary: PayPeriodSummary = {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      rows,
      totals: {
        employees: rows.length,
        workedMinutes: rows.reduce((s, r) => s + r.workedMinutes, 0),
        overtimeMinutes: rows.reduce((s, r) => s + r.overtimeMinutes, 0),
        absentDays: rows.reduce((s, r) => s + r.absentDays, 0),
        leaveDays: rows.reduce((s, r) => s + r.leaveDays, 0),
        incompleteDays: rows.reduce((s, r) => s + r.incompleteDays, 0),
      },
    };

    return reply.send({ data: summary });
  });

  /**
   * Finalise a day by recording an absence for everyone with no record.
   *
   * Exposed as an explicit operation as well as running nightly, so an
   * administrator can close off a day and see exactly what it did. Idempotent:
   * re-running reports zero marked rather than failing or duplicating.
   */
  app.post(
    '/mark-absences',
    { preHandler: requirePermission(PERMISSIONS.ATTENDANCE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(markAbsencesSchema, request.body ?? {});

      const date = toDateOnly(input.date);
      if (date > toDateOnly(new Date().toISOString())) {
        throw new ValidationError({
          date: ['You cannot finalise a day that has not happened yet.'],
        });
      }

      const scopeFilter = await employeeScopeFilter(auth);
      if (scopeFilter === null) {
        const empty: MarkAbsencesResult = {
          date: date.toISOString().slice(0, 10),
          scanned: 0,
          marked: 0,
          skipped: { notWorkingDay: 0, onLeave: 0, alreadyRecorded: 0 },
        };
        return reply.send({ data: empty });
      }

      if (input.employeeId) await assertEmployeeInScope(auth, input.employeeId);

      const result = await markAbsencesForDate({
        companyId: auth.companyId,
        date,
        employeeFilter: {
          AND: [scopeFilter, input.employeeId ? { id: input.employeeId } : {}],
        },
      });

      if (result.marked > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'attendance.mark_absences',
          entityType: 'AttendanceRecord',
          entityId: result.date,
          summary: `Marked ${result.marked} employee(s) absent for ${result.date}`,
          after: { marked: result.marked, scanned: result.scanned },
          request,
        });
      }

      return reply.send({ data: result });
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
