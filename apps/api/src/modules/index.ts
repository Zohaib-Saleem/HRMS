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
import { approvalRoutes } from './approvals/approvals.routes.js';
import { notificationRoutes } from './notifications/notifications.routes.js';
import {
  attendanceDeviceRoutes,
  attendancePunchRoutes,
} from './attendance-device/devices.routes.js';
import { attendancePolicyRoutes } from './time/attendance-policies.routes.js';
import { attendanceRoutes } from './time/attendance.routes.js';
import { shiftRoutes } from './time/shifts.routes.js';
import { timesheetRoutes } from './time/timesheets.routes.js';
import { leaveTypeRoutes } from './leave/leave-types.routes.js';
import { leaveBalanceRoutes, leaveRequestRoutes } from './leave/leave-requests.routes.js';
import { holidayRoutes } from './leave/holidays.routes.js';
import {
  payrollProfileRoutes,
  payrollSalaryRoutes,
  payrollSettingsRoutes,
} from './payroll/payroll.routes.js';
import {
  employeeComponentRoutes,
  payrollAdjustmentRoutes,
  payrollPeriodRoutes,
  payrollRunRoutes,
  payslipRoutes,
  salaryComponentRoutes,
} from './payroll/payroll-runs.routes.js';
import {
  payrollDashboardRoutes,
  payrollReconciliationRoutes,
  payrollReportRoutes,
} from './payroll/payroll-reports.routes.js';

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

  // --- phase 3: approvals, notifications and the time foundation ---------
  { prefix: '/approvals', plugin: approvalRoutes },
  { prefix: '/notifications', plugin: notificationRoutes },
  { prefix: '/attendance', plugin: attendanceRoutes },
  { prefix: '/attendance-policies', plugin: attendancePolicyRoutes },
  { prefix: '/attendance/devices', plugin: attendanceDeviceRoutes },
  { prefix: '/attendance/punches', plugin: attendancePunchRoutes },
  { prefix: '/shifts', plugin: shiftRoutes },
  { prefix: '/timesheets', plugin: timesheetRoutes },

  // --- phase 4: leave and holidays --------------------------------------
  { prefix: '/leave-types', plugin: leaveTypeRoutes },
  { prefix: '/leave/requests', plugin: leaveRequestRoutes },
  { prefix: '/leave/balances', plugin: leaveBalanceRoutes },
  { prefix: '/holidays', plugin: holidayRoutes },

  // --- phase 9 ---
  { prefix: '/payroll/settings', plugin: payrollSettingsRoutes },
  { prefix: '/payroll/profiles', plugin: payrollProfileRoutes },
  { prefix: '/payroll/salaries', plugin: payrollSalaryRoutes },
  { prefix: '/payroll/components', plugin: salaryComponentRoutes },
  { prefix: '/payroll/employee-components', plugin: employeeComponentRoutes },
  { prefix: '/payroll/periods', plugin: payrollPeriodRoutes },
  { prefix: '/payroll/runs', plugin: payrollRunRoutes },
  { prefix: '/payroll/adjustments', plugin: payrollAdjustmentRoutes },
  { prefix: '/payroll/dashboard', plugin: payrollDashboardRoutes },
  { prefix: '/payroll/reports', plugin: payrollReportRoutes },
  { prefix: '/payroll/reconciliation', plugin: payrollReconciliationRoutes },
  { prefix: '/payslips', plugin: payslipRoutes },

  // --- phase 5+ ---------------------------------------------------------
  // { prefix: '/documents', plugin: documentRoutes },
];

export const registerModules: FastifyPluginAsync = async (app) => {
  for (const { prefix, plugin } of modules) {
    await app.register(plugin, { prefix });
  }
};
