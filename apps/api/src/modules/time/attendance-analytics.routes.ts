import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  attendanceAnalyticsQuerySchema,
  type AttendanceAnalyticsResponse,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import { dateColumnToDayKey, dayKeyToDateColumn } from '../../core/zoned-time.js';
import { deriveRangeForEmployees } from './attendance.service.js';
import { EMPLOYMENT_WINDOW_SELECT, attendancePopulationWhere } from './employment-window.js';
import { aggregateDailyTotals, datesInRange, emptySummary } from './attendance-analytics.service.js';

/**
 * Aggregated attendance for the monthly bar chart.
 *
 * One endpoint, one shape: the whole month reduced to a row per calendar day
 * before it leaves the server. A company-wide September is 80 people times 30
 * days - some 2,400 derived days - and sending those to a browser so it can add
 * them up would be slower, larger and a second place for the arithmetic to be
 * wrong. The client receives thirty rows.
 *
 * Every figure comes from `deriveRangeForEmployees`, which is what the
 * attendance table, the calendar, the correction centre and the reports all
 * read. This route adds nothing to it and decides nothing itself: no status is
 * assigned here, no threshold is read here, and no clock time appears here.
 *
 * Scope is applied before a single day is derived, exactly as everywhere else.
 * `employeeScopeFilter` answers "which people?"; the department, team and
 * employee filters narrow inside that answer and can never widen it.
 */

/** A chart is a screen, not a report. Matches the other attendance screens. */
const MAX_RANGE_DAYS = 62;

/** The most people one chart will score. Reported honestly when it bites. */
const EMPLOYEE_CAP = 2000;

/** Employees times days is the ceiling that actually protects the server. */
const MAX_EMPLOYEE_DAYS = 120_000;

function rangeFor(query: { month?: string; from?: string; to?: string }): {
  from: Date;
  to: Date;
} {
  // An explicit range wins over the month shorthand, matching /monthly and the
  // reports, so the three cannot interpret the same query differently.
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

export const attendanceAnalyticsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.ATTENDANCE_READ));

  /**
   * Daily totals for the selected month and filters.
   *
   * Answers with every date in the range, including ones nobody worked, so an
   * empty month draws an empty axis rather than nothing at all.
   */
  app.get('/daily', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(attendanceAnalyticsQuerySchema, request.query);

    const { from, to } = rangeFor(query);
    assertUsableRange(from, to);

    const range = { from: dateColumnToDayKey(from), to: dateColumnToDayKey(to) };

    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      // NONE means no rows, never "no filter". The axis is still drawn.
      const empty: AttendanceAnalyticsResponse = {
        days: datesInRange(from, to).map((date) => ({
          ...aggregateDailyTotals({ dates: [date], byEmployee: new Map() }).days[0]!,
        })),
        summary: emptySummary(),
        range,
        truncated: false,
      };
      return reply.send({ data: empty });
    }

    // A guessed employee id cannot widen what the caller sees: the same check
    // every other attendance route makes, made before any work is done.
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const where: Prisma.EmployeeWhereInput = {
      AND: [
        { companyId: auth.companyId },
        scopeFilter,
        query.employeeId ? { id: query.employeeId } : {},
        query.departmentId ? { departmentId: query.departmentId } : {},
        query.teamId ? { teamId: query.teamId } : {},
        // Nobody is absent for a month before they joined or after they left.
        // The one clause every attendance population applies, for the same
        // reason - and the days INSIDE the month that fall outside their
        // employment are dropped by the deriver, which is what this pair of
        // rules could never do on its own.
        attendancePopulationWhere(from, to),
      ],
    };

    const rows = await prisma.employee.findMany({
      where,
      take: EMPLOYEE_CAP + 1,
      // Only what the deriver needs. The chart shows no names, so it reads none.
      select: { id: true, locationId: true, ...EMPLOYMENT_WINDOW_SELECT },
    });

    const truncated = rows.length > EMPLOYEE_CAP;
    const employees = truncated ? rows.slice(0, EMPLOYEE_CAP) : rows;

    const rangeDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (employees.length * rangeDays > MAX_EMPLOYEE_DAYS) {
      throw new ValidationError({
        to: [
          `That is ${employees.length} employee(s) over ${rangeDays} day(s), which is more than this chart will score at once. Narrow the range or filter by department, team or employee.`,
        ],
      });
    }

    const byEmployee = await deriveRangeForEmployees(auth.companyId, employees, from, to);

    const { days, summary } = aggregateDailyTotals({
      dates: datesInRange(from, to),
      byEmployee,
      status: query.status,
    });

    const data: AttendanceAnalyticsResponse = { days, summary, range, truncated };
    return reply.send({ data });
  });
};
