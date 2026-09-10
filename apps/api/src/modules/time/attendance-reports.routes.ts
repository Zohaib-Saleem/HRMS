import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  ATTENDANCE_REPORT_TYPES,
  PERMISSIONS,
  attendanceEmployeeFileQuerySchema,
  attendanceReportQuerySchema,
  type AttendanceEmployeeFile,
  type AttendanceReport,
  type AttendanceReportType,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import { dayKeyToDateColumn, dateColumnToDayKey } from '../../core/zoned-time.js';
import { deriveRangeForEmployees, shiftOnDate, type DerivedDay } from './attendance.service.js';
import {
  ADJUSTMENT_INCLUDE,
  toAdjustmentRecord,
} from './attendance-corrections.service.js';
import {
  attendancePercent,
  buildAttendanceReport,
  countInto,
  emptyCount,
  type ReportEmployee,
} from './attendance-reports.service.js';

/**
 * Attendance reports.
 *
 * Same scope rules as every other attendance route: `employeeScopeFilter`
 * narrows the employee set before a single day is derived, so a department
 * total cannot be used to infer attendance the caller could not read
 * person-by-person.
 *
 * Reports are allowed a wider range than the screens - a year is a reasonable
 * thing to ask a report for and an unreasonable thing to ask a table - but
 * still bounded, and the employee set is capped with `truncated` reported
 * honestly rather than silently.
 */

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

/** A report may span a year. Beyond that it is an export job, not a request. */
const MAX_REPORT_DAYS = 400;

/** The most employees one report will score. Reported when it bites. */
const EMPLOYEE_CAP = 2000;

/** And the ceiling that actually matters: employees multiplied by days. */
const MAX_EMPLOYEE_DAYS = 120_000;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sendCsv(reply: FastifyReply, filename: string, report: AttendanceReport): FastifyReply {
  const lines = [
    report.columns.map((c) => c.label).join(','),
    ...report.rows.map((row) => report.columns.map((c) => csvCell(row[c.key])).join(',')),
  ];
  if (report.totals) {
    lines.push(report.columns.map((c) => csvCell(report.totals![c.key])).join(','));
  }
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    // BOM so Excel opens UTF-8 names correctly, matching the employee export.
    .send(`﻿${lines.join('\r\n')}\r\n`);
}

function rangeFor(query: { month?: string; from?: string; to?: string }): {
  from: Date;
  to: Date;
} {
  if (query.from || query.to) {
    return {
      from: dayKeyToDateColumn(query.from ?? query.to!),
      to: dayKeyToDateColumn(query.to ?? query.from!),
    };
  }
  if (query.month) {
    const [year, month] = query.month.split('-').map(Number);
    return {
      from: new Date(Date.UTC(year!, month! - 1, 1)),
      to: new Date(Date.UTC(year!, month!, 0)),
    };
  }
  const now = new Date();
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)),
  };
}

function assertReportRange(from: Date, to: Date): void {
  if (to < from) {
    throw new ValidationError({ to: ['The end of the range cannot be before the start.'] });
  }
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (days > MAX_REPORT_DAYS) {
    throw new ValidationError({
      to: [`A report covers at most ${MAX_REPORT_DAYS} days; this range is ${days}.`],
    });
  }
}

export const attendanceReportRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.ATTENDANCE_READ));

  /** Which reports exist, for the screen's picker. */
  app.get('/', async (_request, reply) => {
    return reply.send({ data: ATTENDANCE_REPORT_TYPES });
  });

  /**
   * One employee's whole file over a range.
   *
   * The calendar, the day detail, the raw punches, the corrections and the
   * shift history - assembled once so the screen cannot show a calendar for
   * September beside punches from August.
   */
  app.get('/employee-file', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(attendanceEmployeeFileQuerySchema, request.query);
    await assertEmployeeInScope(auth, query.employeeId);

    const { from, to } = rangeFor(query);
    assertReportRange(from, to);
    const fromKey = dateColumnToDayKey(from);
    const toKey = dateColumnToDayKey(to);

    const employee = await prisma.employee.findFirst({
      where: { id: query.employeeId, companyId: auth.companyId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        employeeNumber: true,
        hireDate: true,
        locationId: true,
        department: { select: { name: true } },
        team: { select: { name: true } },
        designation: { select: { name: true } },
      },
    });
    if (!employee) throw new NotFoundError('Employee');

    const [derived, punches, adjustments, assignments, mappings] = await Promise.all([
      deriveRangeForEmployees(auth.companyId, [employee], from, to),
      prisma.attendanceRawPunch.findMany({
        where: {
          companyId: auth.companyId,
          employeeId: employee.id,
          localDayKey: { gte: fromKey, lte: toKey },
        },
        orderBy: { punchedAt: 'asc' },
        take: 5000,
        select: {
          id: true,
          deviceId: true,
          deviceUserId: true,
          rawTimestamp: true,
          punchedAt: true,
          punchState: true,
          verifyMode: true,
          importedAt: true,
          processedAt: true,
          device: { select: { name: true, serialNumber: true } },
        },
      }),
      prisma.attendanceAdjustment.findMany({
        where: { companyId: auth.companyId, employeeId: employee.id, date: { gte: from, lte: to } },
        orderBy: { createdAt: 'desc' },
        include: ADJUSTMENT_INCLUDE,
      }),
      prisma.employeeShiftAssignment.findMany({
        where: {
          employeeId: employee.id,
          effectiveFrom: { lte: to },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
        },
        orderBy: { effectiveFrom: 'desc' },
        include: { shift: { select: { id: true, name: true, startTime: true, endTime: true } } },
      }),
      prisma.attendanceDeviceUserMapping.findMany({
        where: { companyId: auth.companyId, employeeId: employee.id },
        include: { device: { select: { id: true, name: true } } },
      }),
    ]);

    const days = derived.get(employee.id) ?? [];
    const bucket = emptyCount();
    for (const day of days) countInto(bucket, day);

    const data: AttendanceEmployeeFile = {
      employee: {
        id: employee.id,
        name: displayName(employee),
        employeeNumber: employee.employeeNumber,
        departmentName: employee.department?.name ?? null,
        teamName: employee.team?.name ?? null,
        designationName: employee.designation?.name ?? null,
        joinedOn: employee.hireDate ? dateColumnToDayKey(employee.hireDate) : null,
        punchCodes: mappings.map((m) => ({
          deviceId: m.device.id,
          deviceName: m.device.name,
          deviceUserId: m.deviceUserId,
          effectiveFrom: m.effectiveFrom ? dateColumnToDayKey(m.effectiveFrom) : null,
          effectiveTo: m.effectiveTo ? dateColumnToDayKey(m.effectiveTo) : null,
          isActive: m.isActive,
        })),
      },
      from: fromKey,
      to: toKey,
      days,
      totals: {
        present: bucket.presentDays,
        halfDay: bucket.halfDays,
        absent: bucket.absentDays,
        onLeave: bucket.leaveDays,
        holiday: bucket.holidayDays,
        weekend: bucket.weekendDays,
        upcoming: bucket.upcomingDays,
        offDay: bucket.offDays,
        workedMinutes: bucket.workedMinutes,
        expectedMinutes: bucket.expectedMinutes,
        lateMinutes: bucket.lateMinutes,
        overtimeMinutes: bucket.overtimeMinutes,
        late: bucket.lateCount,
        earlyLeave: bucket.earlyLeaveCount,
        overtime: days.filter((d) => (d.overtimeMinutes ?? 0) > 0).length,
        missingPunch: bucket.missingPunchDays,
        irregular: bucket.irregularDays,
        manual: bucket.manualDays,
        earlyLeaveMinutes: bucket.earlyLeaveMinutes,
        attendancePercentage: attendancePercent(bucket),
      },
      rawPunches: punches.map((p) => ({
        id: p.id,
        deviceId: p.deviceId,
        deviceName: p.device.name,
        deviceSerial: p.device.serialNumber,
        deviceUserId: p.deviceUserId,
        rawTimestamp: p.rawTimestamp,
        punchedAt: p.punchedAt.toISOString(),
        punchState: p.punchState,
        verifyMode: p.verifyMode,
        importedAt: p.importedAt.toISOString(),
        processedAt: p.processedAt?.toISOString() ?? null,
      })),
      adjustments: adjustments.map(toAdjustmentRecord),
      shiftHistory: assignments.map((a) => ({
        id: a.id,
        shiftId: a.shiftId,
        shiftName: a.shift.name,
        startTime: a.shift.startTime,
        endTime: a.shift.endTime,
        effectiveFrom: dateColumnToDayKey(a.effectiveFrom),
        effectiveTo: a.effectiveTo ? dateColumnToDayKey(a.effectiveTo) : null,
      })),
    };

    return reply.send({ data });
  });

  /**
   * Builds a report.
   *
   * Shared by the JSON and the CSV route so an export is byte-for-byte the
   * table that was on screen, rather than a second query that might have
   * moved on.
   */
  const load = async (request: FastifyRequest): Promise<AttendanceReport | null> => {
    const auth = requireAuthContext(request);
    const params = request.params as { type?: string };
    const type = (params.type ?? 'summary') as AttendanceReportType;
    if (!ATTENDANCE_REPORT_TYPES.includes(type)) throw new NotFoundError('Report');

    const query = parseOrThrow(attendanceReportQuerySchema, request.query);
    const { from, to } = rangeFor(query);
    assertReportRange(from, to);

    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) return null;
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const where: Prisma.EmployeeWhereInput = {
      AND: [
        { companyId: auth.companyId },
        scopeFilter,
        query.employeeId ? { id: query.employeeId } : {},
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
        // Nobody is absent for a period before they joined or after they left.
        { OR: [{ hireDate: null }, { hireDate: { lte: to } }] },
        { OR: [{ terminationDate: null }, { terminationDate: { gte: from } }] },
      ],
    };

    const rows = await prisma.employee.findMany({
      where,
      take: EMPLOYEE_CAP + 1,
      orderBy: [{ employeeNumber: 'asc' }, { firstName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        employeeNumber: true,
        locationId: true,
        department: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
        designation: { select: { name: true } },
      },
    });

    const truncated = rows.length > EMPLOYEE_CAP;
    const people = truncated ? rows.slice(0, EMPLOYEE_CAP) : rows;

    /**
     * The real ceiling is employee-days, not either dimension alone.
     *
     * Four hundred days for two thousand people is 800,000 derived days held
     * in memory at once, which is how a report takes a server down. Refusing
     * with the arithmetic shown is far kinder than an out-of-memory kill, and
     * the caller can narrow either side.
     */
    const rangeDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (people.length * rangeDays > MAX_EMPLOYEE_DAYS) {
      throw new ValidationError({
        to: [
          `That is ${people.length} employee(s) over ${rangeDays} day(s), which is more than this report will build at once. Narrow the range or filter by department, team or employee.`,
        ],
      });
    }

    const derived = await deriveRangeForEmployees(auth.companyId, people, from, to);

    // The shift each person is on at the end of the range, for the roster
    // column. Read once per employee, not once per day.
    const shifts = await Promise.all(people.map((p) => shiftOnDate(p.id, to)));

    const employees: ReportEmployee[] = people.map((p, index) => ({
      id: p.id,
      name: displayName(p),
      employeeNumber: p.employeeNumber,
      departmentId: p.department?.id ?? null,
      departmentName: p.department?.name ?? null,
      teamId: p.team?.id ?? null,
      teamName: p.team?.name ?? null,
      designationName: p.designation?.name ?? null,
      shiftName: shifts[index]?.name ?? null,
    }));

    /**
     * The status filter, applied to days rather than to employees.
     *
     * Filtering here - once, in the one place that assembles a report - keeps
     * every report type consistent with it and keeps the deriver unaware of
     * it. An employee with no matching day still appears with no rows, which
     * is what a per-employee summary of "days absent" should show.
     */
    const days = new Map<string, DerivedDay[]>(
      employees.map((e) => {
        const all = derived.get(e.id) ?? [];
        return [e.id, query.status ? all.filter((d) => d.status === query.status) : all];
      }),
    );

    return buildAttendanceReport({
      type,
      from: dateColumnToDayKey(from),
      to: dateColumnToDayKey(to),
      employees,
      days,
      truncated,
    });
  };

  app.get('/:type', async (request, reply) => {
    const report = await load(request);
    if (!report) {
      return reply.send({
        data: {
          type: 'summary',
          title: 'Attendance summary',
          from: '',
          to: '',
          generatedAt: new Date().toISOString(),
          columns: [],
          rows: [],
          totals: null,
          truncated: false,
        } satisfies AttendanceReport,
      });
    }
    return reply.send({ data: report });
  });

  app.get('/:type/export', async (request, reply) => {
    const auth = requireAuthContext(request);
    const report = await load(request);
    if (!report) throw new NotFoundError('Report');

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'attendance.report.export',
      entityType: 'AttendanceReport',
      entityId: report.type,
      summary: `Exported the ${report.title.toLowerCase()} report for ${report.from} to ${report.to} (${report.rows.length} row(s))`,
      request,
    });

    return sendCsv(reply, `attendance-${report.type}-${report.from}-to-${report.to}.csv`, report);
  });
};
