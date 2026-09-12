import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEDICAL_POLICY_DEFAULTS, defaultCategoryLimits, splitContribution } from '@hrms/shared';

/**
 * The medical claim rules engine.
 *
 * The rule this file exists to hold down: not one company threshold is written
 * in the engine. Every assertion below moves a POLICY value and expects the
 * verdict to move with it - so a test passing here is evidence the number came
 * from the database, and a company that edits the settings screen gets the
 * behaviour these tests describe without a deployment.
 *
 * The second rule: the server decides. The engine takes an employee id and
 * reads the policy, the claims already on file and the dependents itself.
 * Nothing a claimant could put in a payload reaches a threshold.
 */

const db = vi.hoisted(() => ({
  company: { findUniqueOrThrow: vi.fn() },
  employee: { findFirst: vi.fn() },
  medicalPolicy: { findFirst: vi.fn(), upsert: vi.fn() },
  medicalDependent: { findMany: vi.fn() },
  medicalClaim: { findMany: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { assessMedicalClaim, daysBetween, yearPosition } = await import('./medical-claim.service.js');

/** Fixed so "how many days ago" is a fact rather than a race with midnight. */
const NOW = new Date('2026-09-12T10:00:00Z');
const TODAY = '2026-09-12';
const daysAgo = (n: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);

const policy = (overrides: Record<string, unknown> = {}, categoryOverrides: Record<string, unknown> = {}) => ({
  id: 'pol-1',
  companyId: 'company-1',
  ...MEDICAL_POLICY_DEFAULTS,
  categories: defaultCategoryLimits().map((c, i) => ({
    id: `cat-${i}`,
    policyId: 'pol-1',
    ...c,
    ...(c.category === 'OPD' ? categoryOverrides : {}),
  })),
  effectiveFrom: new Date('2020-01-01T00:00:00Z'),
  createdAt: new Date('2020-01-01T00:00:00Z'),
  updatedAt: new Date('2020-01-01T00:00:00Z'),
  createdBy: null,
  ...overrides,
});

const employee = (overrides: Record<string, unknown> = {}) => ({
  id: 'emp-1',
  status: 'ACTIVE',
  hireDate: new Date('2024-01-15T00:00:00Z'),
  confirmationDate: new Date('2024-04-15T00:00:00Z'),
  confirmationStatus: 'Permanent',
  contracts: [],
  ...overrides,
});

const claimRow = (overrides: Record<string, unknown> = {}) => ({
  status: 'PAID',
  companyAmount: 0,
  requestedAmount: 0,
  treatmentDate: new Date('2026-03-01T00:00:00Z'),
  submittedAt: new Date('2026-03-02T00:00:00Z'),
  category: 'OPD',
  policy: { id: 'pol-1' },
  ...overrides,
});

const assess = (overrides: Record<string, unknown> = {}) =>
  assessMedicalClaim({
    companyId: 'company-1',
    employeeId: 'emp-1',
    category: 'OPD',
    treatmentDate: TODAY,
    requestedAmount: 5_000,
    providerName: 'City Clinic',
    documentTypes: ['RECEIPT'],
    now: NOW,
    ...overrides,
  } as Parameters<typeof assessMedicalClaim>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  db.company.findUniqueOrThrow.mockResolvedValue({ currency: 'PKR' });
  db.medicalPolicy.findFirst.mockResolvedValue(policy());
  db.employee.findFirst.mockResolvedValue(employee());
  db.medicalDependent.findMany.mockResolvedValue([]);
  db.medicalClaim.findMany.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe('the ordinary claim', () => {
  it('is allowed, and quotes the split the policy produces', async () => {
    const result = await assess();

    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
    // The default policy has the company paying in full.
    expect(result.companyAmount).toBe(5_000);
    expect(result.employeeAmount).toBe(0);
  });

  it('splits by the category percentages, not by a constant', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(
      policy({}, { companyContributionPercent: 80, employeeContributionPercent: 20 }),
    );

    const result = await assess();

    expect(result.companyAmount).toBe(4_000);
    expect(result.employeeAmount).toBe(1_000);
    expect(result.warnings.join(' ')).toContain('own share');
  });

  it('names the policy version that decided it', async () => {
    const result = await assess();

    expect(result.policyVersion.id).toBe('pol-1');
  });

  it('reports what a claim has to carry, so the form can mark it up front', async () => {
    const result = await assess();

    expect(result.requiredDocuments).toEqual(['RECEIPT']);
    expect(result.requireProviderName).toBe(true);
    expect(result.requireTreatmentDate).toBe(true);
  });
});

describe('the split adds up, whatever the percentages', () => {
  it.each([
    [1_000, 100],
    [1_000, 0],
    [333.33, 33.33],
    [99.99, 50],
    [10_000.05, 70],
  ])('%s at %s%% divides without losing a unit', (amount, percent) => {
    const { companyAmount, employeeAmount } = splitContribution(amount, percent);
    expect(Math.round((companyAmount + employeeAmount) * 100) / 100).toBe(amount);
  });
});

describe('eligibility comes first', () => {
  it('refuses a claim from somebody the benefit does not reach', async () => {
    db.employee.findFirst.mockResolvedValue(employee({ hireDate: new Date('2026-08-01T00:00:00Z') }));

    const result = await assess();

    expect(result.allowed).toBe(false);
    expect(result.failedRules).toContain('ELIGIBILITY');
  });

  it('reports the eligibility reason verbatim rather than a claim error', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ enabled: false }));

    const result = await assess();

    expect(result.reasons.join(' ')).toContain('switched off');
  });
});

describe('the category', () => {
  it('refuses a claim against a category that is switched off', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({}, { enabled: false }));

    const result = await assess();

    expect(result.allowed).toBe(false);
    expect(result.failedRules).toContain('CATEGORY_DISABLED');
  });

  it('allows it the moment the category is switched back on', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({}, { enabled: true }));

    expect((await assess()).allowed).toBe(true);
  });
});

describe('dates, every one of them a policy value', () => {
  it('refuses a treatment date in the future', async () => {
    const result = await assess({ treatmentDate: '2026-12-01' });

    expect(result.failedRules).toContain('TREATMENT_DATE_FUTURE');
  });

  it('demands a treatment date while the policy requires one', async () => {
    const result = await assess({ treatmentDate: null });

    expect(result.failedRules).toContain('TREATMENT_DATE_REQUIRED');
  });

  it('accepts a claim with no treatment date once the policy stops requiring one', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ requireTreatmentDate: false }));

    const result = await assess({ treatmentDate: null });

    expect(result.allowed).toBe(true);
  });

  it('refuses a claim past the submission deadline', async () => {
    // Default deadline is 30 days; backdating is allowed to 30.
    const result = await assess({ treatmentDate: daysAgo(45) });

    expect(result.failedRules).toContain('SUBMISSION_DEADLINE');
  });

  it('accepts it once the deadline is lengthened', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(
      policy({ claimSubmissionDeadlineDays: 90, maxBackdatedDays: 90 }),
    );

    const result = await assess({ treatmentDate: daysAgo(45) });

    expect(result.allowed).toBe(true);
  });

  it('refuses anything but today when backdating is switched off', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ allowBackdatedClaims: false }));

    const result = await assess({ treatmentDate: daysAgo(1) });

    expect(result.failedRules).toContain('BACKDATED_NOT_ALLOWED');
  });

  it('still accepts today when backdating is switched off', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ allowBackdatedClaims: false }));

    expect((await assess({ treatmentDate: TODAY })).allowed).toBe(true);
  });

  it('refuses treatment older than the backdating limit', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(
      policy({ maxBackdatedDays: 7, claimSubmissionDeadlineDays: 365 }),
    );

    const result = await assess({ treatmentDate: daysAgo(20) });

    expect(result.failedRules).toContain('BACKDATED_LIMIT');
    expect(result.failedRules).not.toContain('SUBMISSION_DEADLINE');
  });

  it('reports both date rules when both are broken', async () => {
    const result = await assess({ treatmentDate: daysAgo(100) });

    expect(result.failedRules).toContain('BACKDATED_LIMIT');
    expect(result.failedRules).toContain('SUBMISSION_DEADLINE');
  });

  it('counts whole days between two calendar days', () => {
    expect(daysBetween('2026-09-01', '2026-09-12')).toBe(11);
    expect(daysBetween('2026-09-12', '2026-09-12')).toBe(0);
  });
});

describe('what a claim has to carry', () => {
  it('demands the provider while the policy requires it', async () => {
    const result = await assess({ providerName: null });

    expect(result.failedRules).toContain('PROVIDER_REQUIRED');
  });

  it('stops demanding it when the policy stops', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ requireHospitalName: false }));

    expect((await assess({ providerName: null })).allowed).toBe(true);
  });

  it('demands a receipt while the policy requires one', async () => {
    const result = await assess({ documentTypes: [] });

    expect(result.failedRules).toContain('DOCUMENT_REQUIRED');
  });

  it('demands a prescription too, once the policy asks for one', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ requirePrescription: true }));

    const result = await assess({ documentTypes: ['RECEIPT'] });

    expect(result.failedRules).toContain('DOCUMENT_REQUIRED');
    expect(result.reasons.join(' ')).toContain('prescription');
  });

  it('is satisfied when every required document is attached', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(
      policy({ requirePrescription: true, requireDiagnosis: true }),
    );

    const result = await assess({ documentTypes: ['RECEIPT', 'PRESCRIPTION', 'DIAGNOSIS'] });

    expect(result.allowed).toBe(true);
  });

  it('checks nothing when the caller has not started attaching yet', async () => {
    // The preview: an empty list is a form nobody has filled in, and is not the
    // same statement as "this claim has no receipt".
    const result = await assess({ documentTypes: undefined });

    expect(result.failedRules).not.toContain('DOCUMENT_REQUIRED');
  });
});

describe('the money', () => {
  it('refuses a claim over the category maximum', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({}, { maxClaimAmount: 3_000 }));

    const result = await assess({ requestedAmount: 5_000 });

    expect(result.failedRules).toContain('MAX_CLAIM_AMOUNT');
  });

  it('allows it under a raised maximum', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({}, { maxClaimAmount: 8_000 }));

    expect((await assess({ requestedAmount: 5_000 })).allowed).toBe(true);
  });

  it('refuses a claim that would break the category annual limit', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({}, { annualLimit: 6_000 }));
    db.medicalClaim.findMany.mockResolvedValue([
      claimRow({ status: 'PAID', companyAmount: 4_000, category: 'OPD' }),
    ]);

    const result = await assess({ requestedAmount: 5_000 });

    expect(result.failedRules).toContain('CATEGORY_ANNUAL_LIMIT');
    expect(result.categoryAvailable).toBe(2_000);
  });

  it('refuses a claim that would break the employee annual limit', async () => {
    db.medicalClaim.findMany.mockResolvedValue([
      claimRow({ status: 'PAID', companyAmount: 98_000 }),
    ]);

    const result = await assess({ requestedAmount: 5_000 });

    expect(result.failedRules).toContain('ANNUAL_LIMIT');
    expect(result.available).toBe(2_000);
  });

  it('counts a PENDING claim against what is available, so a queue cannot spend it twice', async () => {
    db.medicalClaim.findMany.mockResolvedValue([
      claimRow({ status: 'PENDING', requestedAmount: 97_000 }),
    ]);

    const result = await assess({ requestedAmount: 5_000 });

    expect(result.failedRules).toContain('ANNUAL_LIMIT');
    expect(result.pending).toBe(97_000);
    expect(result.used).toBe(0);
  });

  it('follows the annual limit up when the policy raises it', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ annualLimitPerEmployee: 250_000 }));
    db.medicalClaim.findMany.mockResolvedValue([
      claimRow({ status: 'PAID', companyAmount: 98_000 }),
    ]);

    expect((await assess({ requestedAmount: 5_000 })).allowed).toBe(true);
  });

  it('measures the limit against the COMPANY share, not the claimed amount', async () => {
    // At 50/50 a 10,000 claim only draws 5,000 from the benefit.
    db.medicalPolicy.findFirst.mockResolvedValue(
      policy({}, { companyContributionPercent: 50, employeeContributionPercent: 50 }),
    );
    db.medicalClaim.findMany.mockResolvedValue([
      claimRow({ status: 'PAID', companyAmount: 94_000 }),
    ]);

    const result = await assess({ requestedAmount: 10_000 });

    expect(result.companyAmount).toBe(5_000);
    expect(result.allowed).toBe(true);
  });

  it('refuses an amount of zero', async () => {
    const result = await assess({ requestedAmount: 0 });

    expect(result.failedRules).toContain('AMOUNT');
  });
});

describe('the benefit year', () => {
  it('leaves last year’s claims out of this year’s balance', async () => {
    db.medicalClaim.findMany.mockResolvedValue([
      claimRow({ status: 'PAID', companyAmount: 90_000, treatmentDate: new Date('2025-03-01T00:00:00Z') }),
    ]);

    const result = await assess({ requestedAmount: 50_000 });

    expect(result.used).toBe(0);
    expect(result.allowed).toBe(true);
  });

  it('files a claim with no treatment date under the year it was submitted', async () => {
    const position = await yearPosition({
      companyId: 'company-1',
      employeeId: 'emp-1',
      year: 2026,
    });
    expect(position.used).toBe(0);

    db.medicalClaim.findMany.mockResolvedValue([
      claimRow({
        status: 'PAID',
        companyAmount: 1_000,
        treatmentDate: null,
        submittedAt: new Date('2026-05-05T00:00:00Z'),
      }),
    ]);

    const inYear = await yearPosition({ companyId: 'company-1', employeeId: 'emp-1', year: 2026 });
    const otherYear = await yearPosition({ companyId: 'company-1', employeeId: 'emp-1', year: 2025 });

    expect(inYear.used).toBe(1_000);
    expect(otherYear.used).toBe(0);
  });

  it('can exclude one claim, so re-assessing a claim never blocks itself', async () => {
    db.medicalClaim.findMany.mockResolvedValue([]);

    await yearPosition({
      companyId: 'company-1',
      employeeId: 'emp-1',
      year: 2026,
      excludeClaimId: 'claim-1',
    });

    expect(db.medicalClaim.findMany.mock.calls[0]![0].where.NOT).toEqual({ id: 'claim-1' });
  });
});

describe('dependents', () => {
  const child = (overrides: Record<string, unknown> = {}) => ({
    id: 'dep-1',
    companyId: 'company-1',
    employeeId: 'emp-1',
    name: 'A Child',
    relationship: 'CHILD',
    dateOfBirth: null,
    gender: null,
    status: 'ACTIVE',
    createdBy: null,
    updatedBy: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });

  it('allows a claim for a covered dependent', async () => {
    db.medicalDependent.findMany.mockResolvedValue([child()]);

    expect((await assess({ dependentId: 'dep-1' })).allowed).toBe(true);
  });

  it('refuses a claim for a dependent the policy does not cover', async () => {
    db.medicalDependent.findMany.mockResolvedValue([child({ relationship: 'PARENT' })]);

    const result = await assess({ dependentId: 'dep-1' });

    expect(result.failedRules).toContain('DEPENDENT_NOT_COVERED');
  });

  it('covers that parent the moment the policy does', async () => {
    db.medicalDependent.findMany.mockResolvedValue([child({ relationship: 'PARENT' })]);
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ parentsCovered: true, maxParents: 1 }));

    expect((await assess({ dependentId: 'dep-1' })).allowed).toBe(true);
  });

  it('refuses a claim for the child beyond the policy maximum', async () => {
    db.medicalDependent.findMany.mockResolvedValue([
      child({ id: 'dep-1', createdAt: new Date(Date.UTC(2026, 0, 1)) }),
      child({ id: 'dep-2', createdAt: new Date(Date.UTC(2026, 0, 2)) }),
    ]);
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ maxChildren: 1 }));

    const result = await assess({ dependentId: 'dep-2' });

    expect(result.failedRules).toContain('DEPENDENT_NOT_COVERED');
  });

  it('refuses an id that is not on this employee’s record', async () => {
    db.medicalDependent.findMany.mockResolvedValue([child()]);

    const result = await assess({ dependentId: 'someone-elses-dependent' });

    expect(result.failedRules).toContain('DEPENDENT_NOT_FOUND');
  });

  it('never widens the dependent lookup past this employee', async () => {
    db.medicalDependent.findMany.mockResolvedValue([child()]);

    await assess({ dependentId: 'dep-1' });

    expect(db.medicalDependent.findMany.mock.calls[0]![0].where).toEqual({
      companyId: 'company-1',
      employeeId: 'emp-1',
    });
  });
});

describe('what the policy says about deciding', () => {
  it('reports that a review is needed', async () => {
    expect((await assess()).requiresApproval).toBe(true);
  });

  it('reports when the policy settles claims without one', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ requireHrApproval: false }));

    const result = await assess();

    expect(result.requiresApproval).toBe(false);
    expect(result.warnings.join(' ')).toContain('without a review');
  });

  it('passes the override settings through from the policy', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(
      policy({ allowHrOverride: false, requireOverrideReason: false }),
    );

    const result = await assess();

    expect(result.overrideAllowed).toBe(false);
    expect(result.requireOverrideReason).toBe(false);
  });
});
