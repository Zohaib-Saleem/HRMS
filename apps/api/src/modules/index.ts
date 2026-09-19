import type { FastifyPluginAsync } from 'fastify';
import { authRoutes } from '../auth/auth.routes.js';
import { meRoutes } from './me/me.routes.js';
import { companyRoutes } from './company/company.routes.js';
import { companyLinkRoutes } from './company/company-links.routes.js';
import { rolesRoutes } from './roles/roles.routes.js';
import { userRoutes } from './users/users.routes.js';
import { auditRoutes } from './audit/audit.routes.js';
import { docsRoutes } from './docs/docs.routes.js';
import { departmentRoutes } from './organisation/departments.routes.js';
import { teamRoutes } from './organisation/teams.routes.js';
import { designationRoutes } from './organisation/designations.routes.js';
import { locationRoutes } from './organisation/locations.routes.js';
import { employeeRoutes } from './employees/employees.routes.js';
import { employeePhotoRoutes } from './employees/employee-photo.routes.js';
import { approvalRoutes } from './approvals/approvals.routes.js';
import { notificationRoutes } from './notifications/notifications.routes.js';
import {
  attendanceDeviceRoutes,
  attendancePunchRoutes,
} from './attendance-device/devices.routes.js';
import { deviceMappingRoutes } from './attendance-device/mappings.routes.js';
import { attendancePolicyRoutes } from './time/attendance-policies.routes.js';
import { attendanceRoutes } from './time/attendance.routes.js';
import { attendanceAdminRoutes } from './time/attendance-admin.routes.js';
import { attendanceReportRoutes } from './time/attendance-reports.routes.js';
import { attendanceAnalyticsRoutes } from './time/attendance-analytics.routes.js';
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
import { salaryRevisionRoutes } from './payroll/salary-revisions.routes.js';
import { contractRoutes } from './employment/contracts.routes.js';
import { policyAssignmentRoutes, policyRoutes } from './employment/policies.routes.js';
import { loanRoutes } from './loans/loans.routes.js';
import { loanEligibilityRoutes, loanPolicyRoutes } from './loans/loan-policy.routes.js';
import { medicalRoutes } from './medical/medical.routes.js';
import { medicalPolicyRoutes } from './medical/medical-policy.routes.js';
import { medicalClaimRoutes } from './medical/medical-claims.routes.js';
import { reportRoutes } from './reports/reports.routes.js';
import { caseRoutes } from './cases/cases.routes.js';
import { caseDeskRoutes } from './cases/case-desk.routes.js';
import { caseCatalogueRoutes } from './cases/case-catalogue.routes.js';
import { caseAttachmentRoutes } from './cases/case-attachments.routes.js';
import { lunchOrderRoutes } from './lunch/lunch-orders.routes.js';
import { lunchDeskRoutes } from './lunch/lunch-desk.routes.js';
import { lunchMenuRoutes } from './lunch/lunch-menu.routes.js';
import { jobOpeningRoutes } from './recruitment/job-openings.routes.js';
import { candidateRoutes } from './recruitment/candidates.routes.js';
import { candidateDocumentRoutes } from './recruitment/candidate-documents.routes.js';
import { interviewRoutes } from './recruitment/interviews.routes.js';
import { evaluationRoutes } from './recruitment/evaluations.routes.js';
import { offerRoutes } from './recruitment/offers.routes.js';
import { conversionRoutes } from './recruitment/conversion.routes.js';
import { recruitmentDashboardRoutes } from './recruitment/recruitment-dashboard.routes.js';
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
  { prefix: '/company/links', plugin: companyLinkRoutes },
  { prefix: '/roles', plugin: rolesRoutes },
  { prefix: '/users', plugin: userRoutes },
  { prefix: '/audit-logs', plugin: auditRoutes },
  { prefix: '/docs', plugin: docsRoutes },

  // --- phase 2: organisation and people ---------------------------------
  { prefix: '/departments', plugin: departmentRoutes },
  { prefix: '/teams', plugin: teamRoutes },
  { prefix: '/designations', plugin: designationRoutes },
  { prefix: '/locations', plugin: locationRoutes },
  { prefix: '/employees', plugin: employeeRoutes },
  // A separate plugin on the same prefix, because it needs a different gate:
  // the routes above all require `employee.read`, and an employee who holds no
  // such grant may still manage the photo on their own record.
  { prefix: '/employees', plugin: employeePhotoRoutes },

  // --- phase 3: approvals, notifications and the time foundation ---------
  { prefix: '/approvals', plugin: approvalRoutes },
  { prefix: '/notifications', plugin: notificationRoutes },
  { prefix: '/attendance', plugin: attendanceRoutes },
  // The administrative side of the module: search, one-day detail, correction
  // and the adjustment ledger. Same prefix, separate plugin, so the
  // self-service routes stay readable.
  { prefix: '/attendance', plugin: attendanceAdminRoutes },
  { prefix: '/attendance/reports', plugin: attendanceReportRoutes },
  { prefix: '/attendance/analytics', plugin: attendanceAnalyticsRoutes },
  { prefix: '/attendance/mappings', plugin: deviceMappingRoutes },
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

  // --- phase 10: contracts, policies, salary revisions and loans ---------
  { prefix: '/contracts', plugin: contractRoutes },
  { prefix: '/policies', plugin: policyRoutes },
  { prefix: '/policy-assignments', plugin: policyAssignmentRoutes },
  { prefix: '/payroll/salary-revisions', plugin: salaryRevisionRoutes },
  { prefix: '/loans', plugin: loanRoutes },
  // Both sit on the /loans prefix and both are static segments, so Fastify
  // matches them ahead of `/loans/:id` regardless of registration order.
  { prefix: '/loans/policy', plugin: loanPolicyRoutes },
  { prefix: '/loans', plugin: loanEligibilityRoutes },

  // --- phase 11: medical benefit ----------------------------------------
  // The policy is company configuration and the benefit is somebody's own
  // record, so they are separate plugins on separate permissions. Both are
  // static segments under /medical, so Fastify matches them unambiguously.
  { prefix: '/medical/policy', plugin: medicalPolicyRoutes },
  // Registered ahead of the bare /medical plugin so the static `claims` segment
  // is unambiguous, the same way /loans/policy sits ahead of /loans.
  { prefix: '/medical/claims', plugin: medicalClaimRoutes },
  { prefix: '/medical', plugin: medicalRoutes },
  { prefix: '/reports', plugin: reportRoutes },

  // --- phase 12: cases (the helpdesk) -----------------------------------
  // Four plugins on one prefix, split by what they are rather than by where
  // they sit. The employee's routes narrow every query to the caller's own
  // employee id; the desk's narrow to the queues that caller may work; the
  // catalogue is administration of the routing itself. Keeping them apart is
  // what stops one set of handlers growing a `view=all` parameter.
  //
  // The attachment routes are separate for a mechanical reason as well, the
  // same one the employee photo has: they register raw-body content-type
  // parsers, which are scoped to the plugin that adds them, so keeping them
  // here leaves the routes next door as plain JSON routes.
  { prefix: '/cases', plugin: caseRoutes },
  { prefix: '/cases', plugin: caseDeskRoutes },
  { prefix: '/cases', plugin: caseCatalogueRoutes },
  { prefix: '/cases', plugin: caseAttachmentRoutes },

  // --- phase 13: lunch --------------------------------------------------
  // Three plugins, split by who is holding the screen rather than by where
  // they sit. The employee's routes narrow every query to the caller's own
  // employee id; the desk's narrow to a company and a DAY, because a day's
  // collection is what the office boy is actually holding; the menu is
  // configuration of what may be ordered at all.
  //
  // Deliberately NOT registered anywhere near payroll, and it shares nothing
  // with it: lunch is settled in cash with the office boy on the day, so there
  // is no deduction, no finance approval and no reconciliation step in any of
  // these three.
  //
  // `/lunch/desk` and `/lunch/menu-items` are static segments and are
  // registered ahead of the bare `/lunch` plugin the same way `/loans/policy`
  // sits ahead of `/loans`, so Fastify matches them unambiguously.
  { prefix: '/lunch/desk', plugin: lunchDeskRoutes },
  { prefix: '/lunch/menu-items', plugin: lunchMenuRoutes },
  { prefix: '/lunch', plugin: lunchOrderRoutes },

  // --- phase 14: recruitment --------------------------------------------
  // Eight plugins under /recruitment, split by the GRANT each one needs rather
  // than by where it sits. That is the point of the split: the job openings
  // need `recruitment.read`, the candidates need `candidate.read`, the
  // interviews need `interview.read` and the conversion needs
  // `recruitment.convert.employee` - so an interviewer who can open the
  // calendar cannot open the candidate list, and each plugin's preHandler says
  // exactly which people it is for.
  //
  // The static segments are registered ahead of the parameterised ones, the
  // same way `/loans/policy` sits ahead of `/loans`, so Fastify matches
  // `/recruitment/candidates/board` unambiguously.
  //
  // The document routes are separate for the mechanical reason the case
  // attachments and the employee photo are: they register raw-body
  // content-type parsers, which are scoped to the plugin that adds them, so
  // keeping them apart leaves the routes next door as plain JSON routes.
  //
  // Deliberately NOT registered anywhere near payroll, and sharing nothing
  // with it: an offer's salary is a number on an offer, it creates no salary
  // row, and converting a candidate writes one employee record and stops.
  { prefix: '/recruitment/dashboard', plugin: recruitmentDashboardRoutes },
  { prefix: '/recruitment/job-openings', plugin: jobOpeningRoutes },
  { prefix: '/recruitment/candidates', plugin: candidateRoutes },
  { prefix: '/recruitment/candidates', plugin: candidateDocumentRoutes },
  { prefix: '/recruitment/candidates', plugin: conversionRoutes },
  { prefix: '/recruitment/interviews', plugin: interviewRoutes },
  { prefix: '/recruitment/interviews', plugin: evaluationRoutes },
  { prefix: '/recruitment/offers', plugin: offerRoutes },

  // --- phase 5+ ---------------------------------------------------------
  // { prefix: '/documents', plugin: documentRoutes },
];

export const registerModules: FastifyPluginAsync = async (app) => {
  for (const { prefix, plugin } of modules) {
    await app.register(plugin, { prefix });
  }
};
