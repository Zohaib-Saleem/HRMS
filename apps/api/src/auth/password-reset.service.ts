import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { prisma } from '../core/db.js';
import { recordAudit, clientIp } from '../core/audit.js';
import { notify } from '../core/notifications/notification.service.js';
import { ValidationError } from '../core/errors.js';
import { env } from '../config/env.js';
import { hashPassword } from './password.js';
import { revokeAllUserSessions } from './session.js';

/**
 * Password reset.
 *
 * The token is a 32-byte random value returned only in the email. Only its
 * SHA-256 hash is stored, mirroring how sessions work, so a database leak
 * cannot be turned into an account takeover.
 *
 * The token is never logged, never audited and never returned by any endpoint.
 * Audit entries record that a reset happened, not what the token was.
 */

const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Always completes without revealing whether the address exists. The caller
 * responds identically either way, so this endpoint cannot be used to
 * enumerate accounts.
 */
export async function requestPasswordReset(
  email: string,
  request: FastifyRequest,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, firstName: true, status: true, companyId: true },
  });

  if (!user || user.status !== 'ACTIVE') {
    request.log.info(
      { email },
      'password reset requested for unknown or inactive account - no email sent',
    );
    return;
  }

  // Supersede any outstanding tokens so only the newest link works.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000);

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      requestedIp: clientIp(request),
    },
  });

  const resetUrl = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;

  await notify({
    companyId: user.companyId,
    userId: user.id,
    type: 'PASSWORD_RESET',
    title: 'Password reset requested',
    // The in-app message deliberately carries no link - it would be visible to
    // anyone already holding a session, which defeats the point.
    message: 'A password reset was requested for your account. Check your email for the link.',
    logger: request.log,
    email: {
      to: user.email,
      subject: 'Reset your HRMS password',
      text: [
        `Hello ${user.firstName},`,
        '',
        'Use the link below to choose a new password. It expires in',
        `${env.PASSWORD_RESET_TTL_MINUTES} minutes and can only be used once.`,
        '',
        resetUrl,
        '',
        'If you did not request this, you can ignore this email; your password stays unchanged.',
      ].join('\n'),
    },
  });

  await recordAudit({
    companyId: user.companyId,
    actorId: user.id,
    action: 'auth.password_reset.requested',
    entityType: 'User',
    entityId: user.id,
    summary: 'Password reset link issued',
    request,
  });
}

/**
 * Consumes a token. Single-use and time-limited: the row is marked used inside
 * the same transaction that changes the password, so a replay finds it spent.
 */
export async function completePasswordReset(
  token: string,
  newPassword: string,
  request: FastifyRequest,
): Promise<void> {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, companyId: true, status: true } } },
  });

  const invalid = new ValidationError({
    token: ['That reset link is invalid or has expired. Request a new one.'],
  });

  if (!record || record.usedAt || record.expiresAt <= new Date()) throw invalid;
  if (record.user.status !== 'ACTIVE') throw invalid;

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);

  // A reset means the old credentials may be compromised - drop every session.
  const revoked = await revokeAllUserSessions(record.userId);

  await recordAudit({
    companyId: record.user.companyId,
    actorId: record.userId,
    action: 'auth.password_reset.completed',
    entityType: 'User',
    entityId: record.userId,
    summary: `Password reset completed; revoked ${revoked} session${revoked === 1 ? '' : 's'}`,
    request,
  });
}

/** Housekeeping: drop tokens that expired more than a day ago. */
export async function pruneExpiredResetTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await prisma.passwordResetToken.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return result.count;
}
