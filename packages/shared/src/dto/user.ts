import { z } from 'zod';
import { passwordSchema } from './auth.js';
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

/**
 * Changing the address an account signs in with.
 *
 * Its own schema and its own endpoint rather than a field on
 * `userUpdateSchema`, because it is not the same kind of edit. Correcting a
 * surname is a tidy-up; handing an account a different sign-in identity ends
 * every session, may re-issue an unaccepted invitation, and is the one account
 * change that cannot be undone by simply typing the old value back — the old
 * address may by then belong to somebody else.
 */
export const userEmailChangeSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Enter an email address.')
    .max(254)
    .email('Enter a valid email address.'),
  /**
   * Also write the new address to the linked employee's `workEmail`.
   *
   * Opt-in because the two fields answer different questions: one is how a
   * person authenticates, the other is how the organisation contacts them.
   * They are usually the same and occasionally, deliberately, not.
   */
  syncEmployeeWorkEmail: z.boolean().default(false),
  /**
   * The administrator has read that the old address stops working.
   *
   * Required by the API and not only by the form, so a request assembled by
   * hand is held to the same standard as a click: this change ends every
   * session the person has and cannot be undone by typing the old value back,
   * and a single mis-click must not be enough to cause it.
   */
  acknowledged: z.literal(true, {
    errorMap: () => ({ message: 'Confirm that you understand the old sign-in email will stop working.' }),
  }),
});

export type UserEmailChangeInput = z.infer<typeof userEmailChangeSchema>;

/** What `POST /users/:id/change-email` reports back. */
export interface UserEmailChangeResult {
  id: string;
  email: string;
  previousEmail: string;
  /** The linked employee, when there is one. Its identity is never touched. */
  employeeId: string | null;
  /** Unused password-reset or invitation links retired by the change. */
  retiredResetTokens: number;
  /** Sessions ended by the change. The person must sign in again. */
  revokedSessions: number;
  /** True when an unaccepted invitation was re-sent to the new address. */
  invitationResent: boolean;
  /** True when the linked employee's work email was updated alongside. */
  employeeWorkEmailUpdated: boolean;
}

/**
 * What became of the email a request tried to send.
 *
 * Carried in the response so the screen can say what happened rather than
 * assuming. `unconfirmed` is the honest answer for a server whose mail
 * transport accepted the message without delivering it - the console provider
 * does exactly that - and reporting it as a success is what let a silently
 * unconfigured relay look like a working one.
 */
export const EMAIL_DELIVERY_STATUSES = [
  'skipped',
  'delivered',
  'unconfirmed',
  'failed',
] as const;
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];

/** What `POST /users/:id/send-reset` reports back. */
export interface PasswordResetSendResult {
  /** True when a reset token was created and handed to the mail transport. */
  sent: boolean;
  delivery: EmailDeliveryStatus;
  /**
   * A short technical code when the transport failed - `EAUTH`, `ETIMEDOUT`
   * and so on. Never a host, a username, a credential or a relay's own text,
   * so it is safe to put in front of an administrator.
   */
  errorCode?: string;
}

/**
 * Setting somebody else's password, for handing over in person.
 *
 * The deliberate exception to "this module never handles a password", and the
 * shape encodes why it is survivable: whatever is set here is temporary. The
 * route writes `mustChangePassword` with it, so the value below stops working
 * the first time the person signs in and chooses their own.
 */
export const userSetPasswordSchema = z.object({
  /**
   * Omit it and the server generates a passphrase.
   *
   * Generating is the better path and the form offers it first: a passphrase
   * from the CSPRNG is stronger than what an administrator in a hurry types,
   * and - more to the point - it is not a password that person already uses
   * somewhere else. A typed value is still allowed, held to the same
   * `passwordSchema` as every other password in the system, because an
   * administrator sitting beside a new joiner sometimes needs to agree on
   * something out loud.
   */
  password: passwordSchema.optional(),
  /**
   * The administrator has read what this does.
   *
   * Required by the API and not only by the form, exactly as on the email
   * change: this ends every session the person has, kills their unused reset
   * links, and puts a working password in somebody else's hands. A mis-click
   * must not be enough.
   */
  acknowledged: z.literal(true, {
    errorMap: () => ({
      message: 'Confirm that you understand you will be able to see and use this password.',
    }),
  }),
});
export type UserSetPasswordInput = z.infer<typeof userSetPasswordSchema>;

/**
 * What `POST /users/:id/set-password` reports back.
 *
 * `password` is the ONE place in this system a password crosses the wire
 * outwards, and it is returned exactly once, in the response to the request
 * that set it. It is not stored in the audit trail, not readable from any GET,
 * and not recoverable afterwards: an administrator who loses it sets another.
 */
export interface UserSetPasswordResult {
  password: string;
  /** False when the administrator supplied the password themselves. */
  generated: boolean;
  /** Always true. The person must choose their own at next sign-in. */
  mustChangePassword: boolean;
  /** Sessions ended by the change - anyone signed in as them is now out. */
  revokedSessions: number;
  /** Unused reset links retired, so an older emailed link cannot outlive this. */
  retiredResetTokens: number;
  /** `ACTIVE` after the call. An INVITED account is activated by it. */
  status: UserStatus;
  /** True when this call is what activated a still-INVITED account. */
  activated: boolean;
}

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
    /**
     * The HR record's own address, which is not the sign-in address and may
     * legitimately differ from it. Carried here so the change-email dialog can
     * show what it is about to overwrite rather than asking blind.
     */
    workEmail: string | null;
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
