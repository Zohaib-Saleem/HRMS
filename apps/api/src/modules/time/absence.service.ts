import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/db.js';
import { toDateOnly } from '../leave/leave.service.js';
import { deriveRangeForEmployees } from './attendance.service.js';

/**
 * Automatic absence finalisation.
 *
 * A missing check-in already *displays* as absent, because the derivation
 * classifies every calendar day. That is fine for a screen and useless for a
 * report: nothing is stored, so nothing can be counted, corrected or approved.
 * This job turns the inference into a record.
 *
 * Three properties matter more than anything else here:
 *
 *   - it is idempotent. Absences are inserted with `skipDuplicates` against the
 *     (employeeId, date) unique index, so a second run - or two runs racing -
 *     inserts nothing and reports zero.
 *   - it never overwrites. Only days with no record at all are touched, so a
 *     manual correction, an approved regularisation or a real check-in is
 *     always left exactly as it is.
 *   - it agrees with the calendar. It reuses the same derivation the UI reads,
 *     so weekends, holidays and approved leave are excluded by construction
 *     rather than by a second copy of the rules that can drift.
 */

export interface AbsenceRunResult {
  date: string;
  /** Employees considered - i.e. employed on the date and in scope. */
  scanned: number;
  marked: number;
  skipped: {
    notWorkingDay: number;
    onLeave: number;
    alreadyRecorded: number;
  };
}

const NON_WORKING = new Set(['WEEKEND', 'HOLIDAY']);

/**
 * Marks absent every in-scope employee with no record for `date`.
 *
 * `employeeFilter` is the caller's data-scope fragment. It is applied to the
 * employee query, so a manager running this for their team cannot reach anyone
 * else - the job carries no ambient authority of its own.
 */
export async function markAbsencesForDate(input: {
  companyId: string;
  date: Date;
  employeeFilter?: Prisma.EmployeeWhereInput;
}): Promise<AbsenceRunResult> {
  const date = toDateOnly(input.date);
  const key = date.toISOString().slice(0, 10);

  const employees = await prisma.employee.findMany({
    where: {
      AND: [
        { companyId: input.companyId },
        // Someone who had not started, or had already left, cannot be absent.
        { status: { not: 'TERMINATED' } },
        { OR: [{ hireDate: null }, { hireDate: { lte: date } }] },
        { OR: [{ terminationDate: null }, { terminationDate: { gte: date } }] },
        input.employeeFilter ?? {},
      ],
    },
    select: { id: true, locationId: true },
  });

  const result: AbsenceRunResult = {
    date: key,
    scanned: employees.length,
    marked: 0,
    skipped: { notWorkingDay: 0, onLeave: 0, alreadyRecorded: 0 },
  };

  if (employees.length === 0) return result;

  const derived = await deriveRangeForEmployees(input.companyId, employees, date, date);

  const toCreate: Prisma.AttendanceRecordCreateManyInput[] = [];

  for (const employee of employees) {
    const day = derived.get(employee.id)?.[0];
    if (!day) continue;

    if (NON_WORKING.has(day.status)) {
      result.skipped.notWorkingDay += 1;
      continue;
    }
    if (day.status === 'ON_LEAVE') {
      result.skipped.onLeave += 1;
      continue;
    }
    if (day.hasRecord) {
      result.skipped.alreadyRecorded += 1;
      continue;
    }

    toCreate.push({
      companyId: input.companyId,
      employeeId: employee.id,
      date,
      status: 'ABSENT',
      source: 'SYSTEM',
      notes: 'Marked absent automatically: no attendance was recorded for this working day.',
    });
  }

  if (toCreate.length > 0) {
    // skipDuplicates makes the insert safe to repeat and safe to race: the
    // (employeeId, date) unique index is the authority, not this process.
    const created = await prisma.attendanceRecord.createMany({
      data: toCreate,
      skipDuplicates: true,
    });
    result.marked = created.count;
    result.skipped.alreadyRecorded += toCreate.length - created.count;
  }

  return result;
}

/**
 * The scheduled pass: finalise yesterday for every company.
 *
 * Yesterday, not today - a day still in progress has people who simply have not
 * arrived yet, and marking them absent at 09:00 would be wrong for hours before
 * it became right.
 */
export async function markAbsencesForPreviousDay(): Promise<AbsenceRunResult[]> {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const date = toDateOnly(yesterday);

  const companies = await prisma.company.findMany({ select: { id: true } });

  const results: AbsenceRunResult[] = [];
  for (const company of companies) {
    results.push(await markAbsencesForDate({ companyId: company.id, date }));
  }

  return results;
}
