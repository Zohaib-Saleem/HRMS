import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  idParamSchema,
  userCreateSchema,
  userEmailChangeSchema,
  userQuerySchema,
  userRolesSchema,
  userSuspendSchema,
  userUpdateSchema,
  type LinkableEmployee,
  type UserDetail,
  type UserEmailChangeResult,
  type PasswordResetSendResult,
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
          workEmail: row.employee.workEmail,
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

  // ---------------------------------------------------------- sign-in email

  /**
   * Changes the address an account signs in with.
   *
   * Behind `user.email.manage` rather than `user.manage`, which by default puts
   * it in the hands of `SUPER_ADMIN` alone. The reason is that this is the one
   * account edit that changes who the account *is*: every session ends, every
   * unused reset link dies, an unaccepted invitation is re-issued to the new
   * address, and the old address stops working. An HR administrator fixing a
   * misspelt surname needs none of that, and `user.manage` should not quietly
   * carry it.
   *
   * What it does NOT touch, and the test file holds it to this: the password,
   * the roles, the account status (an INVITED account stays INVITED, a
   * SUSPENDED one stays SUSPENDED and is not sent a link), and every column of
   * the employee record except `workEmail` - and that one only when asked.
   * The employee's identity, number, punch code, attendance, salary, leave,
   * loans and benefits are keyed on the employee row, not on the address, so
   * none of them can move.
   *
   * No password is involved, here as everywhere else in this module. The person
   * signs back in with the password they already had, at the new address.
   */
  app.post(
    '/:id/change-email',
    { preHandler: requirePermission(PERMISSIONS.USER_EMAIL_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(userEmailChangeSchema, request.body);

      // Ending your own sessions is half of what this endpoint does, and a typo
      // in your own address locks you out of the screen that would fix it.
      // Checked before the lookup so the refusal does not depend on the row.
      assertNotSelf(auth.userId, id, 'change the sign-in address of');

      const user = await prisma.user.findFirst({
        where: { id, companyId: auth.companyId },
        select: {
          id: true,
          email: true,
          status: true,
          employee: { select: { id: true, workEmail: true } },
        },
      });
      if (!user) throw new NotFoundError('User');

      // The schema has already lowercased and trimmed the new address, so a
      // difference in case alone is not a change worth signing somebody out for.
      if (user.email.toLowerCase() === input.email) {
        throw new ValidationError({
          email: ['That is already the address this account signs in with.'],
        });
      }

      // Unique across the whole table rather than per company, so the check has
      // to be too - otherwise the update surfaces as a database error instead of
      // something a person can act on. Case-insensitive, because the unique
      // index is not: sign-in lowercases what it is given, so an address that
      // differs only in case from a stored one would be two rows that one
      // login attempt could match.
      const taken = await prisma.user.findFirst({
        where: { email: { equals: input.email, mode: 'insensitive' }, NOT: { id } },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictError('That email address is already in use.');
      }

      const syncWorkEmail = input.syncEmployeeWorkEmail && user.employee !== null;

      /**
       * One transaction for the three writes that must agree. The address, the
       * optional work-email copy and the retirement of every unused reset link
       * either all happen or none do - an employee whose login moved while
       * their HR record did not is exactly the mismatch this route exists to
       * avoid, and a reset link issued to the OLD inbox must not outlive the
       * address it was sent to.
       *
       * Nothing else is written. `status`, `lockedUntil`, `passwordHash` and
       * the roles are not in either `data`, and the employee update names one
       * column.
       */
      const retiredResetTokens = await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id }, data: { email: input.email } });
        if (syncWorkEmail && user.employee) {
          await tx.employee.update({
            where: { id: user.employee.id },
            data: { workEmail: input.email },
          });
        }
        const retired = await tx.passwordResetToken.updateMany({
          where: { userId: id, usedAt: null },
          data: { usedAt: new Date() },
        });
        return retired.count;
      });

      // The address is the identity. A session opened against the old one is no
      // evidence about the holder of the new one, so none of them survive.
      const revokedSessions = await revokeAllUserSessions(id);

      /**
       * An account that never accepted its invitation had its only way in - the
       * invitation link - retired a moment ago, and nothing at all in the new
       * inbox. Re-issuing sends the link where it now belongs. An ACTIVE account
       * gets nothing: its password still works, and mailing an unrequested
       * reset link is not an improvement. A SUSPENDED account gets nothing
       * either, and keeps its suspension - `requestPasswordReset` refuses it
       * regardless, so the status check here is what the response reports, not
       * what keeps the link from going out.
       */
      const invitationResent = user.status === 'INVITED';

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'user.email.change',
        entityType: 'User',
        entityId: id,
        // Both addresses, deliberately. "Changed the sign-in address" without
        // the old value is unanswerable six months later.
        summary: `Changed the sign-in address for ${user.email} to ${input.email}${syncWorkEmail ? ' and the employee work email with it' : ''}`,
        before: {
          email: user.email,
          employeeId: user.employee?.id ?? null,
          employeeWorkEmail: user.employee?.workEmail ?? null,
        },
        after: {
          email: input.email,
          employeeId: user.employee?.id ?? null,
          employeeWorkEmail: syncWorkEmail ? input.email : (user.employee?.workEmail ?? null),
          employeeWorkEmailUpdated: syncWorkEmail,
          revokedSessions,
          retiredResetTokens,
          invitationResent,
        },
        request,
      });

      // After the audit entry, for the reason the create route sends after its
      // own: a mail failure must not roll back a change that has happened.
      if (invitationResent) await requestPasswordReset(input.email, request);

      const result: UserEmailChangeResult = {
        id,
        email: input.email,
        previousEmail: user.email,
        employeeId: user.employee?.id ?? null,
        retiredResetTokens,
        revokedSessions,
        invitationResent,
        employeeWorkEmailUpdated: syncWorkEmail,
      };

      return reply.send({ data: result });
    },
  );

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

    const dispatch = await requestPasswordReset(user.email, request);

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'user.password_reset.sent',
      entityType: 'User',
      entityId: id,
      // Records that a link was issued and what the transport said about it -
      // never the link, the token, or anything identifying the relay.
      summary: `Sent a password reset link to ${user.email} (email ${dispatch.status})`,
      after: { delivery: dispatch.status },
      request,
    });

    /**
     * The token was created, so `sent` is true in the sense the route means it:
     * the request was accepted and a link exists. Whether that link reached an
     * inbox is a separate fact and is reported separately, because they come
     * apart - a server on the console provider creates a perfectly good token
     * and delivers nothing. The screen reads `delivery`, not `sent`, when it
     * decides what to tell the administrator.
     */
    const result: PasswordResetSendResult = {
      sent: true,
      delivery: dispatch.status,
      ...(dispatch.errorCode ? { errorCode: dispatch.errorCode } : {}),
    };

    return reply.send({ data: result });
  });
};
