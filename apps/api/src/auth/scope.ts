import type { Prisma } from '@prisma/client';
import type { DataScope } from '@hrms/shared';
import { prisma } from '../core/db.js';
import { ForbiddenError } from '../core/errors.js';
import type { AuthContext } from './session.js';

/**
 * Data scope resolution.
 *
 * Permissions answer "may you read employees?". Scope answers "which ones?".
 * Keeping them orthogonal means a manager and an HR admin can both hold
 * `employee.read` while seeing very different rows.
 *
 * A user with several roles gets the widest scope among them - the same way
 * permissions union rather than intersect.
 */

const SCOPE_RANK: Record<DataScope, number> = {
  NONE: 0,
  OWN: 1,
  REPORTS: 2,
  REPORTS_AND_OWN: 3,
  DEPARTMENT: 4,
  ALL: 5,
};

export function widestScope(scopes: readonly DataScope[]): DataScope {
  return scopes.reduce<DataScope>(
    (widest, scope) => (SCOPE_RANK[scope] > SCOPE_RANK[widest] ? scope : widest),
    'NONE',
  );
}

/** The employee record belonging to the caller, if they have one. */
async function callerEmployee(
  auth: AuthContext,
): Promise<{ id: string; departmentId: string | null } | null> {
  return prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true, departmentId: true },
  });
}

/**
 * Builds the `where` fragment that narrows a query to what the caller may see.
 *
 * Returns `null` when the scope is NONE, which callers must treat as "no rows"
 * rather than "no filter" - an easy and expensive mistake to make silently.
 */
export async function employeeScopeFilter(
  auth: AuthContext,
): Promise<Prisma.EmployeeWhereInput | null> {
  const scope = auth.dataScope;

  if (scope === 'ALL') return {};
  if (scope === 'NONE') return null;

  const self = await callerEmployee(auth);

  // A scope narrower than ALL is anchored to the caller's own employee record.
  // Without one there is nothing to anchor to, so they see nothing.
  if (!self) return null;

  switch (scope) {
    case 'OWN':
      return { id: self.id };
    case 'REPORTS':
      return { OR: [{ managerId: self.id }, { secondaryManagerId: self.id }] };
    case 'REPORTS_AND_OWN':
      return {
        OR: [{ id: self.id }, { managerId: self.id }, { secondaryManagerId: self.id }],
      };
    case 'DEPARTMENT':
      return self.departmentId
        ? { OR: [{ id: self.id }, { departmentId: self.departmentId }] }
        : { id: self.id };
    default:
      return null;
  }
}

/**
 * Asserts the caller may reach one specific employee, throwing 403 otherwise.
 * Used by detail/update/delete routes, where a filtered list is not enough.
 */
export async function assertEmployeeInScope(
  auth: AuthContext,
  employeeId: string,
): Promise<void> {
  const filter = await employeeScopeFilter(auth);
  if (filter === null) throw new ForbiddenError('You do not have access to that employee.');

  const match = await prisma.employee.findFirst({
    where: { AND: [{ id: employeeId, companyId: auth.companyId }, filter] },
    select: { id: true },
  });

  if (!match) throw new ForbiddenError('You do not have access to that employee.');
}

/** True when the caller can see the whole company - used to gate aggregates. */
export function hasFullScope(auth: AuthContext): boolean {
  return auth.dataScope === 'ALL';
}
