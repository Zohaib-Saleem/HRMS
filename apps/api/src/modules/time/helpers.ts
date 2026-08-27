import { prisma } from '../../core/db.js';
import { ForbiddenError } from '../../core/errors.js';
import type { AuthContext } from '../../auth/session.js';

/**
 * Normalises an ISO date string to midnight UTC.
 *
 * The date columns are `@db.Date`, so anything with a time component would be
 * silently truncated in a way that depends on the server's timezone. Pinning to
 * UTC midnight keeps the stored day stable no matter where the API runs.
 */
export function toDateOnly(value: string): Date {
  const parsed = new Date(value);
  return new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()),
  );
}

/**
 * The employee record behind the caller's login.
 *
 * Self-service actions - raising a correction, submitting a timesheet, asking
 * for a shift change - are all anchored to this. An account with no employee
 * record has nothing to act on, which is a 403 rather than a crash.
 */
export async function callerEmployeeOrThrow(
  auth: AuthContext,
): Promise<{ id: string; firstName: string; lastName: string; locationId: string | null }> {
  const employee = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true, firstName: true, lastName: true, locationId: true },
  });

  if (!employee) {
    throw new ForbiddenError(
      'Your login is not linked to an employee record, so you cannot raise this request.',
    );
  }

  return employee;
}
