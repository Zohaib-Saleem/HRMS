import type { FastifyBaseLogger } from 'fastify';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_ROLE_SCOPES,
  PERMISSION_GROUPS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_META,
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
 * - System ROLES the code defines and a company lacks are inserted. A release
 *   that introduces a role has the same problem a release that introduces a
 *   permission has, and worse: roles are created by the seeder, the seeder runs
 *   once when a company is provisioned, and nothing in the API creates one - so
 *   a role added later would exist on new installations and on no existing one,
 *   with no way for an administrator to make it themselves. An existing role is
 *   never touched: not renamed, not re-scoped, not re-described. Only its
 *   absence is corrected.
 * - System roles are granted the defaults for those NEW permissions only.
 * - Nothing is ever revoked.
 * - No table outside `permissions`, `roles` and `role_permissions` is touched.
 *   No employee, attendance, punch, mapping, payroll, loan or leave row is read
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

/**
 * System roles are matched by name, the way the seeder created them.
 *
 * Read off the shared metadata rather than restated here, so this file and the
 * seeder cannot come to disagree about what a role is called - a disagreement
 * that would not fail, it would simply stop granting.
 */
const ROLE_NAMES: Record<SystemRoleKey, string> = Object.fromEntries(
  Object.values(SYSTEM_ROLES).map((key) => [key, SYSTEM_ROLE_META[key].name]),
) as Record<SystemRoleKey, string>;

const META = new Map(
  PERMISSION_GROUPS.flatMap((group) =>
    group.permissions.map((p) => [p.value, { ...p, groupKey: group.key }] as const),
  ),
);

export interface CatalogueSyncResult {
  /** Permission rows inserted because the code defines them and the DB lacked them. */
  permissionsAdded: Permission[];
  /** System roles created because a release introduced them, by company and name. */
  rolesCreated: Array<{ company: string; role: string }>;
  /** Default grants added to system roles that did not hold them, by role name. */
  grantsAdded: Array<{ role: string; permissions: Permission[] }>;
}

/**
 * Creates any system role a company is missing, and nothing else.
 *
 * Matched on the KEY rather than the name, because the name is the one thing
 * about a role an administrator can change: renaming "Office Boy" to "Canteen"
 * must not make the next boot decide the role is absent and create a second
 * one. The key is what the seeder writes and what the unique index is on.
 *
 * A created role arrives with no grants at all, which is exactly what the grant
 * loop below treats as "never configured" - so it gets its full defaults on
 * this same run, and only on this one.
 */
async function createMissingSystemRoles(): Promise<CatalogueSyncResult['rolesCreated']> {
  const created: CatalogueSyncResult['rolesCreated'] = [];
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });

  for (const company of companies) {
    for (const key of Object.values(SYSTEM_ROLES)) {
      const existing = await prisma.role.findUnique({
        where: { companyId_key: { companyId: company.id, key } },
        select: { id: true },
      });
      if (existing) continue;

      const meta = SYSTEM_ROLE_META[key];
      await prisma.role.create({
        data: {
          companyId: company.id,
          key,
          name: meta.name,
          description: meta.description,
          isSystem: true,
          isProtected: meta.isProtected,
          dataScope: DEFAULT_ROLE_SCOPES[key],
        },
      });

      created.push({ company: company.name, role: meta.name });
    }
  }

  return created;
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

  /*
   * Before the grants, because a role that does not exist cannot be granted
   * anything - and a role created here is empty, which is what the loop below
   * reads as "not configured" and answers with the full defaults.
   */
  const rolesCreated = await createMissingSystemRoles();

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

  return { permissionsAdded, rolesCreated, grantsAdded };
}

/**
 * The boot-time call. Reports what it did and never throws: a catalogue that
 * could not be refreshed leaves the installation exactly as it was, which is
 * survivable, whereas refusing to start the API over it is not.
 */
export async function syncPermissionCatalogueAtBoot(log: FastifyBaseLogger): Promise<void> {
  try {
    const { permissionsAdded, rolesCreated, grantsAdded } = await syncPermissionCatalogue();

    if (permissionsAdded.length > 0) {
      log.info({ permissions: permissionsAdded }, 'permission catalogue: added new permissions');
    }
    for (const { company, role } of rolesCreated) {
      log.info({ company, role }, 'permission catalogue: created system role');
    }
    for (const { role, permissions } of grantsAdded) {
      log.info({ role, permissions }, 'permission catalogue: granted defaults to system role');
    }
    if (permissionsAdded.length === 0 && rolesCreated.length === 0 && grantsAdded.length === 0) {
      log.debug('permission catalogue: already up to date');
    }
  } catch (error) {
    log.error({ err: error }, 'permission catalogue sync failed; permissions left unchanged');
  }
}
