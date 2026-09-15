import {
  EMPLOYMENT_STATUS_LABELS,
  MEDICAL_CATEGORY_LABELS,
  isEmploymentStatusEligible,
  type EmploymentStatus,
  type MedicalCategoryEntitlement,
  type MedicalEligibilityFailure,
  type MedicalEligibilityResult,
  type MedicalEligibilityRule,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
/*
 * Borrowed from the loans module rather than rewritten.
 *
 * "How long have they served" and "are they on probation" are facts about an
 * employment record, not about a loan, and the second one in particular is
 * subtle: an ACTIVE probation contract, the roster's own "Probation" wording,
 * or a confirmation date that has not arrived, with a MISSING confirmation date
 * deliberately not read as probation. A second implementation of that would
 * eventually disagree with the first about one person, and the person would be
 * told they are on probation by one screen and not by another.
 *
 * Imported, not moved: nothing in the loans module is changed by this.
 */
import { completedMonths, isOnProbation } from '../loans/loan-eligibility.service.js';
import { currentMedicalPolicy, toCategoryRecords, type MedicalPolicyRow } from './medical-policy.service.js';

/**
 * Whether an employee's medical benefit reaches them, and if not, why not.
 *
 * The one place the question is answered. The browser calls it to draw a
 * screen, and the claim endpoints call it again to decide - the
 * second call is the gate, and it re-reads the employee and the policy from the
 * database rather than trusting anything that arrived in the request. Nothing
 * an employee can put in a payload reaches a threshold: the subject is resolved
 * from the session by the route, and every limit comes from the policy row.
 *
 * Not one company rule is written here. Every number this function compares
 * against - the waiting period, the annual limit, whether probation counts,
 * whether a resignation blocks the benefit - is read from the policy version in
 * force. Changing any of them is a settings screen, not a deployment.
 *
 * It writes nothing.
 */

export interface MedicalEligibilityInput {
  companyId: string;
  employeeId: string;
  now?: Date;
  /**
   * The policy to judge against, when the caller has already resolved it.
   * Passed by the benefit summary so one request reads one policy - two reads
   * could straddle the instant a scheduled version takes effect and produce a
   * screen whose eligibility and whose limits came from different rules.
   */
  policy?: MedicalPolicyRow;
}

/**
 * Statuses that mean somebody is currently employed here.
 *
 * ON_LEAVE counts. Somebody on leave is still employed, and being on sick leave
 * is if anything the likeliest moment for a medical benefit to matter - a rule
 * that switched their cover off while they were ill would be the exact opposite
 * of the product's intent.
 *
 * TERMINATED and RESIGNED are absent on purpose: whether those block the
 * benefit is the POLICY's decision, made below, not this list's.
 */
const EMPLOYED_STATUSES = ['ACTIVE', 'ON_LEAVE'] as const;

/** The employment statuses the policy has an explicit switch for. */
const POLICY_GOVERNED_STATUSES = ['TERMINATED', 'RESIGNED'] as const;

export function categoryEntitlements(policy: MedicalPolicyRow): MedicalCategoryEntitlement[] {
  return toCategoryRecords(policy).map((c) => ({
    category: c.category,
    label: MEDICAL_CATEGORY_LABELS[c.category],
    enabled: c.enabled,
    annualLimit: c.annualLimit,
    maxClaimAmount: c.maxClaimAmount,
    companyContributionPercent: c.companyContributionPercent,
    employeeContributionPercent: c.employeeContributionPercent,
  }));
}

export async function evaluateMedicalEligibility(
  input: MedicalEligibilityInput,
): Promise<MedicalEligibilityResult> {
  const now = input.now ?? new Date();
  const failures: MedicalEligibilityFailure[] = [];
  const warnings: string[] = [];
  const fail = (rule: MedicalEligibilityRule, message: string) => failures.push({ rule, message });

  const [policy, company] = await Promise.all([
    input.policy ?? currentMedicalPolicy(input.companyId, now),
    prisma.company.findUniqueOrThrow({
      where: { id: input.companyId },
      select: { currency: true },
    }),
  ]);

  const version = {
    id: policy.id,
    name: policy.policyName,
    effectiveFrom: policy.effectiveFrom.toISOString(),
  };
  const benefitLimit = Number(policy.annualLimitPerEmployee);
  const categoryLimits = categoryEntitlements(policy);

  const employee = await prisma.employee.findFirst({
    where: { id: input.employeeId, companyId: input.companyId },
    select: {
      id: true,
      status: true,
      hireDate: true,
      confirmationDate: true,
      employmentStatus: true,
      contracts: {
        where: { status: 'ACTIVE', contractType: 'PROBATION' },
        select: { id: true },
        take: 1,
      },
    },
  });

  // --- 1. the employee exists ------------------------------------------------
  if (!employee) {
    return {
      eligible: false,
      reasons: ['There is no employee record to assess a medical benefit against.'],
      failedRules: ['EMPLOYEE_RECORD'],
      failures: [
        {
          rule: 'EMPLOYEE_RECORD',
          message: 'There is no employee record to assess a medical benefit against.',
        },
      ],
      warnings: [],
      policyVersion: version,
      benefitLimit,
      categoryLimits,
      currency: company.currency,
      employment: {
        status: 'UNKNOWN',
        employmentStatus: null,
        monthsServed: null,
        onProbation: false,
      },
    };
  }

  const onProbation = isOnProbation(employee, now);
  const monthsServed = employee.hireDate ? completedMonths(employee.hireDate, now) : null;

  // --- 2. the benefit is switched on at all ---------------------------------
  //
  // Checked before anything about the person. When the benefit is off, nobody
  // is eligible and the reason has nothing to do with them - saying "you have
  // not served three months" to somebody at a company with no medical benefit
  // would send them to HR with the wrong question.
  if (!policy.enabled) {
    fail(
      'BENEFIT_DISABLED',
      'The company medical benefit is currently switched off, so no one is eligible.',
    );
  }

  // --- 3. employment status --------------------------------------------------
  if ((POLICY_GOVERNED_STATUSES as readonly string[]).includes(employee.status)) {
    if (policy.blockTerminated && employee.status === 'TERMINATED') {
      fail('EMPLOYMENT_STATUS', 'Your employment record is marked terminated.');
    }
    if (policy.blockResigned && employee.status === 'RESIGNED') {
      fail('EMPLOYMENT_STATUS', 'Your employment record is marked resigned.');
    }
  } else if (!(EMPLOYED_STATUSES as readonly string[]).includes(employee.status)) {
    /*
     * SUSPENDED or INACTIVE.
     *
     * Not policy-configurable, and deliberately so: these are not "should the
     * company cover this group" questions with a defensible answer either way,
     * they are records that are parked. The policy's own switches cover the two
     * statuses a company genuinely decides about, which are the two above.
     */
    fail(
      'EMPLOYMENT_STATUS',
      'Your employment record is not currently active, so the medical benefit does not apply.',
    );
  }

  // --- 4. length of service --------------------------------------------------
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

  // --- 5. probation ----------------------------------------------------------
  if (onProbation && !policy.allowProbation) {
    fail('PROBATION', 'Employees on probation are not covered while probation cover is off.');
  }

  // --- 6. employment status --------------------------------------------------
  //
  // The employee's own `employmentStatus` column, measured against the policy's
  // three switches. The SAME column and the SAME function the loan engine uses,
  // so the two benefits cannot end up disagreeing about the same person - which
  // is the entire reason medical does not keep an employment-status field of
  // its own.
  //
  // This used to read `!onProbation` as "permanent", which was true only while
  // there were two kinds of employee. An internee is neither, and under the old
  // test would have been refused or covered according to the PERMANENT switch -
  // a decision nobody made. Now each status answers to its own setting, and a
  // company running a benefit for probationers only, or for interns only, is
  // unusual and none of this code's business to rule out.
  const employmentStatus = employee.employmentStatus as EmploymentStatus | null;
  if (employmentStatus !== 'PROBATION' && !isEmploymentStatusEligible(policy, employmentStatus)) {
    fail(
      employmentStatus === 'PERMANENT' ? 'PERMANENT_NOT_ALLOWED' : 'EMPLOYMENT_STATUS',
      `${EMPLOYMENT_STATUS_LABELS[employmentStatus as EmploymentStatus]} employees are not covered under the current medical policy.`,
    );
  }

  // --- warnings: true, and not blocking -------------------------------------
  if (policy.enabled && failures.length === 0 && benefitLimit <= 0) {
    warnings.push(
      'The annual medical limit is currently set to zero, so there is nothing to claim against.',
    );
  }
  if (failures.length === 0 && categoryLimits.every((c) => !c.enabled)) {
    warnings.push('Every medical category is currently switched off.');
  }

  return {
    eligible: failures.length === 0,
    reasons: failures.map((f) => f.message),
    failedRules: failures.map((f) => f.rule),
    failures,
    warnings,
    policyVersion: version,
    benefitLimit,
    categoryLimits,
    currency: company.currency,
    employment: {
      status: employee.status,
      employmentStatus,
      monthsServed,
      onProbation,
    },
  };
}
