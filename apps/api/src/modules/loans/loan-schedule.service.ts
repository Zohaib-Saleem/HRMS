import type { Prisma } from '@prisma/client';
import { addMonths, payrollMonthForDay, type LoanDeductionMonthInfo, type LoanKind } from '@hrms/shared';
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
 *   today falls in, in the company's timezone.
 *
 *   A salary advance keeps that month even when its payroll is already
 *   finalized: the request is stored against it and flagged, payroll holds
 *   the recovery, and an authorised user decides - a revised month through
 *   the audited reschedule, or a repayment recorded outside payroll. Nothing
 *   moves it on its own.
 *
 *   A loan applied for in a finalized month starts in the first open month
 *   after it, and the form says so before it is submitted.
 *
 * "Closed" is a payroll period marked CLOSED or carrying a FINALIZED run. A
 * closed payroll is never changed to collect anything; the flag is how a
 * deduction month on a screen and the payslip it actually came off are kept
 * from quietly disagreeing.
 *
 * Months are yyyy-MM strings throughout; the database pins them to the first.
 */

type Client = Prisma.TransactionClient | typeof prisma;

const monthKey = (value: Date): string => value.toISOString().slice(0, 7);

/** The day a payroll cycle closes on (payroll settings), or null for calendar months. */
async function cycleEndDayFor(companyId: string, client: Client): Promise<number | null> {
  const settings = await client.payrollSettings.findUnique({
    where: { companyId },
    select: { cycleEndDay: true },
  });
  return settings?.cycleEndDay ?? null;
}

/**
 * The payroll month today falls in, in the company's own timezone. With a
 * cycle closing on the 28th, the 29th onwards already belongs to next month.
 */
export async function currentPayrollMonth(
  companyId: string,
  client: Client = prisma,
  now = new Date(),
): Promise<string> {
  const [company, cycleEndDay] = await Promise.all([
    client.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { timezone: true },
    }),
    cycleEndDayFor(companyId, client),
  ]);
  return payrollMonthForDay(todayInZone(company.timezone || 'UTC', now), cycleEndDay);
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
  const cycleEndDay = periods.length ? await cycleEndDayFor(companyId, client) : null;

  const closed = new Set<string>();
  for (const period of periods) {
    // A period is normally one month; one that spans several closes each. A
    // 29 September - 28 October cycle is October alone: its first days are
    // read through the cycle, so they do not close September as well.
    let month = payrollMonthForDay(period.startDate.toISOString().slice(0, 10), cycleEndDay);
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
  kind: LoanKind = 'LOAN',
): Promise<string> {
  const info = await deductionMonthInfo(companyId, client, now);
  // An advance is against this month's pay, finalized or not; a closed month
  // is flagged for a decision rather than skipped.
  if (kind === 'SALARY_ADVANCE' && (!requested || requested.slice(0, 7) === info.currentMonth)) {
    return info.currentMonth;
  }
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
