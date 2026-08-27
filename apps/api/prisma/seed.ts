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
  DEFAULT_ROLE_SCOPES,
  PERMISSION_GROUPS,
  SYSTEM_ROLES,
  type SystemRoleKey,
} from '@hrms/shared';

const prisma = new PrismaClient();

const DEMO_ADMIN_EMAIL = 'admin@hrms.local';
const DEMO_ADMIN_PASSWORD = 'Admin@12345';
const DEMO_MANAGER_EMAIL = 'manager@hrms.local';
const DEMO_MANAGER_PASSWORD = 'Manager@12345';
const DEMO_EMPLOYEE_EMAIL = 'employee@hrms.local';
const DEMO_EMPLOYEE_PASSWORD = 'Employee@12345';

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
        dataScope: DEFAULT_ROLE_SCOPES[key],
      },
      update: {
        name: meta.name,
        description: meta.description,
        isProtected: meta.protected,
        dataScope: DEFAULT_ROLE_SCOPES[key],
      },
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

  // --- designations ---------------------------------------------------------
  const designationSpecs = [
    { name: 'Systems Administrator', code: 'SYSADMIN' },
    { name: 'Software Engineer', code: 'SWE' },
    { name: 'Senior Software Engineer', code: 'SSWE' },
    { name: 'Engineering Manager', code: 'EM' },
    { name: 'People Operations Lead', code: 'POPS' },
    { name: 'Recruiter', code: 'REC' },
    { name: 'Accountant', code: 'ACC' },
    { name: 'Support Specialist', code: 'SUP' },
  ];

  const designations = new Map<string, string>();
  for (const spec of designationSpecs) {
    const record = await prisma.designation.upsert({
      where: { companyId_name: { companyId: company.id, name: spec.name } },
      create: { companyId: company.id, ...spec },
      update: { code: spec.code },
    });
    designations.set(spec.name, record.id);
  }
  console.log(`  designations     ${designations.size}`);

  // --- locations ------------------------------------------------------------
  const locationSpecs = [
    {
      name: 'Head Office',
      code: 'HQ',
      addressLine1: '18 Harbour Street',
      city: 'Springfield',
      state: 'Illinois',
      country: 'United States',
      timezone: 'UTC',
    },
    { name: 'Remote', code: 'REM', country: 'Distributed', timezone: 'UTC' },
  ];

  const locations = new Map<string, string>();
  for (const spec of locationSpecs) {
    const record = await prisma.location.upsert({
      where: { companyId_name: { companyId: company.id, name: spec.name } },
      create: { companyId: company.id, ...spec },
      update: {},
    });
    locations.set(spec.name, record.id);
  }
  console.log(`  locations        ${locations.size}`);

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
  const adminEmployee = await prisma.employee.upsert({
    where: { companyId_employeeNumber: { companyId: company.id, employeeNumber: 'EMP-0001' } },
    create: {
      companyId: company.id,
      employeeNumber: 'EMP-0001',
      firstName: 'Dev',
      lastName: 'Administrator',
      workEmail: DEMO_ADMIN_EMAIL,
      jobTitle: 'Systems Administrator',
      designationId: designations.get('Systems Administrator') ?? null,
      departmentId: departments.get('People Operations') ?? null,
      teamId: teams.get('Talent') ?? null,
      locationId: locations.get('Head Office') ?? null,
      employmentType: 'FULL_TIME',
      status: 'ACTIVE',
      hireDate: new Date('2024-01-08'),
      userId: admin.id,
    },
    update: {
      userId: admin.id,
      designationId: designations.get('Systems Administrator') ?? null,
      locationId: locations.get('Head Office') ?? null,
    },
  });

  console.log(`  demo admin       ${DEMO_ADMIN_EMAIL}`);

  // --- demo employees -------------------------------------------------------
  // Entirely fictional. Enough structure to exercise departments, teams,
  // designations, locations, reporting lines and every status filter.
  const employeeSpecs = [
    { number: 'EMP-0002', first: 'Amara', last: 'Osei', designation: 'Engineering Manager', department: 'Engineering', team: 'Platform', location: 'Head Office', manager: null, type: 'FULL_TIME', status: 'ACTIVE', hire: '2024-02-19' },
    { number: 'EMP-0003', first: 'Tomas', last: 'Lindqvist', designation: 'Senior Software Engineer', department: 'Engineering', team: 'Platform', location: 'Head Office', manager: 'EMP-0002', type: 'FULL_TIME', status: 'ACTIVE', hire: '2024-03-11' },
    { number: 'EMP-0004', first: 'Priya', last: 'Raghunathan', designation: 'Software Engineer', department: 'Engineering', team: 'Web', location: 'Remote', manager: 'EMP-0002', type: 'FULL_TIME', status: 'ACTIVE', hire: '2024-06-03' },
    { number: 'EMP-0005', first: 'Diego', last: 'Marchetti', designation: 'Software Engineer', department: 'Engineering', team: 'Quality', location: 'Remote', manager: 'EMP-0002', type: 'CONTRACT', status: 'ACTIVE', hire: '2025-01-13' },
    { number: 'EMP-0006', first: 'Hannah', last: 'Boateng', designation: 'People Operations Lead', department: 'People Operations', team: 'Talent', location: 'Head Office', manager: null, type: 'FULL_TIME', status: 'ACTIVE', hire: '2024-01-22' },
    { number: 'EMP-0007', first: 'Yusuf', last: 'Demir', designation: 'Recruiter', department: 'People Operations', team: 'Talent', location: 'Head Office', manager: 'EMP-0006', type: 'FULL_TIME', status: 'ON_LEAVE', hire: '2025-02-17' },
    { number: 'EMP-0008', first: 'Ingrid', last: 'Halvorsen', designation: 'Accountant', department: 'Finance', team: 'Payroll', location: 'Head Office', manager: null, type: 'PART_TIME', status: 'ACTIVE', hire: '2024-09-02' },
    { number: 'EMP-0009', first: 'Kwame', last: 'Mensah', designation: 'Support Specialist', department: 'Customer Success', team: 'Support', location: 'Remote', manager: null, type: 'FULL_TIME', status: 'ACTIVE', hire: '2025-04-07' },
    { number: 'EMP-0010', first: 'Sofia', last: 'Navarro', designation: 'Support Specialist', department: 'Customer Success', team: 'Support', location: 'Remote', manager: 'EMP-0009', type: 'INTERN', status: 'ACTIVE', hire: '2026-01-12' },
    { number: 'EMP-0011', first: 'Peter', last: 'Vasquez', designation: 'Software Engineer', department: 'Engineering', team: 'Web', location: 'Head Office', manager: 'EMP-0002', type: 'FULL_TIME', status: 'TERMINATED', hire: '2023-08-14', termination: '2025-11-28' },
  ] as const;

  const byNumber = new Map<string, string>([['EMP-0001', adminEmployee.id]]);

  // Two passes: create everyone first, then wire reporting lines, since a
  // manager may appear later in the list than their report.
  for (const spec of employeeSpecs) {
    const record = await prisma.employee.upsert({
      where: { companyId_employeeNumber: { companyId: company.id, employeeNumber: spec.number } },
      create: {
        companyId: company.id,
        employeeNumber: spec.number,
        firstName: spec.first,
        lastName: spec.last,
        workEmail: `${spec.first.toLowerCase()}.${spec.last.toLowerCase()}@northwindlabs.example`,
        designationId: designations.get(spec.designation) ?? null,
        departmentId: departments.get(spec.department) ?? null,
        teamId: teams.get(spec.team) ?? null,
        locationId: locations.get(spec.location) ?? null,
        employmentType: spec.type,
        status: spec.status,
        hireDate: new Date(spec.hire),
        terminationDate: 'termination' in spec && spec.termination ? new Date(spec.termination) : null,
      },
      update: {},
    });
    byNumber.set(spec.number, record.id);
  }

  for (const spec of employeeSpecs) {
    if (!spec.manager) continue;
    const employeeId = byNumber.get(spec.number);
    const managerId = byNumber.get(spec.manager);
    if (employeeId && managerId) {
      await prisma.employee.update({ where: { id: employeeId }, data: { managerId } });
    }
  }

  console.log(`  demo employees   ${employeeSpecs.length + 1}`);

  // --- shifts ---------------------------------------------------------------
  const shiftSpecs = [
    { name: 'General', code: 'GEN', startTime: '09:00', endTime: '18:00', breakMinutes: 60 },
    { name: 'Early', code: 'EAR', startTime: '07:00', endTime: '16:00', breakMinutes: 60 },
    { name: 'Late', code: 'LAT', startTime: '13:00', endTime: '22:00', breakMinutes: 60 },
  ];

  const shifts = new Map<string, string>();
  for (const spec of shiftSpecs) {
    const record = await prisma.shift.upsert({
      where: { companyId_name: { companyId: company.id, name: spec.name } },
      create: { companyId: company.id, ...spec },
      update: { startTime: spec.startTime, endTime: spec.endTime, breakMinutes: spec.breakMinutes },
    });
    shifts.set(spec.name, record.id);
  }
  console.log(`  shifts           ${shifts.size}`);

  // --- leave types ----------------------------------------------------------
  // Policy is data-driven: entitlement, accrual and carry-forward all live in
  // these rows, not in the services that read them.
  const leaveTypeSpecs = [
    {
      name: 'Annual Leave',
      code: 'AL',
      description: 'Paid time off, accrued monthly.',
      annualEntitlementDays: 24,
      monthlyAccrualDays: 2,
      carryForwardEnabled: true,
      carryForwardCapDays: 5,
      isPaid: true,
    },
    {
      name: 'Sick Leave',
      code: 'SL',
      description: 'Paid leave for illness.',
      annualEntitlementDays: 12,
      monthlyAccrualDays: 1,
      carryForwardEnabled: false,
      carryForwardCapDays: null,
      isPaid: true,
    },
    {
      name: 'Casual Leave',
      code: 'CL',
      description: 'Short-notice personal leave.',
      annualEntitlementDays: 6,
      monthlyAccrualDays: 0.5,
      carryForwardEnabled: false,
      carryForwardCapDays: null,
      isPaid: true,
    },
    {
      name: 'Unpaid Leave',
      code: 'UL',
      description: 'Approved time off without pay.',
      annualEntitlementDays: 30,
      monthlyAccrualDays: 2.5,
      carryForwardEnabled: false,
      carryForwardCapDays: null,
      isPaid: false,
    },
  ];

  const leaveTypes = new Map<string, string>();
  for (const spec of leaveTypeSpecs) {
    const record = await prisma.leaveType.upsert({
      where: { companyId_name: { companyId: company.id, name: spec.name } },
      create: { companyId: company.id, ...spec },
      update: {
        annualEntitlementDays: spec.annualEntitlementDays,
        monthlyAccrualDays: spec.monthlyAccrualDays,
        carryForwardEnabled: spec.carryForwardEnabled,
        carryForwardCapDays: spec.carryForwardCapDays,
        isPaid: spec.isPaid,
      },
    });
    leaveTypes.set(spec.name, record.id);
  }
  console.log(`  leave types      ${leaveTypes.size}`);

  // --- holidays -------------------------------------------------------------
  // Fictional dates. A null locationId means the holiday applies everywhere.
  const year = new Date().getUTCFullYear();
  const holidaySpecs = [
    { name: 'New Year', month: 0, day: 1, location: null },
    { name: 'Spring Break', month: 3, day: 6, location: null },
    { name: 'Founders Day', month: 6, day: 14, location: 'Head Office' },
    { name: 'Autumn Holiday', month: 9, day: 12, location: null },
    { name: 'Winter Holiday', month: 11, day: 25, location: null },
  ];

  let holidayCount = 0;
  for (const spec of holidaySpecs) {
    const date = new Date(Date.UTC(year, spec.month, spec.day));
    const locationId = spec.location ? (locations.get(spec.location) ?? null) : null;

    const existing = await prisma.holiday.findFirst({
      where: { companyId: company.id, date, locationId },
      select: { id: true },
    });
    if (existing) {
      await prisma.holiday.update({ where: { id: existing.id }, data: { name: spec.name } });
    } else {
      await prisma.holiday.create({
        data: { companyId: company.id, name: spec.name, date, locationId },
      });
    }
    holidayCount += 1;
  }
  console.log(`  holidays         ${holidayCount}`);

  // --- demo manager account -------------------------------------------------
  // Exists so the data-scope rules are testable: this account holds MANAGER,
  // whose scope is REPORTS_AND_OWN, and so sees only itself plus its reports.
  const managerEmployeeId = byNumber.get('EMP-0002');
  const managerRoleId = roleIds.get(SYSTEM_ROLES.MANAGER);

  if (managerEmployeeId && managerRoleId) {
    const managerHash = await hash(DEMO_MANAGER_PASSWORD, {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    const managerUser = await prisma.user.upsert({
      where: { email: DEMO_MANAGER_EMAIL },
      create: {
        companyId: company.id,
        email: DEMO_MANAGER_EMAIL,
        passwordHash: managerHash,
        firstName: 'Amara',
        lastName: 'Osei',
        status: 'ACTIVE',
        avatarColor: '#0f8a72',
      },
      update: { passwordHash: managerHash, status: 'ACTIVE' },
    });

    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: managerUser.id, roleId: managerRoleId } },
      create: { userId: managerUser.id, roleId: managerRoleId },
      update: {},
    });

    await prisma.employee.update({
      where: { id: managerEmployeeId },
      data: { userId: managerUser.id },
    });

    console.log(`  demo manager     ${DEMO_MANAGER_EMAIL}`);
  }

  // --- demo employee account ------------------------------------------------
  // EMP-0003 reports to EMP-0002, so this account can raise requests that the
  // manager account is the assigned approver for - the whole approval loop is
  // reproducible from a fresh seed.
  const staffEmployeeId = byNumber.get('EMP-0003');
  const employeeRoleId = roleIds.get(SYSTEM_ROLES.EMPLOYEE);

  if (staffEmployeeId && employeeRoleId) {
    const staffHash = await hash(DEMO_EMPLOYEE_PASSWORD, {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    const staffUser = await prisma.user.upsert({
      where: { email: DEMO_EMPLOYEE_EMAIL },
      create: {
        companyId: company.id,
        email: DEMO_EMPLOYEE_EMAIL,
        passwordHash: staffHash,
        firstName: 'Tomas',
        lastName: 'Lindqvist',
        status: 'ACTIVE',
        avatarColor: '#b4531f',
      },
      update: { passwordHash: staffHash, status: 'ACTIVE' },
    });

    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: staffUser.id, roleId: employeeRoleId } },
      create: { userId: staffUser.id, roleId: employeeRoleId },
      update: {},
    });

    await prisma.employee.update({
      where: { id: staffEmployeeId },
      data: { userId: staffUser.id },
    });

    console.log(`  demo employee    ${DEMO_EMPLOYEE_EMAIL}`);
  }

  console.log('\nSeed complete.\n');
  console.log('  Sign in with');
  console.log(`    admin    ${DEMO_ADMIN_EMAIL} / ${DEMO_ADMIN_PASSWORD}`);
  console.log(`    manager  ${DEMO_MANAGER_EMAIL} / ${DEMO_MANAGER_PASSWORD}`);
  console.log(`    employee ${DEMO_EMPLOYEE_EMAIL} / ${DEMO_EMPLOYEE_PASSWORD}`);
  console.log('             (limited data scope - sees only their own reporting line)');
  console.log('\n  Local development only - never reuse these credentials elsewhere.\n');
}

main()
  .catch((error: unknown) => {
    console.error('\nSeed failed:\n', error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
