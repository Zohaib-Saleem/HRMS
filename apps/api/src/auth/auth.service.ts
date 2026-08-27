import type { FastifyRequest } from 'fastify';
import type { LoginInput } from '@hrms/shared';
import { prisma } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { UnauthorizedError } from '../core/errors.js';
import { hashPassword, verifyPassword } from './password.js';

/**
 * Brute-force throttling.
 *
 * Per-account counter in addition to the per-IP rate limit on the route, so an
 * attacker rotating IPs still hits a wall on the targeted account.
 */
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

/** Deliberately identical for every failure mode - no user enumeration. */
const GENERIC_FAILURE = 'That email and password combination did not work.';

export async function authenticate(input: LoginInput, request: FastifyRequest) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      companyId: true,
      email: true,
      passwordHash: true,
      status: true,
      failedLoginCount: true,
      lockedUntil: true,
    },
  });

  if (!user) {
    // Spend comparable time on a miss so response timing does not leak
    // whether the account exists.
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000',
      input.password,
    );
    throw new UnauthorizedError(GENERIC_FAILURE);
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000));
    throw new UnauthorizedError(
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
  }

  const ok = await verifyPassword(user.passwordHash, input.password);

  if (!ok) {
    const failed = user.failedLoginCount + 1;
    const shouldLock = failed >= MAX_FAILED_ATTEMPTS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: shouldLock ? 0 : failed,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      },
    });
    await recordAudit({
      companyId: user.companyId,
      actorId: user.id,
      action: 'auth.login.failed',
      entityType: 'User',
      entityId: user.id,
      summary: shouldLock ? 'Account locked after repeated failures' : 'Failed sign-in attempt',
      request,
    });
    throw new UnauthorizedError(GENERIC_FAILURE);
  }

  if (user.status !== 'ACTIVE') {
    await recordAudit({
      companyId: user.companyId,
      actorId: user.id,
      action: 'auth.login.blocked',
      entityType: 'User',
      entityId: user.id,
      summary: `Sign-in blocked - account status is ${user.status}`,
      request,
    });
    throw new UnauthorizedError('This account is not active. Contact your administrator.');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  return user;
}

export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });

  const ok = await verifyPassword(user.passwordHash, currentPassword);
  if (!ok) throw new UnauthorizedError('Your current password is not correct.');

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
  });
}
