import type { ZodSchema, ZodTypeDef } from 'zod';
import { ZodError } from 'zod';
import { ValidationError } from './errors.js';
import { zodToDetails } from './error-handler.js';

/**
 * Parse-or-throw helper. Every route uses this instead of touching
 * request.body directly, so untyped input never reaches a service.
 */
export function parseOrThrow<Out, Def extends ZodTypeDef, In>(
  schema: ZodSchema<Out, Def, In>,
  input: unknown,
): Out {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) throw new ValidationError(zodToDetails(error));
    throw error;
  }
}
