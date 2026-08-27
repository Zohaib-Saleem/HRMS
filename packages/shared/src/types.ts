import type { Permission } from './permissions.js';

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
