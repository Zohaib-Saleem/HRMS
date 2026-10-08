import type { FastifyPluginAsync } from 'fastify';
import type { AttendanceSource, Prisma } from '@prisma/client';
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
  type RegularizationRecord,
  type TeamAttendanceSummaryRow,
  ATTENDANCE_STATUS_LABELS,
  attendanceQuerySchema,
  attendanceSummaryQuerySchema,
  attendanceUpsertSchema,
  checkInSchema,
  checkOutSchema,
  markAbsencesSchema,
  payPeriodQuerySchema,
  regularizationCreateSchema,
  regularizationQuerySchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import {
  assertAttendanceEmployeeInScope,
  attendancePeopleFilter,
} from '../../auth/scope.js';
import {
  assertChainUsable,
  createApprovalRequest,
  notifyApprover,
  resolveChain,
} from '../../core/approvals/approval.service.js';
import { callerEmployeeOrThrow, toDateOnly } from './helpers.js';
import { summariseByTeam, teamFilterClause } from './team-attendance.service.js';
import {
  EMPLOYMENT_WINDOW_SELECT,
  attendancePopulationWhere,
} from './employment-window.js';
import { clockBoundary, dayKeyToDateColumn, todayInZone } from '../../core/zoned-time.js';
import { closesPreviousDay } from '../attendance-device/overnight-attribution.js';
import {
  assertCheckInIpAllowed,
  assertCheckInLocationAllowed,
  assignmentOn,
  deriveRange,
  deriveRangeForEmployees,
  emptyMonthlyTotals as emptyTotals,
  shiftAssignmentsForRange,
  shiftOnDate,
  tallyDerived as tally,
  type DerivedDay,
} from './attendance.service.js';
import {
  computeAttendance,
  effectiveShift,
  policyResolverFor,
  resolveAttendancePolicy,
  resolvePolicyFor,
} from './attendance-policy.js';
import { reconcileAfterAttendanceWrite } from '../leave/leave-reconciliation.service.js';
import { correctionNotice } from './correction-notice.js';
import { markAbsencesForDate } from './absence.service.js';

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

/** A range longer than this is a report, not a screen. */
const MAX_RANGE_DAYS = 62;

/** Same reasoning for the team summary's width: a ceiling, not a page. */
const SUMMARY_EMPLOYEE_CAP = 2000;

/**
 * The employee shape a team attendance row is built from.
 *
 * Shared between the paginated read and the filtered one so the two can never
 * select different columns and produce rows that disagree about the same
 * person - and so both are ordered identically, which is what makes slicing the
 * filtered list into pages behave like database pagination.
 */
const teamEmployeeSelect = {
  id: true,
  firstName: true,
  lastName: true,
  displayName: true,
  employeeNumber: true,
  locationId: true,
  department: { select: { name: true } },
  team: { select: { id: true, name: true } },
  // Which days of the range this person was employed for. The deriver refuses
  // to classify the others; see employment-window.
  ...EMPLOYMENT_WINDOW_SELECT,
} satisfies Prisma.EmployeeSelect;

type TeamEmployee = Prisma.EmployeeGetPayload<{ select: typeof teamEmployeeSelect }>;

const TEAM_ORDER: Prisma.EmployeeOrderByWithRelationInput[] = [
  { firstName: 'asc' },
  { lastName: 'asc' },
];

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

/**
 * What one page of stored days is worth under the active policy.
 *
 * One policy resolution and one shift lookup for the whole page, then the same
 * `computeAttendance` the deriver and the import use. Returns only the rows it
 * re-scored: ADMIN corrections are left out so the caller keeps the stored
 * verdict for them.
 */
async function rescoreStatuses(
  companyId: string,
  rows: ReadonlyArray<{
    id: string;
    employeeId: string;
    date: Date;
    checkInAt: Date | null;
    checkOutAt: Date | null;
    source: AttendanceSource;
  }>,
): Promise<Map<string, AttendanceStatus>> {
  const result = new Map<string, AttendanceStatus>();
  const scorable = rows.filter((row) => row.source !== 'ADMIN');
  if (scorable.length === 0) return result;

  const employeeIds = [...new Set(scorable.map((row) => row.employeeId))];
  const dates = scorable.map((row) => row.date.getTime());
  const from = new Date(Math.min(...dates));
  const to = new Date(Math.max(...dates));

  const [policyFor, assignments] = await Promise.all([
    policyResolverFor(companyId, employeeIds, from, to),
    shiftAssignmentsForRange(employeeIds, from, to),
  ]);

  for (const row of scorable) {
    const key = row.date.toISOString().slice(0, 10);
    const policy = policyFor(row.employeeId, row.date);
    const assigned = assignmentOn(assignments.get(row.employeeId) ?? [], key)?.shift ?? null;
    const computed = computeAttendance({
      day: key,
      checkInAt: row.checkInAt,
      checkOutAt: row.checkOutAt,
      shift: assigned ? effectiveShift(assigned, policy) : null,
      policy,
    });
    result.set(row.id, computed.status);
  }
  return result;
}

export const attendanceRoutes: FastifyPluginAsync = async (app) => {
  /** Today in the company zone. UTC midnight is not midnight in Karachi. */
  const localToday = async (companyId: string): Promise<Date> => {
    const { timeZone } = await resolveAttendancePolicy(companyId);
    return dayKeyToDateColumn(todayInZone(timeZone));
  };

  /**
   * The caller's previous day, while it is still waiting for them to leave.
   *
   * Somebody who checks in at 09:00 and leaves at 01:00 is leaving the day
   * they arrived on, but at 01:00 "today" is already the next one. Without
   * this the check-out found no check-in, the widget offered a check-in
   * instead, and the long day stayed open while the next one was opened by an
   * arrival nobody made. The limits are the company's own overnight settings,
   * the ones the device import already applies to punches.
   */
  const openPreviousDay = async (companyId: string, employeeId: string, today: Date, now: Date) => {
    const yesterday = new Date(today.getTime() - 86_400_000);
    const record = await prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId, date: yesterday } },
    });
    if (!record?.checkInAt || record.checkOutAt) return null;

    const policy = await resolvePolicyFor(companyId, employeeId, yesterday);
    const closes = closesPreviousDay({
      dayKey: today.toISOString().slice(0, 10),
      openedAt: record.checkInAt,
      at: now,
      windowMinutes: policy.overnightCheckOutWindowMinutes,
      cutoff: policy.overnightCheckOutCutoff,
      timeZone: policy.timeZone,
    });
    return closes ? record : null;
  };

  app.addHook('preHandler', requirePermission(PERMISSIONS.ATTENDANCE_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(attendanceQuerySchema, request.query);

    // Attendance rows inherit the employee data scope exactly.
    const scopeFilter = await attendancePeopleFilter(auth);
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
        // Narrowing only, applied INSIDE the scope above: the department and
        // team a caller asks for can never reach an employee the scope filter
        // has already excluded. The query contract has accepted both for a
        // while; the list is what they now actually narrow, so the filters on
        // the attendance page mean the same thing in every view.
        query.departmentId ? { employee: { departmentId: query.departmentId } } : {},
        query.teamId ? { employee: teamFilterClause(query.teamId) } : {},
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

    /**
     * The status of each listed day, under the policy in force for it.
     *
     * The stored column is what the import wrote the night the day arrived,
     * under the thresholds of that night. The calendar and the reports score
     * the same punches through `deriveRange`, which reads the active policy,
     * and the two used to disagree on any day imported before a threshold was
     * changed. The table is the same page of the same rows; it is re-scored
     * the same way so the three views cannot say three different things.
     *
     * A day an administrator corrected keeps the status they gave it - a
     * human decision, exactly as the deriver treats it. The `status` filter
     * above still narrows on the stored column, because a filter has to be a
     * WHERE clause to paginate; a re-scored day therefore lists under the
     * status it was imported with and shows the one the policy now gives it.
     */
    const rescored = await rescoreStatuses(auth.companyId, rows);

    const data: AttendanceRecordItem[] = rows.map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      employeeName: displayName(row.employee),
      date: row.date.toISOString().slice(0, 10),
      status: (rescored.get(row.id) ?? row.status) as AttendanceStatus,
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

      await assertAttendanceEmployeeInScope(auth, input.employeeId);

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
        irregular: computed.irregular,
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

      await reconcileAfterAttendanceWrite({
        companyId: auth.companyId,
        employeeId: input.employeeId,
        dayKey: date.toISOString().slice(0, 10),
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
    const todays = await prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId: self.id, date: today } },
      select: { checkInAt: true },
    });
    // Until the previous day is closed, it is the day the widget is about.
    const carried = todays?.checkInAt
      ? null
      : await openPreviousDay(auth.companyId, self.id, today, new Date());
    const date = carried?.date ?? today;

    const [[day], shift, policy] = await Promise.all([
      deriveRange(auth.companyId, self.id, date, date),
      shiftOnDate(self.id, date),
      resolvePolicyFor(auth.companyId, self.id, date),
    ]);

    const workingDay =
      carried !== null ||
      (day !== undefined &&
      day.status !== 'WEEKEND' &&
      day.status !== 'OFF_DAY' &&
      day.status !== 'HOLIDAY' &&
      day.status !== 'ON_LEAVE');

    const state: AttendanceTodayState = {
      date: date.toISOString().slice(0, 10),
      carriedOver: carried !== null,
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
        day?.holidayName ??
        day?.leaveTypeName ??
        (day?.status === 'WEEKEND' ? 'Weekend' : day?.status === 'OFF_DAY' ? 'Off day' : null),
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
    if (
      day &&
      (day.status === 'WEEKEND' ||
        day.status === 'OFF_DAY' ||
        day.status === 'HOLIDAY' ||
        day.status === 'ON_LEAVE')
    ) {
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
    if (await openPreviousDay(auth.companyId, self.id, today, new Date())) {
      throw new ConflictError('You are still checked in from yesterday. Check out first.');
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

    const now = new Date();
    const today = await localToday(auth.companyId);
    const todays = await prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId: self.id, date: today } },
    });
    // After midnight, the departure may still belong to yesterday.
    const existing = todays?.checkInAt
      ? todays
      : ((await openPreviousDay(auth.companyId, self.id, today, now)) ?? todays);

    if (!existing?.checkInAt) throw new ConflictError('You have not checked in today.');
    if (existing.checkOutAt) throw new ConflictError('You have already checked out today.');

    const policy = await resolvePolicyFor(auth.companyId, self.id, existing.date);

    // The shift captured at check-in is the one scored, so a shift reassignment
    // made during the day cannot change how the day is measured after the fact.
    const shift = existing.shiftId
      ? await prisma.shift.findUnique({
          where: { id: existing.shiftId },
          select: { startTime: true, endTime: true },
        })
      : await shiftOnDate(self.id, existing.date);

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
        irregular: computed.irregular,
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
        irregular: computed.irregular,
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
      await assertAttendanceEmployeeInScope(auth, employeeId);
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
   * Same derivation, one row per employee. There is no separate manager
   * permission: `attendancePeopleFilter` answers "which people?", so a manager
   * sees their reports, HR sees the company, and an employee with OWN scope
   * sees exactly themselves - which is not a leak, just a very small team.
   *
   * It is `attendancePeopleFilter` and not the plain `employeeScopeFilter`,
   * and the difference is one clause: a caller who does not hold
   * `employee.read` is narrowed to their own record HOWEVER WIDE their data
   * scope is. This endpoint is gated on `attendance.read`, which every member
   * of staff holds for their own record, so the scope was previously the whole
   * gate - and a custom role given an ALL scope for an unrelated module was
   * thereby served the company's attendance. See auth/scope.ts.
   */
  app.get('/team', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(attendanceQuerySchema, request.query);

    const scopeFilter = await attendancePeopleFilter(auth);
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
    if (query.employeeId) await assertAttendanceEmployeeInScope(auth, query.employeeId);

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
        teamFilterClause(query.teamId),
        query.departmentId ? { departmentId: query.departmentId } : {},
        /**
         * Only people employed at some point in the range.
         *
         * In the database rather than after the page is cut, because `total`
         * has to count the same population the rows come from - the identical
         * reason the status filter below derives the whole scope before
         * paginating. Someone who left before the range starts is not a row
         * with no days; they are not a row.
         */
        attendancePopulationWhere(from, to),
        ...searchClauses,
      ],
    };

    /**
     * Status and flag narrow by DERIVED day, and no SQL can express that: what
     * a day is comes from the shift calendar, the holiday list, approved leave
     * and the punch, resolved per employee in `deriveRangeForEmployees`.
     *
     * Which is why a filtered page used to arrive short. The page was cut by
     * the database first and the non-matching rows dropped afterwards, so a
     * request for 20 rows of "absent" fetched 20 employees, kept the eight who
     * were absent, and still reported `total` as all 80 people in scope - the
     * table ended after eight rows under a footer reading "Showing 1 to 20 of
     * 80". The same mismatch left later pages blank.
     *
     * So a narrowed request derives the whole scope - under the same ceiling
     * the team summary uses - filters it, and only then cuts it into pages.
     * `meta` and the rows it describes are one set. An unfiltered request is
     * untouched and still paginates in the database.
     */
    const narrowing = Boolean(query.status || query.flag);
    const matchesFilter = (day: DerivedDay): boolean =>
      (!query.status || day.status === query.status) &&
      (!query.flag || day.flags.includes(query.flag));

    const { skip, take } = toSkipTake(query.page, query.limit);

    let total: number;
    let employees: TeamEmployee[];
    let derived: Map<string, DerivedDay[]>;
    let truncated = false;

    if (narrowing) {
      const candidates = await prisma.employee.findMany({
        where,
        take: SUMMARY_EMPLOYEE_CAP,
        orderBy: TEAM_ORDER,
        select: teamEmployeeSelect,
      });
      truncated = candidates.length === SUMMARY_EMPLOYEE_CAP;
      derived = await deriveRangeForEmployees(auth.companyId, candidates, from, to);
      const matched = candidates.filter((e) => (derived.get(e.id) ?? []).some(matchesFilter));
      total = matched.length;
      employees = matched.slice(skip, skip + take);
    } else {
      const [count, page] = await Promise.all([
        prisma.employee.count({ where }),
        prisma.employee.findMany({
          where,
          skip,
          take,
          orderBy: TEAM_ORDER,
          select: teamEmployeeSelect,
        }),
      ]);
      total = count;
      employees = page;
      derived = await deriveRangeForEmployees(auth.companyId, employees, from, to);
    }

    // The shift each person is on at the end of the range, for the roster
    // column. One query per person, so only ever for the page being returned.
    const shifts = await Promise.all(employees.map((e) => shiftOnDate(e.id, to)));

    const data: TeamAttendanceRow[] = employees.map((employee, index) => {
      const days = derived.get(employee.id) ?? [];
      return {
        employeeId: employee.id,
        employeeName: displayName(employee),
        employeeNumber: employee.employeeNumber,
        departmentName: employee.department?.name ?? null,
        teamId: employee.team?.id ?? null,
        teamName: employee.team?.name ?? null,
        shiftName: shifts[index]?.name ?? null,
        days: narrowing ? days.filter(matchesFilter) : days,
        totals: tally(days),
      };
    });

    const totals = tally(data.flatMap((r) => r.days));

    return reply.send({
      data,
      meta: buildMeta(query.page, query.limit, total),
      totals,
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      truncated,
    });
  });

  /**
   * Attendance grouped by team, for the dashboard's team summary.
   *
   * Deliberately not part of `/team`: that endpoint is paginated, and a summary
   * built from one page would silently describe 25 people while claiming to
   * describe the company. This aggregates everyone the caller may see, under
   * the same scope and the same filters.
   *
   * The grouping is a join through the employee - see team-attendance.service -
   * so it reads live team membership and needs no backfill of historic rows.
   */
  app.get('/team-summary', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(attendanceQuerySchema, request.query);

    const scopeFilter = await attendancePeopleFilter(auth);
    if (scopeFilter === null) return reply.send({ data: [] });

    const todayIso = new Date().toISOString();
    const from = toDateOnly(query.from ?? todayIso);
    const to = toDateOnly(query.to ?? query.from ?? todayIso);
    assertUsableRange(from, to);

    if (query.employeeId) await assertAttendanceEmployeeInScope(auth, query.employeeId);

    const where: Prisma.EmployeeWhereInput = {
      AND: [
        { companyId: auth.companyId },
        scopeFilter,
        query.employeeId ? { id: query.employeeId } : {},
        teamFilterClause(query.teamId),
        query.departmentId ? { departmentId: query.departmentId } : {},
        // The same population as `/team`, so the tile and the table it links
        // to cannot count different people.
        attendancePopulationWhere(from, to),
      ],
    };

    // Unpaginated by design, but not unbounded: a company far past this size
    // wants a report, not a dashboard tile.
    const employees = await prisma.employee.findMany({
      where,
      take: SUMMARY_EMPLOYEE_CAP,
      select: {
        id: true,
        locationId: true,
        department: { select: { name: true } },
        team: { select: { id: true, name: true } },
        ...EMPLOYMENT_WINDOW_SELECT,
      },
    });

    const derived = await deriveRangeForEmployees(auth.companyId, employees, from, to);

    const summary: TeamAttendanceSummaryRow[] = summariseByTeam(
      employees.map((employee) => ({
        teamId: employee.team?.id ?? null,
        teamName: employee.team?.name ?? null,
        departmentName: employee.department?.name ?? null,
        days: derived.get(employee.id) ?? [],
      })),
    );

    return reply.send({
      data: summary,
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      truncated: employees.length === SUMMARY_EMPLOYEE_CAP,
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

    const scopeFilter = await attendancePeopleFilter(auth);
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

    if (query.employeeId) await assertAttendanceEmployeeInScope(auth, query.employeeId);

    const employees = await prisma.employee.findMany({
      where: {
        AND: [
          { companyId: auth.companyId },
          scopeFilter,
          query.employeeId ? { id: query.employeeId } : {},
          /**
           * Employed during the period, by the one lifecycle rule.
           *
           * Replaces `status != TERMINATED`, which was wrong in both
           * directions: it dropped a person terminated mid-period out of the
           * period they actually worked, and it kept a resignation - a
           * different exit status - in every period after they had gone.
           */
          attendancePopulationWhere(from, to),
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
        ...EMPLOYMENT_WINDOW_SELECT,
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

      const scopeFilter = await attendancePeopleFilter(auth);
      if (scopeFilter === null) {
        const empty: MarkAbsencesResult = {
          date: date.toISOString().slice(0, 10),
          scanned: 0,
          marked: 0,
          skipped: { notWorkingDay: 0, onLeave: 0, alreadyRecorded: 0 },
        };
        return reply.send({ data: empty });
      }

      if (input.employeeId) await assertAttendanceEmployeeInScope(auth, input.employeeId);

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

  /**
   * Correction requests.
   *
   * Scope-filtered exactly like every other employee-shaped list, so a member
   * of staff with an OWN scope sees their own and nothing else without a
   * second permission, and `?employeeId=` cannot widen that - it is intersected
   * with the scope filter and asserted separately, so a guessed id returns 403
   * rather than somebody else's Tuesday.
   */
  app.get('/regularizations', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(regularizationQuerySchema, request.query);

    const scopeFilter = await attendancePeopleFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }
    if (query.employeeId) await assertAttendanceEmployeeInScope(auth, query.employeeId);

    // `mine` is the self-service view. Resolved from the session, never from
    // the query string, which is what makes it a filter and not a lookup.
    const self =
      query.view === 'mine'
        ? await prisma.employee.findFirst({
            where: { companyId: auth.companyId, userId: auth.userId },
            select: { id: true },
          })
        : null;
    if (query.view === 'mine' && !self) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    const where: Prisma.AttendanceRegularizationRequestWhereInput = {
      AND: [
        { companyId: auth.companyId },
        { employee: scopeFilter },
        self ? { employeeId: self.id } : {},
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.status ? { status: query.status } : {},
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

    /*
     * Who decided, and what they said.
     *
     * Read from the approval engine rather than mirrored onto the correction
     * row: the engine already owns the decision, and a second copy of it here
     * is a second copy that can go stale. One query for the page rather than
     * one per row.
     */
    const approvalIds = rows.map((row) => row.approvalRequestId).filter((id): id is string => Boolean(id));
    const approvals = approvalIds.length
      ? await prisma.approvalRequest.findMany({
          where: { id: { in: approvalIds }, companyId: auth.companyId },
          select: {
            id: true,
            decidedAt: true,
            steps: {
              where: { status: { in: ['APPROVED', 'REJECTED'] } },
              orderBy: { stepOrder: 'desc' },
              take: 1,
              select: {
                comment: true,
                approverEmployee: {
                  select: { firstName: true, lastName: true, displayName: true },
                },
              },
            },
          },
        })
      : [];
    const decisions = new Map(approvals.map((a) => [a.id, a]));

    const data: RegularizationRecord[] = rows.map((row) => {
      const approval = row.approvalRequestId ? decisions.get(row.approvalRequestId) : undefined;
      const step = approval?.steps[0];
      return {
        id: row.id,
        employeeId: row.employeeId,
        employeeName: displayName(row.employee),
        attendanceDate: row.attendanceDate.toISOString().slice(0, 10),
        issueType: row.issueType,
        requestedCheckInAt: row.requestedCheckInAt?.toISOString() ?? null,
        requestedCheckOutAt: row.requestedCheckOutAt?.toISOString() ?? null,
        requestedStatus: row.requestedStatus,
        reason: row.reason,
        status: row.status,
        approvalRequestId: row.approvalRequestId,
        decidedAt: approval?.decidedAt?.toISOString() ?? null,
        reviewerName: step?.approverEmployee ? displayName(step.approverEmployee) : null,
        reviewerComment: step?.comment ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    });

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  /**
   * Raise a correction request for your own attendance.
   *
   * Three things this route deliberately does NOT do:
   *
   *  - It does not take an employee id. The subject is `callerEmployeeOrThrow`,
   *    read from the session, so there is no field in the body an employee
   *    could change to file a correction against somebody else.
   *  - It does not touch `attendance_records`. Submitting asks for a change;
   *    only `applyRegularization`, called by the approval engine once the chain
   *    has actually approved, writes one.
   *  - It does not invent an approval chain. `resolveChain` is the
   *    same manager -> secondary manager -> department head chain leave, shift
   *    changes and loans all run through.
   */
  app.post('/regularizations', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(regularizationCreateSchema, request.body);

    const self = await callerEmployeeOrThrow(auth);
    const policy = await resolveAttendancePolicy(auth.companyId);
    const dayKey = input.attendanceDate.slice(0, 10);

    // A day that has not happened cannot have gone wrong yet, and "today" is
    // the company's today - a correction filed from another timezone must not
    // be accepted or refused on the strength of where the employee is standing.
    if (dayKey > todayInZone(policy.timeZone)) {
      throw new ValidationError({
        attendanceDate: ['You cannot request a correction for a day that has not happened yet.'],
      });
    }

    const attendanceDate = toDateOnly(input.attendanceDate);

    const duplicate = await prisma.attendanceRegularizationRequest.findFirst({
      where: { employeeId: self.id, attendanceDate, status: 'PENDING' },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictError('You already have a pending correction for that date.');
    }

    /*
     * The chain is resolved and checked BEFORE anything is written.
     *
     * The other order leaves an orphan: the request row lands, the chain turns
     * out to be empty or to contain the requester, `createApprovalRequest`
     * throws, and the employee is left with a PENDING correction nobody can
     * ever decide. The loans module fixed this same ordering; this is the last
     * caller that had it the wrong way round.
     */
    const chain = await resolveChain(auth.companyId, 'ATTENDANCE_REGULARIZATION', self.id);
    assertChainUsable(chain, self.id);

    const requestedCheckInAt = resolveRequestedTime(
      input.requestedCheckInAt,
      dayKey,
      policy.timeZone,
      'requestedCheckInAt',
    );
    const requestedCheckOutAt = resolveRequestedTime(
      input.requestedCheckOutAt,
      dayKey,
      policy.timeZone,
      'requestedCheckOutAt',
    );

    if (
      requestedCheckInAt &&
      requestedCheckOutAt &&
      requestedCheckOutAt.getTime() <= requestedCheckInAt.getTime()
    ) {
      throw new ValidationError({
        requestedCheckOutAt: ['The check-out time has to be after the check-in time.'],
      });
    }

    /*
     * What the approver is told: the request itself, with what is on record
     * now beside it, so they can decide from the notification. Read before the
     * transaction; the record is only ever changed by an approved request.
     */
    const current = await prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId: self.id, date: attendanceDate } },
      select: { checkInAt: true, checkOutAt: true },
    });
    const notice = correctionNotice({
      employeeName: `${self.firstName} ${self.lastName}`.trim(),
      dayKey,
      timeZone: policy.timeZone,
      issueType: input.issueType ?? null,
      current,
      requestedCheckInAt,
      requestedCheckOutAt,
      requestedStatusLabel: input.requestedStatus ? ATTENDANCE_STATUS_LABELS[input.requestedStatus] : null,
      reason: input.reason,
    });

    const { created, approval } = await prisma.$transaction(async (tx) => {
      const created = await tx.attendanceRegularizationRequest.create({
        data: {
          companyId: auth.companyId,
          employeeId: self.id,
          attendanceDate,
          issueType: input.issueType ?? null,
          requestedCheckInAt,
          requestedCheckOutAt,
          requestedStatus: input.requestedStatus ?? null,
          reason: input.reason,
          status: 'PENDING',
        },
      });

      const approval = await createApprovalRequest({
        companyId: auth.companyId,
        subjectType: 'ATTENDANCE_REGULARIZATION',
        subjectId: created.id,
        requesterEmployeeId: self.id,
        requesterUserId: auth.userId,
        title: notice.title,
        summary: notice.summary,
        chain,
        request,
        client: tx,
        deferAudit: true,
      });

      await tx.attendanceRegularizationRequest.update({
        where: { id: created.id },
        data: { approvalRequestId: approval.id },
      });

      return { created, approval };
    });

    // Both side effects wait for the commit: an approver must never be told
    // about a request a rolled-back transaction never filed.
    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'attendance.regularization.create',
      entityType: 'AttendanceRegularizationRequest',
      entityId: created.id,
      summary: `Requested attendance correction for ${dayKey}`,
      after: {
        issueType: input.issueType ?? null,
        requestedCheckInAt: requestedCheckInAt?.toISOString() ?? null,
        requestedCheckOutAt: requestedCheckOutAt?.toISOString() ?? null,
        requestedStatus: input.requestedStatus ?? null,
      },
      request,
    });
    await notifyApprover(approval.id, 1, request);

    return reply.status(201).send({ data: { id: created.id, approvalRequestId: approval.id } });
  });
};

/**
 * A requested time, as an instant.
 *
 * `HH:mm` is a wall-clock reading and is resolved against the attendance date
 * in the COMPANY's timezone, which is the only reading that stays right when
 * the employee files it from somewhere else. A full ISO instant is passed
 * through, for callers that were already sending one.
 */
function resolveRequestedTime(
  value: string | null | undefined,
  dayKey: string,
  timeZone: string,
  field: string,
): Date | null {
  if (value === null || value === undefined || value === '') return null;

  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    const instant = clockBoundary(dayKey, value, timeZone);
    if (!instant) throw new ValidationError({ [field]: ['Enter a time as HH:mm.'] });
    return instant;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError({ [field]: ['Enter a valid time.'] });
  }
  return parsed;
}
