import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  payrollDashboardQuerySchema,
  payrollReportQuerySchema,
  type PayrollDashboard,
  type PayrollReportKey,
  type PayrollReportTable,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';

/**
 * Payroll reporting.
 *
 * Everything here reads `PayrollLine` and the itemised rows hanging off it -
 * that is, the figures a run actually produced, not a recalculation. A report
 * that recomputed anything could disagree with the payslip it claims to
 * summarise, and the payslip is the one somebody was paid from.
 *
 * The same data scope applies as everywhere else: a report is narrowed to the
 * employees the caller may see before a single figure is totalled, so an
 * aggregate cannot be used to infer a salary the caller could not read directly.
 */

const num = (value: Prisma.Decimal | number | null): number =>
  value === null ? 0 : Number(value);

const displayName = (e: {
  firstName: string;
  lastName: string;
  displayName: string | null;
}): string => e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

const round2 = (value: number): number => Math.round(value * 100) / 100;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sendCsv(reply: FastifyReply, filename: string, table: PayrollReportTable): FastifyReply {
  const lines = [
    table.columns.map((c) => c.label).join(','),
    ...table.rows.map((row) => table.columns.map((c) => csvCell(row[c.key])).join(',')),
  ];
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    // BOM so Excel opens UTF-8 names correctly, matching the employee export.
    .send(`﻿${lines.join('\r\n')}\r\n`);
}

/**
 * The lines a report is built from.
 *
 * Only finalized and approved runs by default: a draft calculation is working
 * material and reporting on it as though it were payroll would be misleading.
 */
async function reportLines(input: {
  companyId: string;
  scope: Prisma.EmployeeWhereInput;
  runId?: string;
  periodId?: string;
  departmentId?: string;
  locationId?: string;
  employeeId?: string;
  includeDraft?: boolean;
}) {
  const {
    companyId,
    scope,
    runId,
    periodId,
    departmentId,
    locationId,
    employeeId,
    includeDraft,
  } = input;

  const where: Prisma.PayrollLineWhereInput = {
    companyId,
    ...(runId ? { runId } : {}),
    ...(employeeId ? { employeeId } : {}),
    run: {
      ...(periodId ? { periodId } : {}),
      ...(includeDraft ? {} : { status: { in: ['APPROVED', 'FINALIZED'] } }),
    },
    employee: {
      AND: [
        scope,
        departmentId ? { departmentId } : {},
        locationId ? { locationId } : {},
      ],
    },
  };

  return prisma.payrollLine.findMany({
    where,
    include: {
      earnings: true,
      deductions: true,
      employee: {
        select: {
          firstName: true,
          lastName: true,
          displayName: true,
          employeeNumber: true,
          department: { select: { name: true } },
          location: { select: { name: true } },
          designation: { select: { name: true } },
        },
      },
      run: { include: { period: { select: { name: true, startDate: true, endDate: true } } } },
    },
    orderBy: [{ run: { createdAt: 'desc' } }, { employee: { employeeNumber: 'asc' } }],
  });
}

type ReportLine = Awaited<ReturnType<typeof reportLines>>[number];

/** Earnings that are neither basic pay nor overtime: allowances and bonuses. */
const allowanceRows = (line: ReportLine) =>
  line.earnings.filter((e) => e.kind !== 'BASIC' && e.kind !== 'OVERTIME');

const deductionRows = (line: ReportLine) => line.deductions;

// ------------------------------------------------------------------ dashboard

export const payrollDashboardRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.PAYROLL_READ));

  /**
   * The figures the payroll landing page shows.
   *
   * Built from one run - the latest for the chosen period, or the most recent
   * run overall - because "gross payroll" is only meaningful with respect to a
   * particular calculation. Summing several runs for the same month would
   * double-count a recalculated one.
   */
  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(payrollDashboardQuerySchema, request.query);

    const scope = await employeeScopeFilter(auth);
    if (scope === null) {
      const empty: PayrollDashboard = {
        period: null,
        run: null,
        currency: 'USD',
        totalEmployees: 0,
        employeesProcessed: 0,
        grossTotal: 0,
        deductionTotal: 0,
        netTotal: 0,
        overtimeCost: 0,
        overtimeHours: 0,
        allowanceTotal: 0,
        pendingApprovals: 0,
        exceptionCount: 0,
        blockingCount: 0,
        recentRuns: [],
      };
      return reply.send({ data: empty });
    }
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const company = await prisma.company.findUniqueOrThrow({
      where: { id: auth.companyId },
      select: { currency: true },
    });

    const run = await prisma.payrollRun.findFirst({
      where: {
        companyId: auth.companyId,
        ...(query.periodId ? { periodId: query.periodId } : {}),
        status: { not: 'CANCELLED' },
      },
      include: { period: true },
      orderBy: [{ createdAt: 'desc' }],
    });

    const lines = run
      ? await reportLines({
          companyId: auth.companyId,
          scope,
          runId: run.id,
          departmentId: query.departmentId,
          locationId: query.locationId,
          employeeId: query.employeeId,
          includeDraft: true,
        })
      : [];

    // Counted through the same scope and filters as the money, so "processed
    // out of total" compares like with like.
    const totalEmployees = await prisma.employee.count({
      where: {
        AND: [
          { companyId: auth.companyId },
          scope,
          query.departmentId ? { departmentId: query.departmentId } : {},
          query.locationId ? { locationId: query.locationId } : {},
          query.employeeId ? { id: query.employeeId } : {},
          { status: { not: 'TERMINATED' } },
        ],
      },
    });

    const pendingApprovals = await prisma.payrollRun.count({
      where: { companyId: auth.companyId, status: { in: ['REVIEW', 'APPROVED'] } },
    });

    const recent = await prisma.payrollRun.findMany({
      where: { companyId: auth.companyId },
      include: { period: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    const data: PayrollDashboard = {
      period: run
        ? {
            id: run.period.id,
            name: run.period.name,
            startDate: run.period.startDate.toISOString().slice(0, 10),
            endDate: run.period.endDate.toISOString().slice(0, 10),
            status: run.period.status,
          }
        : null,
      run: run ? { id: run.id, status: run.status } : null,
      currency: run?.currency ?? company.currency,
      totalEmployees,
      employeesProcessed: lines.length,
      grossTotal: round2(lines.reduce((s, l) => s + num(l.grossAmount), 0)),
      deductionTotal: round2(lines.reduce((s, l) => s + num(l.deductionsTotal), 0)),
      netTotal: round2(lines.reduce((s, l) => s + num(l.netAmount), 0)),
      overtimeCost: round2(lines.reduce((s, l) => s + num(l.overtimeAmount), 0)),
      overtimeHours: round2(lines.reduce((s, l) => s + l.approvedOvertimeMinutes, 0) / 60),
      allowanceTotal: round2(
        lines.reduce((s, l) => s + allowanceRows(l).reduce((a, e) => a + num(e.amount), 0), 0),
      ),
      pendingApprovals,
      exceptionCount: run?.exceptionCount ?? 0,
      blockingCount: run?.blockingCount ?? 0,
      recentRuns: recent.map((r) => ({
        id: r.id,
        periodName: r.period.name,
        status: r.status,
        netTotal: num(r.netTotal),
        employeeCount: r.employeeCount,
        createdAt: r.createdAt.toISOString(),
      })),
    };

    return reply.send({ data });
  });
};

// -------------------------------------------------------------------- reports

const REPORT_KEYS = [
  'summary',
  'department',
  'employee',
  'overtime',
  'allowance',
  'deduction',
  'attendance',
  'payslip',
] as const;

function buildReport(key: PayrollReportKey, lines: ReportLine[]): PayrollReportTable {
  switch (key) {
    case 'department': {
      interface DeptTotals {
        employees: number;
        gross: number;
        allowances: number;
        overtime: number;
        deductions: number;
        net: number;
      }
      const groups = new Map<string, DeptTotals>();
      for (const line of lines) {
        const name = line.employee.department?.name ?? 'Unassigned';
        const row: DeptTotals = groups.get(name) ?? {
          employees: 0,
          gross: 0,
          allowances: 0,
          overtime: 0,
          deductions: 0,
          net: 0,
        };
        row.employees += 1;
        row.gross += num(line.grossAmount);
        row.allowances += allowanceRows(line).reduce((s, e) => s + num(e.amount), 0);
        row.overtime += num(line.overtimeAmount);
        row.deductions += num(line.deductionsTotal);
        row.net += num(line.netAmount);
        groups.set(name, row);
      }
      return {
        key,
        title: 'Department payroll',
        columns: [
          { key: 'department', label: 'Department' },
          { key: 'employees', label: 'Employees', align: 'right' },
          { key: 'gross', label: 'Gross', align: 'right', money: true },
          { key: 'allowances', label: 'Allowances', align: 'right', money: true },
          { key: 'overtime', label: 'Overtime', align: 'right', money: true },
          { key: 'deductions', label: 'Deductions', align: 'right', money: true },
          { key: 'net', label: 'Net', align: 'right', money: true },
        ],
        rows: [...groups.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([department, row]) => ({
            department,
            employees: row.employees,
            gross: round2(row.gross),
            allowances: round2(row.allowances),
            overtime: round2(row.overtime),
            deductions: round2(row.deductions),
            net: round2(row.net),
          })),
      };
    }

    case 'overtime':
      return {
        key,
        title: 'Overtime cost',
        columns: [
          { key: 'employee', label: 'Employee' },
          { key: 'department', label: 'Department' },
          { key: 'period', label: 'Period' },
          { key: 'recordedHours', label: 'Recorded hours', align: 'right' },
          { key: 'approvedHours', label: 'Approved hours', align: 'right' },
          { key: 'hourlyRate', label: 'Hourly rate', align: 'right', money: true },
          { key: 'cost', label: 'Cost', align: 'right', money: true },
        ],
        rows: lines
          .filter((l) => l.overtimeMinutes > 0 || num(l.overtimeAmount) > 0)
          .map((line) => ({
            employee: displayName(line.employee),
            department: line.employee.department?.name ?? '--',
            period: line.run.period.name,
            recordedHours: round2(line.overtimeMinutes / 60),
            approvedHours: round2(line.approvedOvertimeMinutes / 60),
            hourlyRate: num(line.hourlyRate),
            cost: num(line.overtimeAmount),
          })),
      };

    case 'allowance': {
      const rows: Array<Record<string, string | number>> = [];
      for (const line of lines) {
        for (const earning of allowanceRows(line)) {
          rows.push({
            employee: displayName(line.employee),
            department: line.employee.department?.name ?? '--',
            period: line.run.period.name,
            component: earning.label,
            basis: earning.calc,
            rate: earning.rate === null ? '' : num(earning.rate),
            amount: num(earning.amount),
          });
        }
      }
      return {
        key,
        title: 'Allowances and bonuses',
        columns: [
          { key: 'employee', label: 'Employee' },
          { key: 'department', label: 'Department' },
          { key: 'period', label: 'Period' },
          { key: 'component', label: 'Component' },
          { key: 'basis', label: 'Basis' },
          { key: 'rate', label: 'Rate', align: 'right' },
          { key: 'amount', label: 'Amount', align: 'right', money: true },
        ],
        rows,
      };
    }

    case 'deduction': {
      const rows: Array<Record<string, string | number>> = [];
      for (const line of lines) {
        for (const deduction of deductionRows(line)) {
          rows.push({
            employee: displayName(line.employee),
            department: line.employee.department?.name ?? '--',
            period: line.run.period.name,
            component: deduction.label,
            kind: deduction.kind,
            units: deduction.units === null ? '' : num(deduction.units),
            amount: num(deduction.amount),
          });
        }
      }
      return {
        key,
        title: 'Deductions',
        columns: [
          { key: 'employee', label: 'Employee' },
          { key: 'department', label: 'Department' },
          { key: 'period', label: 'Period' },
          { key: 'component', label: 'Deduction' },
          { key: 'kind', label: 'Type' },
          { key: 'units', label: 'Units', align: 'right' },
          { key: 'amount', label: 'Amount', align: 'right', money: true },
        ],
        rows,
      };
    }

    case 'attendance':
      // The reconciliation view: attendance on the left, what it cost on the
      // right, so "why did my salary change" is answerable from one row.
      return {
        key,
        title: 'Attendance vs payroll',
        columns: [
          { key: 'employee', label: 'Employee' },
          { key: 'period', label: 'Period' },
          { key: 'scheduled', label: 'Scheduled', align: 'right' },
          { key: 'present', label: 'Present', align: 'right' },
          { key: 'paidLeave', label: 'Paid leave', align: 'right' },
          { key: 'unpaidLeave', label: 'Unpaid leave', align: 'right' },
          { key: 'absent', label: 'Absent', align: 'right' },
          { key: 'payableDays', label: 'Payable days', align: 'right' },
          { key: 'unpaidDays', label: 'Unpaid days', align: 'right' },
          { key: 'dailyRate', label: 'Daily rate', align: 'right', money: true },
          { key: 'absenceDeduction', label: 'Absence deduction', align: 'right', money: true },
          { key: 'net', label: 'Net', align: 'right', money: true },
        ],
        rows: lines.map((line) => ({
          employee: displayName(line.employee),
          period: line.run.period.name,
          scheduled: num(line.scheduledDays),
          present: num(line.presentDays),
          paidLeave: num(line.paidLeaveDays),
          unpaidLeave: num(line.unpaidLeaveDays),
          absent: num(line.absentDays),
          payableDays: num(line.payableDays),
          unpaidDays: num(line.unpaidDays),
          dailyRate: num(line.dailyRate),
          absenceDeduction: round2(
            line.deductions
              .filter((d) => d.kind === 'ABSENCE' || d.kind === 'UNPAID_LEAVE')
              .reduce((s, d) => s + num(d.amount), 0),
          ),
          net: num(line.netAmount),
        })),
      };

    case 'payslip':
      return {
        key,
        title: 'Payslips issued',
        columns: [
          { key: 'employee', label: 'Employee' },
          { key: 'employeeNumber', label: 'Employee ID' },
          { key: 'department', label: 'Department' },
          { key: 'period', label: 'Period' },
          { key: 'gross', label: 'Gross', align: 'right', money: true },
          { key: 'deductions', label: 'Deductions', align: 'right', money: true },
          { key: 'net', label: 'Net', align: 'right', money: true },
          { key: 'status', label: 'Run status' },
        ],
        rows: lines.map((line) => ({
          employee: displayName(line.employee),
          employeeNumber: line.employee.employeeNumber,
          department: line.employee.department?.name ?? '--',
          period: line.run.period.name,
          gross: num(line.grossAmount),
          deductions: num(line.deductionsTotal),
          net: num(line.netAmount),
          status: line.run.status,
        })),
      };

    case 'employee':
      return {
        key,
        title: 'Employee payroll',
        columns: [
          { key: 'employee', label: 'Employee' },
          { key: 'employeeNumber', label: 'Employee ID' },
          { key: 'department', label: 'Department' },
          { key: 'designation', label: 'Designation' },
          { key: 'period', label: 'Period' },
          { key: 'salaryType', label: 'Salary type' },
          { key: 'basic', label: 'Basic', align: 'right', money: true },
          { key: 'allowances', label: 'Allowances', align: 'right', money: true },
          { key: 'overtime', label: 'Overtime', align: 'right', money: true },
          { key: 'gross', label: 'Gross', align: 'right', money: true },
          { key: 'deductions', label: 'Deductions', align: 'right', money: true },
          { key: 'net', label: 'Net', align: 'right', money: true },
        ],
        rows: lines.map((line) => ({
          employee: displayName(line.employee),
          employeeNumber: line.employee.employeeNumber,
          department: line.employee.department?.name ?? '--',
          designation: line.employee.designation?.name ?? '--',
          period: line.run.period.name,
          salaryType: line.salaryType,
          basic: num(line.basicAmount),
          allowances: round2(allowanceRows(line).reduce((s, e) => s + num(e.amount), 0)),
          overtime: num(line.overtimeAmount),
          gross: num(line.grossAmount),
          deductions: num(line.deductionsTotal),
          net: num(line.netAmount),
        })),
      };

    default: {
      // Summary: one row per run, which is the shape a finance team asks for.
      const groups = new Map<string, Record<string, string | number>>();
      for (const line of lines) {
        const key2 = line.runId;
        const row = groups.get(key2) ?? {
          period: line.run.period.name,
          status: line.run.status,
          employees: 0,
          basic: 0,
          allowances: 0,
          overtime: 0,
          gross: 0,
          deductions: 0,
          net: 0,
        };
        row.employees = (row.employees as number) + 1;
        row.basic = (row.basic as number) + num(line.basicAmount);
        row.allowances =
          (row.allowances as number) + allowanceRows(line).reduce((s, e) => s + num(e.amount), 0);
        row.overtime = (row.overtime as number) + num(line.overtimeAmount);
        row.gross = (row.gross as number) + num(line.grossAmount);
        row.deductions = (row.deductions as number) + num(line.deductionsTotal);
        row.net = (row.net as number) + num(line.netAmount);
        groups.set(key2, row);
      }
      return {
        key: 'summary',
        title: 'Payroll summary',
        columns: [
          { key: 'period', label: 'Pay period' },
          { key: 'status', label: 'Status' },
          { key: 'employees', label: 'Employees', align: 'right' },
          { key: 'basic', label: 'Basic', align: 'right', money: true },
          { key: 'allowances', label: 'Allowances', align: 'right', money: true },
          { key: 'overtime', label: 'Overtime', align: 'right', money: true },
          { key: 'gross', label: 'Gross', align: 'right', money: true },
          { key: 'deductions', label: 'Deductions', align: 'right', money: true },
          { key: 'net', label: 'Net', align: 'right', money: true },
        ],
        rows: [...groups.values()].map((row) => ({
          ...row,
          basic: round2(row.basic as number),
          allowances: round2(row.allowances as number),
          overtime: round2(row.overtime as number),
          gross: round2(row.gross as number),
          deductions: round2(row.deductions as number),
          net: round2(row.net as number),
        })),
      };
    }
  }
}

export const payrollReportRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.PAYROLL_READ));

  const load = async (request: FastifyRequest) => {
    const auth = requireAuthContext(request);
    const params = request.params as { key?: string };
    const key = (params.key ?? 'summary') as PayrollReportKey;
    if (!REPORT_KEYS.includes(key)) throw new NotFoundError('Report');

    const query = parseOrThrow(payrollReportQuerySchema, request.query);
    const scope = await employeeScopeFilter(auth);
    if (scope === null) {
      return { key, table: buildReport(key, []), query, empty: true as const };
    }
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const lines = await reportLines({
      companyId: auth.companyId,
      scope,
      runId: query.runId,
      periodId: query.periodId,
      departmentId: query.departmentId,
      locationId: query.locationId,
      employeeId: query.employeeId,
      includeDraft: query.includeDraft === 'true',
    });

    return { key, table: buildReport(key, lines), query, empty: false as const };
  };

  app.get('/:key', async (request, reply) => {
    const { table } = await load(request);
    return reply.send({ data: table });
  });

  app.get('/:key/export', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { key, table } = await load(request);

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'payroll.report.export',
      entityType: 'PayrollReport',
      entityId: key,
      summary: `Exported the ${table.title.toLowerCase()} report (${table.rows.length} row(s)) to CSV`,
      request,
    });

    return sendCsv(reply, `payroll-${key}.csv`, table);
  });
};

/**
 * Reconciliation for one employee in one run.
 *
 * The screen HR opens when somebody asks why their pay changed: the attendance
 * on one side, what it cost on the other, and the arithmetic between them shown
 * rather than asserted.
 */
export const payrollReconciliationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.PAYROLL_READ));

  app.get('/:lineId', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { lineId } = request.params as { lineId: string };
    if (!lineId) throw new ValidationError({ lineId: ['Choose a payroll line.'] });

    const line = await prisma.payrollLine.findFirst({
      where: { id: lineId, companyId: auth.companyId },
      include: {
        earnings: true,
        deductions: true,
        employee: {
          select: {
            firstName: true,
            lastName: true,
            displayName: true,
            employeeNumber: true,
            department: { select: { name: true } },
          },
        },
        run: { include: { period: true } },
      },
    });
    if (!line) throw new NotFoundError('Payroll line');
    await assertEmployeeInScope(auth, line.employeeId);

    return reply.send({
      data: {
        lineId: line.id,
        employeeName: displayName(line.employee),
        employeeNumber: line.employee.employeeNumber,
        departmentName: line.employee.department?.name ?? null,
        periodName: line.run.period.name,
        periodStart: line.run.period.startDate.toISOString().slice(0, 10),
        periodEnd: line.run.period.endDate.toISOString().slice(0, 10),
        currency: line.currency,
        attendance: {
          scheduledDays: num(line.scheduledDays),
          presentDays: num(line.presentDays),
          halfDays: num(line.halfDays),
          paidLeaveDays: num(line.paidLeaveDays),
          unpaidLeaveDays: num(line.unpaidLeaveDays),
          absentDays: num(line.absentDays),
          holidayDays: num(line.holidayDays),
          weekendDays: num(line.weekendDays),
          overtimeMinutes: line.overtimeMinutes,
          approvedOvertimeMinutes: line.approvedOvertimeMinutes,
          lateOccurrences: line.lateOccurrences,
          lateMinutes: line.lateMinutes,
          earlyLeaveOccurrences: line.earlyLeaveOccurrences,
          earlyLeaveMinutes: line.earlyLeaveMinutes,
        },
        payroll: {
          salaryType: line.salaryType,
          salaryAmount: num(line.salaryAmount),
          basis: line.basis,
          basisDays: num(line.basisDays),
          dailyRate: num(line.dailyRate),
          hourlyRate: num(line.hourlyRate),
          payableDays: num(line.payableDays),
          unpaidDays: num(line.unpaidDays),
          basicAmount: num(line.basicAmount),
          overtimeAmount: num(line.overtimeAmount),
          grossAmount: num(line.grossAmount),
          deductionsTotal: num(line.deductionsTotal),
          netAmount: num(line.netAmount),
        },
        earnings: line.earnings.map((e) => ({
          code: e.code,
          label: e.label,
          kind: e.kind,
          calc: e.calc,
          rate: e.rate === null ? null : num(e.rate),
          units: null,
          amount: num(e.amount),
        })),
        deductions: line.deductions.map((d) => ({
          code: d.code,
          label: d.label,
          kind: d.kind,
          calc: d.calc,
          rate: d.rate === null ? null : num(d.rate),
          units: d.units === null ? null : num(d.units),
          amount: num(d.amount),
        })),
      },
    });
  });
};
