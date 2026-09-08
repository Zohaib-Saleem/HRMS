import type { FastifyPluginAsync } from 'fastify';
import { PERMISSIONS, attendancePolicySchema, updateCompanySchema } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ForbiddenError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { hasFullScope } from '../../auth/scope.js';
import type { AuthContext } from '../../auth/session.js';

/**
 * Company fields that describe how attendance is POLICED rather than how the
 * company presents itself.
 *
 * Every signed-in user holds `company.read` - they need the name, timezone,
 * currency and date format to render anything at all. These particular fields
 * are different: together they tell an employee which networks bypass the
 * check-in restriction, how far from a location a punch is still accepted, and
 * exactly how much lateness goes unrecorded. That is a description of the
 * control, which is useful only to someone trying to work around it. They are
 * returned only to a caller who could change them anyway.
 */
const RESTRICTED_COMPANY_FIELDS = [
  'allowedCheckInCidrs',
  'ipRestrictionEnabled',
  'locationRestrictionEnabled',
  'defaultGeofenceRadiusM',
  'graceMinutes',
  'earlyLeaveGraceMinutes',
  'halfDayMinutes',
  'fullDayMinutes',
  'overtimeEnabled',
  'overtimeAfterMinutes',
  'overtimeDailyCapMinutes',
] as const;

function mayReadRestrictedConfig(auth: AuthContext): boolean {
  return auth.permissions.has(PERMISSIONS.COMPANY_MANAGE);
}

function redactCompany<T extends Record<string, unknown>>(company: T, auth: AuthContext): T {
  if (mayReadRestrictedConfig(auth)) return company;
  const safe = { ...company };
  for (const field of RESTRICTED_COMPANY_FIELDS) delete safe[field];
  return safe;
}

export const companyRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const company = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } });
      // Non-administrators get the profile without the enforcement settings.
      return reply.send({ data: redactCompany(company as unknown as Record<string, unknown>, auth) });
    },
  );

  app.patch(
    '/',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(updateCompanySchema, request.body);

      const before = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } });
      const after = await prisma.company.update({ where: { id: auth.companyId }, data: input });

      const changes = diff(
        before as unknown as Record<string, unknown>,
        input as unknown as Record<string, unknown>,
      );

      if (changes.changed.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'company.update',
          entityType: 'Company',
          entityId: auth.companyId,
          summary: `Updated company settings (${changes.changed.join(', ')})`,
          before: changes.before,
          after: changes.after,
          request,
        });
      }

      return reply.send({ data: after });
    },
  );

  /**
   * The attendance policy, saved as its own decision.
   *
   * Kept off the company profile form deliberately: these values change how
   * worked time is scored, so they get their own endpoint, their own permission
   * check and their own audit entry rather than riding along with an address
   * change. Read back through GET /company, which returns the whole row.
   */
  app.patch(
    '/attendance-policy',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(attendancePolicySchema, request.body);

      const before = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } });

      // The check-in restriction fields are optional in the payload: a client
      // that does not send them keeps whatever is stored. Merging here rather
      // than defaulting in the schema means an older client cannot switch a
      // security control off simply by not knowing about it.
      const data = {
        ...input,
        ipRestrictionEnabled: input.ipRestrictionEnabled ?? before.ipRestrictionEnabled,
        allowedCheckInCidrs: input.allowedCheckInCidrs ?? before.allowedCheckInCidrs,
      };

      // Checked against the merged result, so enabling the restriction while
      // relying on an already-configured list is allowed, and enabling it with
      // nothing configured is not.
      if (data.ipRestrictionEnabled && data.allowedCheckInCidrs.length === 0) {
        throw new ValidationError({
          allowedCheckInCidrs: [
            'Add at least one network before turning this on - an empty list refuses every check-in.',
          ],
        });
      }

      const after = await prisma.company.update({ where: { id: auth.companyId }, data });

      const changes = diff(
        before as unknown as Record<string, unknown>,
        data as unknown as Record<string, unknown>,
      );

      if (changes.changed.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'company.attendance_policy.update',
          entityType: 'Company',
          entityId: auth.companyId,
          summary: `Updated the attendance policy (${changes.changed.join(', ')})`,
          before: changes.before,
          after: changes.after,
          request,
        });
      }

      return reply.send({ data: after });
    },
  );

  /**
   * KPI counters for the administrative dashboard.
   *
   * Company-wide aggregates, so this needs company-wide SIGHT and not merely
   * the `company.read` permission every signed-in user holds. Permission
   * answers "may you read company things?"; scope answers "how much of the
   * company?" - and this endpoint previously asked only the first question,
   * handing headcount, active-account count, absence levels and the hiring rate
   * to an employee whose scope is OWN. In a small company "on leave: 1" plus a
   * visibly absent colleague identifies that colleague.
   *
   * Personal dashboard figures come from /me/dashboard instead.
   */
  app.get(
    '/stats',
    { preHandler: requirePermission(PERMISSIONS.EMPLOYEE_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      if (!hasFullScope(auth)) {
        throw new ForbiddenError('You do not have permission to view company-wide statistics.');
      }
      const companyId = auth.companyId;

      const [employees, activeEmployees, onLeave, departments, teams, activeUsers, newThisMonth] =
        await Promise.all([
          prisma.employee.count({ where: { companyId } }),
          prisma.employee.count({ where: { companyId, status: 'ACTIVE' } }),
          prisma.employee.count({ where: { companyId, status: 'ON_LEAVE' } }),
          prisma.department.count({ where: { companyId, isActive: true } }),
          prisma.team.count({ where: { companyId, isActive: true } }),
          prisma.user.count({ where: { companyId, status: 'ACTIVE' } }),
          prisma.employee.count({
            where: {
              companyId,
              hireDate: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
            },
          }),
        ]);

      return reply.send({
        data: { employees, activeEmployees, onLeave, departments, teams, activeUsers, newThisMonth },
      });
    },
  );

};
