import type { FastifyPluginAsync } from 'fastify';
import { PERMISSIONS, attendancePolicySchema, updateCompanySchema } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';

export const companyRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const company = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } });
      return reply.send({ data: company });
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

  /** KPI counters for the dashboard. Cheap aggregate queries, one round trip. */
  app.get(
    '/stats',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
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
