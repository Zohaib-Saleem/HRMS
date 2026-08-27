/**
 * Error taxonomy.
 *
 * Route handlers throw these; the global error handler is the only place that
 * knows how to turn one into an HTTP response. That keeps every error the API
 * emits identically shaped: { error: { code, message, details? } }.
 */

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, string[]>;
  /** Set to false for expected errors that should not page anyone. */
  readonly expected: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options?: { details?: Record<string, string[]>; expected?: boolean },
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = options?.details;
    this.expected = options?.expected ?? true;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(details: Record<string, string[]>, message = 'Some fields need your attention.') {
    super(422, 'VALIDATION_ERROR', message, { details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'You need to sign in to continue.') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that.') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, 'NOT_FOUND', `${resource} was not found.`);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'That conflicts with something that already exists.') {
    super(409, 'CONFLICT', message);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many attempts. Please wait a moment and try again.') {
    super(429, 'RATE_LIMITED', message);
  }
}

export class InternalError extends AppError {
  constructor(message = 'Something went wrong on our side.') {
    super(500, 'INTERNAL_ERROR', message, { expected: false });
  }
}
