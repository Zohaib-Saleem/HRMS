import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Permission } from '@hrms/shared';
import { ForbiddenError, UnauthorizedError } from '../core/errors.js';
import type { AuthContext } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the global onRequest hook; null for anonymous callers. */
    auth: AuthContext | null;
  }
}

/** Narrows request.auth to non-null, or throws 401. */
export function requireAuthContext(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new UnauthorizedError();
  return request.auth;
}

export const requireAuth: preHandlerHookHandler = async (request: FastifyRequest) => {
  requireAuthContext(request);
};

/**
 * Permission gate. The frontend hides controls the user cannot use, but this
 * is the gate that actually matters - never rely on the UI for authorisation.
 */
export function requirePermission(...permissions: Permission[]): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const auth = requireAuthContext(request);
    const missing = permissions.filter((p) => !auth.permissions.has(p));
    if (missing.length > 0) {
      request.log.warn(
        { userId: auth.userId, url: request.url, missing },
        'permission denied',
      );
      throw new ForbiddenError('You do not have permission to do that.');
    }
  };
}

/** Passes when the caller holds ANY one of the listed permissions. */
export function requireAnyPermission(...permissions: Permission[]): preHandlerHookHandler {
  return async (request: FastifyRequest) => {
    const auth = requireAuthContext(request);
    if (!permissions.some((p) => auth.permissions.has(p))) {
      throw new ForbiddenError('You do not have permission to do that.');
    }
  };
}
