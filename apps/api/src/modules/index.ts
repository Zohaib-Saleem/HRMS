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
import { teamManagerRoutes } from './organisation/team-managers.routes.js';
import { orgHierarchyRoutes } from './organisation/org-hierarchy.routes.js';
import { designationRoutes } from './organisation/designations.routes.js';
import { locationRoutes } from './organisation/locations.routes.js';
import { employeeRoutes } from './employees/employees.routes.js';
import { employeePhotoRoutes } from './employees/employee-photo.routes.js';
import { approvalRoutes } from './approvals/approvals.routes.js';
import { approvalWorkflowRoutes } from './approvals/approval-workflows.routes.js';
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
import { assetRoutes } from './assets/assets.routes.js';
import { assetCategoryRoutes } from './assets/asset-categories.routes.js';
import { assetLifecycleRoutes } from './assets/asset-lifecycle.routes.js';
import { assetSelfRoutes } from './assets/asset-self.routes.js';
import { assetDocumentRoutes } from './assets/asset-documents.routes.js';
import { assetEmployeeRoutes } from './assets/asset-employees.routes.js';
import { assetEmployeeLookupRoutes } from './assets/asset-employee-lookup.routes.js';
import { assetRequestRoutes } from './assets/asset-requests.routes.js';
import { assetDashboardRoutes } from './assets/asset-dashboard.routes.js';
import { assetReportRoutes } from './assets/asset-reports.routes.js';
import { assetIssueRoutes } from './assets/asset-issues.routes.js';
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
  // A separate plugin on the same prefix, for the reason the employee photo
  // routes are: the roster's GET needs `team.read` and its writes need
  // `team.manage`, which is a different gate from the one `teamRoutes` sets.
  { prefix: '/teams', plugin: teamManagerRoutes },
  { prefix: '/organisation', plugin: orgHierarchyRoutes },
  { prefix: '/designations', plugin: designationRoutes },
  { prefix: '/locations', plugin: locationRoutes },
  { prefix: '/employees', plugin: employeeRoutes },
  // A separate plugin on the same prefix, because it needs a different gate:
  // the routes above all require `employee.read`, and an employee who holds no
  // such grant may still manage the photo on their own record.
  { prefix: '/employees', plugin: employeePhotoRoutes },

  // --- phase 3: approvals, notifications and the time foundation ---------
  // Registered BEFORE `/approvals`, because `/approvals/hierarchy` is a static
  // segment that must not be swallowed by `/approvals/:id`.
  { prefix: '/approvals/hierarchy', plugin: approvalWorkflowRoutes },
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

  // --- phase 15: assets -------------------------------------------------
  // Two plugins, split by what they ARE rather than by where they sit: the
  // register is the company's equipment, and the catalogue is configuration of
  // what kinds of equipment exist at all. Both open on `asset.read`, because
  // the create form on the register is built from the catalogue - and the
  // writes inside each carry their own grant, so somebody who may record a
  // laptop cannot invent the category to file it under.
  //
  // `/assets/categories` is a static segment and is matched ahead of
  // `/assets/:id` regardless of registration order, the same way
  // `/loans/policy` sits ahead of `/loans`. `/assets/summary` is static for the
  // same reason.
  //
  // Deliberately NOT registered anywhere near payroll, and sharing nothing with
  // it: an asset's purchase price is a number on an asset. Issuing somebody a
  // laptop creates no salary row, no deduction and no payroll input of any kind.
  //
  // Step 2 adds four more plugins on the same two prefixes, split by the GRANT
  // each one needs rather than by where it sits:
  //
  //   - the LIFECYCLE plugin carries assign, return, transfer, repair, lost,
  //     damaged, retire and dispose, each on its own permission. They are
  //     together because the invariant between them - one active assignment per
  //     asset - has to be readable in one place;
  //   - the SELF plugin is the employee's own: what they have been issued, and
  //     the two things they may say about it. Every query in it is bound to the
  //     caller's own employee record, resolved from the session, so there is no
  //     employee id in any of its paths to get wrong;
  //   - the DOCUMENT plugin is separate for the mechanical reason the case
  //     attachments and candidate documents are: it registers raw-body
  //     content-type parsers, which are scoped to the plugin that adds them;
  //   - the EMPLOYEE plugin sits on `/employees` and answers "what has this
  //     person got". The URL belongs to the person and the code belongs to the
  //     module that owns the tables, which is the right way round: an assets
  //     query inside the employees module would be a second place that knows
  //     how an assignment is shaped.
  //
  // Step 3 adds two more on the same prefix, and they are separate from the
  // register for the same reason the rest are: each needs a different grant.
  //
  //   - the DASHBOARD plugin opens on `asset.read.ALL` rather than on
  //     `asset.read`, and it is the only read in the module that does. There is
  //     no honest narrow version of it - "total assets: 1, no warranties
  //     expiring" is not a smaller dashboard, it is a misleading one - and the
  //     employee's own view of their kit is `/assets/my`, which answers the
  //     question they actually have;
  //   - the REPORT plugin needs `asset.read` AND `asset.report`, and it still
  //     applies the same data-scope narrowing the list screen does. A reporting
  //     grant is permission to EXPORT what you can already see, never
  //     permission to see more.
  //
  //   - the EMPLOYEE LOOKUP plugin needs any one of `asset.assign`,
  //     `asset.transfer` or `asset.dispose`, and deliberately NOT
  //     `employee.read`. It is the six fields it takes to pick the person you
  //     are handing a laptop to, and it exists so that running the register
  //     does not require the grant that opens the HR screens. See the file.
  //
  // `/assets/my`, `/assets/assignments/...`, `/assets/dashboard`,
  // `/assets/employee-lookup` and `/assets/reports/...` are static segments and
  // are matched ahead of `/assets/:id` regardless of registration order.
  { prefix: '/assets/categories', plugin: assetCategoryRoutes },
  { prefix: '/assets', plugin: assetEmployeeLookupRoutes },
  // Its own prefix rather than a route under `/assets`: an asset request is
  // not an asset, and nothing in this plugin reads the register's gates.
  { prefix: '/asset-requests', plugin: assetRequestRoutes },
  { prefix: '/assets', plugin: assetDashboardRoutes },
  { prefix: '/assets', plugin: assetReportRoutes },
  { prefix: '/assets', plugin: assetSelfRoutes },
  // `/assets/issues` - employee reports, as the queue the asset manager works.
  { prefix: '/assets', plugin: assetIssueRoutes },
  { prefix: '/assets', plugin: assetLifecycleRoutes },
  { prefix: '/assets', plugin: assetDocumentRoutes },
  { prefix: '/assets', plugin: assetRoutes },
  { prefix: '/employees', plugin: assetEmployeeRoutes },

  // --- phase 5+ ---------------------------------------------------------
  // { prefix: '/documents', plugin: documentRoutes },
];

export const registerModules: FastifyPluginAsync = async (app) => {
  for (const { prefix, plugin } of modules) {
    await app.register(plugin, { prefix });
  }
};
