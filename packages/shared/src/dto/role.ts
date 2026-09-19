import { z } from 'zod';
import { ALL_PERMISSIONS, DATA_SCOPES, type DataScope, type Permission } from '../permissions.js';

/**
 * Roles: the catalogue, and creating one.
 *
 * Until this file existed a role could have its permissions edited and nothing
 * else - no create, no rename, no way to change how far it can see. Two roles
 * in production (`CASE_AGENT`, `HELPDESK_MANAGER`) were therefore inserted
 * straight into the database by hand, which is why they appear nowhere in this
 * repository and why nothing would recreate them.
 */

export interface RoleRecord {
  id: string;
  /**
   * The stable identifier. DERIVED from the name on creation and never
   * editable afterwards, because code, seeds and the permission catalogue
   * refer to system roles by key - a renameable key is a broken reference
   * waiting to happen. The display name is what changes.
   */
  key: string;
  name: string;
  description: string | null;
  /** How far the role can see, independently of what it may do. */
  dataScope: DataScope;
  /** Seeded by the system. Cannot be deleted, and its key never changes. */
  isSystem: boolean;
  /** SUPER_ADMIN. Permissions cannot be edited away, which prevents lock-out. */
  isProtected: boolean;
  userCount: number;
  permissions: Permission[];
}

/**
 * Scopes a company may choose for a role it creates.
 *
 * `NONE` and `REPORTS` are deliberately absent from the form. Both exist in
 * `DataScope` and both are meaningful to code, but neither is a sensible thing
 * to hand somebody building a role in a settings screen: `NONE` produces a
 * role that can sign in and read nothing, which reads as a broken account
 * rather than a decision, and `REPORTS` excludes the holder's OWN record,
 * which is almost always a mistake next to `REPORTS_AND_OWN`. A role that
 * genuinely needs either can still be given it in the database.
 */
export const ASSIGNABLE_DATA_SCOPES = [
  DATA_SCOPES.OWN,
  DATA_SCOPES.REPORTS_AND_OWN,
  DATA_SCOPES.DEPARTMENT,
  DATA_SCOPES.ALL,
] as const;

export type AssignableDataScope = (typeof ASSIGNABLE_DATA_SCOPES)[number];

const roleName = z
  .string()
  .trim()
  .min(2, 'Give the role a name of at least 2 characters.')
  .max(60, 'Use at most 60 characters.');

const roleDescription = z
  .string()
  .trim()
  .max(200, 'Use at most 200 characters.')
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const dataScope = z.enum(ASSIGNABLE_DATA_SCOPES, {
  errorMap: () => ({ message: 'Choose how much this role can see.' }),
});

const permissionList = z.array(
  z.enum(ALL_PERMISSIONS as unknown as [string, ...string[]]),
);

export const roleCreateSchema = z.object({
  name: roleName,
  description: roleDescription,
  dataScope,
  /**
   * Optional, and usually empty at creation.
   *
   * A role with no permissions is a legitimate thing to create - it is the
   * starting point for one you are about to configure on the very next screen,
   * and refusing it would force an administrator to guess the whole permission
   * set in a single dialog. It cannot be ASSIGNED to anybody usefully, but
   * `users.routes.ts` already refuses an account with no role rather than
   * relying on this.
   */
  permissions: permissionList.optional(),
});
export type RoleCreateInput = z.infer<typeof roleCreateSchema>;

/** Renaming, re-describing and re-scoping. The key is never in here. */
export const roleUpdateSchema = z.object({
  name: roleName,
  description: roleDescription,
  dataScope,
});
export type RoleUpdateInput = z.infer<typeof roleUpdateSchema>;

export const updateRolePermissionsSchema = z.object({
  permissions: permissionList,
});
export type UpdateRolePermissionsInput = z.infer<typeof updateRolePermissionsSchema>;

/**
 * The key derived from a display name: `IT Manager` becomes `IT_MANAGER`.
 *
 * Shared rather than done in the route, because the form shows the caller what
 * the key WILL be before they commit to it - a key is permanent, and finding
 * out what it became afterwards is too late to object.
 *
 * Anything outside A-Z and 0-9 collapses to a single underscore, and a leading
 * digit is prefixed, because a key is read as an identifier in code and in
 * seeds. An empty result is impossible: the name is at least two characters
 * and a name made entirely of punctuation returns `ROLE`.
 */
export function roleKeyFromName(name: string): string {
  const key = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (!key) return 'ROLE';
  return /^[0-9]/.test(key) ? `ROLE_${key}` : key;
}
