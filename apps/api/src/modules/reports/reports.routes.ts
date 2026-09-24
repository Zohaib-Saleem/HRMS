import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import ExcelJS from 'exceljs';
import {
  EMPLOYEE_MASTER_COLUMNS,
  EMPLOYMENT_STATUS_LABELS,
  PERMISSIONS,
  employeeMasterQuerySchema,
  type EmployeeMasterReport,
  type EmploymentStatus,
  type EmployeeMasterRow,
  type Permission,
} from '@hrms/shared';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import {
  allowedColumns,
  buildEmployeeMasterExport,
  buildEmployeeMasterReport,
} from './employee-master.service.js';

/**
 * Reports.
 *
 * Read-only: there is no mutating route in this module and there is not meant
 * to be one. Every figure comes from the service that owns it; this file
 * decides only what shape it leaves in.
 *
 * The whole module sits behind `employee.read`, and each block within a row is
 * gated again on its own module's permission inside the service, so a caller
 * who may read employees but not pay gets rows without a salary rather than a
 * refusal.
 */

/**
 * The columns an export may contain.
 *
 * Two filters, and both matter. The caller's own permissions decide what could
 * ever be filled - a reader without `payroll.read` cannot export a salary
 * column by asking for it in the query string. Their current selection then
 * decides what actually is, so an export matches the table they are looking at.
 */
function exportColumns(auth: ReturnType<typeof requireAuthContext>, requested?: string) {
  const permitted = new Set(allowedColumns(auth));
  const asked = requested
    ? new Set(requested.split(',').map((c) => c.trim()).filter(Boolean))
    : null;

  return EMPLOYEE_MASTER_COLUMNS.filter(
    (c) => permitted.has(c.key) && (asked === null || asked.has(c.key)),
  );
}

/** The value a column shows, flattened for a spreadsheet cell. */
function cellValue(row: EmployeeMasterRow, key: string): string | number | null {
  switch (key) {
    case 'punchCodes': return row.punchCodes?.join(' / ') ?? null;
    // The label, so the spreadsheet reads "Probation" rather than "PROBATION".
    case 'employmentStatus':
      return row.employmentStatus
        ? (EMPLOYMENT_STATUS_LABELS[row.employmentStatus as EmploymentStatus] ?? row.employmentStatus)
        : null;
    case 'contract':
      return row.contract
        ? [row.contract.type, row.contract.startDate, row.contract.endDate].filter(Boolean).join(' · ')
        : null;
    case 'salaryAmount': return row.salary?.amount ?? null;
    case 'salaryEffectiveFrom': return row.salary?.effectiveFrom ?? null;
    case 'salaryRevisionCount': return row.salary?.revisionCount ?? null;
    case 'lastRevisionDate': return row.salary?.lastRevisionDate ?? null;
    case 'lastRevisionAmount': return row.salary?.lastRevisionAmount ?? null;
    case 'nextIncrementDueDate': return row.salary?.nextIncrementDueDate ?? null;
    case 'leaveEntitlement': return row.leave?.entitlementDays ?? null;
    case 'leaveUsed': return row.leave?.usedDays ?? null;
    case 'leaveConsumed': return row.leave?.consumedDays ?? null;
    case 'leaveAdjusted': return row.leave?.adjustedDays ?? null;
    case 'leaveRemaining': return row.leave?.availableDays ?? null;
    case 'leavePending': return row.leave?.pendingDays ?? null;
    case 'leaveByType':
      return row.leave?.byType.map((t) => `${t.code ?? t.name}: ${t.availableDays}`).join(' / ') ?? null;
    case 'leaveRequestCount': return row.leave?.requestCount ?? null;
    case 'leavePendingCount': return row.leave?.pendingCount ?? null;
    case 'leaveApprovedCount': return row.leave?.approvedCount ?? null;
    case 'leaveRejectedCount': return row.leave?.rejectedCount ?? null;
    case 'hasActiveLoan': return row.loans ? (row.loans.hasActiveLoan ? 'Yes' : 'No') : null;
    case 'loanStatuses': return row.loans?.statuses.join(' / ') || null;
    case 'loanCount': return row.loans?.count ?? null;
    case 'loanPrincipal': return row.loans?.principalTotal ?? null;
    case 'loanPaid': return row.loans?.paidTotal ?? null;
    case 'loanOutstanding': return row.loans?.outstandingTotal ?? null;
    case 'loanMonthly': return row.loans?.monthlyDeduction ?? null;
    case 'loanRemainingInstallments': return row.loans?.remainingInstallments ?? null;
    case 'loanNextDueMonth': return row.loans?.nextDueMonth ?? null;
    case 'attPresent': return row.attendance?.present ?? null;
    case 'attAbsent': return row.attendance?.absent ?? null;
    case 'attLate': return row.attendance?.late ?? null;
    case 'attHalfDay': return row.attendance?.halfDay ?? null;
    case 'attOnLeave': return row.attendance?.onLeave ?? null;
    case 'attHoliday': return row.attendance?.holiday ?? null;
    case 'attWeekend': return row.attendance?.weekend ?? null;
    case 'attWorkedHours': return row.attendance?.workedHours ?? null;
    case 'attOvertimeHours': return row.attendance?.overtimeHours ?? null;
    case 'attPercentage': return row.attendance?.attendancePercentage ?? null;
    default: {
      const value = (row as unknown as Record<string, unknown>)[key];
      if (value === null || value === undefined) return null;
      if (typeof value === 'number' || typeof value === 'string') return value;
      return String(value);
    }
  }
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const filenameFor = (report: EmployeeMasterReport, extension: string) =>
  `employee-master-${report.from}-to-${report.to}.${extension}`;

export const reportRoutes: FastifyPluginAsync = async (app) => {
  // The master report is the consolidated HR view, so it needs its own grant
  // AS WELL AS `employee.read`: a manager or team manager reads the directory
  // for their own reporting line and does not, on that alone, get every
  // module's figure for those people on one sheet. Both gates sit on the whole
  // module, so the screen, the CSV and the workbook answer 403 together. Each
  // block inside a row is then gated separately, by the module that owns it.
  app.addHook(
    'preHandler',
    requirePermission(PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.EMPLOYEE_MASTER_REPORT_READ),
  );

  app.get('/employee-master', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(employeeMasterQuerySchema, request.query);
    const report = await buildEmployeeMasterReport(auth, query);
    return reply.send({ data: report });
  });

  app.get('/employee-master/export.csv', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(employeeMasterQuerySchema, request.query);
    const report = await buildEmployeeMasterExport(auth, query);
    const columns = exportColumns(auth, query.columns);

    await auditExport(auth, report, columns.length, 'csv', request);

    const lines = [
      columns.map((c) => csvCell(c.label)).join(','),
      ...report.rows.map((row) => columns.map((c) => csvCell(cellValue(row, c.key))).join(',')),
    ];

    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filenameFor(report, 'csv')}"`)
      // BOM so Excel opens UTF-8 names correctly, matching the other exports.
      .send(`﻿${lines.join('\n')}`);
  });

  app.get('/employee-master/export.xlsx', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(employeeMasterQuerySchema, request.query);
    const report = await buildEmployeeMasterExport(auth, query);
    const columns = exportColumns(auth, query.columns);

    await auditExport(auth, report, columns.length, 'xlsx', request);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'HRMS';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Employee Master');

    sheet.columns = columns.map((c) => ({
      header: c.label,
      key: c.key,
      width: Math.min(40, Math.max(12, c.label.length + 4)),
    }));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const row of report.rows) {
      sheet.addRow(Object.fromEntries(columns.map((c) => [c.key, cellValue(row, c.key)])));
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filenameFor(report, 'xlsx')}"`)
      .send(Buffer.from(buffer));
  });
};

/** An export leaves the building, so it is recorded like one. */
async function auditExport(
  auth: ReturnType<typeof requireAuthContext>,
  report: EmployeeMasterReport,
  columnCount: number,
  format: string,
  request: Parameters<typeof recordAudit>[0]['request'],
): Promise<void> {
  await recordAudit({
    companyId: auth.companyId,
    actorId: auth.userId,
    action: 'report.employee-master.export',
    entityType: 'EmployeeMasterReport',
    entityId: `${report.from}..${report.to}`,
    summary: `Exported the employee master report for ${report.from} to ${report.to} as ${format} (${report.rows.length} row(s), ${columnCount} column(s))`,
    request,
  });
}

/** Re-exported so a reader of this file can see the permission surface at a glance. */
export const REPORT_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.EMPLOYEE_READ,
  PERMISSIONS.EMPLOYEE_MASTER_REPORT_READ,
];
