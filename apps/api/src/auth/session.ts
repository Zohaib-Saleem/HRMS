import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission } from '@hrms/shared';
import { prisma } from '../core/db.js';
import { clientIp } from '../core/audit.js';
import { env, isProduction } from '../config/env.js';

/**
 * Server-side sessions.
 *
 * The cookie carries a 32-byte opaque token. Only its SHA-256 hash is stored,
 * so a database dump cannot be replayed as a login. Revocation is a single
 * UPDATE, which JWTs cannot offer without a blocklist anyway.
 */

const TOKEN_BYTES = 32;
const REMEMBER_ME_HOURS = 24 * 30;
/** Refresh lastActivityAt at most this often, to avoid a write per request. */
const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface AuthContext {
  sessionId: string;
  userId: string;
  companyId: string;
  email: string;
  permissions: Set<Permission>;
  mustChangePassword: boolean;
}

export async function createSession(
  userId: string,
  request: FastifyRequest,
  rememberMe: boolean,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const hours = rememberMe ? REMEMBER_ME_HOURS : env.SESSION_TTL_HOURS;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ipAddress: clientIp(request),
      userAgent: request.headers['user-agent'] ?? null,
    },
  });

  return { token, expiresAt };
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    expires: expiresAt,
    signed: true,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' });
}

export function readSessionToken(request: FastifyRequest): string | null {
  const raw = request.cookies[env.SESSION_COOKIE_NAME];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

/**
 * Resolves the session on every request. Returns null rather than throwing so
 * that public routes stay public; guards decide what to do about it.
 */
export async function resolveAuthContext(request: FastifyRequest): Promise<AuthContext | null> {
  const token = readSessionToken(request);
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: {
        include: {
          userRoles: {
            include: {
              role: { include: { rolePermissions: { include: { permission: true } } } },
            },
          },
        },
      },
    },
  });

  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;
  if (session.user.status !== 'ACTIVE') return null;

  if (Date.now() - session.lastActivityAt.getTime() > ACTIVITY_WRITE_INTERVAL_MS) {
    // Best-effort: a failed activity bump must not break the request.
    void prisma.session
      .update({ where: { id: session.id }, data: { lastActivityAt: new Date() } })
      .catch(() => undefined);
  }

  const permissions = new Set<Permission>();
  for (const { role } of session.user.userRoles) {
    for (const { permission } of role.rolePermissions) {
      permissions.add(permission.key as Permission);
    }
  }

  return {
    sessionId: session.id,
    userId: session.user.id,
    companyId: session.user.companyId,
    email: session.user.email,
    permissions,
    mustChangePassword: session.user.mustChangePassword,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllUserSessions(userId: string, exceptId?: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Housekeeping: drop sessions that expired more than a day ago. */
export async function pruneExpiredSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await prisma.session.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return result.count;
}
