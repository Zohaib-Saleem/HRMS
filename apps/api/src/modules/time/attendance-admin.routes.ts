import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  attendanceAdjustmentQuerySchema,
  attendanceCorrectionSchema,
  attendanceDashboardQuerySchema,
  attendanceDayQuerySchema,
  attendanceMonthlyQuerySchema,
  type AttendanceDashboard,
  type AttendanceDashboardCounts,
  type AttendanceDashboardGroup,
  type AttendanceDashboardPerson,
  type AttendanceMonthlyRow,
  type DerivedAttendanceStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import {
  assertAttendanceEmployeeInScope,
  attendancePeopleFilter,
} from '../../auth/scope.js';
import { dayKeyToDateColumn, todayInZone } from '../../core/zoned-time.js';
import { resolveAttendancePolicy } from './attendance-policy.js';
import { EMPLOYMENT_WINDOW_SELECT, attendancePopulationWhere } from './employment-window.js';
import {
  deriveRangeForEmployees,
  emptyMonthlyTotals,
  tallyDerived,
  type DerivedDay,
} from './attendance.service.js';
import {
  ADJUSTMENT_INCLUDE,
  applyCorrection,
  attendanceDayDetail,
  toAdjustmentRecord,
} from './attendance-corrections.service.js';

/**
 * The Attendance Correction Centre, and the day view behind it.
 *
 * Mounted alongside the existing attendance routes rather than inside them:
 * this is the administrative side of the module - search everybody, open one
 * day, correct it, read the ledger - and keeping it in its own file means the
 * self-service endpoints stay small enough to read.
 *
 * Every route here is scoped. `attendancePeopleFilter` decides which people the
 * caller may see before a single day is derived, so a manager searching the
 * correction centre finds their own team and an employee finds themselves.
 * Correcting anything additionally requires `attendance.manage`.
 */

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

const dateKey = (d: Date) => d.toISOString().slice(0, 10);

/** A search is a screen, not an export. Reports have their own endpoint. */
const MAX_RANGE_DAYS = 62;

/** The correction centre never scores more people than this in one request. */
const EMPLOYEE_CAP = 2000;

/** The dashboard lists at most this many people per panel. */
const PANEL_SIZE = 25;

function rangeFor(query: {
  month?: string;
  from?: string;
  to?: string;
}): { from: Date; to: Date } {
  // An explicit range wins over the month shorthand, so a caller can always
  // ask precisely for what it wants.
  if (query.from || query.to) {
    const fromKey = query.from ?? query.to!;
    const toKey = query.to ?? query.from!;
    return { from: dayKeyToDateColumn(fromKey), to: dayKeyToDateColumn(toKey) };
  }
  if (query.month) {
    const [year, month] = query.month.split('-').map(Number);
    const from = new Date(Date.UTC(year!, month! - 1, 1));
    const to = new Date(Date.UTC(year!, month!, 0));
    return { from, to };
  }
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  return { from, to };
}

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

const emptyCounts = (): AttendanceDashboardCounts => ({
  totalEmployees: 0,
  present: 0,
  halfDay: 0,
  absent: 0,
  onLeave: 0,
  holiday: 0,
  weekend: 0,
  offDay: 0,
  late: 0,
  earlyLeave: 0,
  overtime: 0,
  missingPunch: 0,
  irregular: 0,
  attendancePercentage: null,
});

function countDay(counts: AttendanceDashboardCounts, day: DerivedDay): void {
  counts.totalEmployees += 1;
  if (day.status === 'PRESENT') counts.present += 1;
  else if (day.status === 'HALF_DAY') counts.halfDay += 1;
  else if (day.status === 'ABSENT') counts.absent += 1;
  else if (day.status === 'ON_LEAVE') counts.onLeave += 1;
  else if (day.status === 'HOLIDAY') counts.holiday += 1;
  else if (day.status === 'WEEKEND') counts.weekend += 1;
  else if (day.status === 'OFF_DAY') counts.offDay += 1;

  for (const flag of day.flags) {
    if (flag === 'LATE') counts.late += 1;
    else if (flag === 'EARLY_LEAVE') counts.earlyLeave += 1;
    else if (flag === 'OVERTIME') counts.overtime += 1;
    else if (flag === 'MISSING_PUNCH') counts.missingPunch += 1;
    else if (flag === 'IRREGULAR') counts.irregular += 1;
  }
}

function finishCounts(counts: AttendanceDashboardCounts): AttendanceDashboardCounts {
  const scored = counts.present + counts.halfDay + counts.absent + counts.onLeave;
  counts.attendancePercentage =
    scored > 0 ? Math.round(((counts.present + counts.halfDay * 0.5) / scored) * 1000) / 10 : null;
  return counts;
}

export const attendanceAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.ATTENDANCE_READ));

  /**
   * The Attendance Correction Centre's search.
   *
   * One row per employee per day, filtered by everything HR actually searches
   * on: the person, their code, the PunchCode their terminal knows them by, a
   * date or a month, department, team, shift, status and flag.
   *
   * Paginated by employee, not by row: a page that cut mid-employee would show
   * somebody's first eleven days and call it a month.
   */
  app.get('/monthly', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(attendanceMonthlyQuerySchema, request.query);

    const scopeFilter = await attendancePeopleFilter(auth);
    if (scopeFilter === null) {
      return reply.send({
        data: [],
        meta: buildMeta(query.page, query.limit, 0),
        totals: emptyMonthlyTotals(),
      });
    }
    if (query.employeeId) await assertAttendanceEmployeeInScope(auth, query.employeeId);

    const { from, to } = rangeFor(query);
    assertUsableRange(from, to);

    /**
     * A PunchCode narrows to whoever it is mapped to.
     *
     * Every employee the PIN has ever been mapped to, active or closed - the
     * question "who does this PunchCode belong to?" is usually asked precisely
     * because the answer changed at some point.
     */
    let punchCodeEmployeeIds: string[] | null = null;
    if (query.punchCode) {
      const mappings = await prisma.attendanceDeviceUserMapping.findMany({
        where: { companyId: auth.companyId, deviceUserId: query.punchCode },
        select: { employeeId: true },
      });
      punchCodeEmployeeIds = [...new Set(mappings.map((m) => m.employeeId))];
      if (punchCodeEmployeeIds.length === 0) {
        return reply.send({
          data: [],
          meta: buildMeta(query.page, query.limit, 0),
          totals: emptyMonthlyTotals(),
        });
      }
    }

    const terms = query.q ? query.q.split(/\s+/).filter(Boolean) : [];
    const where: Prisma.EmployeeWhereInput = {
      AND: [
        { companyId: auth.companyId },
        scopeFilter,
        query.employeeId ? { id: query.employeeId } : {},
        punchCodeEmployeeIds ? { id: { in: punchCodeEmployeeIds } } : {},
        query.employeeNumber
          ? { employeeNumber: { equals: query.employeeNumber, mode: 'insensitive' } }
          : {},
        query.departmentId ? { departmentId: query.departmentId } : {},
        query.teamId ? { teamId: query.teamId } : {},
        query.shiftId
          ? {
              shiftAssignments: {
                some: {
                  shiftId: query.shiftId,
                  effectiveFrom: { lte: to },
                  OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
                },
              },
            }
          : {},
        ...terms.map((term) => ({
          OR: [
            { firstName: { contains: term, mode: 'insensitive' as const } },
            { lastName: { contains: term, mode: 'insensitive' as const } },
            { displayName: { contains: term, mode: 'insensitive' as const } },
            { employeeNumber: { contains: term, mode: 'insensitive' as const } },
          ],
        })),
        // Only people employed at some point in the month. Narrowed in the
        // database so `count` and the page it describes see one population.
        attendancePopulationWhere(from, to),
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, employees] = await Promise.all([
      prisma.employee.count({ where }),
      prisma.employee.findMany({
        where,
        skip,
        take,
        orderBy: [{ employeeNumber: 'asc' }, { firstName: 'asc' }],
        select: {
          id: true,
          firstName: true,
          lastName: true,
          displayName: true,
          employeeNumber: true,
          locationId: true,
          department: { select: { name: true } },
          team: { select: { name: true } },
          ...EMPLOYMENT_WINDOW_SELECT,
        },
      }),
    ]);

    const derived = await deriveRangeForEmployees(auth.companyId, employees, from, to);

    const rows: AttendanceMonthlyRow[] = [];
    const kept: DerivedDay[] = [];

    for (const employee of employees) {
      for (const day of derived.get(employee.id) ?? []) {
        if (query.status && day.status !== query.status) continue;
        if (query.flag && !day.flags.includes(query.flag)) continue;
        if (
          query.workingOnly === 'true' &&
          (day.status === 'WEEKEND' ||
            day.status === 'HOLIDAY' ||
            day.status === 'OFF_DAY' ||
            day.status === 'UPCOMING')
        ) {
          continue;
        }

        kept.push(day);
        rows.push({
          date: day.date,
          employeeId: employee.id,
          employeeName: displayName(employee),
          employeeNumber: employee.employeeNumber,
          departmentName: employee.department?.name ?? null,
          teamName: employee.team?.name ?? null,
          shiftId: day.shiftId,
          shiftName: day.shiftName,
          checkInAt: day.checkInAt,
          checkOutAt: day.checkOutAt,
          workedMinutes: day.workedMinutes,
          expectedMinutes: day.expectedMinutes,
          lateMinutes: day.lateMinutes,
          earlyLeaveMinutes: day.earlyLeaveMinutes,
          overtimeMinutes: day.overtimeMinutes,
          status: day.status,
          flags: day.flags,
          leaveTypeName: day.leaveTypeName,
          holidayName: day.holidayName,
          source: day.source,
          hasRecord: day.hasRecord,
        });
      }
    }

    return reply.send({
      data: rows,
      meta: buildMeta(query.page, query.limit, total),
      totals: tallyDerived(kept),
      range: { from: dateKey(from), to: dateKey(to) },
    });
  });

  /**
   * One employee-day, in full.
   *
   * The stored day, the rules that produced it, the raw punches underneath,
   * what those punches would score today, and every correction ever made.
   * "View original punches" is this endpoint.
   */
  app.get('/day', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(attendanceDayQuerySchema, request.query);
    await assertAttendanceEmployeeInScope(auth, query.employeeId);

    const data = await attendanceDayDetail({
      companyId: auth.companyId,
      employeeId: query.employeeId,
      dayKey: query.date,
    });

    return reply.send({ data });
  });

  /**
   * Corrects a processed day.
   *
   * Needs `attendance.manage` on top of the read gate, and the employee has to
   * be in scope. The raw punches are not touched, no other day is
   * recalculated, and the change is written to both the adjustment ledger and
   * the audit log before the response is sent.
   */
  app.post(
    '/corrections',
    { preHandler: requirePermission(PERMISSIONS.ATTENDANCE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(attendanceCorrectionSchema, request.body);
      await assertAttendanceEmployeeInScope(auth, input.employeeId);

      const outcome = await applyCorrection({
        companyId: auth.companyId,
        actorId: auth.userId,
        correction: input,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'attendance.correct',
        entityType: 'AttendanceRecord',
        entityId: outcome.recordId,
        summary: `${outcome.summary} - ${input.reason}`,
        before: outcome.before,
        after: outcome.after,
        request,
      });

      return reply.status(201).send({
        data: {
          recordId: outcome.recordId,
          adjustmentId: outcome.adjustmentId,
          changedFields: outcome.changedFields,
        },
      });
    },
  );

  /**
   * The adjustment ledger.
   *
   * Append-only and never pruned. Scoped like everything else, so a manager
   * reads corrections for their own team and nobody reads the company's by
   * accident.
   */
  app.get('/adjustments', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(attendanceAdjustmentQuerySchema, request.query);

    const scopeFilter = await attendancePeopleFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }
    if (query.employeeId) await assertAttendanceEmployeeInScope(auth, query.employeeId);

    const where: Prisma.AttendanceAdjustmentWhereInput = {
      AND: [
        { companyId: auth.companyId },
        { employee: scopeFilter },
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.date ? { date: dayKeyToDateColumn(query.date) } : {},
        query.from ? { date: { gte: dayKeyToDateColumn(query.from) } } : {},
        query.to ? { date: { lte: dayKeyToDateColumn(query.to) } } : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.attendanceAdjustment.count({ where }),
      prisma.attendanceAdjustment.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: ADJUSTMENT_INCLUDE,
      }),
    ]);

    return reply.send({
      data: rows.map(toAdjustmentRecord),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  /**
   * The attendance dashboard for one day.
   *
   * Headline counts, a short trend, the same counts by department and by team,
   * and the four lists somebody actually opens the screen for: who arrived
   * recently, who was late, who is still in, and who is missing.
   *
   * Employees on no team are grouped as "Unassigned" rather than dropped -
   * teams are optional in this HRMS and a summary that quietly omitted a third
   * of the company would be worse than no summary.
   */
  app.get('/dashboard', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(attendanceDashboardQuerySchema, request.query);

    const policy = await resolveAttendancePolicy(auth.companyId);
    const dayKey = query.date ?? todayInZone(policy.timeZone);
    const date = dayKeyToDateColumn(dayKey);

    const scopeFilter = await attendancePeopleFilter(auth);
    const empty: AttendanceDashboard = {
      date: dayKey,
      truncated: false,
      counts: finishCounts(emptyCounts()),
      trend: [],
      byDepartment: [],
      byTeam: [],
      recent: [],
      late: [],
      presentNow: [],
      absent: [],
    };
    if (scopeFilter === null) return reply.send({ data: empty });

    const where: Prisma.EmployeeWhereInput = {
      AND: [
        { companyId: auth.companyId },
        scopeFilter,
        // People who had left before the day, or had not joined yet, are not
        // absent - they were not expected. The one lifecycle rule, so this
        // day's counts and the drill-down behind them agree.
        attendancePopulationWhere(date, date),
        query.departmentId ? { departmentId: query.departmentId } : {},
        query.teamId ? { teamId: query.teamId } : {},
      ],
    };

    const employees = await prisma.employee.findMany({
      where,
      take: EMPLOYEE_CAP + 1,
      orderBy: [{ employeeNumber: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        employeeNumber: true,
        locationId: true,
        department: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
        ...EMPLOYMENT_WINDOW_SELECT,
      },
    });

    const truncated = employees.length > EMPLOYEE_CAP;
    const people = truncated ? employees.slice(0, EMPLOYEE_CAP) : employees;

    const trendFrom = new Date(date);
    trendFrom.setUTCDate(trendFrom.getUTCDate() - (query.trendDays - 1));

    const derived = await deriveRangeForEmployees(auth.companyId, people, trendFrom, date);

    const counts = emptyCounts();
    const byDepartment = new Map<string, AttendanceDashboardGroup>();
    const byTeam = new Map<string, AttendanceDashboardGroup>();
    const trend = new Map<string, AttendanceDashboardCounts>();

    const persons: Array<{ person: AttendanceDashboardPerson; day: DerivedDay }> = [];

    const groupFor = (
      map: Map<string, AttendanceDashboardGroup>,
      id: string | null,
      name: string,
    ): AttendanceDashboardGroup => {
      const key = id ?? '__unassigned__';
      let group = map.get(key);
      if (!group) {
        group = { id, name, ...emptyCounts() };
        map.set(key, group);
      }
      return group;
    };

    for (const employee of people) {
      const days = derived.get(employee.id) ?? [];

      for (const day of days) {
        let bucket = trend.get(day.date);
        if (!bucket) trend.set(day.date, (bucket = emptyCounts()));
        countDay(bucket, day);
      }

      const today = days.find((d) => d.date === dayKey);
      if (!today) continue;

      countDay(counts, today);
      countDay(groupFor(byDepartment, employee.department?.id ?? null, employee.department?.name ?? 'Unassigned'), today);
      countDay(groupFor(byTeam, employee.team?.id ?? null, employee.team?.name ?? 'Unassigned'), today);

      persons.push({
        day: today,
        person: {
          employeeId: employee.id,
          employeeName: displayName(employee),
          employeeNumber: employee.employeeNumber,
          departmentName: employee.department?.name ?? null,
          teamName: employee.team?.name ?? null,
          status: today.status,
          flags: today.flags,
          checkInAt: today.checkInAt,
          checkOutAt: today.checkOutAt,
          lateMinutes: today.lateMinutes,
          overtimeMinutes: today.overtimeMinutes,
          shiftName: today.shiftName,
        },
      });
    }

    const byCheckInDesc = (a: (typeof persons)[number], b: (typeof persons)[number]) =>
      (b.day.checkInAt ?? '').localeCompare(a.day.checkInAt ?? '');

    const data: AttendanceDashboard = {
      date: dayKey,
      truncated,
      counts: finishCounts(counts),
      trend: [...trend.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, c]) => ({ date: d, ...finishCounts(c) })),
      byDepartment: [...byDepartment.values()]
        .map((g) => ({ ...g, ...finishCounts(g) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      byTeam: [...byTeam.values()]
        .map((g) => ({ ...g, ...finishCounts(g) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      recent: persons
        .filter((p) => p.day.checkInAt !== null)
        .sort(byCheckInDesc)
        .slice(0, PANEL_SIZE)
        .map((p) => p.person),
      late: persons
        .filter((p) => p.day.flags.includes('LATE'))
        .sort((a, b) => (b.day.lateMinutes ?? 0) - (a.day.lateMinutes ?? 0))
        .slice(0, PANEL_SIZE)
        .map((p) => p.person),
      presentNow: persons
        .filter((p) => p.day.checkInAt !== null && p.day.checkOutAt === null)
        .sort(byCheckInDesc)
        .slice(0, PANEL_SIZE)
        .map((p) => p.person),
      absent: persons
        .filter((p) => p.day.status === ('ABSENT' satisfies DerivedAttendanceStatus))
        .slice(0, PANEL_SIZE)
        .map((p) => p.person),
    };

    return reply.send({ data });
  });
};
