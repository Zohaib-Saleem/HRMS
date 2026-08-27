import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError, ConflictError, NotFoundError, ValidationError } from './errors.js';
import { isProduction } from '../config/env.js';

/** Flattens a ZodError into { fieldName: [messages] } for inline form display. */
export function zodToDetails(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

function normalise(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new ValidationError(zodToDetails(error));
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P2002 unique constraint, P2025 record not found, P2003 FK violation
    if (error.code === 'P2002') {
      const target = error.meta?.target;
      const field = Array.isArray(target) ? target.join(', ') : String(target ?? 'value');
      return new ConflictError(`That ${field} is already in use.`);
    }
    if (error.code === 'P2025') return new NotFoundError('Record');
    if (error.code === 'P2003') {
      return new ConflictError('That item is still referenced by other records.');
    }
  }

  const fallback = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on our side.', {
    expected: false,
  });
  if (error instanceof Error) fallback.stack = error.stack;
  return fallback;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    // Fastify's own errors (body parse failure, rate limit) carry a statusCode.
    const raw = error as { statusCode?: number; message?: string; code?: string };
    if (!(error instanceof AppError) && raw?.statusCode && raw.statusCode < 500) {
      const code = raw.statusCode === 429 ? 'RATE_LIMITED' : (raw.code ?? 'BAD_REQUEST');
      return reply.status(raw.statusCode).send({
        error: { code, message: raw.message ?? 'Request could not be processed.' },
      });
    }

    const appError = normalise(error);

    if (!appError.expected || appError.statusCode >= 500) {
      request.log.error(
        { err: error, url: request.url, method: request.method },
        'unhandled request error',
      );
    } else {
      request.log.debug(
        { code: appError.code, url: request.url, method: request.method },
        appError.message,
      );
    }

    return reply.status(appError.statusCode).send({
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details ? { details: appError.details } : {}),
        ...(!isProduction && appError.statusCode >= 500 && error instanceof Error
          ? { stack: error.stack }
          : {}),
      },
    });
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(404).send({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `No route for ${request.method} ${request.url}.`,
      },
    });
  });
}
