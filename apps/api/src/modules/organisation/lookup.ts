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
  teams: Array<LookupOption & { departmentId: string }>;
  designations: LookupOption[];
  locations: LookupOption[];
  managers: LookupOption[];
}> {
  const [departments, teams, designations, locations, managers] = await Promise.all([
    prisma.department.findMany({
      where: { companyId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true },
    }),
    prisma.team.findMany({
      where: { companyId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, departmentId: true, department: { select: { name: true } } },
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
    // Anyone still employed can be someone's manager.
    prisma.employee.findMany({
      where: { companyId, status: { not: 'TERMINATED' } },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: { id: true, firstName: true, lastName: true, employeeNumber: true, jobTitle: true },
    }),
  ]);

  return {
    departments: departments.map((d) => ({ id: d.id, label: d.name, secondaryLabel: d.code })),
    teams: teams.map((t) => ({
      id: t.id,
      label: t.name,
      secondaryLabel: t.department.name,
      departmentId: t.departmentId,
    })),
    designations: designations.map((d) => ({ id: d.id, label: d.name, secondaryLabel: d.code })),
    locations: locations.map((l) => ({ id: l.id, label: l.name, secondaryLabel: l.city })),
    managers: managers.map((m) => ({
      id: m.id,
      label: `${m.firstName} ${m.lastName}`.trim(),
      secondaryLabel: m.jobTitle ?? m.employeeNumber,
    })),
  };
}
