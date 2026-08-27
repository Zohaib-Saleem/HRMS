import type { FastifyPluginAsync } from 'fastify';
import { authRoutes } from '../auth/auth.routes.js';
import { meRoutes } from './me/me.routes.js';
import { companyRoutes } from './company/company.routes.js';
import { rolesRoutes } from './roles/roles.routes.js';
import { auditRoutes } from './audit/audit.routes.js';

/**
 * Module registry.
 *
 * This is the extension point: a new HRMS module (employees, attendance,
 * leave, payroll...) becomes one folder under `modules/` and one line here.
 * Nothing else in the application needs to change.
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

  // --- phase 2+ ---------------------------------------------------------
  // { prefix: '/employees',  plugin: employeeRoutes },
  // { prefix: '/attendance', plugin: attendanceRoutes },
  // { prefix: '/leave',      plugin: leaveRoutes },
];

export const registerModules: FastifyPluginAsync = async (app) => {
  for (const { prefix, plugin } of modules) {
    await app.register(plugin, { prefix });
  }
};
