import { describe, expect, it } from 'vitest';
import type { DerivedDay } from './attendance.service.js';
import { aggregateDailyTotals, datesInRange } from './attendance-analytics.service.js';

/**
 * Daily aggregation for the attendance chart.
 *
 * The aggregation is pure, so it is pinned against figures that can be checked
 * on paper. Three properties matter more than the rest, and each is asserted
 * from several directions:
 *
 *   - The worked split partitions worked minutes. On-time, late-day and
 *     overtime are disjoint and sum to the total, so a stacked column is the
 *     height of the time actually worked and never taller.
 *   - Late minutes are not worked minutes. They are time missed at the start
 *     of a shift, and adding them to a bar would draw time nobody worked.
 *   - Weekends, holidays, off days and days still ahead are not attendance
 *     anybody failed to produce, and are never in the attendance denominator.
 */

function day(over: Partial<DerivedDay> = {}): DerivedDay {
  return {
    date: '2026-09-01',
    status: 'PRESENT',
    flags: [],
    checkInAt: '2026-09-01T04:00:00.000Z',
    checkOutAt: '2026-09-01T13:00:00.000Z',
    workedMinutes: 540,
    expectedMinutes: 540,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    irregular: false,
    integrity: 'COMPLETE',
    mode: null,
    shiftId: null,
    shiftName: 'General',
    notes: null,
    leaveTypeName: null,
    leaveIsPaid: null,
    leaveIsDeductible: null,
    leaveDayPart: null,
    holidayName: null,
    source: 'DEVICE',
    recordId: 'rec-1',
    hasRecord: true,
    ...over,
  };
}

/** A non-working day carries no rostered minutes, exactly as the deriver leaves it. */
const nonWorking = (over: Partial<DerivedDay>): DerivedDay =>
  day({
    checkInAt: null,
    checkOutAt: null,
    workedMinutes: null,
    expectedMinutes: null,
    lateMinutes: null,
    earlyLeaveMinutes: null,
    overtimeMinutes: null,
    source: null,
    recordId: null,
    hasRecord: false,
    ...over,
  });

const one = (days: DerivedDay[], dates = ['2026-09-01']) =>
  aggregateDailyTotals({ dates, byEmployee: new Map([['emp-1', days]]) });

describe('daily attendance aggregation', () => {
  describe('every date in the range is returned', () => {
    it('returns a row per calendar day, including days nothing happened on', () => {
      const result = aggregateDailyTotals({
        dates: datesInRange(new Date('2026-09-01'), new Date('2026-09-30')),
        byEmployee: new Map(),
      });

      expect(result.days).toHaveLength(30);
      expect(result.days[0]!.date).toBe('2026-09-01');
      expect(result.days[29]!.date).toBe('2026-09-30');
    });

    it('reports a month with no records as empty columns, not as no columns', () => {
      // The distinction the screen depends on: an empty month must draw an
      // axis, because a chart with nothing in it looks like a failed request.
      const result = aggregateDailyTotals({
        dates: ['2026-02-01', '2026-02-02'],
        byEmployee: new Map(),
      });

      expect(result.days).toHaveLength(2);
      expect(result.days.every((d) => d.workedMinutes === 0)).toBe(true);
      expect(result.days.every((d) => d.employeeCount === 0)).toBe(true);
      expect(result.summary.totalEmployees).toBe(0);
      expect(result.summary.averageWorkedMinutes).toBeNull();
      expect(result.summary.attendancePercentage).toBeNull();
    });

    it('ignores a derived day outside the requested dates rather than inventing a column', () => {
      const result = one([day({ date: '2026-08-31' })], ['2026-09-01']);

      expect(result.days).toHaveLength(1);
      expect(result.days[0]!.employeeCount).toBe(0);
    });
  });

  describe('the worked split partitions worked minutes', () => {
    it('carves overtime out of worked time instead of adding it on top', () => {
      // 540 worked of which 60 is overtime: the column is 540 tall, not 600.
      const result = one([day({ workedMinutes: 540, overtimeMinutes: 60, flags: ['OVERTIME'] })]);
      const row = result.days[0]!;

      expect(row.workedMinutes).toBe(540);
      expect(row.onTimeMinutes).toBe(480);
      expect(row.overtimeMinutes).toBe(60);
      expect(row.onTimeMinutes + row.lateWorkedMinutes + row.overtimeMinutes).toBe(540);
    });

    it('puts a late day’s regular time in the late segment, not the on-time one', () => {
      const result = one([
        day({ workedMinutes: 500, lateMinutes: 40, flags: ['LATE'] }),
        day({ workedMinutes: 540 }),
      ]);
      const row = result.days[0]!;

      expect(row.lateWorkedMinutes).toBe(500);
      expect(row.onTimeMinutes).toBe(540);
      expect(row.onTimeMinutes + row.lateWorkedMinutes + row.overtimeMinutes).toBe(1040);
      expect(row.workedMinutes).toBe(1040);
    });

    it('splits a day that was both late and long across the late and overtime segments', () => {
      const result = one([
        day({ workedMinutes: 600, overtimeMinutes: 60, lateMinutes: 30, flags: ['LATE', 'OVERTIME'] }),
      ]);
      const row = result.days[0]!;

      expect(row.onTimeMinutes).toBe(0);
      expect(row.lateWorkedMinutes).toBe(540);
      expect(row.overtimeMinutes).toBe(60);
      expect(row.workedMinutes).toBe(600);
    });

    it('adds the overtime it was given, without a clamp of its own', () => {
      /**
       * The engine guarantees overtime never exceeds worked minutes, so this
       * file does not re-check it. It used to, and that was the bug: the row
       * clamped, the summary beside it did not, and neither did the CSV - so
       * the chart and its own export could disagree about the same day.
       *
       * A figure this shape can no longer be derived. If one ever is, it shows
       * up identically everywhere instead of being quietly reshaped here.
       */
      const result = one([day({ workedMinutes: 100, overtimeMinutes: 500 })]);
      const row = result.days[0]!;

      expect(row.overtimeMinutes).toBe(500);
      expect(row.overtimeMinutes).toBe(result.summary.overtimeMinutes);
      expect(row.onTimeMinutes).toBe(0);
    });
  });

  describe('late minutes are reported but never drawn as worked time', () => {
    it('keeps late minutes out of worked minutes and out of the split', () => {
      const result = one([day({ workedMinutes: 480, lateMinutes: 45, flags: ['LATE'] })]);
      const row = result.days[0]!;

      expect(row.lateMinutes).toBe(45);
      expect(row.workedMinutes).toBe(480);
      expect(row.onTimeMinutes + row.lateWorkedMinutes + row.overtimeMinutes).toBe(480);
    });

    it('counts late days separately from late minutes', () => {
      const result = one([
        day({ lateMinutes: 10, flags: ['LATE'] }),
        day({ lateMinutes: 20, flags: ['LATE'] }),
        day({ lateMinutes: 0 }),
      ]);

      expect(result.days[0]!.lateCount).toBe(2);
      expect(result.days[0]!.lateMinutes).toBe(30);
      expect(result.summary.lateMinutes).toBe(30);
    });
  });

  describe('statuses are counted, never reassigned', () => {
    it('tallies each derived status into its own counter', () => {
      const result = one([
        day({ status: 'PRESENT' }),
        day({ status: 'HALF_DAY' }),
        day({ status: 'ABSENT' }),
        nonWorking({ status: 'ON_LEAVE', leaveTypeName: 'Annual' }),
        nonWorking({ status: 'HOLIDAY', holidayName: 'Independence Day' }),
        nonWorking({ status: 'WEEKEND' }),
        nonWorking({ status: 'OFF_DAY' }),
        nonWorking({ status: 'UPCOMING' }),
      ]);
      const row = result.days[0]!;

      expect(row.present).toBe(1);
      expect(row.halfDay).toBe(1);
      expect(row.absent).toBe(1);
      expect(row.onLeave).toBe(1);
      expect(row.holiday).toBe(1);
      expect(row.weekend).toBe(1);
      expect(row.offDay).toBe(1);
      expect(row.upcoming).toBe(1);
      expect(row.employeeCount).toBe(8);
    });

    it('leaves a late day counted as present, because a flag is not a status', () => {
      const result = one([day({ status: 'PRESENT', lateMinutes: 30, flags: ['LATE'] })]);

      expect(result.days[0]!.present).toBe(1);
      expect(result.days[0]!.absent).toBe(0);
      expect(result.days[0]!.lateCount).toBe(1);
    });
  });

  describe('the day state describes the date, not the people', () => {
    it('calls a day a holiday only when every employee-day was that holiday', () => {
      const result = one([
        nonWorking({ status: 'HOLIDAY', holidayName: 'Independence Day' }),
        nonWorking({ status: 'HOLIDAY', holidayName: 'Independence Day' }),
      ]);

      expect(result.days[0]!.dayState).toBe('HOLIDAY');
      expect(result.days[0]!.holidayName).toBe('Independence Day');
    });

    it('withholds the name when two locations kept different holidays that day', () => {
      const result = one([
        nonWorking({ status: 'HOLIDAY', holidayName: 'Independence Day' }),
        nonWorking({ status: 'HOLIDAY', holidayName: 'Founders Day' }),
      ]);

      expect(result.days[0]!.dayState).toBe('HOLIDAY');
      expect(result.days[0]!.holidayName).toBeNull();
    });

    it('calls a day working as soon as one person worked it', () => {
      // A holiday somebody came in for is a working day for them; the date is
      // not "a holiday" for the chart just because most people were off.
      const result = one([nonWorking({ status: 'HOLIDAY', holidayName: 'Eid' }), day()]);

      expect(result.days[0]!.dayState).toBe('WORKING');
      expect(result.days[0]!.holidayName).toBeNull();
    });

    it('reads the weekend from the statuses, so a Friday weekend needs no special case', () => {
      // 2026-09-04 is a Friday. Nothing here knows or cares which day it is.
      const result = one([nonWorking({ date: '2026-09-04', status: 'WEEKEND' })], ['2026-09-04']);

      expect(result.days[0]!.dayState).toBe('WEEKEND');
    });

    it('treats a mix of company weekend and rostered off days as a weekend', () => {
      const result = one([
        nonWorking({ status: 'WEEKEND' }),
        nonWorking({ status: 'OFF_DAY' }),
      ]);

      expect(result.days[0]!.dayState).toBe('WEEKEND');
    });

    it('stays upcoming when a future day already has leave booked on it', () => {
      // Leave approved three weeks out must not turn the day into a working
      // day the other 79 people failed to attend.
      const result = one([
        nonWorking({ status: 'ON_LEAVE', leaveTypeName: 'Annual' }),
        nonWorking({ status: 'UPCOMING' }),
        nonWorking({ status: 'UPCOMING' }),
      ]);

      expect(result.days[0]!.dayState).toBe('UPCOMING');
      // The booking is still counted; it just does not decide the date.
      expect(result.days[0]!.onLeave).toBe(1);
    });

    it('becomes a working day as soon as one person has been scored on it', () => {
      const result = one([day({ status: 'PRESENT' }), nonWorking({ status: 'UPCOMING' })]);

      expect(result.days[0]!.dayState).toBe('WORKING');
    });

    it('calls today a working day even before anybody has checked out', () => {
      // Everyone is in and nobody has finished, so there are no worked minutes
      // yet. The date has still happened.
      const result = one([
        day({ status: 'PRESENT', checkOutAt: null, workedMinutes: null, overtimeMinutes: null }),
        day({ status: 'PRESENT', checkOutAt: null, workedMinutes: null, overtimeMinutes: null }),
      ]);

      expect(result.days[0]!.dayState).toBe('WORKING');
      expect(result.days[0]!.present).toBe(2);
      expect(result.days[0]!.workedMinutes).toBe(0);
    });

    it('marks a date nobody has reached yet as upcoming, never as absence', () => {
      const result = one([nonWorking({ status: 'UPCOMING' }), nonWorking({ status: 'UPCOMING' })]);

      expect(result.days[0]!.dayState).toBe('UPCOMING');
      expect(result.days[0]!.absent).toBe(0);
      expect(result.summary.attendancePercentage).toBeNull();
    });
  });

  describe('first in and last out', () => {
    it('reports the earliest check-in and the latest check-out of the day', () => {
      const result = one([
        day({ checkInAt: '2026-09-01T04:30:00.000Z', checkOutAt: '2026-09-01T13:00:00.000Z' }),
        day({ checkInAt: '2026-09-01T03:55:00.000Z', checkOutAt: '2026-09-01T14:20:00.000Z' }),
      ]);

      expect(result.days[0]!.firstCheckInAt).toBe('2026-09-01T03:55:00.000Z');
      expect(result.days[0]!.lastCheckOutAt).toBe('2026-09-01T14:20:00.000Z');
    });

    it('leaves both null when nobody punched, so the tooltip can show a dash', () => {
      const result = one([nonWorking({ status: 'ABSENT' })]);

      expect(result.days[0]!.firstCheckInAt).toBeNull();
      expect(result.days[0]!.lastCheckOutAt).toBeNull();
    });

    it('ignores a missing punch on one end without losing the other', () => {
      const result = one([day({ checkOutAt: null })]);

      expect(result.days[0]!.firstCheckInAt).toBe('2026-09-01T04:00:00.000Z');
      expect(result.days[0]!.lastCheckOutAt).toBeNull();
    });
  });

  describe('the summary describes the same population as the chart', () => {
    it('counts distinct employees, not employee-days', () => {
      const result = aggregateDailyTotals({
        dates: ['2026-09-01', '2026-09-02'],
        byEmployee: new Map([
          ['emp-1', [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })]],
          ['emp-2', [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })]],
        ]),
      });

      expect(result.summary.totalEmployees).toBe(2);
      expect(result.summary.present).toBe(4);
    });

    it('averages worked minutes over days that produced a figure, not over all days', () => {
      // Two worked days of 540 and 480, plus a weekend nobody worked. The mean
      // is 510, not 340 - a weekend must not drag the working average down.
      const result = aggregateDailyTotals({
        dates: ['2026-09-01', '2026-09-02', '2026-09-05'],
        byEmployee: new Map([
          [
            'emp-1',
            [
              day({ date: '2026-09-01', workedMinutes: 540 }),
              day({ date: '2026-09-02', workedMinutes: 480 }),
              nonWorking({ date: '2026-09-05', status: 'WEEKEND' }),
            ],
          ],
        ]),
      });

      expect(result.summary.averageWorkedMinutes).toBe(510);
    });

    it('keeps weekends, holidays, off days and upcoming days out of the attendance rate', () => {
      const result = one([
        day({ status: 'PRESENT' }),
        day({ status: 'ABSENT' }),
        nonWorking({ status: 'WEEKEND' }),
        nonWorking({ status: 'HOLIDAY' }),
        nonWorking({ status: 'OFF_DAY' }),
        nonWorking({ status: 'UPCOMING' }),
      ]);

      // One present out of two scored days.
      expect(result.summary.attendancePercentage).toBe(50);
    });

    it('counts a half day as half, matching every other attendance figure', () => {
      const result = one([day({ status: 'PRESENT' }), day({ status: 'HALF_DAY' })]);

      expect(result.summary.attendancePercentage).toBe(75);
    });

    it('sums overtime across days without double counting it into worked time', () => {
      const result = aggregateDailyTotals({
        dates: ['2026-09-01', '2026-09-02'],
        byEmployee: new Map([
          [
            'emp-1',
            [
              day({ date: '2026-09-01', workedMinutes: 600, overtimeMinutes: 60 }),
              day({ date: '2026-09-02', workedMinutes: 570, overtimeMinutes: 30 }),
            ],
          ],
        ]),
      });

      expect(result.summary.workedMinutes).toBe(1170);
      expect(result.summary.overtimeMinutes).toBe(90);
    });
  });

  describe('the status filter narrows chart and summary together', () => {
    it('keeps only employee-days in the requested state', () => {
      const result = aggregateDailyTotals({
        dates: ['2026-09-01'],
        byEmployee: new Map([
          ['emp-1', [day({ status: 'PRESENT' })]],
          ['emp-2', [day({ status: 'ABSENT', workedMinutes: null })]],
        ]),
        status: 'ABSENT',
      });

      expect(result.days[0]!.absent).toBe(1);
      expect(result.days[0]!.present).toBe(0);
      expect(result.days[0]!.employeeCount).toBe(1);
      expect(result.summary.totalEmployees).toBe(1);
    });

    it('drops the filtered-out worked time from the columns as well as the cards', () => {
      const result = aggregateDailyTotals({
        dates: ['2026-09-01'],
        byEmployee: new Map([
          ['emp-1', [day({ workedMinutes: 540 })]],
          ['emp-2', [day({ status: 'HALF_DAY', workedMinutes: 240 })]],
        ]),
        status: 'HALF_DAY',
      });

      expect(result.days[0]!.workedMinutes).toBe(240);
      expect(result.summary.workedMinutes).toBe(240);
    });

    it('answers a weekend filter, which the stored status set cannot express', () => {
      const result = one([day(), nonWorking({ status: 'WEEKEND' })]);
      const filtered = aggregateDailyTotals({
        dates: ['2026-09-01'],
        byEmployee: new Map([['emp-1', [day(), nonWorking({ status: 'WEEKEND' })]]]),
        status: 'WEEKEND',
      });

      expect(result.days[0]!.employeeCount).toBe(2);
      expect(filtered.days[0]!.employeeCount).toBe(1);
      expect(filtered.days[0]!.weekend).toBe(1);
    });
  });

  describe('datesInRange', () => {
    it('is inclusive at both ends', () => {
      expect(datesInRange(new Date('2026-09-01'), new Date('2026-09-03'))).toEqual([
        '2026-09-01',
        '2026-09-02',
        '2026-09-03',
      ]);
    });

    it('returns a single day for a single-day range', () => {
      expect(datesInRange(new Date('2026-09-10'), new Date('2026-09-10'))).toEqual(['2026-09-10']);
    });

    it('returns nothing when the range is inverted, rather than looping forever', () => {
      expect(datesInRange(new Date('2026-09-10'), new Date('2026-09-01'))).toEqual([]);
    });

    it('crosses a month boundary without skipping or repeating a day', () => {
      const dates = datesInRange(new Date('2026-01-30'), new Date('2026-02-02'));

      expect(dates).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
      expect(new Set(dates).size).toBe(dates.length);
    });
  });
});
