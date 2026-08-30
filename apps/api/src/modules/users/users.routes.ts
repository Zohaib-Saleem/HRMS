import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  idParamSchema,
  userCreateSchema,
  userQuerySchema,
  userRolesSchema,
  userSuspendSchema,
  userUpdateSchema,
  type LinkableEmployee,
  type UserDetail,
  type UserRecord,
  type UserSessionRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { revokeAllUserSessions } from '../../auth/session.js';
import { requestPasswordReset } from '../../auth/password-reset.service.js';
import {
  USER_INCLUDE,
  USER_OMIT,
  activeSessionWhere,
  canRestore,
  restoreUser,
  suspendUser,
  type UserRow,
} from './users.service.js';

/**
 * Login account administration.
 *
 * Two things this module never does, and the reasons matter more than the
 * rules:
 *
 *   - **It never handles a password.** Not on create, not on reset, not as a
 *     temporary value an administrator reads out over the phone. A new account
 *     is INVITED with no usable password and the person sets their own through
 *     the ordinary reset link. An administrator therefore never knows anybody's
 *     password, which is the only way that statement stays true.
 *
 *   - **It never returns authentication material.** The serialiser below does
 *     not select `passwordHash`, and there is no field for it, a placeholder
 *     for it, or a boolean about it anywhere in the response shape.
 *
 * Everything here is behind `user.read` / `user.manage`, which only the
 * administrator roles hold. A manager gains nothing from managing people.
 */

const displayName = (e: {
  firstName: string;
  lastName: string;
  displayName?: string | null;
}): string => e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

function toRecord(row: UserRow, activeSessionCount: number): UserRecord {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    fullName: `${row.firstName} ${row.lastName}`.trim(),
    status: row.status,
    avatarColor: row.avatarColor,
    isLockedOut: row.lockedUntil !== null && row.lockedUntil > new Date(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    suspendedReason: row.suspendedReason,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    suspendedByName: row.suspendedBy
      ? `${row.suspendedBy.firstName} ${row.suspendedBy.lastName}`.trim()
      : null,
    roles: row.userRoles.map((ur) => ur.role),
    employee: row.employee
      ? {
          id: row.employee.id,
          employeeNumber: row.employee.employeeNumber,
          fullName: displayName(row.employee),
          status: row.employee.status,
          departmentName: row.employee.department?.name ?? null,
        }
      : null,
    activeSessionCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Refuses an action against your own account.
 *
 * Suspending yourself, stripping your own roles or revoking your own sessions
 * from this screen are all ways to lock the last administrator out of the
 * system. Signing out is what the header is for.
 */
function assertNotSelf(actorUserId: string, targetUserId: string, action: string): void {
  if (actorUserId === targetUserId) {
    throw new ValidationError({ _: [`You cannot ${action} your own account from here.`] });
  }
}

/**
 * Refuses removal of the last account that can administer roles.
 *
 * A company with nobody holding `role.manage` cannot grant it back to anybody,
 * because granting it is the thing that requires it. That is unrecoverable
 * without database access, so it is refused here.
 */
async function assertNotLastAdministrator(
  companyId: string,
  userId: string,
  action: string,
): Promise<void> {
  const others = await prisma.user.count({
    where: {
      companyId,
      id: { not: userId },
      status: 'ACTIVE',
      userRoles: {
        some: {
          role: {
            rolePermissions: { some: { permission: { key: PERMISSIONS.ROLE_MANAGE } } },
          },
        },
      },
    },
  });

  if (others === 0) {
    throw new ValidationError({
      _: [
        `This is the only active account that can administer roles. ${action} it would lock everybody out.`,
      ],
    });
  }
}

/** Validates that every role id belongs to this company. */
async function resolveRoles(companyId: string, roleIds: readonly string[]) {
  const unique = [...new Set(roleIds)];
  const roles = await prisma.role.findMany({
    where: { id: { in: unique }, companyId },
    select: { id: true, key: true, name: true },
  });

  if (roles.length !== unique.length) {
    throw new ValidationError({ roleIds: ['One or more of those roles does not exist.'] });
  }
  return roles;
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  /** Every route needs at least read access. */
  app.addHook('preHandler', requirePermission(PERMISSIONS.USER_READ));

  // ------------------------------------------------------------------- list

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(userQuerySchema, request.query);

    const where: Prisma.UserWhereInput = {
      companyId: auth.companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.roleId ? { userRoles: { some: { roleId: query.roleId } } } : {}),
      ...(query.unlinkedOnly === 'true' ? { employee: null } : {}),
      ...(query.q
        ? {
            OR: [
              { firstName: { contains: query.q, mode: 'insensitive' } },
              { lastName: { contains: query.q, mode: 'insensitive' } },
              { email: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip,
        take,
        include: USER_INCLUDE,
        omit: USER_OMIT,
        orderBy: [{ status: 'asc' }, { firstName: 'asc' }, { lastName: 'asc' }],
      }),
    ]);

    // One grouped query rather than a count per row.
    const sessionCounts = await prisma.session.groupBy({
      by: ['userId'],
      where: { userId: { in: rows.map((r) => r.id) }, ...activeSessionWhere() },
      _count: { _all: true },
    });
    const byUser = new Map(sessionCounts.map((s) => [s.userId, s._count._all]));

    return reply.send({
      data: rows.map((row) => toRecord(row, byUser.get(row.id) ?? 0)),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  /** Employees with no login yet, for the create form. */
  app.get('/linkable-employees', async (request, reply) => {
    const auth = requireAuthContext(request);

    const employees = await prisma.employee.findMany({
      where: { companyId: auth.companyId, userId: null, status: { not: 'TERMINATED' } },
      select: {
        id: true,
        employeeNumber: true,
        firstName: true,
        lastName: true,
        displayName: true,
        workEmail: true,
        department: { select: { name: true } },
      },
      orderBy: { employeeNumber: 'asc' },
      take: 500,
    });

    const data: LinkableEmployee[] = employees.map((e) => ({
      id: e.id,
      employeeNumber: e.employeeNumber,
      fullName: displayName(e),
      workEmail: e.workEmail,
      departmentName: e.department?.name ?? null,
    }));

    return reply.send({ data });
  });

  // ----------------------------------------------------------------- detail

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await prisma.user.findFirst({
      where: { id, companyId: auth.companyId },
      include: USER_INCLUDE,
        omit: USER_OMIT,
    });
    if (!row) throw new NotFoundError('User');

    const sessions = await prisma.session.findMany({
      where: { userId: id, ...activeSessionWhere() },
      orderBy: { lastActivityAt: 'desc' },
      take: 50,
    });

    const decision = canRestore({
      status: row.status,
      suspendedReason: row.suspendedReason,
      statusBeforeSuspension: row.statusBeforeSuspension,
      employee: row.employee,
    });

    const data: UserDetail = {
      ...toRecord(row, sessions.length),
      sessions: sessions.map(
        (s): UserSessionRecord => ({
          id: s.id,
          ipAddress: s.ipAddress,
          userAgent: s.userAgent,
          createdAt: s.createdAt.toISOString(),
          lastActivityAt: s.lastActivityAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
        }),
      ),
      restore: { allowed: decision.allowed, reason: decision.reason },
    };

    return reply.send({ data });
  });

  // ----------------------------------------------------------------- create

  app.post('/', { preHandler: requirePermission(PERMISSIONS.USER_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(userCreateSchema, request.body);

    // Email is unique across the whole table, not per company, so the check
    // has to be too - otherwise the insert fails with a database error rather
    // than something a person can act on.
    const existing = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) throw new ConflictError('An account with that email address already exists.');

    const roles = await resolveRoles(auth.companyId, input.roleIds);

    let employee = null;
    if (input.employeeId) {
      employee = await prisma.employee.findFirst({
        where: { id: input.employeeId, companyId: auth.companyId },
        select: { id: true, firstName: true, lastName: true, status: true, userId: true },
      });
      if (!employee) throw new NotFoundError('Employee');

      // The one-to-one is enforced by a unique index on employee.userId; this
      // turns the resulting database error into an explanation.
      if (employee.userId) {
        throw new ConflictError('That employee already has a login account.');
      }
      if (employee.status === 'TERMINATED') {
        throw new ValidationError({
          employeeId: ['That employee is terminated and cannot be given a login.'],
        });
      }
    }

    /**
     * Created INVITED with a password hash that cannot be produced by any
     * input. It is not a placeholder to be replaced later by an administrator -
     * it is a value the verifier will always reject, so the only route into the
     * account is the reset link the invitee receives.
     */
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          companyId: auth.companyId,
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          passwordHash: 'invited:no-password-set',
          status: 'INVITED',
          mustChangePassword: true,
        },
      });

      await tx.userRole.createMany({
        data: roles.map((role) => ({ userId: user.id, roleId: role.id })),
      });

      if (employee) {
        await tx.employee.update({ where: { id: employee.id }, data: { userId: user.id } });
      }

      return user;
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'user.create',
      entityType: 'User',
      entityId: created.id,
      summary: `Created account for ${input.email} with role(s) ${roles.map((r) => r.name).join(', ')}${employee ? `, linked to ${employee.firstName} ${employee.lastName}` : ''}`,
      after: {
        email: input.email,
        status: 'INVITED',
        roles: roles.map((r) => r.key),
        employeeId: employee?.id ?? null,
      },
      request,
    });

    // Sends the invitation as an ordinary reset link. Deliberately after the
    // audit entry: a mail failure must not roll back the account, and the
    // administrator can resend from the detail screen.
    await requestPasswordReset(input.email, request);

    return reply.status(201).send({ data: { id: created.id, status: created.status } });
  });

  // ----------------------------------------------------------------- update

  app.patch('/:id', { preHandler: requirePermission(PERMISSIONS.USER_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const input = parseOrThrow(userUpdateSchema, request.body);

    const before = await prisma.user.findFirst({
      where: { id, companyId: auth.companyId },
      include: { employee: { select: { id: true } } },
    });
    if (!before) throw new NotFoundError('User');

    const nextEmployeeId = input.employeeId ?? null;
    const currentEmployeeId = before.employee?.id ?? null;

    if (nextEmployeeId !== currentEmployeeId) {
      if (nextEmployeeId) {
        const employee = await prisma.employee.findFirst({
          where: { id: nextEmployeeId, companyId: auth.companyId },
          select: { id: true, userId: true, status: true },
        });
        if (!employee) throw new NotFoundError('Employee');
        if (employee.userId && employee.userId !== id) {
          throw new ConflictError('That employee already has a login account.');
        }
        if (employee.status === 'TERMINATED') {
          throw new ValidationError({
            employeeId: ['That employee is terminated and cannot be linked to a login.'],
          });
        }
      }

      await prisma.$transaction(async (tx) => {
        if (currentEmployeeId) {
          await tx.employee.update({ where: { id: currentEmployeeId }, data: { userId: null } });
        }
        if (nextEmployeeId) {
          await tx.employee.update({ where: { id: nextEmployeeId }, data: { userId: id } });
        }
      });
    }

    await prisma.user.update({
      where: { id },
      data: { firstName: input.firstName, lastName: input.lastName },
    });

    const changes = diff(
      { firstName: before.firstName, lastName: before.lastName, employeeId: currentEmployeeId },
      { firstName: input.firstName, lastName: input.lastName, employeeId: nextEmployeeId },
    );

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: nextEmployeeId !== currentEmployeeId ? 'user.link' : 'user.update',
      entityType: 'User',
      entityId: id,
      summary: `Updated account ${before.email}${changes.changed.length ? ` (${changes.changed.join(', ')})` : ''}`,
      before: changes.before,
      after: changes.after,
      request,
    });

    return reply.send({ data: { id } });
  });

  // ------------------------------------------------------------------ roles

  app.put('/:id/roles', { preHandler: requirePermission(PERMISSIONS.USER_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const input = parseOrThrow(userRolesSchema, request.body);

    const user = await prisma.user.findFirst({
      where: { id, companyId: auth.companyId },
      include: USER_INCLUDE,
        omit: USER_OMIT,
    });
    if (!user) throw new NotFoundError('User');

    const roles = await resolveRoles(auth.companyId, input.roleIds);
    const before = user.userRoles.map((ur) => ur.role.key).sort();
    const after = roles.map((r) => r.key).sort();

    if (JSON.stringify(before) === JSON.stringify(after)) {
      return reply.send({ data: { id, roles: after } });
    }

    // Losing the ability to administer roles is only dangerous if nobody else
    // has it. Checked before the write, and only when it is actually being
    // taken away.
    const losesRoleManage =
      user.userRoles.some((ur) =>
        // A protected role always carries every permission, including this one.
        ur.role.key === 'SUPER_ADMIN',
      ) && !roles.some((r) => r.key === 'SUPER_ADMIN');
    if (losesRoleManage) {
      await assertNotLastAdministrator(auth.companyId, id, 'Changing the roles on');
    }

    await prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({
        data: roles.map((role) => ({ userId: id, roleId: role.id })),
      });
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'user.roles.update',
      entityType: 'User',
      entityId: id,
      summary: `Changed roles for ${user.email}: ${before.join(', ') || 'none'} to ${after.join(', ')}`,
      before: { roles: before },
      after: { roles: after },
      request,
    });

    return reply.send({ data: { id, roles: after } });
  });

  // ------------------------------------------------------- suspend, restore

  app.post('/:id/suspend', { preHandler: requirePermission(PERMISSIONS.USER_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const input = parseOrThrow(userSuspendSchema, request.body);

    const user = await prisma.user.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true, email: true, status: true },
    });
    if (!user) throw new NotFoundError('User');

    assertNotSelf(auth.userId, id, 'suspend');
    if (user.status === 'SUSPENDED') throw new ConflictError('That account is already suspended.');
    await assertNotLastAdministrator(auth.companyId, id, 'Suspending');

    const outcome = await suspendUser({
      userId: id,
      reason: 'ADMINISTRATIVE',
      actorUserId: auth.userId,
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'user.suspend',
      entityType: 'User',
      entityId: id,
      summary: `Suspended ${user.email}: ${input.reason} (revoked ${outcome.revokedSessions} session(s))`,
      before: { status: user.status },
      after: { status: 'SUSPENDED', reason: 'ADMINISTRATIVE', note: input.reason },
      request,
    });

    return reply.send({ data: { id, status: 'SUSPENDED', revokedSessions: outcome.revokedSessions } });
  });

  app.post('/:id/restore', { preHandler: requirePermission(PERMISSIONS.USER_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const user = await prisma.user.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true, email: true, status: true },
    });
    if (!user) throw new NotFoundError('User');

    // An administrator restoring from this screen is acting deliberately, so
    // an administrative suspension is theirs to override. What they cannot
    // override is the employee still being terminated - that would produce a
    // working login for somebody who has left.
    const outcome = await restoreUser({ userId: id, onlyIfTerminationSuspended: false });

    if (!outcome.restored) {
      if (outcome.refusal === 'NOT_SUSPENDED') {
        throw new ConflictError('That account is not suspended.');
      }
      throw new ValidationError({
        _: [
          'The employee this account belongs to is terminated. Reactivate the employee first.',
        ],
      });
    }

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'user.restore',
      entityType: 'User',
      entityId: id,
      summary: `Restored ${user.email} to ${outcome.status}`,
      before: { status: 'SUSPENDED' },
      after: { status: outcome.status },
      request,
    });

    return reply.send({ data: { id, status: outcome.status } });
  });

  // --------------------------------------------------------------- sessions

  app.post('/:id/revoke-sessions', { preHandler: requirePermission(PERMISSIONS.USER_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const user = await prisma.user.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true, email: true },
    });
    if (!user) throw new NotFoundError('User');

    assertNotSelf(auth.userId, id, 'revoke the sessions of');

    const revoked = await revokeAllUserSessions(id);

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'user.sessions.revoke',
      entityType: 'User',
      entityId: id,
      summary: `Revoked ${revoked} session${revoked === 1 ? '' : 's'} for ${user.email}`,
      after: { revoked },
      request,
    });

    return reply.send({ data: { revoked } });
  });

  // --------------------------------------------------------- password reset

  /**
   * Sends a reset link. This is the only password-related action an
   * administrator can take, and it does not tell them anything: the link goes
   * to the account holder's own address and the token is never returned here,
   * logged, or written to the audit trail.
   */
  app.post('/:id/send-reset', { preHandler: requirePermission(PERMISSIONS.USER_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const user = await prisma.user.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true, email: true, status: true },
    });
    if (!user) throw new NotFoundError('User');

    if (user.status === 'SUSPENDED') {
      throw new ConflictError(
        'That account is suspended. Restore it before sending a reset link.',
      );
    }

    await requestPasswordReset(user.email, request);

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'user.password_reset.sent',
      entityType: 'User',
      entityId: id,
      // Records that a link was issued, never the link or the token.
      summary: `Sent a password reset link to ${user.email}`,
      request,
    });

    return reply.send({ data: { sent: true } });
  });
};
