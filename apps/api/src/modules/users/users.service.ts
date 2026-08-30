import type { Prisma, UserStatus } from '@prisma/client';
import { prisma } from '../../core/db.js';
import { revokeAllUserSessions } from '../../auth/session.js';

/**
 * The account lifecycle.
 *
 * These functions exist so that suspending an account means the same thing
 * whether an administrator did it from the users screen or an employee
 * termination did it automatically. Before this module existed, termination
 * suspended the login and nothing could put it back — the two halves lived in
 * different files and only one of them had been written.
 *
 * The rule that shapes all of it: an account carries **why** it was suspended.
 * An account switched off because someone left may be switched back on when
 * they return. An account switched off because of a security concern may not,
 * and reactivating the employee must not silently undo that decision.
 */

/**
 * Fields the password hash is never among.
 *
 * `omit` rather than a careful serialiser: the hash does not reach the
 * application at all, so no future edit to a response shape can leak it by
 * accident. A comment saying "remember not to return this" is a weaker
 * guarantee than never having it in hand.
 */
export const USER_OMIT = { passwordHash: true } satisfies Prisma.UserOmit;

/** Everything the serialisers need. */
export const USER_INCLUDE = {
  userRoles: { include: { role: { select: { id: true, key: true, name: true } } } },
  employee: {
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      displayName: true,
      status: true,
      department: { select: { name: true } },
    },
  },
  suspendedBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.UserInclude;

export type UserRow = Prisma.UserGetPayload<{
  include: typeof USER_INCLUDE;
  omit: typeof USER_OMIT;
}>;

/** Sessions that could still be used: not revoked, not expired. */
export const activeSessionWhere = (): Prisma.SessionWhereInput => ({
  revokedAt: null,
  expiresAt: { gt: new Date() },
});

export interface SuspendOutcome {
  changed: boolean;
  revokedSessions: number;
  previousStatus: UserStatus | null;
}

/**
 * Suspends an account and ends every session it has.
 *
 * Idempotent: suspending an already-suspended account changes nothing and, in
 * particular, does **not** overwrite the reason. An account an administrator
 * locked for a security concern keeps that reason even if the employee is
 * terminated afterwards, so a later reactivation still refuses to restore it.
 */
export async function suspendUser(input: {
  userId: string;
  reason: 'EMPLOYMENT_TERMINATED' | 'ADMINISTRATIVE';
  actorUserId: string | null;
}): Promise<SuspendOutcome> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, status: true },
  });
  if (!user) return { changed: false, revokedSessions: 0, previousStatus: null };

  if (user.status === 'SUSPENDED') {
    // Already off. Still drop any session that somehow survived, because the
    // guarantee this function makes is "cannot sign in", not "status is set".
    const revoked = await revokeAllUserSessions(input.userId);
    return { changed: false, revokedSessions: revoked, previousStatus: user.status };
  }

  await prisma.user.update({
    where: { id: input.userId },
    data: {
      status: 'SUSPENDED',
      statusBeforeSuspension: user.status,
      suspendedReason: input.reason,
      suspendedAt: new Date(),
      suspendedById: input.actorUserId,
    },
  });

  // Belt and braces. `resolveAuthContext` already refuses a session whose user
  // is not ACTIVE, so the account is locked out the moment the status changes;
  // revoking as well means the rows do not linger looking usable.
  const revokedSessions = await revokeAllUserSessions(input.userId);

  return { changed: true, revokedSessions, previousStatus: user.status };
}

export type RestoreRefusal =
  | 'NOT_SUSPENDED'
  | 'SUSPENDED_ADMINISTRATIVELY'
  | 'EMPLOYEE_NOT_ACTIVE';

export interface RestoreDecision {
  allowed: boolean;
  refusal: RestoreRefusal | null;
  reason: string | null;
  /** The status the account would return to. */
  target: UserStatus;
}

/**
 * Whether an account may be restored, and what it would return to.
 *
 * Split out from the act of restoring so the interface can explain the refusal
 * before anybody clicks, and so employee reactivation can ask the same question
 * this module answers rather than inventing its own answer.
 */
export function canRestore(user: {
  status: UserStatus;
  suspendedReason: string | null;
  statusBeforeSuspension: UserStatus | null;
  employee: { status: string } | null;
}): RestoreDecision {
  const target = user.statusBeforeSuspension ?? 'ACTIVE';

  if (user.status !== 'SUSPENDED') {
    return {
      allowed: false,
      refusal: 'NOT_SUSPENDED',
      reason: 'This account is not suspended.',
      target,
    };
  }

  if (user.employee && user.employee.status === 'TERMINATED') {
    return {
      allowed: false,
      refusal: 'EMPLOYEE_NOT_ACTIVE',
      reason:
        'The employee this account belongs to is terminated. Reactivate the employee first.',
      target,
    };
  }

  return { allowed: true, refusal: null, reason: null, target };
}

export interface RestoreOutcome {
  restored: boolean;
  refusal: RestoreRefusal | null;
  status: UserStatus;
}

/**
 * Puts a suspended account back the way it was.
 *
 * Restores to `statusBeforeSuspension`, so an account that was only ever
 * INVITED returns to INVITED rather than being handed a working login it never
 * had. The lockout counter is cleared too: an account suspended mid-lockout
 * should not come back still locked.
 */
export async function restoreUser(input: {
  userId: string;
  /**
   * When true, an account suspended administratively is refused. Employee
   * reactivation passes true; an administrator acting deliberately on the users
   * screen passes false, because overriding their own earlier decision is
   * exactly what they are there to do.
   */
  onlyIfTerminationSuspended: boolean;
}): Promise<RestoreOutcome> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      status: true,
      suspendedReason: true,
      statusBeforeSuspension: true,
      employee: { select: { status: true } },
    },
  });
  if (!user) return { restored: false, refusal: 'NOT_SUSPENDED', status: 'SUSPENDED' };

  const decision = canRestore(user);
  if (!decision.allowed) {
    return { restored: false, refusal: decision.refusal, status: user.status };
  }

  // The rule the whole module exists for. An account disabled for a reason of
  // its own is not collateral of the employee record, and reactivating the
  // employee must not quietly undo it.
  if (input.onlyIfTerminationSuspended && user.suspendedReason !== 'EMPLOYMENT_TERMINATED') {
    return { restored: false, refusal: 'SUSPENDED_ADMINISTRATIVELY', status: user.status };
  }

  await prisma.user.update({
    where: { id: input.userId },
    data: {
      status: decision.target,
      statusBeforeSuspension: null,
      suspendedReason: null,
      suspendedAt: null,
      suspendedById: null,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  return { restored: true, refusal: null, status: decision.target };
}
