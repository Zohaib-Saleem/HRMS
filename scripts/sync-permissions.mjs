/**
 * Brings the permission catalogue in the database up to date with the code.
 *
 * Additive on purpose. The seeder rewrites every role's grants from the
 * defaults, which is right for a fresh database and wrong for a running one:
 * it would discard whatever an administrator has configured since. This only
 * inserts what is missing - new permission rows, and the default grants for
 * system roles that do not already have them - and removes nothing.
 *
 *   npx dotenv -e .env -- npx tsx scripts/sync-permissions.mjs
 */
import { PrismaClient } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_GROUPS,
  SYSTEM_ROLES,
} from '@hrms/shared';

const prisma = new PrismaClient();

const META = new Map(
  PERMISSION_GROUPS.flatMap((group) =>
    group.permissions.map((p) => [p.value, { ...p, groupKey: group.key }]),
  ),
);

let added = 0;
let granted = 0;

try {
  for (const key of ALL_PERMISSIONS) {
    const meta = META.get(key);
    const existing = await prisma.permission.findUnique({ where: { key } });
    if (!existing) added += 1;

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

  const permissionIds = new Map(
    (await prisma.permission.findMany({ select: { id: true, key: true } })).map((p) => [
      p.key,
      p.id,
    ]),
  );

  // System roles are matched by name, the way the seeder created them.
  const ROLE_NAMES = {
    [SYSTEM_ROLES.SUPER_ADMIN]: 'Super Admin',
    [SYSTEM_ROLES.HR_ADMIN]: 'HR Admin',
    [SYSTEM_ROLES.MANAGER]: 'Manager',
    [SYSTEM_ROLES.EMPLOYEE]: 'Employee',
  };

  for (const [key, name] of Object.entries(ROLE_NAMES)) {
    const roles = await prisma.role.findMany({ where: { name } });
    const wanted = DEFAULT_ROLE_PERMISSIONS[key] ?? [];

    for (const role of roles) {
      const held = new Set(
        (
          await prisma.rolePermission.findMany({
            where: { roleId: role.id },
            include: { permission: { select: { key: true } } },
          })
        ).map((rp) => rp.permission.key),
      );

      const missing = wanted.filter((p) => !held.has(p));
      if (missing.length === 0) continue;

      await prisma.rolePermission.createMany({
        data: missing.map((p) => ({ roleId: role.id, permissionId: permissionIds.get(p) })),
        skipDuplicates: true,
      });
      granted += missing.length;
      console.log(`  ${name}: granted ${missing.join(', ')}`);
    }
  }

  console.log(`\npermissions added: ${added}`);
  console.log(`grants added:      ${granted}`);
} finally {
  await prisma.$disconnect();
}
