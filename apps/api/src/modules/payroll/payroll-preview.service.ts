import type { Prisma } from '@prisma/client';
import type {
  PayrollExceptionCode,
  PayrollExceptionSeverity,
  PayrollMoneyLine,
  PayrollPreview,
  PayrollPreviewRow,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { computePayroll, type ComputedLine } from './payroll.service.js';

/**
 * The payroll preview.
 *
 * "Show me what this period pays, before anybody commits to it." It runs the
 * same `computePayroll` a run runs and writes none of it: no lines, no
 * exceptions, no adjustment claimed, no run moved out of DRAFT. A preview is
 * a question, and asking a question should not change the answer.
 *
 * The columns are the ones the specification asks for - basic, paid days,
 * absent days, unpaid leave, allowances, overtime hours and amount,
 * deductions, gross, net - split out of the calculation's own earnings and
 * deductions rather than recomputed, so the preview and the payslip agree by
 * construction.
 */

/**
 * A figure off a computed line.
 *
 * Prisma types a Decimal input as string | number | Decimal | DecimalJsLike,
 * because all four are accepted on the way in. Every one of them answers to
 * `Number`, and a value that somehow does not becomes zero rather than a NaN
 * that would silently poison a total.
 */
const num = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Sums the money lines whose code matches, ignoring the rest. */
const sumWhere = (
  lines: readonly PayrollMoneyLine[] | ReturnType<typeof toMoneyLines>,
  predicate: (line: { code: string | null; kind: string }) => boolean,
): number => lines.filter(predicate).reduce((total, line) => total + Number(line.amount), 0);

function toMoneyLines(
  lines: ComputedLine['earnings'] | ComputedLine['deductions'],
): PayrollMoneyLine[] {
  return lines.map((line) => ({
    componentId: line.componentId,
    code: line.code,
    label: line.label,
    kind: line.kind,
    calc: line.calc,
    rate: line.rate,
    units: line.units,
    amount: line.amount,
    isTaxable: line.isTaxable,
  })) as PayrollMoneyLine[];
}

export interface PreviewScope {
  companyId: string;
  runId?: string;
  periodId?: string;
  from?: string;
  to?: string;
  employeeId?: string;
  departmentId?: string;
  /** The caller's data scope. Applied before anything is calculated. */
  scopeFilter: Prisma.EmployeeWhereInput;
}

/**
 * Resolves what period a preview covers.
 *
 * A run, a period or an explicit range, in that order of specificity. A run
 * is the usual case - somebody is about to finalize one - and carries its
 * status through so the screen can say what it is looking at.
 */
async function resolveRange(scope: PreviewScope): Promise<{
  from: Date;
  to: Date;
  periodId: string | null;
  runId: string | null;
  runStatus: string | null;
}> {
  if (scope.runId) {
    const run = await prisma.payrollRun.findFirst({
      where: { id: scope.runId, companyId: scope.companyId },
      include: { period: true },
    });
    if (!run) throw new NotFoundError('Payroll run');
    return {
      from: run.period.startDate,
      to: run.period.endDate,
      periodId: run.periodId,
      runId: run.id,
      runStatus: run.status,
    };
  }

  if (scope.periodId) {
    const period = await prisma.payrollPeriod.findFirst({
      where: { id: scope.periodId, companyId: scope.companyId },
    });
    if (!period) throw new NotFoundError('Payroll period');
    return {
      from: period.startDate,
      to: period.endDate,
      periodId: period.id,
      runId: null,
      runStatus: null,
    };
  }

  if (!scope.from || !scope.to) {
    throw new ValidationError({
      from: ['Choose a run, a period, or give a date range to preview.'],
    });
  }

  const from = new Date(`${scope.from.slice(0, 10)}T00:00:00.000Z`);
  const to = new Date(`${scope.to.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ValidationError({ from: ['Enter valid dates.'] });
  }
  if (to < from) {
    throw new ValidationError({ to: ['The end of the range cannot be before the start.'] });
  }
  return { from, to, periodId: null, runId: null, runStatus: null };
}

export async function buildPayrollPreview(scope: PreviewScope): Promise<PayrollPreview> {
  const { from, to, periodId, runId, runStatus } = await resolveRange(scope);

  const filter: Prisma.EmployeeWhereInput = {
    AND: [
      scope.scopeFilter,
      scope.employeeId ? { id: scope.employeeId } : {},
      scope.departmentId ? { departmentId: scope.departmentId } : {},
    ],
  };

  const computed = await computePayroll({
    companyId: scope.companyId,
    from,
    to,
    // The run being previewed, so the adjustments and loan installments it has
    // already claimed are still counted - without it, a calculated run's
    // preview silently drops them and disagrees with the run. Passing it only
    // widens what is read: claiming happens in `calculateRun`, never here.
    runId,
    filter,
  });

  // Exceptions carry the employee they belong to, so the preview can hang
  // each one on its row instead of listing them all in a heap at the bottom.
  const byEmployee = new Map<string, string[]>();
  const blockedEmployees = new Set<string>();
  for (const exception of computed.exceptions) {
    if (!exception.employeeId) continue;
    const list = byEmployee.get(exception.employeeId);
    if (list) list.push(exception.message);
    else byEmployee.set(exception.employeeId, [exception.message]);
    if (exception.severity === 'BLOCKING') blockedEmployees.add(exception.employeeId);
  }

  const rows: PayrollPreviewRow[] = computed.lines.map((line) => {
    const data = line.data;
    const earnings = toMoneyLines(line.earnings);
    const deductions = toMoneyLines(line.deductions);

    // "Allowances" is every earning that is not the basic pay or the overtime
    // line: the components a company has configured, whatever it calls them.
    const allowances = sumWhere(earnings, (l) => l.kind === 'COMPONENT');
    const lateDeduction = sumWhere(deductions, (l) => l.code === 'LATE');
    const earlyLeaveDeduction = sumWhere(deductions, (l) => l.code === 'EARLY_LEAVE');
    const absenceDeduction = sumWhere(
      deductions,
      (l) => l.code === 'ABSENCE' || l.code === 'UNPAID_LEAVE' || l.code === 'PAID_LEAVE',
    );
    const shortHoursDeduction = sumWhere(deductions, (l) => l.code === 'SHORT_HOURS');
    /**
     * Loan repayments, called what they are.
     *
     * They reach the calculation through the adjustment channel because a
     * repayment is arithmetically an adjustment, but a reviewer reading a
     * breakdown needs "Loan" rather than a share of "Other" - which is what
     * they were, and why a payslip could not be reconciled against a loan
     * schedule without opening both.
     */
    const loanDeduction = sumWhere(deductions, (l) => l.code === 'LOAN');
    // A salary advance being recovered, kept apart from loan repayments for
    // the same reason loans are kept apart from "Other".
    const advanceDeduction = sumWhere(deductions, (l) => l.code === 'ADVANCE');
    const otherDeductions =
      num(data.deductionsTotal) -
      lateDeduction -
      earlyLeaveDeduction -
      absenceDeduction -
      shortHoursDeduction -
      loanDeduction -
      advanceDeduction;

    return {
      employeeId: line.employeeId,
      employeeName: line.employeeName,
      employeeNumber: line.employeeNumber,
      departmentName: line.departmentName,
      currency: String(data.currency ?? computed.currency),
      salaryType: data.salaryType as PayrollPreviewRow['salaryType'],
      basicSalary: num(data.salaryAmount),
      salarySegments: Number(data.salarySegments ?? 1),
      basis: data.basis as PayrollPreviewRow['basis'],
      basisDays: num(data.basisDays),
      dailyRate: num(data.dailyRate),
      hourlyRate: num(data.hourlyRate),

      scheduledDays: num(data.scheduledDays),
      paidDays: num(data.payableDays),
      presentDays: num(data.presentDays),
      absentDays: num(data.absentDays),
      unpaidLeaveDays: num(data.unpaidLeaveDays),
      paidLeaveDays: num(data.paidLeaveDays),
      holidayDays: num(data.holidayDays),
      weekendDays: num(data.weekendDays),

      allowances: round2(allowances),
      // The hours actually priced, after approval and the payroll cap - not
      // the hours worked. A preview that showed worked hours beside a capped
      // amount would look like an arithmetic error.
      overtimeHours: round2(num(data.paidOvertimeMinutes) / 60),
      overtimeAmount: num(data.overtimeAmount),
      lateDeduction: round2(lateDeduction),
      earlyLeaveDeduction: round2(earlyLeaveDeduction),
      absenceDeduction: round2(absenceDeduction),
      shortHoursDeduction: round2(shortHoursDeduction),
      loanDeduction: round2(loanDeduction),
      advanceDeduction: round2(advanceDeduction),
      otherDeductions: round2(otherDeductions),
      deductionsTotal: num(data.deductionsTotal),
      adjustmentTotal: num(data.adjustmentTotal),

      basicAmount: num(data.basicAmount),
      grossAmount: num(data.grossAmount),
      netAmount: num(data.netAmount),

      earnings,
      deductions,
      notes: byEmployee.get(line.employeeId) ?? [],
      blocked: blockedEmployees.has(line.employeeId),
    };
  });

  /**
   * Employees a blocking exception stopped short of a line.
   *
   * They belong in the preview precisely because they are missing: a preview
   * that quietly omitted the three people with no salary on record would be
   * how a payroll gets finalized without them.
   */
  const withLines = new Set(rows.map((r) => r.employeeId));
  const missingIds = [...blockedEmployees].filter((id) => !withLines.has(id));
  if (missingIds.length > 0) {
    const missing = await prisma.employee.findMany({
      where: { id: { in: missingIds }, companyId: scope.companyId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        employeeNumber: true,
        department: { select: { name: true } },
      },
    });

    for (const employee of missing) {
      rows.push({
        employeeId: employee.id,
        employeeName: employee.displayName ?? `${employee.firstName} ${employee.lastName}`.trim(),
        employeeNumber: employee.employeeNumber,
        departmentName: employee.department?.name ?? null,
        currency: computed.currency,
        salaryType: 'MONTHLY',
        basicSalary: 0,
        salarySegments: 0,
        basis: 'CALENDAR_DAYS',
        basisDays: 0,
        dailyRate: 0,
        hourlyRate: 0,
        scheduledDays: 0,
        paidDays: 0,
        presentDays: 0,
        absentDays: 0,
        unpaidLeaveDays: 0,
        paidLeaveDays: 0,
        holidayDays: 0,
        weekendDays: 0,
        allowances: 0,
        overtimeHours: 0,
        overtimeAmount: 0,
        lateDeduction: 0,
        earlyLeaveDeduction: 0,
        absenceDeduction: 0,
        shortHoursDeduction: 0,
        loanDeduction: 0,
        advanceDeduction: 0,
        otherDeductions: 0,
        deductionsTotal: 0,
        adjustmentTotal: 0,
        basicAmount: 0,
        grossAmount: 0,
        netAmount: 0,
        earnings: [],
        deductions: [],
        notes: byEmployee.get(employee.id) ?? [],
        blocked: true,
      });
    }
  }

  rows.sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber));

  const sum = (pick: (row: PayrollPreviewRow) => number): number =>
    round2(rows.reduce((total, row) => total + pick(row), 0));

  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    periodId,
    runId,
    runStatus,
    currency: computed.currency,
    generatedAt: new Date().toISOString(),
    rows,
    totals: {
      employees: rows.length,
      blocked: rows.filter((r) => r.blocked).length,
      basicAmount: sum((r) => r.basicAmount),
      allowances: sum((r) => r.allowances),
      overtimeAmount: sum((r) => r.overtimeAmount),
      deductionsTotal: sum((r) => r.deductionsTotal),
      grossAmount: sum((r) => r.grossAmount),
      netAmount: sum((r) => r.netAmount),
    },
    exceptions: computed.exceptions
      .slice()
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'BLOCKING' ? -1 : 1))
      .map((e) => ({
        code: e.code as PayrollExceptionCode,
        severity: e.severity as PayrollExceptionSeverity,
        message: e.message,
        employeeId: e.employeeId,
      })),
  };
}
