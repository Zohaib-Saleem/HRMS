import type { FastifyPluginAsync } from 'fastify';
import { forgotPasswordSchema, loginSchema, resetPasswordSchema } from '@hrms/shared';
import { completePasswordReset, requestPasswordReset } from './password-reset.service.js';
import { parseOrThrow } from '../core/validate.js';
import { recordAudit } from '../core/audit.js';
import { authenticate } from './auth.service.js';
import { requireAuth, requireAuthContext } from './guards.js';
import {
  clearSessionCookie,
  createSession,
  revokeAllUserSessions,
  revokeSession,
  setSessionCookie,
} from './session.js';

export const authRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Login is the one route with its own rate limit: 10 attempts per IP per
   * 5 minutes. Paired with the per-account lockout in auth.service.
   */
  app.post(
    '/login',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '5 minutes' },
      },
    },
    async (request, reply) => {
      const input = parseOrThrow(loginSchema, request.body);
      const user = await authenticate(input, request);

      const { token, expiresAt } = await createSession(user.id, request, input.rememberMe);
      setSessionCookie(reply, token, expiresAt);

      await recordAudit({
        companyId: user.companyId,
        actorId: user.id,
        action: 'auth.login',
        entityType: 'User',
        entityId: user.id,
        summary: 'Signed in',
        request,
      });

      return reply.status(200).send({ data: { ok: true } });
    },
  );

  app.post('/logout', { preHandler: requireAuth }, async (request, reply) => {
    const auth = requireAuthContext(request);
    await revokeSession(auth.sessionId);
    clearSessionCookie(reply);

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'auth.logout',
      entityType: 'User',
      entityId: auth.userId,
      summary: 'Signed out',
      request,
    });

    return reply.status(200).send({ data: { ok: true } });
  });

  /** Sign out everywhere else - keeps the current session alive. */
  app.post('/logout-others', { preHandler: requireAuth }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const count = await revokeAllUserSessions(auth.userId, auth.sessionId);

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'auth.logout.others',
      entityType: 'User',
      entityId: auth.userId,
      summary: `Revoked ${count} other session${count === 1 ? '' : 's'}`,
      request,
    });

    return reply.send({ data: { revoked: count } });
  });

  /** Cheap poll used by the web app to detect an expired session. */
  app.get('/session', async (request, reply) => {
    return reply.send({ data: { authenticated: Boolean(request.auth) } });
  });

  /**
   * Password reset request.
   *
   * Always answers 200 with the same body whether or not the address exists,
   * so it cannot be used to discover which emails have accounts. Rate limited
   * harder than login because it triggers outbound mail.
   */
  app.post(
    '/forgot-password',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = parseOrThrow(forgotPasswordSchema, request.body);
      await requestPasswordReset(input.email, request);

      return reply.status(200).send({
        data: {
          ok: true,
          message: 'If that address has an account, a reset link is on its way.',
        },
      });
    },
  );

  app.post(
    '/reset-password',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = parseOrThrow(resetPasswordSchema, request.body);
      await completePasswordReset(input.token, input.newPassword, request);

      return reply.status(200).send({ data: { ok: true } });
    },
  );
};
