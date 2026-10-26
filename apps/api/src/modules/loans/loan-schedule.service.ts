import type { Prisma } from '@prisma/client';
import { addMonths, type LoanDeductionMonthInfo } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { ValidationError } from '../../core/errors.js';
import { todayInZone } from '../../core/zoned-time.js';

/**
 * Which payroll month a deduction belongs to.
 *
 * The rule, in one place so the request form, the approval, the release and
 * payroll all read the same month:
 *
 *   A request is recovered from the payroll month it is made in - the month
 *   today falls in, in the company's timezone - unless that month's payroll is
 *   already finalized, in which case it is the first month after it that is
 *   still open.
 *
 * "Closed" is a payroll period marked CLOSED or carrying a FINALIZED run.
 * Nothing new is ever scheduled into a closed month: a closed payroll cannot
 * collect it, and pretending otherwise is how a deduction month on a screen
 * and the payslip it actually came off end up different.
 *
 * Months are yyyy-MM strings throughout; the database pins them to the first.
 */

type Client = Prisma.TransactionClient | typeof prisma;

const monthKey = (value: Date): string => value.toISOString().slice(0, 7);

/** The payroll month today falls in, in the company's own timezone. */
export async function currentPayrollMonth(
  companyId: string,
  client: Client = prisma,
  now = new Date(),
): Promise<string> {
  const company = await client.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { timezone: true },
  });
  return todayInZone(company.timezone || 'UTC', now).slice(0, 7);
}

/**
 * Months whose payroll is finalized, from `fromMonth` onwards.
 *
 * Read off the periods rather than off the runs alone: a period is CLOSED by
 * the same transaction that finalizes its run, and a period someone closed by
 * hand is closed too.
 */
export async function closedPayrollMonths(
  companyId: string,
  fromMonth: string,
  client: Client = prisma,
): Promise<Set<string>> {
  const from = new Date(`${fromMonth.slice(0, 7)}-01T00:00:00.000Z`);
  const periods = await client.payrollPeriod.findMany({
    where: {
      companyId,
      endDate: { gte: from },
      OR: [{ status: 'CLOSED' }, { runs: { some: { status: 'FINALIZED' } } }],
    },
    select: { startDate: true, endDate: true },
  });

  const closed = new Set<string>();
  for (const period of periods) {
    // A period is normally one month; one that spans several closes each.
    let month = monthKey(period.startDate);
    const last = monthKey(period.endDate);
    for (let guard = 0; month <= last && guard < 24; guard += 1) {
      closed.add(month);
      month = addMonths(month, 1).slice(0, 7);
    }
  }
  return closed;
}

/** The first month at or after `month` that is not closed. */
export function firstOpenMonth(month: string, closed: ReadonlySet<string>): string {
  let candidate = month.slice(0, 7);
  // Bounded: a company cannot plausibly have closed two years ahead.
  for (let guard = 0; closed.has(candidate) && guard < 36; guard += 1) {
    candidate = addMonths(candidate, 1).slice(0, 7);
  }
  return candidate;
}

export async function deductionMonthInfo(
  companyId: string,
  client: Client = prisma,
  now = new Date(),
): Promise<LoanDeductionMonthInfo> {
  const currentMonth = await currentPayrollMonth(companyId, client, now);
  const closed = await closedPayrollMonths(companyId, currentMonth, client);
  return {
    currentMonth,
    defaultMonth: firstOpenMonth(currentMonth, closed),
    closedMonths: [...closed].sort(),
  };
}

/**
 * The month a new request is recovered from: the one asked for, checked, or
 * the rule's default when none was asked for.
 *
 * Refused rather than adjusted: an employee who chose a month and got a
 * different one without being told is exactly the mismatch this exists to
 * prevent.
 */
export async function resolveRequestedDeductionMonth(
  companyId: string,
  requested: string | undefined,
  client: Client = prisma,
  now = new Date(),
): Promise<string> {
  const info = await deductionMonthInfo(companyId, client, now);
  if (!requested) return info.defaultMonth;

  const month = requested.slice(0, 7);
  if (month < info.currentMonth) {
    throw new ValidationError({
      startMonth: [
        `Deductions cannot start before the current payroll month (${info.currentMonth}).`,
      ],
    });
  }
  if (info.closedMonths.includes(month)) {
    throw new ValidationError({
      startMonth: [
        `Payroll for ${month} is already finalized. The earliest month open for deductions is ${info.defaultMonth}.`,
      ],
    });
  }
  return month;
}

/**
 * How far a schedule has to move so nothing still owed sits in a closed month.
 *
 * Zero when the first scheduled month is open. Otherwise the number of months
 * that takes the first one to the first open month - the whole remaining
 * schedule moves by the same amount, so it keeps its spacing and its order.
 */
export function carryForwardShift(firstScheduledMonth: string, closed: ReadonlySet<string>): number {
  const first = firstScheduledMonth.slice(0, 7);
  if (!closed.has(first)) return 0;
  const open = firstOpenMonth(first, closed);
  const [fy, fm] = first.split('-').map(Number);
  const [oy, om] = open.split('-').map(Number);
  return (oy! - fy!) * 12 + (om! - fm!);
}
