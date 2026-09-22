import type { LookupOption } from '@hrms/shared';
import { prisma } from '../../core/db.js';

/**
 * Dropdown data.
 *
 * Forms need "every department I can pick", which is a different question from
 * the paginated, filtered list a table needs. Keeping them separate stops the
 * select boxes from silently inheriting a table's filters.
 */
export async function organisationLookups(companyId: string): Promise<{
  departments: LookupOption[];
  /*
   * Teams carry NO `departmentId`. They used to, and every form that offered
   * both dropdowns used it to narrow the team list to the chosen department -
   * which is exactly the coupling this product does not want. Department and
   * team are picked independently, so the full team list is always offered.
   */
  teams: LookupOption[];
  designations: LookupOption[];
  locations: LookupOption[];
  managers: LookupOption[];
  /**
   * Only the people who actively RUN a team, for the "team manager" filter.
   * A subset of `managers`, which is everybody still employed: asking "show me
   * Abdul Aziz's people" is only meaningful for somebody who has some.
   */
  teamManagers: LookupOption[];
}> {
  const [departments, teams, designations, locations, managers, teamManagers] = await Promise.all([
    prisma.department.findMany({
      where: { companyId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true },
    }),
    prisma.team.findMany({
      where: { companyId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.designation.findMany({
      where: { companyId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true },
    }),
    prisma.location.findMany({
      where: { companyId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, city: true },
    }),
    // Anyone still employed can be someone's manager. Both exit statuses are
    // excluded, so somebody who resigned stops being offered as one.
    prisma.employee.findMany({
      where: { companyId, status: { notIn: ['TERMINATED', 'RESIGNED'] } },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: { id: true, firstName: true, lastName: true, employeeNumber: true, jobTitle: true },
    }),
    prisma.employee.findMany({
      where: {
        companyId,
        status: { notIn: ['TERMINATED', 'RESIGNED'] },
        teamManagerships: { some: { isActive: true, team: { isActive: true } } },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        teamManagerships: {
          where: { isActive: true, team: { isActive: true } },
          orderBy: { assignedAt: 'asc' },
          select: { team: { select: { name: true } } },
        },
      },
    }),
  ]);

  return {
    departments: departments.map((d) => ({ id: d.id, label: d.name, secondaryLabel: d.code })),
    teams: teams.map((t) => ({ id: t.id, label: t.name })),
    designations: designations.map((d) => ({ id: d.id, label: d.name, secondaryLabel: d.code })),
    locations: locations.map((l) => ({ id: l.id, label: l.name, secondaryLabel: l.city })),
    managers: managers.map((m) => ({
      id: m.id,
      label: `${m.firstName} ${m.lastName}`.trim(),
      secondaryLabel: m.jobTitle ?? m.employeeNumber,
    })),
    teamManagers: teamManagers.map((m) => ({
      id: m.id,
      label: `${m.firstName} ${m.lastName}`.trim(),
      // The teams they run, so two people with the same name are tellable
      // apart by the thing the filter is actually about.
      secondaryLabel: m.teamManagerships.map((t) => t.team.name).join(', '),
    })),
  };
}
