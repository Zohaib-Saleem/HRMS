/**
 * Development seed.
 *
 * Everything here is fictional placeholder data written for this project.
 * No data from any reference system is used.
 *
 * The seed is idempotent - run it as often as you like.
 */
import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_GROUPS,
  SYSTEM_ROLES,
  type SystemRoleKey,
} from '@hrms/shared';

const prisma = new PrismaClient();

const DEMO_ADMIN_EMAIL = 'admin@hrms.local';
const DEMO_ADMIN_PASSWORD = 'Admin@12345';

const ROLE_META: Record<SystemRoleKey, { name: string; description: string; protected: boolean }> = {
  SUPER_ADMIN: {
    name: 'Super Admin',
    description: 'Unrestricted access. Always holds every permission.',
    protected: true,
  },
  HR_ADMIN: {
    name: 'HR Admin',
    description: 'Manages people, organisation structure and company settings.',
    protected: false,
  },
  MANAGER: {
    name: 'Manager',
    description: 'Views their department and team information.',
    protected: false,
  },
  EMPLOYEE: {
    name: 'Employee',
    description: 'Baseline access for every member of staff.',
    protected: false,
  },
};

/** Flat lookup of permission metadata, derived from the shared groups. */
const PERMISSION_META = new Map(
  PERMISSION_GROUPS.flatMap((group) =>
    group.permissions.map((p) => [p.value, { ...p, groupKey: group.key }] as const),
  ),
);

async function main(): Promise<void> {
  console.log('Seeding development data...\n');

  // --- permission catalogue -------------------------------------------------
  for (const key of ALL_PERMISSIONS) {
    const meta = PERMISSION_META.get(key);
    await prisma.permission.upsert({
      where: { key },
      create: {
        key,
        name: meta?.label ?? key,
        description: meta?.description ?? null,
        groupKey: meta?.groupKey ?? 'other',
      },
      update: {
        name: meta?.label ?? key,
        description: meta?.description ?? null,
        groupKey: meta?.groupKey ?? 'other',
      },
    });
  }
  console.log(`  permissions      ${ALL_PERMISSIONS.length}`);

  // --- company --------------------------------------------------------------
  const existing = await prisma.company.findFirst({ orderBy: { createdAt: 'asc' } });
  const company = existing
    ? await prisma.company.update({ where: { id: existing.id }, data: {} })
    : await prisma.company.create({
        data: {
          name: 'Northwind Labs',
          legalName: 'Northwind Labs Pvt Ltd',
          email: 'people@northwindlabs.example',
          phone: '+1 555 0100',
          website: 'https://northwindlabs.example',
          addressLine1: '18 Harbour Street',
          city: 'Springfield',
          state: 'Illinois',
          postalCode: '62701',
          country: 'United States',
          timezone: 'UTC',
          currency: 'USD',
          dateFormat: 'dd MMM yyyy',
          weekStartsOn: 'MONDAY',
        },
      });
  console.log(`  company          ${company.name}`);

  // --- roles ----------------------------------------------------------------
  const roleIds = new Map<SystemRoleKey, string>();
  for (const key of Object.values(SYSTEM_ROLES)) {
    const meta = ROLE_META[key];
    const role = await prisma.role.upsert({
      where: { companyId_key: { companyId: company.id, key } },
      create: {
        companyId: company.id,
        key,
        name: meta.name,
        description: meta.description,
        isSystem: true,
        isProtected: meta.protected,
      },
      update: { name: meta.name, description: meta.description, isProtected: meta.protected },
    });
    roleIds.set(key, role.id);

    const grants = DEFAULT_ROLE_PERMISSIONS[key];
    const permissionRows = await prisma.permission.findMany({
      where: { key: { in: [...grants] } },
      select: { id: true },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: permissionRows.map((p) => ({ roleId: role.id, permissionId: p.id })),
    });
  }
  console.log(`  roles            ${roleIds.size}`);

  // --- departments ----------------------------------------------------------
  const departmentSpecs = [
    { name: 'Engineering', code: 'ENG', description: 'Product engineering and platform.' },
    { name: 'People Operations', code: 'POP', description: 'Hiring, onboarding and HR.' },
    { name: 'Finance', code: 'FIN', description: 'Accounting, payroll and procurement.' },
    { name: 'Customer Success', code: 'CS', description: 'Onboarding and account support.' },
  ];

  const departments = new Map<string, string>();
  for (const spec of departmentSpecs) {
    const dept = await prisma.department.upsert({
      where: { companyId_name: { companyId: company.id, name: spec.name } },
      create: { companyId: company.id, ...spec },
      update: { code: spec.code, description: spec.description },
    });
    departments.set(spec.name, dept.id);
  }
  console.log(`  departments      ${departments.size}`);

  // --- teams ----------------------------------------------------------------
  const teamSpecs = [
    { name: 'Platform', department: 'Engineering' },
    { name: 'Web', department: 'Engineering' },
    { name: 'Quality', department: 'Engineering' },
    { name: 'Talent', department: 'People Operations' },
    { name: 'Payroll', department: 'Finance' },
    { name: 'Support', department: 'Customer Success' },
  ];

  const teams = new Map<string, string>();
  for (const spec of teamSpecs) {
    const departmentId = departments.get(spec.department);
    if (!departmentId) continue;
    const team = await prisma.team.upsert({
      where: { departmentId_name: { departmentId, name: spec.name } },
      create: { companyId: company.id, departmentId, name: spec.name },
      update: {},
    });
    teams.set(spec.name, team.id);
  }
  console.log(`  teams            ${teams.size}`);

  // --- demo admin account ---------------------------------------------------
  const passwordHash = await hash(DEMO_ADMIN_PASSWORD, {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const admin = await prisma.user.upsert({
    where: { email: DEMO_ADMIN_EMAIL },
    create: {
      companyId: company.id,
      email: DEMO_ADMIN_EMAIL,
      passwordHash,
      firstName: 'Dev',
      lastName: 'Administrator',
      status: 'ACTIVE',
      avatarColor: '#3f6cd6',
    },
    update: { passwordHash, status: 'ACTIVE' },
  });

  const superAdminRoleId = roleIds.get(SYSTEM_ROLES.SUPER_ADMIN);
  if (superAdminRoleId) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: admin.id, roleId: superAdminRoleId } },
      create: { userId: admin.id, roleId: superAdminRoleId },
      update: {},
    });
  }

  // Matching HR record, so the org relationships are exercised end to end.
  await prisma.employee.upsert({
    where: { companyId_employeeNumber: { companyId: company.id, employeeNumber: 'EMP-0001' } },
    create: {
      companyId: company.id,
      employeeNumber: 'EMP-0001',
      firstName: 'Dev',
      lastName: 'Administrator',
      workEmail: DEMO_ADMIN_EMAIL,
      jobTitle: 'Systems Administrator',
      departmentId: departments.get('People Operations') ?? null,
      teamId: teams.get('Talent') ?? null,
      employmentType: 'FULL_TIME',
      status: 'ACTIVE',
      hireDate: new Date('2024-01-08'),
      userId: admin.id,
    },
    update: { userId: admin.id },
  });

  console.log(`  demo admin       ${DEMO_ADMIN_EMAIL}`);

  console.log('\nSeed complete.\n');
  console.log('  Sign in with');
  console.log(`    email     ${DEMO_ADMIN_EMAIL}`);
  console.log(`    password  ${DEMO_ADMIN_PASSWORD}`);
  console.log('\n  Local development only - never reuse these credentials elsewhere.\n');
}

main()
  .catch((error: unknown) => {
    console.error('\nSeed failed:\n', error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
