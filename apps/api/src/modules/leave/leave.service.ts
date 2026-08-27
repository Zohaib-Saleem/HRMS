import type { LeaveDayPart, Prisma } from '@prisma/client';
import { prisma } from '../../core/db.js';
import { ValidationError } from '../../core/errors.js';

/**
 * Leave calculation.
 *
 * Two rules drive everything here and both are data-driven, read from the
 * LeaveType row rather than hard-coded:
 *
 *   accrued   = min(monthlyAccrualDays x completed months, annualEntitlementDays)
 *   available = opening + accrued + adjustment - used - pending
 *
 * Only `opening` and `adjustment` are stored. Accrued is derived from the
 * policy and the calendar, used and pending are derived from request rows, so
 * a stored total can never drift away from the records behind it.
 */

/**
 * Weekends come from the company configuration, never from a constant here.
 *
 * A leave request and an attendance calendar that disagree about which days are
 * working days would quietly corrupt balances, so both read `isWeekendFor` with
 * the same `Company.weekendDays` value.
 */
import { isWeekendFor, weekendDaysFor } from '../time/attendance-policy.js';

export { isWeekendFor, weekendDaysFor };

/** Dates are stored as @db.Date; pin to UTC midnight so the day never shifts. */
export function toDateOnly(value: string | Date): Date {
  const parsed = typeof value === 'string' ? new Date(value) : value;
  return new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()),
  );
}

export const toNumber = (value: Prisma.Decimal | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

/**
 * Holidays that apply to one employee: those pinned to their location, plus
 * every company-wide holiday (locationId null).
 */
export async function applicableHolidays(
  companyId: string,
  locationId: string | null,
  from: Date,
  to: Date,
): Promise<Set<string>> {
  const rows = await prisma.holiday.findMany({
    where: {
      companyId,
      isActive: true,
      date: { gte: from, lte: to },
      OR: [{ locationId: null }, ...(locationId ? [{ locationId }] : [])],
    },
    select: { date: true },
  });

  return new Set(rows.map((r) => r.date.toISOString().slice(0, 10)));
}

/**
 * Working days in a range, weekends and applicable holidays removed.
 *
 * A half-day only makes sense for a single-day request; a multi-day range is
 * always counted in whole days.
 */
export async function countWorkingDays(
  companyId: string,
  locationId: string | null,
  start: Date,
  end: Date,
  dayPart: LeaveDayPart,
): Promise<number> {
  const [holidays, weekendDays] = await Promise.all([
    applicableHolidays(companyId, locationId, start, end),
    weekendDaysFor(companyId),
  ]);

  let days = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (isWeekendFor(d, weekendDays)) continue;
    if (holidays.has(d.toISOString().slice(0, 10))) continue;
    days += 1;
  }

  const singleDay = start.getTime() === end.getTime();
  if (singleDay && dayPart !== 'FULL_DAY') return days === 0 ? 0 : 0.5;

  return days;
}

/** Completed months of the year so far. December of a past year gives 12. */
export function completedMonths(year: number, now = new Date()): number {
  if (year < now.getUTCFullYear()) return 12;
  if (year > now.getUTCFullYear()) return 0;
  // The current month counts once it has started, so January gives 1.
  return now.getUTCMonth() + 1;
}

export interface LeaveBalanceView {
  leaveTypeId: string;
  leaveTypeName: string;
  leaveTypeCode: string | null;
  isPaid: boolean;
  year: number;
  annualEntitlementDays: number;
  monthlyAccrualDays: number;
  carryForwardEnabled: boolean;
  carryForwardCapDays: number | null;
  openingDays: number;
  accruedDays: number;
  adjustmentDays: number;
  usedDays: number;
  pendingDays: number;
  availableDays: number;
}

/**
 * Balances for one employee across every active leave type.
 *
 * `used` counts approved leave only; `pending` counts requests still awaiting a
 * decision. Pending is subtracted from what is available so an employee cannot
 * spend the same day twice by stacking requests before anyone approves them.
 */
export async function balancesForEmployee(
  companyId: string,
  employeeId: string,
  year: number,
): Promise<LeaveBalanceView[]> {
  const [types, stored, requests] = await Promise.all([
    prisma.leaveType.findMany({
      where: { companyId, isActive: true },
      orderBy: { name: 'asc' },
    }),
    prisma.leaveBalance.findMany({ where: { employeeId, year } }),
    prisma.leaveRequest.findMany({
      where: {
        employeeId,
        status: { in: ['PENDING', 'APPROVED'] },
        startDate: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lte: new Date(Date.UTC(year, 11, 31)),
        },
      },
      select: { leaveTypeId: true, status: true, totalDays: true },
    }),
  ]);

  const storedBy = new Map(stored.map((s) => [s.leaveTypeId, s]));
  const months = completedMonths(year);

  return types.map((type) => {
    const row = storedBy.get(type.id);
    const annual = toNumber(type.annualEntitlementDays);
    const monthly = toNumber(type.monthlyAccrualDays);

    // Never accrue past the annual entitlement.
    const accrued = Math.min(monthly * months, annual);

    const mine = requests.filter((r) => r.leaveTypeId === type.id);
    const used = mine
      .filter((r) => r.status === 'APPROVED')
      .reduce((sum, r) => sum + toNumber(r.totalDays), 0);
    const pending = mine
      .filter((r) => r.status === 'PENDING')
      .reduce((sum, r) => sum + toNumber(r.totalDays), 0);

    const opening = toNumber(row?.openingDays);
    const adjustment = toNumber(row?.adjustmentDays);

    return {
      leaveTypeId: type.id,
      leaveTypeName: type.name,
      leaveTypeCode: type.code,
      isPaid: type.isPaid,
      year,
      annualEntitlementDays: annual,
      monthlyAccrualDays: monthly,
      carryForwardEnabled: type.carryForwardEnabled,
      carryForwardCapDays: type.carryForwardCapDays === null ? null : toNumber(type.carryForwardCapDays),
      openingDays: opening,
      accruedDays: round2(accrued),
      adjustmentDays: adjustment,
      usedDays: round2(used),
      pendingDays: round2(pending),
      availableDays: round2(opening + accrued + adjustment - used - pending),
    };
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Rejects a request that would overlap leave the employee already has.
 * Cancelled and rejected rows are ignored - only live commitments block.
 */
export async function assertNoOverlap(
  employeeId: string,
  start: Date,
  end: Date,
  excludeRequestId?: string,
): Promise<void> {
  const clash = await prisma.leaveRequest.findFirst({
    where: {
      employeeId,
      status: { in: ['PENDING', 'APPROVED'] },
      ...(excludeRequestId ? { NOT: { id: excludeRequestId } } : {}),
      // Two ranges overlap when each starts before the other ends.
      startDate: { lte: end },
      endDate: { gte: start },
    },
    select: { id: true, startDate: true, endDate: true, status: true },
  });

  if (clash) {
    const from = clash.startDate.toISOString().slice(0, 10);
    const to = clash.endDate.toISOString().slice(0, 10);
    throw new ValidationError({
      startDate: [
        `That overlaps leave you already have from ${from} to ${to} (${clash.status.toLowerCase()}).`,
      ],
    });
  }
}

/**
 * Carry-forward for a year boundary.
 *
 * Applies the leave type's cap and writes the result as next year's opening
 * balance. Exposed so an administrator can run it deliberately rather than it
 * happening invisibly on a schedule.
 */
export async function carryForwardYear(
  companyId: string,
  fromYear: number,
): Promise<{ processed: number }> {
  const types = await prisma.leaveType.findMany({
    where: { companyId, isActive: true, carryForwardEnabled: true },
  });
  if (types.length === 0) return { processed: 0 };

  const employees = await prisma.employee.findMany({
    where: { companyId, status: { not: 'TERMINATED' } },
    select: { id: true },
  });

  let processed = 0;
  for (const employee of employees) {
    const balances = await balancesForEmployee(companyId, employee.id, fromYear);

    for (const type of types) {
      const balance = balances.find((b) => b.leaveTypeId === type.id);
      if (!balance) continue;

      const cap = type.carryForwardCapDays === null ? Infinity : toNumber(type.carryForwardCapDays);
      const carried = Math.max(0, Math.min(balance.availableDays, cap));

      await prisma.leaveBalance.upsert({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: employee.id,
            leaveTypeId: type.id,
            year: fromYear + 1,
          },
        },
        create: {
          companyId,
          employeeId: employee.id,
          leaveTypeId: type.id,
          year: fromYear + 1,
          openingDays: carried,
        },
        update: { openingDays: carried },
      });
      processed += 1;
    }
  }

  return { processed };
}
