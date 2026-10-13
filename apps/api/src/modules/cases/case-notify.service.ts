import type { FastifyBaseLogger } from 'fastify';
import { PERMISSIONS } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { notify } from '../../core/notifications/notification.service.js';

/**
 * Who on the desk hears about a case, and how they are told.
 *
 * Before this file, the only desk notification was "assigned to you". A new
 * case told its requester and nobody else, so a department's desk learnt about
 * it only by opening the queue - and an unassigned case in a queue nobody was
 * watching sat there. This resolves the people who should be told, from grants
 * and the department's own row, never from a list of names:
 *
 *   1. The DEPARTMENT'S OWN DESK. Everybody whose employee record sits in the
 *      case's department and whose roles carry `case.read.department` plus a
 *      grant to act on a case (`case.respond`, `case.update` or `case.assign`)
 *      - exactly the people `deskScopeFilter` lets open it and the routes let
 *      work it. Not every member of the department: an employee in IT who
 *      holds no desk grant is not told about IT cases.
 *   2. The DEPARTMENT HEAD (`departments.headEmployeeId`), when they can open
 *      and act on the case. A head who cannot open it is not told, because a
 *      notification that leads to a 404 is worse than none.
 *   3. Only when 1 and 2 are both empty: the company-wide DISPATCHERS, the
 *      accounts holding `case.read.all` and `case.assign`. A case filed with a
 *      department that has no desk still reaches somebody who can hand it on,
 *      rather than waiting unseen in the unassigned queue.
 *
 * One notification per account, whichever of those it qualifies under, and
 * never to the person whose action caused it.
 */

const ACT_GRANTS: string[] = [
  PERMISSIONS.CASE_RESPOND,
  PERMISSIONS.CASE_UPDATE,
  PERMISSIONS.CASE_ASSIGN,
];

/** The entity type desk notifications carry, so the bell opens the desk view. */
export const CASE_DESK_ENTITY = 'CaseDesk';

export async function caseQueueOwners(companyId: string, departmentId: string): Promise<string[]> {
  const [department, users] = await Promise.all([
    prisma.department.findFirst({
      where: { id: departmentId, companyId },
      select: { headEmployeeId: true },
    }),
    prisma.user.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        userRoles: {
          some: {
            role: {
              rolePermissions: {
                some: {
                  permission: {
                    key: { in: [PERMISSIONS.CASE_READ_DEPARTMENT, PERMISSIONS.CASE_READ_ALL] },
                  },
                },
              },
            },
          },
        },
      },
      select: {
        id: true,
        employee: { select: { id: true, departmentId: true } },
        userRoles: {
          select: {
            role: {
              select: { rolePermissions: { select: { permission: { select: { key: true } } } } },
            },
          },
        },
      },
    }),
  ]);

  const candidates = users.map((user) => {
    const grants = new Set(
      user.userRoles.flatMap((ur) => ur.role.rolePermissions.map((rp) => rp.permission.key)),
    );
    const inDepartment = user.employee?.departmentId === departmentId;
    const readsAll = grants.has(PERMISSIONS.CASE_READ_ALL);
    const readsHere = readsAll || (inDepartment && grants.has(PERMISSIONS.CASE_READ_DEPARTMENT));
    return {
      id: user.id,
      employeeId: user.employee?.id ?? null,
      inDepartment,
      readsAll,
      readsHere,
      acts: ACT_GRANTS.some((key) => grants.has(key)),
      assigns: grants.has(PERMISSIONS.CASE_ASSIGN),
      grants,
    };
  });

  const owners = new Set<string>();
  for (const c of candidates) {
    const ownDesk = c.inDepartment && c.grants.has(PERMISSIONS.CASE_READ_DEPARTMENT) && c.acts;
    const head =
      department?.headEmployeeId != null &&
      c.employeeId === department.headEmployeeId &&
      c.readsHere &&
      c.acts;
    if (ownDesk || head) owners.add(c.id);
  }

  if (owners.size === 0) {
    for (const c of candidates) if (c.readsAll && c.assigns) owners.add(c.id);
  }

  return [...owners];
}

/**
 * Tells each of `userIds` once, skipping the actor and anybody in `exclude`.
 * Best-effort by construction: `notify` never throws, so a notification can
 * never undo the write it reports. Returns who was told.
 */
export async function notifyDesk(input: {
  companyId: string;
  caseId: string;
  userIds: ReadonlyArray<string | null | undefined>;
  actorUserId: string;
  exclude?: ReadonlyArray<string | null | undefined>;
  title: string;
  message: string;
  logger?: FastifyBaseLogger;
}): Promise<string[]> {
  const skip = new Set([input.actorUserId, ...(input.exclude ?? [])]);
  const recipients = [...new Set(input.userIds)].filter(
    (id): id is string => typeof id === 'string' && !skip.has(id),
  );

  for (const userId of recipients) {
    await notify({
      companyId: input.companyId,
      userId,
      type: 'CASE_UPDATE',
      title: input.title,
      message: input.message,
      entityType: CASE_DESK_ENTITY,
      entityId: input.caseId,
      logger: input.logger,
    });
  }
  return recipients;
}

/**
 * Whoever is responsible for acting on a case right now: its assignee, or -
 * while nobody holds it - the department's queue owners.
 */
export async function caseResponsible(row: {
  companyId: string;
  departmentId: string;
  assignedUserId: string | null;
}): Promise<string[]> {
  if (row.assignedUserId) return [row.assignedUserId];
  return caseQueueOwners(row.companyId, row.departmentId);
}
