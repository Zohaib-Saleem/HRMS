import type { DataScope, Permission } from './permissions.js';

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  avatarColor: string;
  roles: Array<{ id: string; key: string; name: string }>;
  employee: {
    id: string;
    employeeNumber: string;
    jobTitle: string | null;
    departmentName: string | null;
    teamName: string | null;
    /** The employee's own avatar, or null for initials. */
    photoUrl: string | null;
  } | null;
}

export interface SessionCompany {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  dateFormat: string;
  weekStartsOn: string;
}

/** Payload of GET /api/v1/me - everything the shell needs to render. */
export interface SessionContext {
  user: SessionUser;
  company: SessionCompany;
  permissions: Permission[];
  /**
   * The caller's widest data scope. The shell needs it to decide WHICH
   * dashboard to render: permissions say what you may do, scope says over how
   * many people, and "my own figures" versus "the company's figures" is a
   * scope question. Authorisation is still enforced server-side - this only
   * saves the client from requesting a page it would be refused.
   */
  dataScope: DataScope;
  /** False when the login has no employee record, so personal data is unavailable. */
  employeeLinked: boolean;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string | null;
  ipAddress: string | null;
  createdAt: string;
  actor: { id: string; fullName: string; email: string } | null;
}
