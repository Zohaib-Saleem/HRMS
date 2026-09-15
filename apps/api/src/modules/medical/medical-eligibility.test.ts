import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEDICAL_POLICY_DEFAULTS, defaultCategoryLimits } from '@hrms/shared';

/**
 * The medical eligibility engine.
 *
 * The rule this file exists to hold down: not one company threshold is written
 * in the engine. Every assertion below moves a POLICY value and expects the
 * answer to move with it - so a test passing here is evidence that the number
 * came from the database, and a company that edits the settings screen gets the
 * behaviour these tests describe without a deployment.
 *
 * The second rule: the server decides. Nothing the browser can send appears in
 * any input below, because the engine takes an employee id and reads everything
 * else itself.
 */

const db = vi.hoisted(() => ({
  company: { findUniqueOrThrow: vi.fn() },
  employee: { findFirst: vi.fn() },
  medicalPolicy: { findFirst: vi.fn(), upsert: vi.fn() },
  medicalClaim: { aggregate: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { evaluateMedicalEligibility } = await import('./medical-eligibility.service.js');

const NOW = new Date('2026-09-12T10:00:00Z');

const policy = (overrides: Record<string, unknown> = {}) => ({
  id: 'pol-1',
  companyId: 'company-1',
  ...MEDICAL_POLICY_DEFAULTS,
  categories: defaultCategoryLimits().map((c, i) => ({ id: `cat-${i}`, policyId: 'pol-1', ...c })),
  effectiveFrom: new Date('2020-01-01T00:00:00Z'),
  createdAt: new Date('2020-01-01T00:00:00Z'),
  updatedAt: new Date('2020-01-01T00:00:00Z'),
  createdBy: null,
  ...overrides,
});

/** Two years' service, confirmed, active. Eligible under every default. */
const employee = (overrides: Record<string, unknown> = {}) => ({
  id: 'emp-1',
  status: 'ACTIVE',
  hireDate: new Date('2024-01-15T00:00:00Z'),
  confirmationDate: new Date('2024-04-15T00:00:00Z'),
  employmentStatus: 'PERMANENT',
  contracts: [],
  ...overrides,
});

const evaluate = (overrides: Record<string, unknown> = {}) =>
  evaluateMedicalEligibility({
    companyId: 'company-1',
    employeeId: 'emp-1',
    now: NOW,
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  db.company.findUniqueOrThrow.mockResolvedValue({ currency: 'PKR' });
  db.medicalPolicy.findFirst.mockResolvedValue(policy());
  db.employee.findFirst.mockResolvedValue(employee());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the happy path', () => {
  it('finds a confirmed, long-serving, active employee eligible', async () => {
    const result = await evaluate();

    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.failedRules).toEqual([]);
  });

  it('quotes the limit and the categories from the policy in force', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ annualLimitPerEmployee: 250_000 }));

    const result = await evaluate();

    expect(result.benefitLimit).toBe(250_000);
    expect(result.categoryLimits).toHaveLength(7);
    expect(result.currency).toBe('PKR');
  });

  it('names the policy version that decided the answer', async () => {
    const result = await evaluate();

    expect(result.policyVersion).toEqual({
      id: 'pol-1',
      name: 'Company Medical Benefit',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
  });
});

describe('the employee has to exist', () => {
  it('refuses when there is no employee record', async () => {
    db.employee.findFirst.mockResolvedValue(null);

    const result = await evaluate();

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toEqual(['EMPLOYEE_RECORD']);
  });

  it('does not find an employee belonging to another company', async () => {
    await evaluate();

    expect(db.employee.findFirst.mock.calls[0]![0].where).toMatchObject({
      id: 'emp-1',
      companyId: 'company-1',
    });
  });
});

describe('the benefit can be switched off entirely', () => {
  it('makes everybody ineligible when the policy is disabled', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ enabled: false }));

    const result = await evaluate();

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toContain('BENEFIT_DISABLED');
  });

  it('says so without blaming the employee', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ enabled: false }));

    const result = await evaluate();

    expect(result.reasons.join(' ')).toContain('switched off');
    expect(result.failedRules).not.toContain('MIN_EMPLOYMENT');
  });
});

describe('the minimum employment period', () => {
  it('refuses somebody short of it', async () => {
    // Hired six weeks ago against a three-month default.
    db.employee.findFirst.mockResolvedValue(
      employee({ hireDate: new Date('2026-08-01T00:00:00Z') }),
    );

    const result = await evaluate();

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toContain('MIN_EMPLOYMENT');
    expect(result.employment.monthsServed).toBe(1);
  });

  it('is the POLICY value, not a constant - lowering it makes them eligible', async () => {
    db.employee.findFirst.mockResolvedValue(
      employee({ hireDate: new Date('2026-08-01T00:00:00Z') }),
    );
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ minEmploymentMonths: 1 }));

    const result = await evaluate();

    expect(result.eligible).toBe(true);
  });

  it('and raising it makes a long-serving employee ineligible', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ minEmploymentMonths: 120 }));

    const result = await evaluate();

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toContain('MIN_EMPLOYMENT');
  });

  it('refuses rather than guesses when the joining date is missing', async () => {
    db.employee.findFirst.mockResolvedValue(employee({ hireDate: null }));

    const result = await evaluate();

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toContain('MIN_EMPLOYMENT');
    expect(result.reasons.join(' ')).toContain('Ask HR');
  });

  it('checks nothing when the period is set to zero', async () => {
    db.employee.findFirst.mockResolvedValue(employee({ hireDate: null }));
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ minEmploymentMonths: 0 }));

    const result = await evaluate();

    expect(result.failedRules).not.toContain('MIN_EMPLOYMENT');
  });
});

describe('probation', () => {
  const onProbation = () =>
    employee({ employmentStatus: 'PROBATION', confirmationDate: null });

  it('refuses a probationer while probation cover is off', async () => {
    db.employee.findFirst.mockResolvedValue(onProbation());

    const result = await evaluate();

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toContain('PROBATION');
    expect(result.employment.onProbation).toBe(true);
  });

  it('covers them once the policy allows it', async () => {
    db.employee.findFirst.mockResolvedValue(onProbation());
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ allowProbation: true }));

    const result = await evaluate();

    expect(result.eligible).toBe(true);
  });

  it('reads an ACTIVE probation contract as probation', async () => {
    db.employee.findFirst.mockResolvedValue(
      employee({ contracts: [{ id: 'contract-1' }] }),
    );

    const result = await evaluate();

    expect(result.employment.onProbation).toBe(true);
    expect(result.failedRules).toContain('PROBATION');
  });

  it('does not read a missing confirmation date as probation', async () => {
    db.employee.findFirst.mockResolvedValue(
      employee({ confirmationDate: null, employmentStatus: null }),
    );

    const result = await evaluate();

    expect(result.employment.onProbation).toBe(false);
    expect(result.eligible).toBe(true);
  });
});

describe('permanent employees', () => {
  it('can be excluded, if that is what the policy says', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ allowPermanent: false }));

    const result = await evaluate();

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toContain('PERMANENT_NOT_ALLOWED');
  });
});

describe('employment status', () => {
  it('refuses a resigned employee while the policy blocks resignations', async () => {
    db.employee.findFirst.mockResolvedValue(employee({ status: 'RESIGNED' }));

    const result = await evaluate();

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toContain('EMPLOYMENT_STATUS');
  });

  it('covers a resigned employee once the policy stops blocking them', async () => {
    db.employee.findFirst.mockResolvedValue(employee({ status: 'RESIGNED' }));
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ blockResigned: false }));

    const result = await evaluate();

    expect(result.eligible).toBe(true);
  });

  it('refuses a terminated employee while the policy blocks terminations', async () => {
    db.employee.findFirst.mockResolvedValue(employee({ status: 'TERMINATED' }));

    const result = await evaluate();

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toContain('EMPLOYMENT_STATUS');
  });

  it('covers a terminated employee once the policy stops blocking them', async () => {
    db.employee.findFirst.mockResolvedValue(employee({ status: 'TERMINATED' }));
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ blockTerminated: false }));

    const result = await evaluate();

    expect(result.eligible).toBe(true);
  });

  it('keeps covering somebody who is on leave', async () => {
    db.employee.findFirst.mockResolvedValue(employee({ status: 'ON_LEAVE' }));

    const result = await evaluate();

    expect(result.eligible).toBe(true);
  });

  it('refuses a suspended record', async () => {
    db.employee.findFirst.mockResolvedValue(employee({ status: 'SUSPENDED' }));

    const result = await evaluate();

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toContain('EMPLOYMENT_STATUS');
  });

  it('refuses an inactive record', async () => {
    db.employee.findFirst.mockResolvedValue(employee({ status: 'INACTIVE' }));

    const result = await evaluate();

    expect(result.eligible).toBe(false);
    expect(result.failedRules).toContain('EMPLOYMENT_STATUS');
  });
});

describe('a policy change reaches the NEXT check, and only the next one', () => {
  it('answers differently after the policy moves', async () => {
    const before = await evaluate();
    expect(before.eligible).toBe(true);

    db.medicalPolicy.findFirst.mockResolvedValue(policy({ id: 'pol-2', minEmploymentMonths: 120 }));
    const after = await evaluate();

    expect(after.eligible).toBe(false);
    expect(after.policyVersion.id).toBe('pol-2');
  });

  it('writes nothing at all - no claim, no dependent, no employee row', async () => {
    await evaluate();

    // The only write the engine may cause is the seeding upsert of a first
    // policy version, and it does not even do that when one already exists.
    expect(db.medicalPolicy.upsert).not.toHaveBeenCalled();
  });
});

describe('warnings, which say something true without blocking', () => {
  it('flags a zero limit', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(policy({ annualLimitPerEmployee: 0 }));

    const result = await evaluate();

    expect(result.eligible).toBe(true);
    expect(result.warnings.join(' ')).toContain('zero');
  });

  it('flags every category being switched off', async () => {
    db.medicalPolicy.findFirst.mockResolvedValue(
      policy({
        categories: defaultCategoryLimits().map((c, i) => ({
          id: `cat-${i}`,
          policyId: 'pol-1',
          ...c,
          enabled: false,
        })),
      }),
    );

    const result = await evaluate();

    expect(result.eligible).toBe(true);
    expect(result.warnings.join(' ')).toContain('category');
  });
});
