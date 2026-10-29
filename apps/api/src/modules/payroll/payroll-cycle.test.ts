import { describe, expect, it } from 'vitest';
import { payrollCycleDates, payrollMonthForDay } from '@hrms/shared';

describe('payroll cycle ending on the 28th', () => {
  it('reads the 29th onwards as next month', () => {
    expect(payrollMonthForDay('2026-10-28', 28)).toBe('2026-10');
    expect(payrollMonthForDay('2026-10-29', 28)).toBe('2026-11');
    expect(payrollMonthForDay('2026-12-31', 28)).toBe('2027-01');
  });

  it('keeps calendar months when no cycle is set', () => {
    expect(payrollMonthForDay('2026-10-31', null)).toBe('2026-10');
  });

  it('dates October as 29 September to 28 October', () => {
    expect(payrollCycleDates('2026-10', 28)).toEqual({ startDate: '2026-09-29', endDate: '2026-10-28' });
    expect(payrollCycleDates('2027-03', 28)).toEqual({ startDate: '2027-03-01', endDate: '2027-03-28' });
    expect(payrollCycleDates('2027-01', 28)).toEqual({ startDate: '2026-12-29', endDate: '2027-01-28' });
  });

  it('dates a calendar month when no cycle is set', () => {
    expect(payrollCycleDates('2027-02', null)).toEqual({ startDate: '2027-02-01', endDate: '2027-02-28' });
  });
});

describe('loan and advance months under a cycle ending on the 28th', () => {
  const client = (periods: { startDate: Date; endDate: Date }[]) =>
    ({
      company: { findUniqueOrThrow: async () => ({ timezone: 'Asia/Karachi' }) },
      payrollSettings: { findUnique: async () => ({ cycleEndDay: 28 }) },
      payrollPeriod: { findMany: async () => periods },
    }) as never;

  it('puts a request made on 30 October into November', async () => {
    const { currentPayrollMonth } = await import('../loans/loan-schedule.service.js');
    const now = new Date('2026-10-30T06:00:00Z');
    expect(await currentPayrollMonth('c', client([]), now)).toBe('2026-11');
    expect(await currentPayrollMonth('c', client([]), new Date('2026-10-28T06:00:00Z'))).toBe('2026-10');
  });

  it('closes October alone when the 29 September - 28 October period is finalized', async () => {
    const { closedPayrollMonths } = await import('../loans/loan-schedule.service.js');
    const closed = await closedPayrollMonths(
      'c',
      '2026-09',
      client([{ startDate: new Date('2026-09-29T00:00:00Z'), endDate: new Date('2026-10-28T00:00:00Z') }]),
    );
    expect([...closed]).toEqual(['2026-10']);
  });
});
