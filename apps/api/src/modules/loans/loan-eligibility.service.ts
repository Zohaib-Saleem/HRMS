import {
  monthlyDeductionFor,
  type LoanEligibilityFailure,
  type LoanEligibilityResult,
  type LoanEligibilityRule,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { dayKeyToDateColumn, todayInZone } from '../../core/zoned-time.js';
import { deriveRange, tallyDerived } from '../time/attendance.service.js';
import { resolveAttendancePolicy } from '../time/attendance-policy.js';
import { currentLoanPolicy, normaliseEvaluationMonths, type LoanPolicyRow } from './loan-policy.service.js';
import { toNumber } from './loans.service.js';

/**
 * Whether an employee may borrow, and if not, why not.
 *
 * The one place the question is answered. The browser calls it to draw a form
 * and `POST /loans/apply` calls it again to decide - the second call is the
 * gate, and it re-reads the employee, the salary, the attendance and the policy
 * from the database rather than trusting anything that arrived in the request.
 * Nothing an employee can put in a payload reaches a threshold: the subject is
 * resolved from the session, and every limit comes from the policy row.
 *
 * It owns no arithmetic it can borrow. Attendance is `deriveRange` +
 * `tallyDerived`, the same engine the attendance screens and payroll read;
 * the installment is `monthlyDeductionFor`, the same function that builds the
 * schedule that will actually be collected. A second opinion about either
 * would be a second engine, and two engines eventually disagree about one
 * person.
 *
 * It writes nothing and decides nothing about loans that already exist.
 */

/** Statuses that occupy the "already has a loan" slots the policy can close. */
const ACTIVE_LIKE = ['APPROVED', 'ACTIVE'] as const;

export interface EligibilityInput {
  companyId: string;
  employeeId: string;
  /** Optional: with neither, this answers "what could this person borrow". */
  requestedAmount?: number | null;
  requestedInstallments?: number | null;
  now?: Date;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${Math.round(n * 10) / 10}%`;

/**
 * The attendance window: whole calendar months, ending with the last one that
 * finished.
 *
 * Today is deliberately outside it. A loan refused at 11am on the strength of a
 * morning somebody has not finished working is a refusal that would have gone
 * the other way after lunch, and an eligibility answer that changes hour by
 * hour is not a rule anybody can plan against. The company's timezone decides
 * which month "this" one is, so the window does not shift with the employee.
 */
export function evaluationWindow(
  months: number,
  timeZone: string,
  now: Date,
): { from: string; to: string } {
  const today = todayInZone(timeZone, now);
  const [year, month] = today.split('-').map(Number) as [number, number, number];

  // The first of this month, then step back: `months` whole months end on the
  // last day before it.
  const endExclusive = new Date(Date.UTC(year, month - 1, 1));
  const start = new Date(Date.UTC(year, month - 1 - months, 1));
  const end = new Date(endExclusive.getTime() - 24 * 60 * 60 * 1000);

  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/**
 * A monthly figure for a salary that may not be recorded monthly.
 *
 * Converted with the company's OWN payroll configuration - what it counts as a
 * month of days, and what it counts as a day of hours - rather than with a
 * constant invented here. When a company has no payroll settings there is no
 * honest way to turn a daily rate into a monthly one, so it returns null and
 * the caller reports a missing salary rather than guessing.
 */
async function monthlySalaryFrom(
  companyId: string,
  salary: { amount: unknown; salaryType: string },
): Promise<number | null> {
  const amount = toNumber(salary.amount as never);
  if (salary.salaryType === 'MONTHLY') return amount;

  const settings = await prisma.payrollSettings.findUnique({
    where: { companyId },
    select: { fixedBasisDays: true, standardHoursPerDay: true },
  });
  if (!settings) return null;

  const days = settings.fixedBasisDays;
  if (salary.salaryType === 'DAILY') return round2(amount * days);
  return round2(amount * toNumber(settings.standardHoursPerDay) * days);
}

/** An empty answer, used when the subject cannot be evaluated at all. */
function blocked(
  currency: string,
  policy: LoanPolicyRow | null,
  failures: LoanEligibilityFailure[],
): LoanEligibilityResult {
  return {
    eligible: false,
    maxAllowedAmount: 0,
    maxMonthlyDeduction: 0,
    monthlySalary: null,
    currency,
    maxTenureMonths: policy?.maxTenureMonths ?? 0,
    maxInstallments: policy?.maxInstallments ?? 0,
    estimatedMonthlyDeduction: null,
    reasons: failures.map((f) => f.message),
    failedRules: failures.map((f) => f.rule),
    failures,
    warnings: [],
    evaluation: {
      months: policy ? normaliseEvaluationMonths(policy.evaluationMonths) : 0,
      from: null,
      to: null,
      attendancePercentage: null,
      unapprovedAbsences: 0,
      lateDays: 0,
      missingPunches: 0,
      measured: false,
    },
    overrideAllowed: policy?.allowHrOverride ?? false,
  };
}

export async function evaluateLoanEligibility(
  input: EligibilityInput,
): Promise<LoanEligibilityResult> {
  const now = input.now ?? new Date();
  const failures: LoanEligibilityFailure[] = [];
  const warnings: string[] = [];
  const fail = (rule: LoanEligibilityRule, message: string) => failures.push({ rule, message });

  const [policy, company] = await Promise.all([
    currentLoanPolicy(input.companyId, now),
    prisma.company.findUniqueOrThrow({
      where: { id: input.companyId },
      select: { currency: true },
    }),
  ]);

  const employee = await prisma.employee.findFirst({
    where: { id: input.employeeId, companyId: input.companyId },
    select: {
      id: true,
      status: true,
      hireDate: true,
      confirmationDate: true,
      confirmationStatus: true,
      locationId: true,
      contracts: {
        where: { status: 'ACTIVE', contractType: 'PROBATION' },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!employee) {
    return blocked(company.currency, policy, [
      { rule: 'EMPLOYEE_RECORD', message: 'There is no employee record to apply against.' },
    ]);
  }

  // --- employment status ----------------------------------------------------
  if (policy.blockTerminated && employee.status === 'TERMINATED') {
    fail('EMPLOYMENT_STATUS', 'Your employment record is marked terminated.');
  }
  if (policy.blockResigned && employee.status === 'RESIGNED') {
    fail('EMPLOYMENT_STATUS', 'Your employment record is marked resigned.');
  }

  // --- length of service ----------------------------------------------------
  const monthsServed = employee.hireDate ? completedMonths(employee.hireDate, now) : null;
  if (policy.minEmploymentMonths > 0) {
    if (monthsServed === null) {
      fail(
        'MIN_EMPLOYMENT',
        `Your joining date is not on record, so ${policy.minEmploymentMonths} months of service cannot be confirmed. Ask HR to add it.`,
      );
    } else if (monthsServed < policy.minEmploymentMonths) {
      fail(
        'MIN_EMPLOYMENT',
        `You have completed ${monthsServed} month${monthsServed === 1 ? '' : 's'} of service. The minimum is ${policy.minEmploymentMonths}.`,
      );
    }
  }

  // --- probation ------------------------------------------------------------
  if (!policy.allowProbation && isOnProbation(employee, now)) {
    fail('PROBATION', 'Employees on probation cannot apply while probation applications are off.');
  }

  // --- salary ---------------------------------------------------------------
  const today = now.toISOString().slice(0, 10);
  const salaryRow = await prisma.employeeSalary.findFirst({
    where: {
      companyId: input.companyId,
      employeeId: employee.id,
      effectiveFrom: { lte: dayKeyToDateColumn(today) },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: dayKeyToDateColumn(today) } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    select: { amount: true, currency: true, salaryType: true },
  });

  const monthlySalary = salaryRow ? await monthlySalaryFrom(input.companyId, salaryRow) : null;
  const currency = salaryRow?.currency ?? company.currency;

  if (monthlySalary === null || monthlySalary <= 0) {
    fail('SALARY_RECORD', 'You have no salary on record, so a loan limit cannot be worked out.');
  } else if (monthlySalary < toNumber(policy.minSalary)) {
    fail(
      'MIN_SALARY',
      `Your salary is below the ${currency} ${format(toNumber(policy.minSalary))} minimum for a loan.`,
    );
  }

  const salary = monthlySalary ?? 0;
  const maxAllowedAmount = round2(salary * toNumber(policy.maxSalaryMultiplier));
  const maxMonthlyDeduction = round2(
    salary * (toNumber(policy.maxMonthlyDeductionPercent) / 100),
  );

  // --- attendance -----------------------------------------------------------
  const months = normaliseEvaluationMonths(policy.evaluationMonths);
  const attendancePolicy = await resolveAttendancePolicy(input.companyId);
  const full = evaluationWindow(months, attendancePolicy.timeZone, now);

  /*
   * The window never starts before the employee did.
   *
   * `deriveRange` scores a past working day with no record as ABSENT, which is
   * right for an attendance screen - a day nobody turned up for is a day nobody
   * turned up for - and wrong for the days before somebody was hired. Left
   * unclamped, a joiner of six weeks is measured against three months, two of
   * which they were not employed for, and arrives at an attendance percentage
   * that describes the calendar rather than them.
   */
  const hireDay = employee.hireDate ? employee.hireDate.toISOString().slice(0, 10) : null;
  const window = {
    from: hireDay && hireDay > full.from ? hireDay : full.from,
    to: full.to,
  };

  const [days, recordCount] = await Promise.all([
    window.from > window.to
      ? Promise.resolve([])
      : deriveRange(
          input.companyId,
          employee.id,
          dayKeyToDateColumn(window.from),
          dayKeyToDateColumn(window.to),
        ),
    /*
     * Is there any attendance evidence at all?
     *
     * The difference between "we know they were absent" and "we know nothing"
     * is invisible in the derived days - both come back ABSENT - and it decides
     * whether this employee can be judged on attendance. A company that has not
     * rolled terminals out to a location, or an employee whose first month has
     * not been imported yet, must not be refused a loan at 0% for data that was
     * never collected about them.
     *
     * A count, not the rows: the rows are already being derived above.
     */
    window.from > window.to
      ? Promise.resolve(0)
      : prisma.attendanceRecord.count({
          where: {
            employeeId: employee.id,
            date: {
              gte: dayKeyToDateColumn(window.from),
              lte: dayKeyToDateColumn(window.to),
            },
          },
        }),
  ]);
  const totals = tallyDerived(days);

  /*
   * Unresolved missing punches.
   *
   * A day the engine flagged MISSING_PUNCH that the employee has not already
   * raised. An APPROVED correction has rewritten the record and cleared the
   * flag, so it cannot appear here at all; a PENDING one is a day somebody is
   * already dealing with, and holding it against them while it waits for a
   * manager would penalise them for the queue rather than the punch.
   */
  const raised = await prisma.attendanceRegularizationRequest.findMany({
    where: {
      companyId: input.companyId,
      employeeId: employee.id,
      status: { in: ['PENDING', 'APPROVED'] },
      attendanceDate: {
        gte: dayKeyToDateColumn(window.from),
        lte: dayKeyToDateColumn(window.to),
      },
    },
    select: { attendanceDate: true },
  });
  const raisedDays = new Set(raised.map((r) => r.attendanceDate.toISOString().slice(0, 10)));
  const missingPunches = days.filter(
    (d) => d.flags.includes('MISSING_PUNCH') && !raisedDays.has(d.date),
  ).length;

  /*
   * Attendance, as the LOAN policy asks the question.
   *
   * `tallyDerived` scores approved leave in the denominator with no credit, so
   * its percentage falls when somebody takes their annual leave. That is a
   * defensible answer to "how much of the period was worked", which is what the
   * attendance screens ask - and the wrong answer to "did this person turn up
   * when they were expected to", which is what a loan rule asks. Somebody
   * refused a loan for taking leave they were granted has been penalised twice
   * for one approval.
   *
   * So the denominator here is the days they were expected to attend: present,
   * half days and absences. This is NOT a second attendance engine - every
   * figure below is one `tallyDerived` produced, and no day is re-scored. It is
   * the loan policy choosing which of the engine's days it judges, the way
   * `foldPaidBalances` chooses which leave types it folds.
   */
  const expectedDays = totals.present + totals.halfDay + totals.absent;
  const attendedDays = totals.present + totals.halfDay * 0.5;
  const attendancePercentage =
    expectedDays > 0 ? Math.round((attendedDays / expectedDays) * 1000) / 10 : null;

  const measured = attendancePercentage !== null && recordCount > 0;

  if (!measured) {
    // Nothing to measure is not the same as failing. A new joiner whose window
    // predates them has no attendance to be judged on, and refusing them on a
    // percentage that does not exist would be a rule nobody wrote.
    warnings.push(
      `There is no attendance on record between ${window.from} and ${window.to}, so the attendance rules could not be applied.`,
    );
  } else {
    const attendance = attendancePercentage!;
    if (attendance < toNumber(policy.minAttendancePercent)) {
      fail(
        'ATTENDANCE_PERCENT',
        `Your attendance is ${pct(attendance)}. The minimum required is ${pct(toNumber(policy.minAttendancePercent))}.`,
      );
    }
    if (totals.absent > policy.maxUnapprovedAbsences) {
      fail(
        'UNAPPROVED_ABSENCES',
        `You have ${totals.absent} unapproved absence${totals.absent === 1 ? '' : 's'}. The maximum allowed is ${policy.maxUnapprovedAbsences}.`,
      );
    }
    if (totals.late > policy.maxLateDays) {
      fail(
        'LATE_DAYS',
        `You have ${totals.late} late day${totals.late === 1 ? '' : 's'}. The maximum allowed is ${policy.maxLateDays}.`,
      );
    }
    if (missingPunches > policy.maxMissingPunches) {
      fail(
        'MISSING_PUNCHES',
        `You have ${missingPunches} unresolved missing punch${missingPunches === 1 ? '' : 'es'}. The maximum allowed is ${policy.maxMissingPunches}. Raising a correction clears them.`,
      );
    }
  }

  // --- loans already on file ------------------------------------------------
  if (policy.oneActiveLoan) {
    const active = await prisma.employeeLoan.findFirst({
      where: { employeeId: employee.id, status: { in: [...ACTIVE_LIKE] } },
      select: { id: true },
    });
    if (active) fail('ACTIVE_LOAN', 'You already have a loan in progress.');
  }
  if (policy.onePendingLoan) {
    const pending = await prisma.employeeLoan.findFirst({
      where: { employeeId: employee.id, status: 'PENDING' },
      select: { id: true },
    });
    if (pending) {
      fail('PENDING_LOAN', 'You already have an application waiting for a decision.');
    }
  }

  // --- the application itself -----------------------------------------------
  const requestedAmount = input.requestedAmount ?? null;
  const requestedInstallments = input.requestedInstallments ?? null;

  if (requestedInstallments !== null) {
    if (requestedInstallments > policy.maxInstallments) {
      fail(
        'MAX_INSTALLMENTS',
        `${requestedInstallments} installments is more than the ${policy.maxInstallments} allowed.`,
      );
    }
    if (requestedInstallments > policy.maxTenureMonths) {
      fail(
        'MAX_TENURE',
        `Repaying over ${requestedInstallments} months is longer than the ${policy.maxTenureMonths}-month maximum.`,
      );
    }
  }

  if (requestedAmount !== null && monthlySalary !== null && monthlySalary > 0) {
    if (requestedAmount > maxAllowedAmount) {
      fail(
        'MAX_AMOUNT',
        `You asked for ${currency} ${format(requestedAmount)}. The most you can borrow is ${currency} ${format(maxAllowedAmount)}.`,
      );
    }
  }

  // The installment the schedule would actually carry - the same function that
  // builds it, so the figure quoted here is the figure that gets collected.
  const estimatedMonthlyDeduction =
    requestedAmount !== null && requestedInstallments !== null
      ? monthlyDeductionFor(requestedAmount, requestedInstallments)
      : null;

  if (
    estimatedMonthlyDeduction !== null &&
    monthlySalary !== null &&
    monthlySalary > 0 &&
    estimatedMonthlyDeduction > maxMonthlyDeduction
  ) {
    fail(
      'MONTHLY_DEDUCTION',
      `The monthly repayment would be ${currency} ${format(estimatedMonthlyDeduction)}. The most that can be deducted is ${currency} ${format(maxMonthlyDeduction)} (${pct(toNumber(policy.maxMonthlyDeductionPercent))} of salary).`,
    );
  }

  return {
    eligible: failures.length === 0,
    maxAllowedAmount,
    maxMonthlyDeduction,
    monthlySalary,
    currency,
    maxTenureMonths: policy.maxTenureMonths,
    maxInstallments: policy.maxInstallments,
    estimatedMonthlyDeduction,
    reasons: failures.map((f) => f.message),
    failedRules: failures.map((f) => f.rule),
    failures,
    warnings,
    evaluation: {
      months,
      from: window.from,
      to: window.to,
      attendancePercentage,
      unapprovedAbsences: totals.absent,
      lateDays: totals.late,
      missingPunches,
      measured,
    },
    overrideAllowed: policy.allowHrOverride,
  };
}

/** Whole months between a date and now. */
export function completedMonths(from: Date, now: Date): number {
  let months =
    (now.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - from.getUTCMonth());
  if (now.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * Whether somebody is still on probation.
 *
 * Three signals, any of which is enough, and none of which is invented: an
 * ACTIVE contract of type PROBATION, the roster's own "Probation" wording, or a
 * confirmation date that has not arrived. A missing confirmation date says
 * nothing either way and is deliberately not read as probation - most of the
 * existing roster has none, and treating silence as probation would block a
 * whole company on a field nobody filled in.
 */
export function isOnProbation(
  employee: {
    confirmationDate: Date | null;
    confirmationStatus: string | null;
    contracts: ReadonlyArray<{ id: string }>;
  },
  now: Date,
): boolean {
  if (employee.contracts.length > 0) return true;
  if (employee.confirmationStatus?.trim().toLowerCase() === 'probation') return true;
  if (employee.confirmationDate && employee.confirmationDate.getTime() > now.getTime()) return true;
  return false;
}

const format = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
