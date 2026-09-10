import { describe, expect, it } from 'vitest';
import type { AttendanceDailyTotal } from '@hrms/shared';
import { calendarCell } from './attendance-analytics';

/**
 * Turning an aggregated day into a calendar cell.
 *
 * The rule worth testing is the one it would be easiest to get wrong: a day on
 * which twelve people were present and three were not has no single status, and
 * the cell must not pretend otherwise. It takes the character of the DATE -
 * weekend, holiday, not yet arrived - and prints a headcount for everything
 * else. With one employee in scope there is a single status, and the cell shows
 * exactly what the personal calendar has always shown.
 */

function total(over: Partial<AttendanceDailyTotal> = {}): AttendanceDailyTotal {
  return {
    date: '2026-09-09',
    employeeCount: 0,
    present: 0,
    halfDay: 0,
    absent: 0,
    onLeave: 0,
    holiday: 0,
    weekend: 0,
    offDay: 0,
    upcoming: 0,
    workedMinutes: 0,
    expectedMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    lateCount: 0,
    overtimeCount: 0,
    onTimeMinutes: 0,
    lateWorkedMinutes: 0,
    overtimeMinutes: 0,
    firstCheckInAt: null,
    lastCheckOutAt: null,
    dayState: 'WORKING',
    holidayName: null,
    ...over,
  };
}

describe('calendar cell from an aggregated day', () => {
  describe('a mixed day is a headcount, not a status', () => {
    it('prints attended over total rather than claiming one status', () => {
      const cell = calendarCell(
        total({ employeeCount: 15, present: 11, halfDay: 1, absent: 3 }),
        false,
      );

      expect(cell.label).toBe('12/15 in');
      expect(cell.detail).toContain('12 of 15 present');
      expect(cell.detail).toContain('3 absent');
    });

    it('counts a half day as somebody who came in', () => {
      const cell = calendarCell(total({ employeeCount: 4, present: 2, halfDay: 2 }), false);

      expect(cell.label).toBe('4/4 in');
    });

    it('takes the absent colour when anybody was absent, so the day stands out', () => {
      const cell = calendarCell(total({ employeeCount: 10, present: 9, absent: 1 }), false);

      expect(cell.status).toBe('ABSENT');
    });

    it('takes the present colour when nobody was absent', () => {
      const cell = calendarCell(total({ employeeCount: 10, present: 10 }), false);

      expect(cell.status).toBe('PRESENT');
    });
  });

  describe('the date’s own character wins over the headcount', () => {
    it('shows a weekend as a weekend', () => {
      const cell = calendarCell(total({ employeeCount: 8, weekend: 8, dayState: 'WEEKEND' }), false);

      expect(cell.status).toBe('WEEKEND');
      expect(cell.label).toBe('Weekend');
    });

    it('names a holiday when the aggregate carries one name', () => {
      const cell = calendarCell(
        total({ employeeCount: 8, holiday: 8, dayState: 'HOLIDAY', holidayName: 'Eid' }),
        false,
      );

      expect(cell.status).toBe('HOLIDAY');
      expect(cell.label).toBe('Eid');
    });

    it('falls back to "Holiday" when two locations kept different ones', () => {
      const cell = calendarCell(
        total({ employeeCount: 8, holiday: 8, dayState: 'HOLIDAY', holidayName: null }),
        false,
      );

      expect(cell.label).toBe('Holiday');
    });

    it('never marks an upcoming day as absence', () => {
      const cell = calendarCell(total({ employeeCount: 8, upcoming: 8, dayState: 'UPCOMING' }), false);

      expect(cell.status).toBe('UPCOMING');
      expect(cell.label).toBe('Upcoming');
      expect(cell.detail).not.toContain('absent');
    });

    it('shows a rostered off day as an off day, not a weekend', () => {
      const cell = calendarCell(total({ employeeCount: 3, offDay: 3, dayState: 'OFF_DAY' }), false);

      expect(cell.status).toBe('OFF_DAY');
      expect(cell.label).toBe('Off day');
    });
  });

  describe('one employee in scope reads as a single status', () => {
    it('shows Present for a day that person worked', () => {
      const cell = calendarCell(
        total({ employeeCount: 1, present: 1, workedMinutes: 540 }),
        true,
      );

      expect(cell.status).toBe('PRESENT');
      expect(cell.label).toBe('Present');
      expect(cell.detail).toContain('9.0h worked');
    });

    it('shows Half day', () => {
      const cell = calendarCell(total({ employeeCount: 1, halfDay: 1 }), true);

      expect(cell.status).toBe('HALF_DAY');
      expect(cell.label).toBe('Half day');
    });

    it('shows On leave', () => {
      const cell = calendarCell(total({ employeeCount: 1, onLeave: 1 }), true);

      expect(cell.status).toBe('ON_LEAVE');
      expect(cell.label).toBe('On leave');
    });

    it('shows Absent', () => {
      const cell = calendarCell(total({ employeeCount: 1, absent: 1 }), true);

      expect(cell.status).toBe('ABSENT');
      expect(cell.label).toBe('Absent');
    });

    it('never prints a headcount for a single person', () => {
      const cell = calendarCell(total({ employeeCount: 1, present: 1 }), true);

      expect(cell.label).not.toContain('/');
    });
  });

  describe('the detail line carries the figures the tooltip shows', () => {
    it('includes late and overtime minutes when there are any', () => {
      const cell = calendarCell(
        total({ employeeCount: 5, present: 5, workedMinutes: 2700, lateMinutes: 45, overtimeMinutes: 120 }),
        false,
      );

      expect(cell.detail).toContain('45m late');
      expect(cell.detail).toContain('120m overtime');
    });

    it('omits them rather than printing zeros', () => {
      const cell = calendarCell(total({ employeeCount: 5, present: 5, workedMinutes: 2400 }), false);

      expect(cell.detail).not.toContain('late');
      expect(cell.detail).not.toContain('overtime');
    });

    it('always names the date', () => {
      const cell = calendarCell(total({ date: '2026-09-09', employeeCount: 1, present: 1 }), true);

      expect(cell.detail).toContain('2026');
      expect(cell.date).toBe('2026-09-09');
    });
  });
});
