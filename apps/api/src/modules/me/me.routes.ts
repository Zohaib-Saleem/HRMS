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
    };

    return reply.send({ data: payload });
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
