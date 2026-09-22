import type { Prisma } from '@prisma/client';
import { PERMISSIONS, type DataScope } from '@hrms/shared';
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
): Promise<{ id: string; departmentId: string | null; teamId: string | null } | null> {
  return prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true, departmentId: true, teamId: true },
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

/**
 * The teams this caller actively MANAGES.
 *
 * Two conditions, and both are required. The caller must hold
 * `team.data.read` - a grant, handed out with a role, that an administrator
 * can withhold - and there must be an ACTIVE row in `team_managers` naming
 * them. Neither on its own reaches anything: a grant without an appointment
 * returns nothing, and an appointment without the grant is invisible to every
 * query in this file.
 *
 * Returns team ids rather than a filter because three different callers want
 * three different shapes out of the same fact.
 */
export async function managedTeamIds(auth: AuthContext): Promise<string[]> {
  if (!auth.permissions.has(PERMISSIONS.TEAM_DATA_READ)) return [];

  const self = await callerEmployee(auth);
  if (!self) return [];

  const rows = await prisma.teamManager.findMany({
    where: { companyId: auth.companyId, employeeId: self.id, isActive: true, team: { isActive: true } },
    select: { teamId: true },
  });

  return rows.map((row) => row.teamId);
}

/**
 * The employee filter for the screens a TEAM MANAGER has a reason to open.
 *
 * `employeeScopeFilter` answers "which employee records does this person's ROLE
 * reach". This answers "...and which does their APPOINTMENT reach" - the union
 * of the two - and it is deliberately a SEPARATE function rather than a wider
 * data scope.
 *
 * WHY IT IS NOT A DATA SCOPE. Scopes union across a user's roles and the
 * widest wins, so a TEAM scope would have been handed to anybody holding a
 * team-manager role beside the Employee role, and it would have widened every
 * module that consults the scope. Two of those modules are `payslip.read` and
 * `loan.read`, which every member of staff holds for their own pay. A team
 * manager opening their team's payslips is the exact outcome section 3 of the
 * brief forbids, and it would have arrived silently, as a consequence of an
 * enum value, on a screen nobody changed.
 *
 * So the widening lives here, and the modules that call it are the ones a
 * manager is meant to reach: the employee directory, attendance, leave,
 * timesheets, approvals and the kit their people hold. PAYROLL, PAYSLIPS,
 * LOANS, MEDICAL, CONTRACTS, SALARY REVISIONS AND SENSITIVE IDENTITY FIELDS
 * CALL `employeeScopeFilter` AND MUST CONTINUE TO. That is not a convention -
 * it is the enforcement, and it is why the two functions have different names.
 *
 * Returns `null` for "no rows", exactly as `employeeScopeFilter` does.
 */
export async function teamScopeFilter(
  auth: AuthContext,
): Promise<Prisma.EmployeeWhereInput | null> {
  const scoped = await employeeScopeFilter(auth);

  // ALL already reaches everything; a union with it is still everything.
  if (scoped !== null && Object.keys(scoped).length === 0) return scoped;

  const teamIds = await managedTeamIds(auth);
  if (teamIds.length === 0) return scoped;

  const teamClause: Prisma.EmployeeWhereInput = { teamId: { in: teamIds } };
  if (scoped === null) return teamClause;
  return { OR: [scoped, teamClause] };
}

/**
 * Asserts the caller may reach one employee through role OR appointment.
 *
 * The detail-route counterpart of `teamScopeFilter`. Read paths only: a
 * manager may open a team member's record, and WRITING to one is
 * `employee.manage` under the ordinary scope, which this deliberately does not
 * widen.
 */
export async function assertEmployeeInTeamScope(
  auth: AuthContext,
  employeeId: string,
): Promise<void> {
  const filter = await teamScopeFilter(auth);
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

/**
 * The same question, asked about SOMEBODY ELSE'S attendance.
 *
 * `attendance.read` is held by every member of staff, because everybody has
 * their own attendance, and the scope alone decided how many people's
 * attendance that reached. That worked for as long as every role with a scope
 * wider than OWN was an HR or management role - and it stopped working the
 * first time a company built a role for a job. A custom role created for the
 * person who looks after the laptops, given an ALL data scope because the
 * register is company-wide, was thereby handed the whole company's present,
 * absent and late figures through `/attendance/team` without holding one HR
 * permission. That is not a hypothetical: it is what `IT_MANAGER` did in
 * production, and it is why this function exists.
 *
 * The rule it adds is one sentence: A CALLER WHO MAY NOT READ THE EMPLOYEE
 * DIRECTORY MAY NOT READ ANOTHER EMPLOYEE'S ATTENDANCE. `employee.read` is
 * already what the sidebar gates Team attendance and Attendance reports on, and
 * already half the gate on `/company/stats`, so this makes the DATA agree with
 * the signposts rather than inventing a new idea about who may see what.
 *
 * It is a narrowing and only ever a narrowing, and it is written as an
 * INTERSECTION rather than as a substitution so that it cannot be anything
 * else: the ordinary scope filter is computed first, and a caller without the
 * directory grant has it ANDed with their own employee id. A scope of NONE
 * still means no rows, and a scope of REPORTS - which deliberately excludes the
 * holder's own record - still excludes it. Replacing the filter with
 * `{ id: self.id }` would have quietly WIDENED both of those, which is the
 * mistake a function whose whole job is narrowing must not be able to make.
 *
 * Every system role with a scope wider than OWN - Super Admin, HR Admin,
 * Manager - holds `employee.read`, so nothing about any of them changes. What
 * changes is that a wide scope granted for one module no longer quietly opens
 * attendance for the whole company.
 *
 * Returns `null` for "no rows", exactly as `employeeScopeFilter` does.
 */
export async function attendancePeopleFilter(
  auth: AuthContext,
): Promise<Prisma.EmployeeWhereInput | null> {
  /*
   * The union with the caller's managed teams happens FIRST, and then the
   * directory narrowing is applied to the whole of it. A team manager holds
   * `employee.read`, so in practice their union survives intact; somebody who
   * was appointed to a team but holds no directory grant is narrowed to their
   * own record like anybody else, which is the rule this function exists for
   * and must not be escapable by being made a manager.
   */
  const scoped = await teamScopeFilter(auth);
  if (scoped === null) return null;
  if (auth.permissions.has(PERMISSIONS.EMPLOYEE_READ)) return scoped;

  /*
   * INERT WHERE THERE IS NOTHING TO NARROW. An OWN scope already reaches
   * exactly the caller's own record, so it is handed back untouched rather than
   * wrapped in an AND that means the same thing - which keeps the query every
   * ordinary member of staff makes byte-for-byte what it was before this
   * function existed. NONE has already returned null above.
   */
  const managed = await managedTeamIds(auth);
  if (SCOPE_RANK[auth.dataScope] <= SCOPE_RANK.OWN && managed.length === 0) return scoped;

  const self = await callerEmployee(auth);
  // No employee record and no directory grant: there is nobody this caller is,
  // so there is nobody's attendance to serve.
  if (!self) return null;
  return { AND: [scoped, { id: self.id }] };
}

/**
 * Asserts the caller may reach one specific employee's ATTENDANCE, 403 otherwise.
 *
 * The detail-route counterpart of `attendancePeopleFilter`, and it must be used
 * wherever an attendance route takes an `employeeId` - a filtered list that
 * narrows correctly is worth nothing beside a `?employeeId=` that does not.
 */
export async function assertAttendanceEmployeeInScope(
  auth: AuthContext,
  employeeId: string,
): Promise<void> {
  const filter = await attendancePeopleFilter(auth);
  if (filter === null) throw new ForbiddenError('You do not have access to that employee.');

  const match = await prisma.employee.findFirst({
    where: { AND: [{ id: employeeId, companyId: auth.companyId }, filter] },
    select: { id: true },
  });

  if (!match) throw new ForbiddenError('You do not have access to that employee.');
}
