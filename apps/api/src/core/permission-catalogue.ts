import type { FastifyBaseLogger } from 'fastify';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_GROUPS,
  SYSTEM_ROLES,
  type Permission,
  type SystemRoleKey,
} from '@hrms/shared';
import { prisma } from './db.js';

/**
 * Brings the permission catalogue in the database up to date with the code.
 *
 * A migration that introduces a permission creates no rows for it: the
 * catalogue lives in `packages/shared/src/permissions.ts`, and the tables it
 * is written into are ordinary data. So a release that adds a permission ships
 * a feature that nobody holds the permission for, and the screens behind it
 * are simply absent - not broken, not forbidden, absent, which is the hardest
 * kind of missing to diagnose. That is exactly what happened to the phase 10
 * loans and contracts screens.
 *
 * Running it at boot rather than as a deploy step is deliberate. A deploy
 * script is not version-controlled on every host that runs this API, and the
 * one thing worse than a catalogue that is out of date is a catalogue that is
 * out of date on some machines only.
 *
 * ADDITIVE, always:
 *
 * - Permissions the code defines and the database lacks are inserted.
 * - System roles are granted the defaults for those NEW permissions only.
 * - Nothing is ever revoked.
 * - No table outside `permissions` and `role_permissions` is touched. No
 *   employee, attendance, punch, mapping, payroll, loan or leave row is read
 *   for writing or written.
 *
 * Idempotent: a second run reports nothing to do.
 *
 * That second rule is narrower than it first looks, and the narrowness is the
 * point. A sync that re-asserts every default on every run cannot tell a
 * permission a role never had from one an administrator deliberately took
 * away, so it restores the latter - which is survivable as a once-per-release
 * chore and is not survivable at every boot, where it would undo the same
 * configuration change again after each restart. Confining the grants to
 * permissions this run introduced keeps the fix (a permission arrives with its
 * defaults, once) and drops the misfeature.
 *
 * The exception is a system role holding no grants whatsoever, which is a role
 * nobody has configured rather than one somebody has emptied - a freshly
 * provisioned company, say. That gets the full defaults.
 */

/** System roles are matched by name, the way the seeder created them. */
const ROLE_NAMES: Record<SystemRoleKey, string> = {
  [SYSTEM_ROLES.SUPER_ADMIN]: 'Super Admin',
  [SYSTEM_ROLES.HR_ADMIN]: 'HR Admin',
  [SYSTEM_ROLES.MANAGER]: 'Manager',
  [SYSTEM_ROLES.EMPLOYEE]: 'Employee',
};

const META = new Map(
  PERMISSION_GROUPS.flatMap((group) =>
    group.permissions.map((p) => [p.value, { ...p, groupKey: group.key }] as const),
  ),
);

export interface CatalogueSyncResult {
  /** Permission rows inserted because the code defines them and the DB lacked them. */
  permissionsAdded: Permission[];
  /** Default grants added to system roles that did not hold them, by role name. */
  grantsAdded: Array<{ role: string; permissions: Permission[] }>;
}

export async function syncPermissionCatalogue(): Promise<CatalogueSyncResult> {
  const known = new Set(
    (await prisma.permission.findMany({ select: { key: true } })).map((p) => p.key),
  );
  const permissionsAdded = ALL_PERMISSIONS.filter((key) => !known.has(key));

  for (const key of ALL_PERMISSIONS) {
    const meta = META.get(key);
    const fields = {
      name: meta?.label ?? key,
      description: meta?.description ?? null,
      groupKey: meta?.groupKey ?? 'other',
    };
    // The labels are the code's to own - they are what the roles screen reads -
    // so an existing row has its wording refreshed. Its grants are untouched.
    await prisma.permission.upsert({ where: { key }, create: { key, ...fields }, update: fields });
  }

  const permissionIds = new Map(
    (await prisma.permission.findMany({ select: { id: true, key: true } })).map((p) => [
      p.key,
      p.id,
    ]),
  );

  const grantsAdded: CatalogueSyncResult['grantsAdded'] = [];

  const isNew = new Set<Permission>(permissionsAdded);

  for (const [key, name] of Object.entries(ROLE_NAMES) as Array<[SystemRoleKey, string]>) {
    const defaults = DEFAULT_ROLE_PERMISSIONS[key] ?? [];

    // Every role of that name, across every company on the installation.
    for (const role of await prisma.role.findMany({ where: { name } })) {
      const held = new Set(
        (
          await prisma.rolePermission.findMany({
            where: { roleId: role.id },
            include: { permission: { select: { key: true } } },
          })
        ).map((rp) => rp.permission.key),
      );

      // An ungranted role has not been configured, it has not been started -
      // give it everything. A role somebody has set up gets only what this run
      // introduced, so an earlier decision to withhold a default survives.
      const wanted = held.size === 0 ? defaults : defaults.filter((p) => isNew.has(p));

      const missing = wanted.filter((p) => !held.has(p));
      if (missing.length === 0) continue;

      await prisma.rolePermission.createMany({
        data: missing.flatMap((p) => {
          const permissionId = permissionIds.get(p);
          return permissionId ? [{ roleId: role.id, permissionId }] : [];
        }),
        skipDuplicates: true,
      });
      grantsAdded.push({ role: name, permissions: [...missing] });
    }
  }

  return { permissionsAdded, grantsAdded };
}

/**
 * The boot-time call. Reports what it did and never throws: a catalogue that
 * could not be refreshed leaves the installation exactly as it was, which is
 * survivable, whereas refusing to start the API over it is not.
 */
export async function syncPermissionCatalogueAtBoot(log: FastifyBaseLogger): Promise<void> {
  try {
    const { permissionsAdded, grantsAdded } = await syncPermissionCatalogue();

    if (permissionsAdded.length > 0) {
      log.info({ permissions: permissionsAdded }, 'permission catalogue: added new permissions');
    }
    for (const { role, permissions } of grantsAdded) {
      log.info({ role, permissions }, 'permission catalogue: granted defaults to system role');
    }
    if (permissionsAdded.length === 0 && grantsAdded.length === 0) {
      log.debug('permission catalogue: already up to date');
    }
  } catch (error) {
    log.error({ err: error }, 'permission catalogue sync failed; permissions left unchanged');
  }
}
