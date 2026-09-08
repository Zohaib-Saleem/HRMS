import type { Prisma } from '@prisma/client';

/**
 * Shift assignment intervals.
 *
 * An assignment is a half-open-ended date range: `effectiveFrom` is inclusive,
 * `effectiveTo` is inclusive when set and means "still in force" when null.
 * `shiftOnDate` resolves a day by taking the latest assignment that covers it,
 * so two assignments covering the same day do not error - one of them simply
 * wins, silently and by insertion order. That is the failure this module
 * exists to prevent: the wrong shift on a day is indistinguishable from the
 * right one once it has been scored into an attendance record.
 *
 * The database has no constraint for this (the indexes on
 * `employee_shift_assignments` are not unique), so the check has to happen
 * before the insert.
 */

export interface DateRange {
  effectiveFrom: Date;
  /** Null means open-ended. */
  effectiveTo: Date | null;
}

/**
 * Whether two assignment ranges cover any day in common.
 *
 * Null `effectiveTo` is treated as +infinity rather than as "no end date",
 * which is what makes an open-ended assignment overlap everything after it.
 */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  const aStartsAfterBEnds = b.effectiveTo !== null && a.effectiveFrom > b.effectiveTo;
  const bStartsAfterAEnds = a.effectiveTo !== null && b.effectiveFrom > a.effectiveTo;
  return !aStartsAfterBEnds && !bStartsAfterAEnds;
}

/** True when the range is back to front, which is always a mistake. */
export function isInvertedRange(range: DateRange): boolean {
  return range.effectiveTo !== null && range.effectiveTo < range.effectiveFrom;
}

/**
 * A `where` fragment matching every assignment for one employee that would
 * overlap the given range.
 *
 * Expressed as the negation of "ends before this starts" and "starts after this
 * ends", so the null cases fall out of the query rather than needing a second
 * branch.
 */
export function overlappingAssignmentWhere(
  employeeId: string,
  range: DateRange,
): Prisma.EmployeeShiftAssignmentWhereInput {
  return {
    employeeId,
    // existing.effectiveTo >= new.effectiveFrom, or the existing one is open.
    AND: [
      { OR: [{ effectiveTo: null }, { effectiveTo: { gte: range.effectiveFrom } }] },
      // existing.effectiveFrom <= new.effectiveTo, or the new one is open.
      ...(range.effectiveTo === null
        ? []
        : [{ effectiveFrom: { lte: range.effectiveTo } }]),
    ],
  };
}
