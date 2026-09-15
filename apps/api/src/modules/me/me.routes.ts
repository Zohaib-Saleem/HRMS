import type { FastifyPluginAsync } from 'fastify';
import type { SessionContext } from '@hrms/shared';
import { changePasswordSchema, updateProfileSchema } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { NotFoundError } from '../../core/errors.js';
import { recordAudit } from '../../core/audit.js';
import { requireAuth, requireAuthContext } from '../../auth/guards.js';
import { changeOwnPassword } from '../../auth/auth.service.js';
import { revokeAllUserSessions } from '../../auth/session.js';
import { deriveRange, shiftOnDate } from '../time/attendance.service.js';
import { resolveAttendancePolicy, resolvePolicyFor } from '../time/attendance-policy.js';
import { balancesForEmployee } from '../leave/leave.service.js';
import { dayKeyToDateColumn, todayInZone } from '../../core/zoned-time.js';
import { resolvePhotoUrl } from '../employees/employees.service.js';

/**
 * The session context endpoint. One request gives the shell everything it needs
 * to render: who you are, which company, and exactly what you may do.
 */
export const meRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      include: {
        company: true,
        userRoles: { include: { role: true } },
        employee: {
          include: {
            department: { select: { name: true } },
            team: { select: { name: true } },
          },
        },
      },
    });

    if (!user) throw new NotFoundError('User');

    const payload: SessionContext = {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: `${user.firstName} ${user.lastName}`.trim(),
        status: user.status,
        mustChangePassword: user.mustChangePassword,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        avatarColor: user.avatarColor,
        roles: user.userRoles.map(({ role }) => ({
          id: role.id,
          key: role.key,
          name: role.name,
        })),
        employee: user.employee
          ? {
              id: user.employee.id,
              employeeNumber: user.employee.employeeNumber,
              jobTitle: user.employee.jobTitle,
              departmentName: user.employee.department?.name ?? null,
              teamName: user.employee.team?.name ?? null,
              photoUrl: resolvePhotoUrl(user.employee),
            }
          : null,
      },
      company: {
        id: user.company.id,
        name: user.company.name,
        timezone: user.company.timezone,
        currency: user.company.currency,
        dateFormat: user.company.dateFormat,
        weekStartsOn: user.company.weekStartsOn,
      },
      permissions: [...auth.permissions].sort(),
      dataScope: auth.dataScope,
      employeeLinked: user.employee !== null,
    };

    return reply.send({ data: payload });
  });


  /**
   * Everything the employee's own dashboard renders, in one request.
   *
   * Deliberately separate from /company/stats. That endpoint answers "how is
   * the company doing?" and needs company-wide sight; this one answers "how am
   * I doing?" and needs nothing beyond the caller's own record. An employee
   * asking for their dashboard should never be the reason a headcount is
   * computed.
   *
   * Every figure here is scoped to the caller by construction - the employee id
   * comes from the session, never from the query string - so there is no
   * parameter an employee could change to see somebody else.
   */
  app.get('/dashboard', async (request, reply) => {
    const auth = requireAuthContext(request);

    const employee = await prisma.employee.findFirst({
      where: { companyId: auth.companyId, userId: auth.userId },
      select: {
        id: true,
        employeeNumber: true,
        firstName: true,
        lastName: true,
        displayName: true,
        jobTitle: true,
        status: true,
        photoUrl: true,
        photoObjectKey: true,
        photoUpdatedAt: true,
        hireDate: true,
        employmentType: true,
        // Read-only here, and read-only everywhere an employee can reach.
        // Nothing under /me writes an employee record, so an employee can see
        // their own employment status and has no route by which to change it.
        employmentStatus: true,
        locationId: true,
        department: { select: { name: true } },
        team: { select: { name: true } },
        designation: { select: { name: true } },
        manager: { select: { firstName: true, lastName: true } },
      },
    });

    /**
     * A login with no employee record is a real, reachable state: an account
     * can be created before the HR record exists, or linked to the wrong one.
     * It is reported explicitly rather than rendered as a dashboard full of
     * zeroes, which reads as "you have no leave and were absent all month".
     */
    if (!employee) {
      return reply.send({
        data: {
          employeeLinked: false,
          message:
            'Your login is not linked to an employee record yet, so attendance and leave are unavailable. Ask an administrator to link your account.',
          profile: null,
          today: null,
          leave: null,
          upcoming: null,
          attendanceMonth: null,
        },
      });
    }

    const policy = await resolveAttendancePolicy(auth.companyId);
    const todayKey = todayInZone(policy.timeZone);
    const today = dayKeyToDateColumn(todayKey);

    const monthStart = dayKeyToDateColumn(`${todayKey.slice(0, 7)}-01`);
    const monthEnd = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0),
    );

    const year = Number(todayKey.slice(0, 4));

    const [monthDays, balances, leaveRequests, holidays, shift, dayPolicy] = await Promise.all([
      deriveRange(auth.companyId, employee.id, monthStart, monthEnd),
      balancesForEmployee(auth.companyId, employee.id, year),
      prisma.leaveRequest.findMany({
        where: { companyId: auth.companyId, employeeId: employee.id },
        include: { leaveType: { select: { name: true, isPaid: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.holiday.findMany({
        where: {
          companyId: auth.companyId,
          isActive: true,
          date: { gte: today },
          OR: [{ locationId: null }, { locationId: employee.locationId }],
        },
        orderBy: { date: 'asc' },
        take: 3,
        select: { id: true, name: true, date: true },
      }),
      shiftOnDate(employee.id, today),
      resolvePolicyFor(auth.companyId, employee.id, today),
    ]);

    const todayDay = monthDays.find((d) => d.date === todayKey) ?? null;
    const workingDay =
      todayDay !== null &&
      todayDay.status !== 'WEEKEND' &&
      todayDay.status !== 'OFF_DAY' &&
      todayDay.status !== 'HOLIDAY' &&
      todayDay.status !== 'ON_LEAVE';

    // Counted from derived days, so UPCOMING is simply never tallied - a day
    // that has not happened is not an absence.
    const totals = { present: 0, halfDay: 0, absent: 0, onLeave: 0, holiday: 0, weekend: 0, upcoming: 0, lateDays: 0, workedMinutes: 0 };
    for (const d of monthDays) {
      if (d.status === 'PRESENT') totals.present += 1;
      else if (d.status === 'HALF_DAY') totals.halfDay += 1;
      else if (d.status === 'ABSENT') totals.absent += 1;
      else if (d.status === 'ON_LEAVE') totals.onLeave += 1;
      else if (d.status === 'HOLIDAY') totals.holiday += 1;
      else if (d.status === 'WEEKEND' || d.status === 'OFF_DAY') totals.weekend += 1;
      else if (d.status === 'UPCOMING') totals.upcoming += 1;
      if ((d.lateMinutes ?? 0) > 0) totals.lateDays += 1;
      totals.workedMinutes += d.workedMinutes ?? 0;
    }

    const asView = (r: (typeof leaveRequests)[number]) => ({
      id: r.id,
      leaveTypeName: r.leaveType.name,
      startDate: r.startDate.toISOString().slice(0, 10),
      endDate: r.endDate.toISOString().slice(0, 10),
      totalDays: Number(r.totalDays),
      status: r.status,
      dayPart: r.dayPart,
    });

    return reply.send({
      data: {
        employeeLinked: true,
        message: null,
        profile: {
          employeeId: employee.id,
          employeeNumber: employee.employeeNumber,
          fullName: employee.displayName ?? `${employee.firstName} ${employee.lastName}`,
          firstName: employee.firstName,
          jobTitle: employee.jobTitle,
          departmentName: employee.department?.name ?? null,
          teamName: employee.team?.name ?? null,
          designationName: employee.designation?.name ?? null,
          managerName: employee.manager
            ? `${employee.manager.firstName} ${employee.manager.lastName}`
            : null,
          status: employee.status,
          employmentType: employee.employmentType,
          employmentStatus: employee.employmentStatus,
          hireDate: employee.hireDate?.toISOString().slice(0, 10) ?? null,
          photoUrl: resolvePhotoUrl(employee),
        },
        today: {
          date: todayKey,
          status: todayDay?.status ?? 'UPCOMING',
          isWorkingDay: workingDay,
          reason:
            todayDay?.status === 'WEEKEND'
              ? 'Weekend'
              : todayDay?.status === 'HOLIDAY'
                ? (todayDay.holidayName ?? 'Holiday')
                : todayDay?.status === 'ON_LEAVE'
                  ? (todayDay.leaveTypeName ?? 'On leave')
                  : null,
          checkedIn: Boolean(todayDay?.checkInAt),
          checkedOut: Boolean(todayDay?.checkOutAt),
          checkInAt: todayDay?.checkInAt ?? null,
          checkOutAt: todayDay?.checkOutAt ?? null,
          workedMinutes: todayDay?.workedMinutes ?? null,
          // The buttons the UI should offer. Derived here so the client never
          // has to reimplement the rule the server enforces anyway.
          canCheckIn: workingDay && !todayDay?.checkInAt,
          canCheckOut: workingDay && Boolean(todayDay?.checkInAt) && !todayDay?.checkOutAt,
          shiftName: shift?.name ?? null,
          locationRequired: dayPolicy.locationRestrictionEnabled,
          networkRestricted: dayPolicy.ipRestrictionEnabled,
        },
        leave: {
          balances,
          pending: leaveRequests.filter((r) => r.status === 'PENDING').map(asView),
          recent: leaveRequests.slice(0, 5).map(asView),
        },
        upcoming: {
          holidays: holidays.map((h) => ({
            id: h.id,
            name: h.name,
            date: h.date.toISOString().slice(0, 10),
          })),
          approvedLeave: leaveRequests
            .filter((r) => r.status === 'APPROVED' && r.endDate >= today)
            .map(asView),
        },
        attendanceMonth: { month: todayKey.slice(0, 7), totals, days: monthDays },
      },
    });
  });

  app.patch('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(updateProfileSchema, request.body);

    const before = await prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { firstName: true, lastName: true },
    });

    const updated = await prisma.user.update({
      where: { id: auth.userId },
      data: { firstName: input.firstName, lastName: input.lastName },
      select: { id: true, firstName: true, lastName: true },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'user.profile.update',
      entityType: 'User',
      entityId: auth.userId,
      summary: 'Updated own profile',
      before,
      after: { firstName: updated.firstName, lastName: updated.lastName },
      request,
    });

    return reply.send({ data: updated });
  });

  app.patch('/password', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(changePasswordSchema, request.body);

    await changeOwnPassword(auth.userId, input.currentPassword, input.newPassword);

    // A password change invalidates every other session - standard practice,
    // and the reason sessions are server-side in the first place.
    const revoked = await revokeAllUserSessions(auth.userId, auth.sessionId);

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'user.password.change',
      entityType: 'User',
      entityId: auth.userId,
      summary: `Changed own password; revoked ${revoked} other session${revoked === 1 ? '' : 's'}`,
      request,
    });

    return reply.send({ data: { ok: true, revokedSessions: revoked } });
  });

  /** Active sessions for the security section of the profile screen. */
  app.get('/sessions', async (request, reply) => {
    const auth = requireAuthContext(request);
    const sessions = await prisma.session.findMany({
      where: { userId: auth.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastActivityAt: 'desc' },
      select: {
        id: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        lastActivityAt: true,
        expiresAt: true,
      },
    });

    return reply.send({
      data: sessions.map((s) => ({ ...s, isCurrent: s.id === auth.sessionId })),
    });
  });
};
