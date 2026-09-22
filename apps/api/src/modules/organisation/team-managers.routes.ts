import type { FastifyPluginAsync } from 'fastify';
import {
  PERMISSIONS,
  TEAM_MANAGER_MAX,
  idParamSchema,
  teamManagerAssignSchema,
  teamManagerRemoveSchema,
  teamManagerReplaceSchema,
  type TeamManagerRecord,
  type TeamManagerRoster,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';

/**
 * Who runs a team.
 *
 * Every rule the brief asks for is enforced HERE, on the server, and none of
 * them is left to the form:
 *
 *   - AT MOST THREE ACTIVE MANAGERS, counted inside the transaction that
 *     writes the row. Not by a disabled button.
 *   - NOBODY WHO HAS LEFT. An employee whose status is not ACTIVE cannot be
 *     appointed, and the approval resolver checks the same thing again on the
 *     way out, so a manager terminated tonight stops filling stages tomorrow
 *     whatever this table still says.
 *   - AN APPOINTMENT IS ENDED, NEVER DELETED. Replacing somebody closes their
 *     row with a date and a reason and opens the successor's. "Who ran this
 *     team last March" is a question companies are asked.
 *   - REPLACEMENT IS ONE ENDPOINT. A team already at three managers cannot
 *     remove-then-add in that order without being refused, and cannot
 *     add-then-remove without briefly leaving a departed manager in charge of
 *     its approvals. So both happen in one transaction.
 */

const MANAGER_INCLUDE = {
  team: { select: { id: true, name: true } },
  employee: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      displayName: true,
      employeeNumber: true,
      status: true,
      userId: true,
      designation: { select: { name: true } },
    },
  },
} as const;

type ManagerRow = {
  id: string;
  teamId: string;
  isActive: boolean;
  assignedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  team: { id: string; name: string };
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    displayName: string | null;
    employeeNumber: string;
    status: string;
    userId: string | null;
    designation: { name: string } | null;
  };
};

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

/**
 * Which of these people's logins actually carry `team.data.read`.
 *
 * An appointment and a role are two different things, and the gap between them
 * is the likeliest thing to go wrong with this feature: somebody is made a
 * manager and nothing changes for them, because no role they hold carries the
 * grant that lets `teamScopeFilter` widen. One query, so the roster can say so
 * on the screen instead of leaving it to be discovered.
 */
async function teamDataAccessByUser(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const users = await prisma.user.findMany({
    where: {
      id: { in: userIds },
      userRoles: {
        some: {
          role: {
            rolePermissions: {
              some: { permission: { key: PERMISSIONS.TEAM_DATA_READ } },
            },
          },
        },
      },
    },
    select: { id: true },
  });

  return new Set(users.map((u) => u.id));
}

function toRecord(row: ManagerRow, withAccess: Set<string>): TeamManagerRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    teamName: row.team.name,
    employeeId: row.employee.id,
    employeeName: displayName(row.employee),
    employeeNumber: row.employee.employeeNumber,
    designation: row.employee.designation?.name ?? null,
    employeeStatus: row.employee.status,
    isActive: row.isActive,
    assignedAt: row.assignedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    endReason: row.endReason,
    hasTeamDataAccess: row.employee.userId ? withAccess.has(row.employee.userId) : null,
  };
}

/** The team, or a 404. Always scoped to the caller's company. */
async function teamOrThrow(companyId: string, teamId: string) {
  const team = await prisma.team.findFirst({
    where: { id: teamId, companyId },
    include: { _count: { select: { employees: true } } },
  });
  if (!team) throw new NotFoundError('Team');
  return team;
}

/**
 * An employee who may hold an ACTIVE appointment, or a field error saying why
 * not.
 *
 * `field` so the message lands on the right control when this is called from
 * the replace endpoint, which has two employee pickers on it.
 */
async function appointableEmployee(companyId: string, employeeId: string, field: string) {
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, companyId },
    select: { id: true, firstName: true, lastName: true, displayName: true, status: true },
  });
  if (!employee) throw new ValidationError({ [field]: ['That employee does not exist.'] });

  /*
   * The brief asks that an inactive or terminated employee cannot be an active
   * team manager, and this is the gate. Every non-ACTIVE status is refused,
   * RESIGNED included: somebody serving notice should not be handed a team
   * whose leave they will be approving after they have gone.
   */
  if (employee.status !== 'ACTIVE') {
    throw new ValidationError({
      [field]: [`${displayName(employee)} is ${employee.status.toLowerCase()} and cannot manage a team.`],
    });
  }

  return employee;
}

export const teamManagerRoutes: FastifyPluginAsync = async (app) => {
  /** The roster for one team: who runs it now, and who used to. */
  app.get(
    '/:id/managers',
    { preHandler: requirePermission(PERMISSIONS.TEAM_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const team = await teamOrThrow(auth.companyId, id);

      const rows = (await prisma.teamManager.findMany({
        where: { teamId: team.id },
        include: MANAGER_INCLUDE,
        orderBy: [{ isActive: 'desc' }, { assignedAt: 'asc' }],
      })) as unknown as ManagerRow[];

      const withAccess = await teamDataAccessByUser(
        rows.filter((r) => r.isActive && r.employee.userId).map((r) => r.employee.userId as string),
      );

      const data: TeamManagerRoster = {
        teamId: team.id,
        teamName: team.name,
        employeeCount: team._count.employees,
        managers: rows.filter((r) => r.isActive).map((r) => toRecord(r, withAccess)),
        formerManagers: rows
          .filter((r) => !r.isActive)
          .sort((a, b) => (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0))
          .map((r) => toRecord(r, withAccess)),
        canManage: auth.permissions.has(PERMISSIONS.TEAM_MANAGE),
      };

      return reply.send({ data });
    },
  );

  /** Appoint a manager. */
  app.post(
    '/:id/managers',
    { preHandler: requirePermission(PERMISSIONS.TEAM_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(teamManagerAssignSchema, request.body);

      const team = await teamOrThrow(auth.companyId, id);
      const employee = await appointableEmployee(auth.companyId, input.employeeId, 'employeeId');

      const created = await prisma.$transaction(async (tx) => {
        /*
         * The ceiling, counted inside the transaction rather than before it.
         *
         * A partial unique index cannot express "at most three active rows per
         * team" and Prisma would drop one written by hand on the next
         * migration, so this is the enforcement. The race it leaves - two
         * administrators appointing a fourth manager in the same second - ends
         * in four managers on one team, which is a tidy-up rather than a
         * corruption, and is the trade the schema comment records.
         */
        const active = await tx.teamManager.count({
          where: { teamId: team.id, isActive: true, employeeId: { not: employee.id } },
        });
        if (active >= TEAM_MANAGER_MAX) {
          throw new ConflictError(
            `${team.name} already has ${TEAM_MANAGER_MAX} managers, which is the maximum. Replace one of them instead.`,
          );
        }

        /*
         * Re-appointing somebody REVIVES their existing row rather than
         * writing a second one - the unique index on (teamId, employeeId)
         * requires it, and it keeps one person's history with this team on one
         * line. The end-of-appointment columns are cleared, because the
         * appointment is no longer over.
         */
        return tx.teamManager.upsert({
          where: { teamId_employeeId: { teamId: team.id, employeeId: employee.id } },
          create: {
            companyId: auth.companyId,
            teamId: team.id,
            employeeId: employee.id,
            isActive: true,
            assignedByUserId: auth.userId,
          },
          update: {
            isActive: true,
            assignedAt: new Date(),
            assignedByUserId: auth.userId,
            endedAt: null,
            endedByUserId: null,
            endedByEmployeeId: null,
            endReason: null,
          },
          include: MANAGER_INCLUDE,
        });
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'team.manager.assign',
        entityType: 'Team',
        entityId: team.id,
        summary: `Made ${displayName(employee)} a manager of ${team.name}`,
        after: { teamId: team.id, employeeId: employee.id },
        request,
      });

      const withAccess = await teamDataAccessByUser(
        (created as unknown as ManagerRow).employee.userId
          ? [(created as unknown as ManagerRow).employee.userId as string]
          : [],
      );

      return reply.status(201).send({ data: toRecord(created as unknown as ManagerRow, withAccess) });
    },
  );

  /**
   * End an appointment.
   *
   * Deliberately allowed to empty a team. The floor of one manager is advisory
   * and cannot be otherwise: a team whose only manager resigned this morning
   * must be allowed to exist for the hour it takes HR to name a successor, and
   * refusing the removal would leave the leaver approving that team's leave in
   * the meantime. What the company loses is the TEAM_MANAGER stage for that
   * team - the chain skips it and says so on every request - which is visible,
   * recorded, and fixed by appointing somebody.
   */
  app.post(
    '/:id/managers/:employeeId/remove',
    { preHandler: requirePermission(PERMISSIONS.TEAM_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const { employeeId } = parseOrThrow(
        teamManagerAssignSchema.pick({ employeeId: true }),
        request.params,
      );
      const body = parseOrThrow(teamManagerRemoveSchema, request.body ?? {});

      const team = await teamOrThrow(auth.companyId, id);

      const existing = await prisma.teamManager.findFirst({
        where: { teamId: team.id, employeeId, isActive: true },
        include: MANAGER_INCLUDE,
      });
      if (!existing) throw new NotFoundError('Team manager');

      const actor = await prisma.employee.findFirst({
        where: { companyId: auth.companyId, userId: auth.userId },
        select: { id: true },
      });

      await prisma.teamManager.update({
        where: { id: existing.id },
        data: {
          isActive: false,
          endedAt: new Date(),
          endedByUserId: auth.userId,
          endedByEmployeeId: actor?.id ?? null,
          endReason: body.reason,
        },
      });

      const row = existing as unknown as ManagerRow;
      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'team.manager.remove',
        entityType: 'Team',
        entityId: team.id,
        summary: `${displayName(row.employee)} no longer manages ${team.name}${body.reason ? ` (${body.reason})` : ''}`,
        before: { teamId: team.id, employeeId },
        request,
      });

      const remaining = await prisma.teamManager.count({
        where: { teamId: team.id, isActive: true },
      });

      return reply.send({ data: { id: existing.id, remainingManagers: remaining } });
    },
  );

  /**
   * Swap one manager for another, atomically.
   *
   * The endpoint HR reaches for when somebody leaves, and the reason it exists
   * rather than being two calls is written at the top of this file.
   */
  app.post(
    '/:id/managers/replace',
    { preHandler: requirePermission(PERMISSIONS.TEAM_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(teamManagerReplaceSchema, request.body);

      if (input.outgoingEmployeeId === input.incomingEmployeeId) {
        throw new ValidationError({
          incomingEmployeeId: ['That is the same person. Nothing would change.'],
        });
      }

      const team = await teamOrThrow(auth.companyId, id);
      const incoming = await appointableEmployee(
        auth.companyId,
        input.incomingEmployeeId,
        'incomingEmployeeId',
      );

      const outgoing = await prisma.teamManager.findFirst({
        where: { teamId: team.id, employeeId: input.outgoingEmployeeId, isActive: true },
        include: MANAGER_INCLUDE,
      });
      if (!outgoing) {
        throw new ValidationError({
          outgoingEmployeeId: ['That person does not currently manage this team.'],
        });
      }

      const actor = await prisma.employee.findFirst({
        where: { companyId: auth.companyId, userId: auth.userId },
        select: { id: true },
      });

      await prisma.$transaction(async (tx) => {
        await tx.teamManager.update({
          where: { id: outgoing.id },
          data: {
            isActive: false,
            endedAt: new Date(),
            endedByUserId: auth.userId,
            endedByEmployeeId: actor?.id ?? null,
            endReason: input.reason ?? 'Replaced',
          },
        });

        await tx.teamManager.upsert({
          where: { teamId_employeeId: { teamId: team.id, employeeId: incoming.id } },
          create: {
            companyId: auth.companyId,
            teamId: team.id,
            employeeId: incoming.id,
            isActive: true,
            assignedByUserId: auth.userId,
          },
          update: {
            isActive: true,
            assignedAt: new Date(),
            assignedByUserId: auth.userId,
            endedAt: null,
            endedByUserId: null,
            endedByEmployeeId: null,
            endReason: null,
          },
        });

        /*
         * The ceiling is checked AFTER both writes, inside the same
         * transaction, because the swap itself is what keeps the count level -
         * checking before would refuse a legitimate replacement on a team that
         * is already at three, which is precisely the team most likely to need
         * one.
         */
        const active = await tx.teamManager.count({ where: { teamId: team.id, isActive: true } });
        if (active > TEAM_MANAGER_MAX) {
          throw new ConflictError(
            `That would leave ${team.name} with ${active} managers, and the maximum is ${TEAM_MANAGER_MAX}.`,
          );
        }
      });

      const outgoingRow = outgoing as unknown as ManagerRow;
      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'team.manager.replace',
        entityType: 'Team',
        entityId: team.id,
        summary: `${displayName(incoming)} replaced ${displayName(outgoingRow.employee)} as a manager of ${team.name}${input.reason ? ` (${input.reason})` : ''}`,
        before: { employeeId: input.outgoingEmployeeId },
        after: { employeeId: incoming.id },
        request,
      });

      return reply.send({
        data: { teamId: team.id, outgoingEmployeeId: input.outgoingEmployeeId, incomingEmployeeId: incoming.id },
      });
    },
  );
};
