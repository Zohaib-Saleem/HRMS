import type { FastifyPluginAsync } from 'fastify';
import { authRoutes } from '../auth/auth.routes.js';
import { meRoutes } from './me/me.routes.js';
import { companyRoutes } from './company/company.routes.js';
import { rolesRoutes } from './roles/roles.routes.js';
import { auditRoutes } from './audit/audit.routes.js';
import { departmentRoutes } from './organisation/departments.routes.js';
import { teamRoutes } from './organisation/teams.routes.js';
import { designationRoutes } from './organisation/designations.routes.js';
import { locationRoutes } from './organisation/locations.routes.js';
import { employeeRoutes } from './employees/employees.routes.js';

/**
 * Module registry.
 *
 * This is the extension point: a new HRMS module (attendance, leave, payroll...)
 * becomes one folder under `modules/` and one line here. Nothing else in the
 * application needs to change.
 */
interface ModuleDefinition {
  prefix: string;
  plugin: FastifyPluginAsync;
}

export const modules: ModuleDefinition[] = [
  { prefix: '/auth', plugin: authRoutes },
  { prefix: '/me', plugin: meRoutes },
  { prefix: '/company', plugin: companyRoutes },
  { prefix: '/roles', plugin: rolesRoutes },
  { prefix: '/audit-logs', plugin: auditRoutes },

  // --- phase 2: organisation and people ---------------------------------
  { prefix: '/departments', plugin: departmentRoutes },
  { prefix: '/teams', plugin: teamRoutes },
  { prefix: '/designations', plugin: designationRoutes },
  { prefix: '/locations', plugin: locationRoutes },
  { prefix: '/employees', plugin: employeeRoutes },

  // --- phase 3+ ---------------------------------------------------------
  // { prefix: '/approvals',  plugin: approvalRoutes },
  // { prefix: '/leave',      plugin: leaveRoutes },
  // { prefix: '/attendance', plugin: attendanceRoutes },
];

export const registerModules: FastifyPluginAsync = async (app) => {
  for (const { prefix, plugin } of modules) {
    await app.register(plugin, { prefix });
  }
};
