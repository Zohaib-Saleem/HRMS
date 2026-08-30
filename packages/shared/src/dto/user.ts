import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

/** Login accounts: creation, linking, roles, suspension and sessions. */

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  INVITED: 'Invited',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
};

export const USER_STATUS_DESCRIPTIONS: Record<UserStatus, string> = {
  INVITED: 'Created but has never set a password. Cannot sign in yet.',
  ACTIVE: 'Can sign in.',
  SUSPENDED: 'Cannot sign in. Existing sessions stop working immediately.',
};

export const USER_SUSPENSION_REASONS = ['EMPLOYMENT_TERMINATED', 'ADMINISTRATIVE'] as const;
export type UserSuspensionReason = (typeof USER_SUSPENSION_REASONS)[number];

export const USER_SUSPENSION_REASON_LABELS: Record<UserSuspensionReason, string> = {
  EMPLOYMENT_TERMINATED: 'Employee was terminated',
  ADMINISTRATIVE: 'Suspended by an administrator',
};

/**
 * A password is never accepted, sent or returned by any user-management route.
 *
 * A new account is created as INVITED with no usable password, and the person
 * sets their own through the ordinary reset link. That means no temporary
 * password is ever generated, transmitted, or seen by an administrator.
 */
export const userCreateSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Enter an email address.')
    .max(254)
    .email('Enter a valid email address.'),
  firstName: z.string().trim().min(1, 'First name is required.').max(80),
  lastName: z.string().trim().min(1, 'Last name is required.').max(80),
  /** The employee this login belongs to. One account per employee. */
  employeeId: z.string().trim().max(64).nullish(),
  /** At least one, or the account can sign in and see nothing. */
  roleIds: z
    .array(z.string().trim().min(1).max(64))
    .min(1, 'Choose at least one role.')
    .max(10),
});

export type UserCreateInput = z.infer<typeof userCreateSchema>;

export const userUpdateSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required.').max(80),
  lastName: z.string().trim().min(1, 'Last name is required.').max(80),
  employeeId: z.string().trim().max(64).nullish(),
});

export type UserUpdateInput = z.infer<typeof userUpdateSchema>;

export const userRolesSchema = z.object({
  roleIds: z
    .array(z.string().trim().min(1).max(64))
    .min(1, 'A user must keep at least one role.')
    .max(10),
});

export type UserRolesInput = z.infer<typeof userRolesSchema>;

export const userSuspendSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Say why this account is being suspended.')
    .max(300),
});

export type UserSuspendInput = z.infer<typeof userSuspendSchema>;

export const userQuerySchema = paginationQuerySchema.extend({
  status: z.enum(USER_STATUSES).optional(),
  roleId: z.string().trim().max(64).optional(),
  /** `true` restricts to accounts with no employee linked. */
  unlinkedOnly: z.enum(['true', 'false']).optional(),
});

/**
 * A user, as every endpoint returns one.
 *
 * There is no password field of any kind - not the hash, not a placeholder, not
 * a boolean about its contents. The serialiser cannot leak what it never
 * selects.
 */
export interface UserRecord {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  status: UserStatus;
  avatarColor: string;

  /** True while the account is locked out after repeated failed sign-ins. */
  isLockedOut: boolean;
  lastLoginAt: string | null;

  suspendedReason: UserSuspensionReason | null;
  suspendedAt: string | null;
  suspendedByName: string | null;

  roles: Array<{ id: string; key: string; name: string }>;

  employee: {
    id: string;
    employeeNumber: string;
    fullName: string;
    status: string;
    departmentName: string | null;
  } | null;

  /** Sessions that are neither revoked nor expired. */
  activeSessionCount: number;

  createdAt: string;
}

export interface UserSessionRecord {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

export interface UserDetail extends UserRecord {
  sessions: UserSessionRecord[];
  /** Whether this account can currently be restored, and why not if it cannot. */
  restore: { allowed: boolean; reason: string | null };
}

/** Employees with no login yet, for the create-user form. */
export interface LinkableEmployee {
  id: string;
  employeeNumber: string;
  fullName: string;
  workEmail: string | null;
  departmentName: string | null;
}
