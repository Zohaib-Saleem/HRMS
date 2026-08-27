import type { FastifyRequest } from 'fastify';
import { prisma } from './db.js';

/**
 * Audit logging.
 *
 * Every module writes through this one service, so any feature added later
 * inherits a consistent, queryable trail without inventing its own format.
 *
 * Design notes:
 *  - Writes are fire-and-forget: an audit failure must never fail the user's
 *    request, but it is always logged loudly.
 *  - `before`/`after` are redacted here, not at call sites, so a new caller
 *    cannot accidentally persist a password hash.
 */

const REDACTED = '[redacted]';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'newpassword',
  'currentpassword',
  'confirmpassword',
  'token',
  'tokenhash',
  'secret',
  'sessionsecret',
  'apikey',
  'authorization',
]);

export type AuditableValue = Record<string, unknown> | null | undefined;

function redact(value: AuditableValue): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : raw;
  }
  return out;
}

/** Keeps only the fields that actually changed, so the log stays readable. */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown>; changed: string[] } {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  const changed: string[] = [];

  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    const same = a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
    if (!same) {
      changedBefore[key] = a ?? null;
      changedAfter[key] = b ?? null;
      changed.push(key);
    }
  }

  return { before: changedBefore, after: changedAfter, changed };
}

export interface AuditInput {
  companyId: string;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string | null;
  before?: AuditableValue;
  after?: AuditableValue;
  request?: FastifyRequest;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  const { request } = input;
  try {
    await prisma.auditLog.create({
      data: {
        companyId: input.companyId,
        actorId: input.actorId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        summary: input.summary ?? null,
        before: (redact(input.before) ?? undefined) as never,
        after: (redact(input.after) ?? undefined) as never,
        ipAddress: request ? clientIp(request) : null,
        userAgent: request ? (request.headers['user-agent'] ?? null) : null,
      },
    });
  } catch (error) {
    request?.log.error({ err: error, action: input.action }, 'failed to write audit log');
  }
}

export function clientIp(request: FastifyRequest): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim() ?? null;
  }
  return request.ip ?? null;
}
