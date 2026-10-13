import type { Prisma } from '@prisma/client';
import {
  CASE_LIVE_STATUSES,
  CASE_STATUS_TRANSITIONS,
  EMPTY_CASE_COUNTS,
  EMPTY_CASE_QUEUE_SUMMARY,
  PERMISSIONS,
  canDeskReply,
  type CaseAgentOption,
  type CaseDeskAbilities,
  type CaseDeskDetail,
  type CaseDeskScope,
  type CaseQueueSummary,
  type CaseStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import type { AuthContext } from '../../auth/session.js';
import { CASE_INCLUDE, callerContext, toCaseDetail, type CaseRow } from './cases.service.js';

/**
 * The desk's data layer: who may see which queue, and what they may do to it.
 *
 * The employee side of this module narrows every query to one employee id. The
 * desk cannot do that - its whole purpose is reading cases somebody else
 * raised - so it narrows on the other axis instead, and this file is the only
 * place that decides how wide that is:
 *
 *   `case.read.all`         every case in the company.
 *   `case.read.department`  every case routed to a department the caller's own
 *                           employee record sits in.
 *   neither                 nothing at all, which is not an error state: it is
 *                           what almost everybody in the company gets.
 *
 * The department comes from the caller's employee record rather than from a
 * roster somebody maintains, and that is worth being explicit about because it
 * is the one judgement call in the design. A case is already routed to a real
 * department row, and the people who work IT cases are the IT department; a
 * second list saying who is on which desk would be a second thing to keep in
 * step with the first, and it would be wrong within a release. The cost is that
 * somebody who works two queues cannot be described this way - they hold
 * `case.read.all` instead, which is the honest way to say "this person sees
 * everything" rather than a roster that quietly grows into one.
 *
 * What it is NOT is a DataScope. `DEPARTMENT` scope is granted so that a
 * department head can read their people's employee RECORDS, and reading
 * somebody's record is not a reason to read what they asked HR about. The two
 * questions are different, so they get different answers and different grants.
 */

// --- who is asking -----------------------------------------------------------

export interface CaseDeskAgent {
  userId: string;
  companyId: string;
  scope: CaseDeskScope;
  /**
   * The departments this caller may work, when the scope is DEPARTMENT.
   *
   * A list rather than one id, because the shape of the answer should not have
   * to change when somebody is on two desks - and because an empty list is the
   * meaningful case: a departmental grant with no department behind it sees
   * only what is assigned to it, which `deskScopeFilter` turns into exactly
   * those rows rather than no filter.
   */
  departmentIds: string[];
}

/**
 * The caller as a member of the desk, or null if they are not one.
 *
 * Null rather than a throw, so a list can answer "no cases" and a write can
 * answer with a message. The permission check has already happened in the route
 * guard; this decides the WIDTH, which is a different question from whether the
 * endpoint was reachable at all.
 */
export async function resolveDeskAgent(auth: AuthContext): Promise<CaseDeskAgent | null> {
  const base = { userId: auth.userId, companyId: auth.companyId };

  if (auth.permissions.has(PERMISSIONS.CASE_READ_ALL)) {
    return { ...base, scope: 'ALL', departmentIds: [] };
  }

  if (!auth.permissions.has(PERMISSIONS.CASE_READ_DEPARTMENT)) return null;

  const employee = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { departmentId: true },
  });

  return {
    ...base,
    scope: 'DEPARTMENT',
    // No employee record, or a record with no department, is an empty list -
    // and an empty list is the same answer as no grant at all.
    departmentIds: employee?.departmentId ? [employee.departmentId] : [],
  };
}

/**
 * The WHERE fragment that narrows a query to the queues this caller may work.
 *
 * Returns null for "no rows", which every caller must treat as no rows rather
 * than as no filter - the mistake that turns a departmental agent into a
 * company-wide one is exactly one `?? {}` away, so the type makes it explicit.
 *
 * A departmental agent also reaches the cases ASSIGNED to them, wherever they
 * are filed. Assignment is the desk handing somebody a case on purpose, and an
 * assignee who is notified and then meets a 404 is the failure this closes:
 * `assertAssignable` accepts anybody holding a desk grant, so a case can
 * rightly be handed across departments. The reach ends with the assignment -
 * reassign the case and it leaves their scope unless their department holds it.
 */
export function deskScopeFilter(agent: CaseDeskAgent): Prisma.CaseWhereInput | null {
  if (agent.scope === 'ALL') return { companyId: agent.companyId };
  if (agent.scope === 'NONE') return null;

  const mine: Prisma.CaseWhereInput = { assignedUserId: agent.userId };
  return {
    companyId: agent.companyId,
    OR:
      agent.departmentIds.length > 0
        ? [{ departmentId: { in: agent.departmentIds } }, mine]
        : [mine],
  };
}

/**
 * One case from a queue this caller may work, or a 404.
 *
 * The scope is in the WHERE clause rather than checked against the row after
 * it is read, for the same reason the employee side puts the requester id
 * there: a check after the read is a check somebody can forget to write on the
 * next branch. A case outside the caller's queues is reported as not found
 * rather than forbidden, which tells a guesser nothing about whether it exists.
 */
export async function deskCaseOrThrow(agent: CaseDeskAgent, caseId: string): Promise<CaseRow> {
  const scope = deskScopeFilter(agent);
  if (!scope) throw new NotFoundError('Case');

  const row = await prisma.case.findFirst({
    where: { AND: [{ id: caseId }, scope] },
    include: CASE_INCLUDE,
  });

  if (!row) throw new NotFoundError('Case');
  return row;
}

// --- what they may do to it --------------------------------------------------

/**
 * The controls the desk screen may draw, from grants plus the case's status.
 *
 * `nextStatuses` is the workflow itself, sent rather than re-derived, so the
 * browser holds no second copy of the transition map. Every one of these is
 * advisory: the endpoint behind each control re-checks the same grant and the
 * same transition against the case as it actually stands when the request
 * arrives.
 */
export function deskAbilities(auth: AuthContext, status: CaseStatus): CaseDeskAbilities {
  const { permissions } = auth;
  const canUpdate = permissions.has(PERMISSIONS.CASE_UPDATE);
  const writable = canDeskReply(status);

  return {
    canAssign: permissions.has(PERMISSIONS.CASE_ASSIGN),
    canUpdate,
    canRespond: permissions.has(PERMISSIONS.CASE_RESPOND) && writable,
    canNote: permissions.has(PERMISSIONS.CASE_NOTE_INTERNAL) && writable,
    canRoute: canUpdate && writable,
    nextStatuses: canUpdate ? [...CASE_STATUS_TRANSITIONS[status]] : [],
  };
}

type DeskDetailParts = Parameters<typeof toCaseDetail>[2];

/**
 * One case as the desk reads it.
 *
 * The same record the requester gets, plus what this caller may do with it and
 * the two facts about the requester that only the desk is shown: how to reach
 * them, and which department they sit in. Neither is in `CaseRecord`, so
 * neither can reach an employee's response by accident.
 */
export function toDeskDetail(
  row: CaseRow,
  auth: AuthContext,
  parts: DeskDetailParts,
): CaseDeskDetail {
  return {
    ...toCaseDetail(row, callerContext(auth, false), parts),
    abilities: deskAbilities(auth, row.status as CaseStatus),
    requesterEmail: row.requester.workEmail,
    requesterDepartmentName: row.requester.department?.name ?? null,
  };
}

// --- who a case can be handed to ---------------------------------------------

/**
 * The people a case may be assigned to.
 *
 * "Anybody with a login" is the wrong list and the tempting one. A case
 * assigned to somebody who cannot open it is worse than an unassigned case: it
 * looks handled, it leaves the unassigned queue, and nobody is coming. So the
 * list is the accounts that actually hold a desk grant, read from the roles
 * they have rather than from a guess about their job title.
 *
 * `case.respond` is the grant that makes somebody answerable - it is the one
 * that lets them talk to the requester - and it is paired with a read grant
 * because a person who may reply but may not open the case is in the same
 * position as one who cannot reply at all.
 */
const DESK_GRANT_KEYS: string[] = [PERMISSIONS.CASE_READ_ALL, PERMISSIONS.CASE_READ_DEPARTMENT];

export async function assignableAgents(companyId: string): Promise<CaseAgentOption[]> {
  const users = await prisma.user.findMany({
    where: {
      companyId,
      status: 'ACTIVE',
      userRoles: {
        some: {
          role: {
            rolePermissions: {
              some: { permission: { key: { in: DESK_GRANT_KEYS } } },
            },
          },
        },
      },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employee: { select: { department: { select: { name: true } } } },
    },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });

  return users.map((user) => ({
    userId: user.id,
    name: `${user.firstName} ${user.lastName}`.trim(),
    departmentName: user.employee?.department?.name ?? null,
  }));
}

/**
 * Proves an assignee is somebody this case can actually be handed to.
 *
 * Read again on the server rather than trusted from the dropdown, and reported
 * as a field error rather than as a 404: the id came from a list this same API
 * drew, so the useful answer names the field that has to change.
 */
export async function assertAssignable(companyId: string, userId: string): Promise<void> {
  const allowed = await prisma.user.findFirst({
    where: {
      id: userId,
      companyId,
      status: 'ACTIVE',
      userRoles: {
        some: {
          role: {
            rolePermissions: {
              some: { permission: { key: { in: DESK_GRANT_KEYS } } },
            },
          },
        },
      },
    },
    select: { id: true },
  });

  if (!allowed) {
    throw new ValidationError({
      assignedUserId: ['That person cannot work cases, so a case cannot be assigned to them.'],
    });
  }
}

// --- the queue's figures -----------------------------------------------------

/**
 * The headline numbers over whatever this caller can see.
 *
 * Four counts from two grouped queries rather than four `count` calls, and all
 * of them inside the same scope filter - so two people on the same screen with
 * different grants see different numbers and both are correct.
 */
export async function deskQueueSummary(agent: CaseDeskAgent): Promise<CaseQueueSummary> {
  const scope = deskScopeFilter(agent);
  if (!scope) return { ...EMPTY_CASE_QUEUE_SUMMARY, counts: { ...EMPTY_CASE_COUNTS } };

  const live: Prisma.CaseWhereInput = { AND: [scope, { status: { in: [...CASE_LIVE_STATUSES] } }] };

  const [grouped, unassigned, mine, urgent] = await Promise.all([
    prisma.case.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
    prisma.case.count({ where: { AND: [live, { assignedUserId: null }] } }),
    prisma.case.count({ where: { AND: [live, { assignedUserId: agent.userId }] } }),
    prisma.case.count({ where: { AND: [live, { priority: { in: ['URGENT', 'HIGH'] } }] } }),
  ]);

  const counts = { ...EMPTY_CASE_COUNTS };
  for (const group of grouped) counts[group.status as CaseStatus] = group._count._all;

  return {
    live: CASE_LIVE_STATUSES.reduce((sum, status) => sum + counts[status], 0),
    unassigned,
    mine,
    urgent,
    counts,
  };
}
