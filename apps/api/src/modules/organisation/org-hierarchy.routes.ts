import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type MyTeamContext,
  type OrgChart,
  type OrgChartPerson,
  type OrgChartTeam,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { managedTeamIds, teamScopeFilter } from '../../auth/scope.js';
import { resolvePhotoUrl } from '../employees/employees.service.js';

/**
 * The organisation chart, and the caller's own place in it.
 *
 * Two endpoints with very different audiences:
 *
 *   GET /organisation/chart  needs `employee.read`, and is narrowed to the
 *   people the caller may actually see. A team manager opens it and finds
 *   their own teams; HR opens it and finds the company. It is NOT a
 *   company-wide directory handed to anybody who can read one employee record.
 *
 *   GET /organisation/my-team  needs nothing but a session. Every member of
 *   staff may know which team they are on and who approves their requests -
 *   that is the first thing anybody asks about an approval chain, and refusing
 *   to answer it would make the chain feel arbitrary.
 *
 * The top of the chart - the CEO and the HR managers - is read from the
 * approval stage assignees rather than from a second table of its own. A
 * company that has said "these people fill the CEO stage" has already answered
 * "who is at the top", and asking them twice is how two answers come to
 * disagree.
 */

const PERSON_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  displayName: true,
  employeeNumber: true,
  status: true,
  photoObjectKey: true,
  photoUrl: true,
  photoUpdatedAt: true,
  designation: { select: { name: true } },
} satisfies Prisma.EmployeeSelect;

type PersonRow = Prisma.EmployeeGetPayload<{ select: typeof PERSON_SELECT }>;

function toPerson(row: PersonRow): OrgChartPerson {
  return {
    employeeId: row.id,
    name: row.displayName ?? `${row.firstName} ${row.lastName}`.trim(),
    employeeNumber: row.employeeNumber,
    designation: row.designation?.name ?? null,
    status: row.status,
    photoUrl: resolvePhotoUrl(row),
  };
}

/** The people filling one company-wide approval stage, as chart people. */
async function stagePeople(companyId: string, stage: 'CEO' | 'HR_MANAGER'): Promise<OrgChartPerson[]> {
  const rows = await prisma.approvalStageAssignee.findMany({
    where: { companyId, stage, isActive: true },
    orderBy: { assignedAt: 'asc' },
    include: { employee: { select: PERSON_SELECT } },
  });
  return rows.map((row) => toPerson(row.employee));
}

/** How many members of a team the chart will show before it stops listing. */
const MEMBERS_SHOWN = 60;

export const orgHierarchyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get(
    '/chart',
    { preHandler: requirePermission(PERMISSIONS.EMPLOYEE_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);

      const visible = await teamScopeFilter(auth);
      const managed = await managedTeamIds(auth);

      const [ceo, hrManagers] = await Promise.all([
        stagePeople(auth.companyId, 'CEO'),
        stagePeople(auth.companyId, 'HR_MANAGER'),
      ]);

      if (visible === null && managed.length === 0) {
        const empty: OrgChart = {
          ceo,
          hrManagers,
          teams: [],
          unassignedCount: 0,
          totalEmployees: 0,
        };
        return reply.send({ data: empty });
      }

      /*
       * A team is on this caller's chart when they manage it, or when it holds
       * at least one person they may already see. The second clause is what
       * makes an HR or Super Admin chart the whole company without a special
       * case, and what keeps a team manager's chart to their own teams without
       * one either.
       */
      const teamWhere: Prisma.TeamWhereInput = {
        companyId: auth.companyId,
        isActive: true,
        OR: [
          ...(managed.length > 0 ? [{ id: { in: managed } }] : []),
          ...(visible !== null ? [{ employees: { some: visible } }] : []),
        ],
      };

      const teams = await prisma.team.findMany({
        where: teamWhere,
        orderBy: [{ department: { name: 'asc' } }, { name: 'asc' }],
        include: {
          department: { select: { id: true, name: true } },
          managers: {
            where: { isActive: true },
            orderBy: { assignedAt: 'asc' },
            include: { employee: { select: PERSON_SELECT } },
          },
        },
      });

      const chartTeams: OrgChartTeam[] = [];
      for (const team of teams) {
        /*
         * Members are narrowed by the same filter, so a department head
         * looking at a shared team sees their own people on it and not
         * somebody else's. A manager's own teams are inside `teamScopeFilter`
         * already, so their members come back whole.
         */
        const memberWhere: Prisma.EmployeeWhereInput = {
          AND: [
            { companyId: auth.companyId, teamId: team.id, status: 'ACTIVE' },
            managed.includes(team.id) ? {} : (visible ?? {}),
          ],
        };

        const [members, memberCount] = await Promise.all([
          prisma.employee.findMany({
            where: memberWhere,
            orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
            take: MEMBERS_SHOWN,
            select: PERSON_SELECT,
          }),
          prisma.employee.count({ where: memberWhere }),
        ]);

        chartTeams.push({
          teamId: team.id,
          teamName: team.name,
          departmentId: team.department.id,
          departmentName: team.department.name,
          isActive: team.isActive,
          managers: team.managers.map((m) => toPerson(m.employee)),
          members: members.map(toPerson),
          memberCount,
        });
      }

      /*
       * The two totals, over the SAME people the chart is showing.
       *
       * `visible ?? {}` would be wrong here and wrong in the expensive
       * direction: a caller whose role scope reaches nobody, and who is on this
       * page only because they manage a team, would have had `{}` - no filter -
       * and been handed a company headcount they may not see. So a null scope
       * falls back to the managed teams rather than to everything.
       */
      const countable: Prisma.EmployeeWhereInput =
        visible ?? (managed.length > 0 ? { teamId: { in: managed } } : { id: '' });

      const [totalEmployees, unassignedCount] = await Promise.all([
        prisma.employee.count({
          where: { AND: [{ companyId: auth.companyId, status: 'ACTIVE' }, countable] },
        }),
        prisma.employee.count({
          where: {
            AND: [{ companyId: auth.companyId, status: 'ACTIVE', teamId: null }, countable],
          },
        }),
      ]);

      const data: OrgChart = { ceo, hrManagers, teams: chartTeams, unassignedCount, totalEmployees };
      return reply.send({ data });
    },
  );

  /**
   * "Which team am I on, who runs it, and do I run anything?"
   *
   * No permission gate beyond having a session: every field here is about the
   * caller themselves or about the people who will be deciding the caller's
   * own requests.
   */
  app.get('/my-team', async (request, reply) => {
    const auth = requireAuthContext(request);

    const self = await prisma.employee.findFirst({
      where: { companyId: auth.companyId, userId: auth.userId },
      select: { id: true, teamId: true, team: { select: { id: true, name: true } } },
    });

    const empty: MyTeamContext = {
      managedTeams: [],
      myTeamId: null,
      myTeamName: null,
      myTeamManagers: [],
      isTeamManager: false,
    };
    if (!self) return reply.send({ data: empty });

    /*
     * The managed list is read from the appointment DIRECTLY rather than
     * through `managedTeamIds`, which also requires `team.data.read`. This
     * endpoint answers "do you run a team", and the answer to that is the same
     * whether or not somebody has given the person a role that lets them SEE
     * the team. The difference is exactly what the Teams screen warns about.
     */
    const appointments = await prisma.teamManager.findMany({
      where: { companyId: auth.companyId, employeeId: self.id, isActive: true, team: { isActive: true } },
      include: { team: { select: { id: true, name: true, _count: { select: { employees: true } } } } },
      orderBy: { assignedAt: 'asc' },
    });

    const myTeamManagers = self.teamId
      ? await prisma.teamManager.findMany({
          where: { teamId: self.teamId, isActive: true },
          orderBy: { assignedAt: 'asc' },
          include: { employee: { select: PERSON_SELECT } },
        })
      : [];

    const data: MyTeamContext = {
      managedTeams: appointments.map((a) => ({
        teamId: a.team.id,
        teamName: a.team.name,
        memberCount: a.team._count.employees,
      })),
      myTeamId: self.team?.id ?? null,
      myTeamName: self.team?.name ?? null,
      myTeamManagers: myTeamManagers.map((m) => toPerson(m.employee)),
      isTeamManager: appointments.length > 0,
    };

    return reply.send({ data });
  });
};
