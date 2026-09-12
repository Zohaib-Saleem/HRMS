import { PERMISSIONS, type EmployeeProfileSummary, type Permission } from '@hrms/shared';
import type { AuthContext } from '../../auth/session.js';
import { prisma } from '../../core/db.js';
import { deriveRange, tallyDerived } from '../time/attendance.service.js';
import { balancesForEmployee, foldPaidBalances } from '../leave/leave.service.js';
import { loanTotals, toNumber } from '../loans/loans.service.js';

/**
 * The headline strip on the Employee 360 profile.
 *
 * This endpoint calculates NOTHING of its own. Attendance comes from
 * `deriveRange` and `tallyDerived` - the same central engine the attendance
 * screens and payroll read, so the overtime shown here is the overtime the
 * company's own policy produced and not a second opinion about it. Leave comes
 * from `balancesForEmployee`, the service behind every leave screen. Loans come
 * from `loanTotals`, the same schedule arithmetic the loans module uses. Salary
 * is read straight off the salary records.
 *
 * It exists as one request rather than five so that opening a profile is one
 * round trip, and so that a caller who may see attendance but not pay gets a
 * partial summary instead of a page half of whose cards failed.
 *
 * Every block is gated on the permission its own module requires, and an
 * ungranted block is OMITTED rather than zeroed - a zero would read as "no
 * loans", which is a different statement from "not yours to see".
 */
export async function employeeProfileSummary(
  auth: AuthContext,
  employeeId: string,
  reference = new Date(),
): Promise<EmployeeProfileSummary> {
  const can = (permission: Permission) => auth.permissions.has(permission);

  const summary: EmployeeProfileSummary = { employeeId };

  const [punchCodes, attendance, leave, loans, salary] = await Promise.all([
    can(PERMISSIONS.DEVICE_READ) ? punchCodesFor(auth.companyId, employeeId) : null,
    can(PERMISSIONS.ATTENDANCE_READ)
      ? attendanceFor(auth.companyId, employeeId, reference)
      : null,
    can(PERMISSIONS.LEAVE_READ) ? leaveFor(auth.companyId, employeeId, reference) : null,
    can(PERMISSIONS.LOAN_READ) ? loansFor(auth.companyId, employeeId) : null,
    can(PERMISSIONS.PAYROLL_READ) ? salaryFor(auth.companyId, employeeId, reference) : null,
  ]);

  if (punchCodes) summary.punchCodes = punchCodes;
  if (attendance) summary.attendance = attendance;
  if (leave) summary.leave = leave;
  if (loans) summary.loans = loans;
  if (salary) summary.salary = salary;

  return summary;
}

/**
 * The PINs this person punches under today.
 *
 * Read-only, and deliberately only the active ones: a closed mapping is the
 * record of a PIN somebody used to hold, which belongs on the mapping screen's
 * history and not on a profile header. Nothing here writes.
 */
async function punchCodesFor(companyId: string, employeeId: string): Promise<string[]> {
  const rows = await prisma.attendanceDeviceUserMapping.findMany({
    where: { companyId, employeeId, isActive: true },
    select: { deviceUserId: true },
    orderBy: { deviceUserId: 'asc' },
  });
  return [...new Set(rows.map((r) => r.deviceUserId))];
}

/** The calendar month `reference` falls in, scored by the central engine. */
async function attendanceFor(
  companyId: string,
  employeeId: string,
  reference: Date,
): Promise<EmployeeProfileSummary['attendance']> {
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();
  const from = new Date(Date.UTC(year, month, 1));
  const to = new Date(Date.UTC(year, month + 1, 0));

  const days = await deriveRange(companyId, employeeId, from, to);
  const totals = tallyDerived(days);

  return {
    month: `${year}-${String(month + 1).padStart(2, '0')}`,
    present: totals.present,
    halfDay: totals.halfDay,
    absent: totals.absent,
    onLeave: totals.onLeave,
    late: totals.late,
    earlyLeave: totals.earlyLeave,
    missingPunch: totals.missingPunch,
    irregular: totals.irregular,
    workedMinutes: totals.workedMinutes,
    expectedMinutes: totals.expectedMinutes,
    overtimeMinutes: totals.overtimeMinutes,
    attendancePercentage: totals.attendancePercentage,
  };
}

/**
 * This year's PAID leave, folded across every active type.
 *
 * A single figure on a header card, where the Leave tab breaks the same numbers
 * out per type. No arithmetic here at all: entitlement, accrual, used and
 * available are decided by the leave service, and the fold - which excludes
 * unpaid types - is `foldPaidBalances`, shared with the master report so a
 * profile and a report cannot disagree about the same person.
 */
async function leaveFor(
  companyId: string,
  employeeId: string,
  reference: Date,
): Promise<EmployeeProfileSummary['leave']> {
  const year = reference.getUTCFullYear();
  const balances = await balancesForEmployee(companyId, employeeId, year);

  return { year, ...foldPaidBalances(balances) };
}

/**
 * What is still owed on live loans.
 *
 * ACTIVE only. An approved-but-unreleased loan has collected nothing and a
 * completed one is settled; neither is money the next payslip will take, which
 * is the question this card answers.
 */
async function loansFor(
  companyId: string,
  employeeId: string,
): Promise<EmployeeProfileSummary['loans']> {
  const rows = await prisma.employeeLoan.findMany({
    where: { companyId, employeeId, status: 'ACTIVE' },
    include: { installments: { select: { status: true, amount: true } } },
  });

  let outstandingAmount = 0;
  let monthlyDeduction = 0;
  for (const loan of rows) {
    outstandingAmount += loanTotals(loan.installments).remainingAmount;
    monthlyDeduction += toNumber(loan.monthlyDeduction);
  }

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { currency: true },
  });

  return {
    activeCount: rows.length,
    outstandingAmount: Math.round(outstandingAmount * 100) / 100,
    monthlyDeduction: Math.round(monthlyDeduction * 100) / 100,
    currency: rows[0]?.currency ?? company.currency,
  };
}

/**
 * The salary in force on the reference date.
 *
 * "In force" is the same test the salary screens use: it started on or before
 * today and has not ended. A future-dated revision is not the current salary,
 * and neither is a superseded one.
 */
async function salaryFor(
  companyId: string,
  employeeId: string,
  reference: Date,
): Promise<EmployeeProfileSummary['salary']> {
  const today = reference.toISOString().slice(0, 10);

  const [rows, employee] = await Promise.all([
    prisma.employeeSalary.findMany({
      where: { companyId, employeeId },
      orderBy: { effectiveFrom: 'desc' },
      select: { amount: true, currency: true, effectiveFrom: true, effectiveTo: true },
    }),
    prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { nextIncrementDueDate: true },
    }),
  ]);

  const dayKey = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);
  const current = rows.find(
    (row) =>
      dayKey(row.effectiveFrom)! <= today &&
      (row.effectiveTo === null || dayKey(row.effectiveTo)! >= today),
  );

  const nextIncrementDueDate = dayKey(employee.nextIncrementDueDate);

  // No salary in force is a real answer for a new joiner whose pay has not been
  // entered yet, and the increment date is worth showing even then.
  if (!current) {
    const company = await prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { currency: true },
    });
    return { amount: 0, currency: company.currency, effectiveFrom: null, nextIncrementDueDate };
  }

  return {
    amount: toNumber(current.amount),
    currency: current.currency,
    effectiveFrom: dayKey(current.effectiveFrom),
    nextIncrementDueDate,
  };
}
