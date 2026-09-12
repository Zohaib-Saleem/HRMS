import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MASTER_COLUMNS,
  EMPLOYEE_MASTER_COLUMNS,
  PERMISSIONS,
  resolveReportPeriod,
} from '@hrms/shared';
import { allowedColumns } from './employee-master.service.js';
import { foldPaidBalances, type LeaveBalanceView } from '../leave/leave.service.js';
import type { AuthContext } from '../../auth/session.js';

/**
 * The Employee Master Report's two safety properties.
 *
 * The first is that a column nobody may read is never offered. The report puts
 * salary, CNIC, loan balances and device PINs on one screen, which is precisely
 * the combination that turns a small permission mistake into a large one; the
 * picker must not even list a column the caller could not fill.
 *
 * The second is that the period a preset names is the period the query runs.
 * The header and the attendance engine read the same resolver, so a report
 * headed "last month" cannot quietly tally this one.
 */

const auth = (...permissions: string[]): AuthContext =>
  ({
    sessionId: 's',
    userId: 'u',
    companyId: 'c',
    email: 'e@example.com',
    permissions: new Set(permissions),
    dataScope: 'ALL',
    mustChangePassword: false,
  }) as unknown as AuthContext;

describe('which columns a caller is offered', () => {
  it('offers an unrestricted column to everybody', () => {
    const columns = allowedColumns(auth(PERMISSIONS.EMPLOYEE_READ));

    expect(columns).toContain('fullName');
    expect(columns).toContain('departmentName');
    expect(columns).toContain('hireDate');
  });

  it('withholds pay, CNIC, loans, leave, attendance and PINs without their permission', () => {
    const columns = allowedColumns(auth(PERMISSIONS.EMPLOYEE_READ));

    expect(columns).not.toContain('salaryAmount');
    expect(columns).not.toContain('nationalId');
    expect(columns).not.toContain('loanOutstanding');
    expect(columns).not.toContain('leaveRemaining');
    expect(columns).not.toContain('attPercentage');
    expect(columns).not.toContain('punchCodes');
  });

  it('grants exactly the block whose permission is held, and no neighbour', () => {
    const columns = allowedColumns(auth(PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.LEAVE_READ));

    expect(columns).toContain('leaveRemaining');
    expect(columns).toContain('leaveUsed');
    // Holding one module's permission says nothing about another's.
    expect(columns).not.toContain('salaryAmount');
    expect(columns).not.toContain('loanOutstanding');
  });

  it('offers every column to a reader who holds every permission', () => {
    const all = auth(...EMPLOYEE_MASTER_COLUMNS.flatMap((c) => (c.permission ? [c.permission] : [])));

    expect(allowedColumns(all)).toHaveLength(EMPLOYEE_MASTER_COLUMNS.length);
  });

  it('never defaults to a column a bare employee.read caller cannot see', () => {
    // The default set is what an operator meets before touching the picker, so
    // a default the server will not fill would render as an unexplained blank.
    const columns = new Set(allowedColumns(auth(...EMPLOYEE_MASTER_COLUMNS.flatMap((c) => (c.permission ? [c.permission] : [])))));

    for (const key of DEFAULT_MASTER_COLUMNS) expect(columns.has(key)).toBe(true);
  });

  it('gives every column a group the picker knows how to render', () => {
    for (const column of EMPLOYEE_MASTER_COLUMNS) {
      expect(column.group).toBeTruthy();
      expect(column.key).toMatch(/^[a-zA-Z]+$/);
    }
    // Keys are the export contract and the localStorage contract at once.
    const keys = EMPLOYEE_MASTER_COLUMNS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the period a preset means', () => {
  const reference = new Date('2026-09-11T12:00:00.000Z');

  it('reads this month as the calendar month, ends included', () => {
    expect(resolveReportPeriod('this-month', reference)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('reads last month as the previous calendar month', () => {
    expect(resolveReportPeriod('last-month', reference)).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
    });
  });

  it('crosses a year boundary backwards without landing in month -1', () => {
    expect(resolveReportPeriod('last-month', new Date('2026-01-09T00:00:00.000Z'))).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  it('reads this year as the whole calendar year', () => {
    expect(resolveReportPeriod('this-year', reference)).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
    });
  });

  it('takes a custom range as given', () => {
    expect(
      resolveReportPeriod('custom', reference, { from: '2026-03-05', to: '2026-04-20' }),
    ).toEqual({ from: '2026-03-05', to: '2026-04-20' });
  });

  it('falls back to this month rather than an open-ended range', () => {
    // An unbounded range would tally every day the company has ever recorded.
    expect(resolveReportPeriod('custom', reference, { from: null, to: null })).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });
});

describe('folding a year of leave into one figure', () => {
  const balance = (over: Partial<LeaveBalanceView>): LeaveBalanceView =>
    ({
      leaveTypeId: 't',
      leaveTypeName: 'Type',
      leaveTypeCode: 'T',
      isPaid: true,
      year: 2026,
      annualEntitlementDays: 0,
      monthlyAccrualDays: 0,
      carryForwardEnabled: false,
      carryForwardCapDays: null,
      openingDays: 0,
      accruedDays: 0,
      adjustmentDays: 0,
      usedDays: 0,
      pendingDays: 0,
      availableDays: 0,
      ...over,
    }) as LeaveBalanceView;

  /** This company's types: 6 + 3 + 6 paid, and 30 unpaid. */
  const company = [
    balance({ leaveTypeCode: 'AL', isPaid: true, annualEntitlementDays: 6, usedDays: 9, availableDays: -3 }),
    balance({ leaveTypeCode: 'CL', isPaid: true, annualEntitlementDays: 3, availableDays: 3 }),
    balance({ leaveTypeCode: 'SL', isPaid: true, annualEntitlementDays: 6, availableDays: 6 }),
    balance({ leaveTypeCode: 'UL', isPaid: false, annualEntitlementDays: 30, availableDays: 30 }),
  ];

  it('excludes unpaid leave, which is not leave anybody has', () => {
    const folded = foldPaidBalances(company);

    // 6 + 3 + 6, the policy. Not 45.
    expect(folded.entitlementDays).toBe(15);
    // -3 + 3 + 6. The unpaid 30 must not flatter it.
    expect(folded.availableDays).toBe(6);
    expect(folded.usedDays).toBe(9);
  });

  describe('days consumed', () => {
    it('counts leave taken before HRMS, which no request records', () => {
      // The 2026 import: 57.5 days taken, written as a balance debit because
      // the workbook had no dates, types or statuses to build requests from.
      const folded = foldPaidBalances([
        balance({ isPaid: true, annualEntitlementDays: 6, adjustmentDays: -57.5, availableDays: -51.5 }),
        balance({ isPaid: true, annualEntitlementDays: 3, availableDays: 3 }),
        balance({ isPaid: true, annualEntitlementDays: 6, availableDays: 6 }),
      ]);

      // Nothing was booked through HRMS, so `usedDays` is honestly zero...
      expect(folded.usedDays).toBe(0);
      // ...and the report must still not claim this person has taken nothing.
      expect(folded.adjustedDays).toBe(57.5);
      expect(folded.consumedDays).toBe(57.5);
    });

    it('adds an approved request to imported history rather than replacing it', () => {
      const folded = foldPaidBalances([
        balance({ isPaid: true, usedDays: 4, adjustmentDays: -12, availableDays: -10 }),
      ]);

      expect(folded.consumedDays).toBe(16);
    });

    it('does not let an administrative credit cancel days already taken', () => {
      // A positive adjustment is a grant, not consumption. Folding the signed
      // value would report somebody with a 5-day credit as having taken 5 fewer.
      const folded = foldPaidBalances([
        balance({ isPaid: true, usedDays: 8, adjustmentDays: 5, availableDays: 3 }),
      ]);

      expect(folded.adjustedDays).toBe(0);
      expect(folded.consumedDays).toBe(8);
    });

    it('ignores an unpaid type entirely, credit or debit', () => {
      const folded = foldPaidBalances([
        balance({ isPaid: true, usedDays: 2 }),
        balance({ isPaid: false, usedDays: 9, adjustmentDays: -20 }),
      ]);

      expect(folded.consumedDays).toBe(2);
    });

    it('sums a debit spread across several paid types', () => {
      const folded = foldPaidBalances([
        balance({ isPaid: true, adjustmentDays: -6 }),
        balance({ isPaid: true, adjustmentDays: -1.5 }),
        balance({ isPaid: true, usedDays: 1 }),
      ]);

      expect(folded.consumedDays).toBe(8.5);
    });
  });

  it('keeps an overdrawn paid balance negative rather than clamping it', () => {
    const folded = foldPaidBalances([
      balance({ isPaid: true, annualEntitlementDays: 6, usedDays: 53, availableDays: -47 }),
      balance({ isPaid: false, annualEntitlementDays: 30, availableDays: 30 }),
    ]);

    // Somebody 47 days overdrawn is 47 days overdrawn, and an unpaid bucket
    // sitting alongside does not settle the debt.
    expect(folded.availableDays).toBe(-47);
  });

  it('answers zero, not NaN, when every type is unpaid', () => {
    expect(foldPaidBalances([balance({ isPaid: false, annualEntitlementDays: 30, availableDays: 30 })])).toEqual({
      entitlementDays: 0,
      usedDays: 0,
      adjustedDays: 0,
      consumedDays: 0,
      pendingDays: 0,
      availableDays: 0,
    });
  });

  it('answers zero for an employee with no balances at all', () => {
    expect(foldPaidBalances([])).toEqual({
      entitlementDays: 0,
      usedDays: 0,
      adjustedDays: 0,
      consumedDays: 0,
      pendingDays: 0,
      availableDays: 0,
    });
  });

  it('rounds to two places rather than trailing a float', () => {
    const folded = foldPaidBalances([
      balance({ isPaid: true, availableDays: 0.1 }),
      balance({ isPaid: true, availableDays: 0.2 }),
    ]);

    expect(folded.availableDays).toBe(0.3);
  });
});
