import type { LoanPolicy, Prisma } from '@prisma/client';
import {
  LOAN_POLICY_DEFAULTS,
  LOAN_POLICY_LABELS,
  LOAN_EVALUATION_MONTHS,
  type LoanEvaluationMonths,
  type LoanPolicyFieldChange,
  type LoanPolicyHistoryEntry,
  type LoanPolicyInput,
  type LoanPolicyRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { toNumber } from './loans.service.js';

/**
 * Reading and writing the loan policy.
 *
 * Versions are immutable. Nothing in this file updates a policy row - saving a
 * change creates a new one - so the rules that governed an application made
 * last March can still be read in full today, and a loan already on file can
 * never be re-judged by rules written after it.
 *
 * The policy in force at an instant is the newest version at or before it.
 * That single sentence is the whole resolution rule, and it is implemented once
 * here so the eligibility engine, the settings screen and the history all agree.
 */

/**
 * The first version starts at the epoch.
 *
 * Not "now": a policy created today with effectiveFrom = today would leave
 * every application ever submitted with no policy behind it, and "which rules
 * applied to this loan?" would have no answer for the whole existing history.
 * Starting at the epoch means the defaults are, retroactively, what the company
 * had always been operating - which is true, because they are the behaviour the
 * product shipped with.
 */
const EPOCH = new Date(0);

export type LoanPolicyRow = LoanPolicy;

/**
 * The policy in force at `at`, creating the seeded default if none exists.
 *
 * The seed is written with `upsert` on the [companyId, effectiveFrom] unique
 * index rather than find-then-create: two requests arriving together on a fresh
 * company would otherwise both find nothing and both insert, and a company
 * would end up with two "first" policies. The upsert makes the loser of that
 * race read the winner's row.
 */
export async function resolveLoanPolicyAt(companyId: string, at: Date): Promise<LoanPolicyRow> {
  const inForce = await prisma.loanPolicy.findFirst({
    where: { companyId, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (inForce) return inForce;

  return prisma.loanPolicy.upsert({
    where: { companyId_effectiveFrom: { companyId, effectiveFrom: EPOCH } },
    update: {},
    create: { companyId, effectiveFrom: EPOCH, ...defaultsForCreate() },
  });
}

/** The policy governing anything decided right now. */
export function currentLoanPolicy(companyId: string, now = new Date()): Promise<LoanPolicyRow> {
  return resolveLoanPolicyAt(companyId, now);
}

/**
 * A version saved with a future effective date, if there is one.
 *
 * Shown on the settings screen so an administrator who scheduled a change can
 * see it waiting rather than wondering why the form still reads the old value.
 */
export async function scheduledLoanPolicy(
  companyId: string,
  now = new Date(),
): Promise<LoanPolicyRow | null> {
  return prisma.loanPolicy.findFirst({
    where: { companyId, effectiveFrom: { gt: now } },
    orderBy: { effectiveFrom: 'asc' },
  });
}

function defaultsForCreate(): Omit<Prisma.LoanPolicyCreateInput, 'company' | 'effectiveFrom'> {
  const d = LOAN_POLICY_DEFAULTS;
  return {
    maxSalaryMultiplier: d.maxSalaryMultiplier,
    minEmploymentMonths: d.minEmploymentMonths,
    allowProbation: d.allowProbation,
    allowPermanent: d.allowPermanent,
    allowInternee: d.allowInternee,
    minSalary: d.minSalary,
    minAttendancePercent: d.minAttendancePercent,
    maxUnapprovedAbsences: d.maxUnapprovedAbsences,
    maxLateDays: d.maxLateDays,
    maxMissingPunches: d.maxMissingPunches,
    evaluationMonths: d.evaluationMonths,
    maxMonthlyDeductionPercent: d.maxMonthlyDeductionPercent,
    maxTenureMonths: d.maxTenureMonths,
    maxInstallments: d.maxInstallments,
    oneActiveLoan: d.oneActiveLoan,
    onePendingLoan: d.onePendingLoan,
    blockTerminated: d.blockTerminated,
    blockResigned: d.blockResigned,
    allowHrOverride: d.allowHrOverride,
    requireOverrideReason: d.requireOverrideReason,
  };
}

/**
 * A stored row as the settings form reads it.
 *
 * `evaluationMonths` is narrowed back to the offered set on the way out. The
 * column is a plain integer, so a row edited directly in the database could
 * carry 7; the form has no such option and would render blank. Falling back to
 * the default is the honest reading of a value the policy does not define.
 */
export function toLoanPolicyRecord(
  row: LoanPolicyRow,
  input: { createdByName: string | null; isCurrent: boolean },
): LoanPolicyRecord {
  return {
    id: row.id,
    maxSalaryMultiplier: toNumber(row.maxSalaryMultiplier),
    minEmploymentMonths: row.minEmploymentMonths,
    allowProbation: row.allowProbation,
    allowPermanent: row.allowPermanent,
    allowInternee: row.allowInternee,
    minAttendancePercent: toNumber(row.minAttendancePercent),
    maxUnapprovedAbsences: row.maxUnapprovedAbsences,
    maxLateDays: row.maxLateDays,
    maxMissingPunches: row.maxMissingPunches,
    evaluationMonths: normaliseEvaluationMonths(row.evaluationMonths),
    maxMonthlyDeductionPercent: toNumber(row.maxMonthlyDeductionPercent),
    oneActiveLoan: row.oneActiveLoan,
    onePendingLoan: row.onePendingLoan,
    blockTerminated: row.blockTerminated,
    blockResigned: row.blockResigned,
    minSalary: toNumber(row.minSalary),
    maxTenureMonths: row.maxTenureMonths,
    maxInstallments: row.maxInstallments,
    allowHrOverride: row.allowHrOverride,
    requireOverrideReason: row.requireOverrideReason,
    effectiveFrom: row.effectiveFrom.toISOString(),
    createdAt: row.createdAt.toISOString(),
    createdByName: input.createdByName,
    isCurrent: input.isCurrent,
  };
}

export function normaliseEvaluationMonths(value: number): LoanEvaluationMonths {
  return (LOAN_EVALUATION_MONTHS as readonly number[]).includes(value)
    ? (value as LoanEvaluationMonths)
    : LOAN_POLICY_DEFAULTS.evaluationMonths;
}

/** The policy fields, in the order the settings screen lists them. */
const POLICY_FIELDS = [
  'maxSalaryMultiplier',
  'minEmploymentMonths',
  'allowProbation',
  'allowPermanent',
  'allowInternee',
  'minAttendancePercent',
  'evaluationMonths',
  'minSalary',
  'maxUnapprovedAbsences',
  'maxLateDays',
  'maxMissingPunches',
  'oneActiveLoan',
  'onePendingLoan',
  'maxTenureMonths',
  'maxInstallments',
  'maxMonthlyDeductionPercent',
  'blockTerminated',
  'blockResigned',
  'allowHrOverride',
  'requireOverrideReason',
] as const satisfies ReadonlyArray<keyof LoanPolicyInput>;

const asText = (value: number | boolean): string =>
  typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);

/**
 * What changed between two consecutive versions.
 *
 * Derived rather than stored. A change log written alongside the values it
 * describes is a second copy of them, and a second copy eventually disagrees -
 * so the history is computed from the versions themselves, which are the only
 * record there is.
 */
export function diffPolicies(
  previous: LoanPolicyRecord | null,
  next: LoanPolicyRecord,
): LoanPolicyFieldChange[] {
  if (!previous) return [];

  const changes: LoanPolicyFieldChange[] = [];
  for (const field of POLICY_FIELDS) {
    const from = previous[field];
    const to = next[field];
    if (from === to) continue;
    changes.push({
      field,
      label: LOAN_POLICY_LABELS[field],
      from: asText(from),
      to: asText(to),
    });
  }
  return changes;
}

/**
 * The change history, newest first.
 *
 * One extra row is read beyond the page so the oldest entry on it can still be
 * diffed against its predecessor. Without it the last row of every page would
 * report every field as unchanged.
 */
export async function loanPolicyHistory(
  companyId: string,
  page: number,
  limit: number,
): Promise<{ entries: LoanPolicyHistoryEntry[]; total: number }> {
  const skip = (page - 1) * limit;

  const [total, rows] = await Promise.all([
    prisma.loanPolicy.count({ where: { companyId } }),
    prisma.loanPolicy.findMany({
      where: { companyId },
      orderBy: { effectiveFrom: 'desc' },
      skip,
      take: limit + 1,
    }),
  ]);

  const authorNames = await namesForUsers(rows.map((r) => r.createdBy));

  const entries: LoanPolicyHistoryEntry[] = [];
  for (let i = 0; i < Math.min(rows.length, limit); i += 1) {
    const row = rows[i]!;
    const previous = rows[i + 1] ?? null;
    const record = toLoanPolicyRecord(row, { createdByName: null, isCurrent: false });
    const previousRecord = previous
      ? toLoanPolicyRecord(previous, { createdByName: null, isCurrent: false })
      : null;

    entries.push({
      id: row.id,
      effectiveFrom: row.effectiveFrom.toISOString(),
      changedAt: row.createdAt.toISOString(),
      changedByName: row.createdBy ? (authorNames.get(row.createdBy) ?? null) : null,
      changes: diffPolicies(previousRecord, record),
    });
  }

  return { entries, total };
}

/**
 * Who saved a version.
 *
 * The employee's name where the user has one, falling back to the account's own
 * name: an administrator is not always on the payroll.
 */
export async function namesForUsers(
  ids: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: wanted } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      employee: { select: { firstName: true, lastName: true, displayName: true } },
    },
  });

  return new Map(
    users.map((u) => {
      const e = u.employee;
      const employeeName = e ? (e.displayName ?? `${e.firstName} ${e.lastName}`.trim()) : '';
      const accountName = `${u.firstName} ${u.lastName}`.trim();
      return [u.id, employeeName || accountName || u.email];
    }),
  );
}

/**
 * Save a new version.
 *
 * Always an insert. The unique index on [companyId, effectiveFrom] is what
 * stops two administrators saving different rules for the same instant; the
 * route turns that collision into a message rather than a 500.
 */
export async function saveLoanPolicy(input: {
  companyId: string;
  values: LoanPolicyInput;
  userId: string;
  effectiveFrom: Date;
}): Promise<LoanPolicyRow> {
  const v = input.values;
  return prisma.loanPolicy.create({
    data: {
      companyId: input.companyId,
      effectiveFrom: input.effectiveFrom,
      createdBy: input.userId,
      maxSalaryMultiplier: v.maxSalaryMultiplier,
      minEmploymentMonths: v.minEmploymentMonths,
      allowProbation: v.allowProbation,
      allowPermanent: v.allowPermanent,
      allowInternee: v.allowInternee,
      minSalary: v.minSalary,
      minAttendancePercent: v.minAttendancePercent,
      maxUnapprovedAbsences: v.maxUnapprovedAbsences,
      maxLateDays: v.maxLateDays,
      maxMissingPunches: v.maxMissingPunches,
      evaluationMonths: v.evaluationMonths,
      maxMonthlyDeductionPercent: v.maxMonthlyDeductionPercent,
      maxTenureMonths: v.maxTenureMonths,
      maxInstallments: v.maxInstallments,
      oneActiveLoan: v.oneActiveLoan,
      onePendingLoan: v.onePendingLoan,
      blockTerminated: v.blockTerminated,
      blockResigned: v.blockResigned,
      allowHrOverride: v.allowHrOverride,
      requireOverrideReason: v.requireOverrideReason,
    },
  });
}
