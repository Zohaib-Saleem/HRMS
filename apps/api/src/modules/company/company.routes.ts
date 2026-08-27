import type { FastifyPluginAsync } from 'fastify';
import { PERMISSIONS, updateCompanySchema } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { diff, recordAudit } from '../../core/audit.js';
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
