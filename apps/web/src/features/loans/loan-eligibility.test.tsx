// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { LoanEligibilityResult } from '@hrms/shared';
import { LoanEligibilityPanel } from './loan-eligibility-panel';

/**
 * What an employee is shown about their own eligibility.
 *
 * The panel renders whatever the server said and decides nothing. These tests
 * hold down the two things that matter to the person reading it:
 *
 *   - a refusal names every rule that failed, with the figure behind it, so
 *     they know what to fix rather than that "something" was wrong;
 *   - nothing internal leaks. No employee id, no policy id, no colleague.
 */

const RESULT: LoanEligibilityResult = {
  eligible: true,
  maxAllowedAmount: 100_000,
  maxMonthlyDeduction: 30_000,
  monthlySalary: 100_000,
  currency: 'PKR',
  maxTenureMonths: 12,
  maxInstallments: 12,
  estimatedMonthlyDeduction: 6_666.66,
  reasons: [],
  failedRules: [],
  failures: [],
  warnings: [],
  evaluation: {
    months: 3,
    from: '2026-04-01',
    to: '2026-06-30',
    attendancePercentage: 97,
    unapprovedAbsences: 0,
    lateDays: 2,
    missingPunches: 0,
    measured: true,
  },
  overrideAllowed: true,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('an eligible employee', () => {
  /** The figure printed beside a row's label. */
  const valueFor = (label: string): string =>
    screen.getByText(label).parentElement?.lastElementChild?.textContent ?? '';

  it('is shown the ceiling, the installment and the deduction limit', () => {
    render(<LoanEligibilityPanel result={RESULT} />);

    expect(screen.getByText('Eligible to apply')).toBeInTheDocument();
    // Read by label rather than by value: at a 1x multiple the salary and the
    // ceiling are the same number, and asserting the text alone would pass
    // even if the two rows were swapped.
    expect(valueFor('Monthly salary')).toBe('PKR 100,000');
    expect(valueFor('Maximum eligible loan')).toBe('PKR 100,000');
    expect(valueFor('Estimated monthly deduction')).toBe('PKR 6,666.66');
    expect(valueFor('Maximum permitted deduction')).toBe('PKR 30,000');
    expect(valueFor('Longest repayment')).toBe('12 months');
  });

  it('marks an installment over the deduction ceiling', () => {
    const { container } = render(
      <LoanEligibilityPanel
        result={{ ...RESULT, estimatedMonthlyDeduction: 35_000 }}
      />,
    );

    const flagged = container.querySelector('.text-destructive');
    expect(flagged).toHaveTextContent('PKR 35,000');
  });

  it('says so when the window held no attendance, without refusing anybody', () => {
    render(
      <LoanEligibilityPanel
        result={{
          ...RESULT,
          warnings: ['There is no attendance on record between 2026-04-01 and 2026-06-30, so the attendance rules could not be applied.'],
        }}
      />,
    );

    expect(screen.getByText('Eligible to apply')).toBeInTheDocument();
    expect(screen.getByText(/no attendance on record/)).toBeInTheDocument();
  });
});

describe('a refused employee', () => {
  const REFUSED: LoanEligibilityResult = {
    ...RESULT,
    eligible: false,
    reasons: [
      'Your attendance is 84%. The minimum required is 90%.',
      'You have 5 unapproved absences. The maximum allowed is 3.',
      'You already have a loan in progress.',
    ],
    failedRules: ['ATTENDANCE_PERCENT', 'UNAPPROVED_ABSENCES', 'ACTIVE_LOAN'],
    failures: [
      { rule: 'ATTENDANCE_PERCENT', message: 'Your attendance is 84%. The minimum required is 90%.' },
      {
        rule: 'UNAPPROVED_ABSENCES',
        message: 'You have 5 unapproved absences. The maximum allowed is 3.',
      },
      { rule: 'ACTIVE_LOAN', message: 'You already have a loan in progress.' },
    ],
  };

  it('says the application is unavailable and lists every rule that failed', () => {
    render(<LoanEligibilityPanel result={REFUSED} />);

    expect(screen.getByText('Loan application unavailable')).toBeInTheDocument();
    expect(
      screen.getByText('Your attendance is 84%. The minimum required is 90%.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('You have 5 unapproved absences. The maximum allowed is 3.'),
    ).toBeInTheDocument();
    expect(screen.getByText('You already have a loan in progress.')).toBeInTheDocument();
  });

  it('leaks nothing internal', () => {
    const { container } = render(<LoanEligibilityPanel result={REFUSED} />);
    const text = container.textContent ?? '';

    // The machine-readable rule keys drive the UI; they are never printed.
    expect(text).not.toContain('ATTENDANCE_PERCENT');
    expect(text).not.toContain('UNAPPROVED_ABSENCES');
    expect(text).not.toMatch(/emp-|pol-|policyId/);
  });
});
