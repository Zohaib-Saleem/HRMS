import { describe, expect, it } from 'vitest';
import type { AttendanceReportType } from '@hrms/shared';
import {
  attendancePercent,
  buildAttendanceReport,
  countInto,
  emptyCount,
  type ReportEmployee,
} from './attendance-reports.service.js';
import type { DerivedDay } from './attendance.service.js';

/**
 * Attendance reporting.
 *
 * The counting is what matters here, and it is pure, so it is pinned against
 * figures that can be worked out on paper. Two rules in particular have a
 * habit of quietly going wrong and are asserted repeatedly:
 *
 *   - Weekends, holidays, off days and days still ahead are not attendance
 *     anybody failed to produce. They are never in the denominator.
 *   - Employees on no team are grouped as "Unassigned", never dropped. Teams
 *     are optional in this HRMS and a report that omitted everyone outside one
 *     would understate the company by however many people that is.
 */

function day(over: Partial<DerivedDay> = {}): DerivedDay {
  return {
    date: '2026-06-01',
    status: 'PRESENT',
    flags: [],
    checkInAt: '2026-06-01T04:00:00.000Z',
    checkOutAt: '2026-06-01T13:00:00.000Z',
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
    leaveDayPart: null,
    holidayName: null,
    source: 'DEVICE',
    recordId: 'rec-1',
    hasRecord: true,
    ...over,
  };
}

const days = (count: number, over: Partial<DerivedDay> = {}): DerivedDay[] =>
  Array.from({ length: count }, (_, i) =>
    day({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, ...over }),
  );

function employee(over: Partial<ReportEmployee> = {}): ReportEmployee {
  return {
    id: 'emp-1',
    name: 'Ayesha Khan',
    employeeNumber: 'E-001',
    departmentId: 'dep-1',
    departmentName: 'Engineering',
    teamId: 'team-1',
    teamName: 'Platform',
    designationName: 'Engineer',
    shiftName: 'General',
    ...over,
  };
}

function report(
  type: AttendanceReportType,
  employees: ReportEmployee[],
  byEmployee: Record<string, DerivedDay[]>,
) {
  return buildAttendanceReport({
    type,
    from: '2026-06-01',
    to: '2026-06-30',
    employees,
    days: new Map(Object.entries(byEmployee)),
    truncated: false,
  });
}

// ---------------------------------------------------------------- counting

describe('counting a period', () => {
  it('does not count weekends, holidays, off days or future days as scheduled', () => {
    const bucket = emptyCount();
    for (const d of [
      ...days(20),
      ...days(4, { status: 'WEEKEND', workedMinutes: null }),
      ...days(2, { status: 'HOLIDAY', workedMinutes: null }),
      ...days(1, { status: 'OFF_DAY', workedMinutes: null }),
      ...days(3, { status: 'UPCOMING', workedMinutes: null, hasRecord: false }),
    ]) {
      countInto(bucket, d);
    }

    expect(bucket.scheduledDays).toBe(20);
    expect(bucket.weekendDays).toBe(4);
    expect(bucket.holidayDays).toBe(2);
    expect(bucket.offDays).toBe(1);
    expect(bucket.upcomingDays).toBe(3);
  });

  it('counts a half day as half a present day and as a half day', () => {
    const bucket = emptyCount();
    for (const d of days(2, { status: 'HALF_DAY' })) countInto(bucket, d);

    // Payroll reads presentDays; HR reads halfDays. Both have to be right.
    expect(bucket.presentDays).toBe(1);
    expect(bucket.halfDays).toBe(2);
    expect(bucket.scheduledDays).toBe(2);
  });

  it('separates paid from unpaid leave', () => {
    const bucket = emptyCount();
    countInto(bucket, day({ status: 'ON_LEAVE', leaveIsPaid: true, workedMinutes: null }));
    countInto(bucket, day({ status: 'ON_LEAVE', leaveIsPaid: false, workedMinutes: null }));
    countInto(bucket, day({ status: 'ON_LEAVE', leaveIsPaid: null, workedMinutes: null }));

    expect(bucket.leaveDays).toBe(3);
    expect(bucket.paidLeaveDays).toBe(1);
    // A leave type with no paid flag counts as unpaid rather than guessed at.
    expect(bucket.unpaidLeaveDays).toBe(2);
  });

  it('counts flags, not statuses, for late and early', () => {
    const bucket = emptyCount();
    // A late day is still a present day. Nothing here downgrades a status.
    countInto(bucket, day({ flags: ['LATE'], lateMinutes: 25 }));
    countInto(bucket, day({ flags: ['EARLY_LEAVE'], earlyLeaveMinutes: 15 }));
    countInto(bucket, day({ flags: ['MISSING_PUNCH'] }));

    expect(bucket.presentDays).toBe(3);
    expect(bucket.lateCount).toBe(1);
    expect(bucket.lateMinutes).toBe(25);
    expect(bucket.earlyLeaveCount).toBe(1);
    expect(bucket.earlyLeaveMinutes).toBe(15);
    expect(bucket.missingPunchDays).toBe(1);
  });
});

describe('the attendance percentage', () => {
  it('is present days over days actually scored', () => {
    const bucket = emptyCount();
    for (const d of [...days(18), ...days(2, { status: 'ABSENT', workedMinutes: null })]) {
      countInto(bucket, d);
    }
    // 18 of 20 = 90%
    expect(attendancePercent(bucket)).toBe(90);
  });

  it('does not let a month that has barely started read as absence', () => {
    const bucket = emptyCount();
    for (const d of [
      ...days(5),
      ...days(17, { status: 'UPCOMING', workedMinutes: null, hasRecord: false }),
      ...days(8, { status: 'WEEKEND', workedMinutes: null }),
    ]) {
      countInto(bucket, d);
    }
    // Five days in, five days attended. Not 5/30.
    expect(attendancePercent(bucket)).toBe(100);
  });

  it('is null rather than zero when nothing was scored', () => {
    const bucket = emptyCount();
    for (const d of days(8, { status: 'WEEKEND', workedMinutes: null })) countInto(bucket, d);
    // "No data" and "nobody came" are different answers.
    expect(attendancePercent(bucket)).toBeNull();
  });

  it('gives a half day half the credit', () => {
    const bucket = emptyCount();
    for (const d of [...days(1), ...days(1, { status: 'HALF_DAY' })]) countInto(bucket, d);
    expect(attendancePercent(bucket)).toBe(75);
  });
});

// ----------------------------------------------------------------- reports

describe('the monthly report', () => {
  it('gives one row per employee with every column the specification lists', () => {
    const table = report('monthly', [employee()], {
      'emp-1': [
        ...days(18),
        ...days(1, { status: 'HALF_DAY' }),
        ...days(2, { status: 'ABSENT', workedMinutes: null }),
        ...days(1, { status: 'ON_LEAVE', leaveIsPaid: true, workedMinutes: null }),
        ...days(1, { status: 'HOLIDAY', workedMinutes: null }),
        ...days(8, { status: 'WEEKEND', workedMinutes: null }),
        ...days(1, { flags: ['LATE'], lateMinutes: 20 }),
        ...days(1, { flags: ['OVERTIME'], overtimeMinutes: 120 }),
      ],
    });

    const keys = table.columns.map((c) => c.key);
    for (const required of [
      'presentDays',
      'halfDays',
      'absentDays',
      'leaveDays',
      'holidayDays',
      'weekendDays',
      'lateCount',
      'lateMinutes',
      'earlyLeaveCount',
      'earlyLeaveMinutes',
      'overtimeHours',
      'attendancePercentage',
    ]) {
      expect(keys).toContain(required);
    }

    const row = table.rows[0]!;
    // 18 whole + 1 half + 1 late + 1 overtime day, all present = 20.5
    expect(row.presentDays).toBe(20.5);
    expect(row.halfDays).toBe(1);
    expect(row.absentDays).toBe(2);
    expect(row.leaveDays).toBe(1);
    expect(row.holidayDays).toBe(1);
    expect(row.weekendDays).toBe(8);
    expect(row.lateCount).toBe(1);
    expect(row.lateMinutes).toBe(20);
    expect(row.overtimeHours).toBe(2);
  });

  it('totals the rows rather than recomputing them', () => {
    const table = report(
      'monthly',
      [employee(), employee({ id: 'emp-2', employeeNumber: 'E-002', name: 'Bilal Ahmed' })],
      { 'emp-1': days(10), 'emp-2': days(10) },
    );

    expect(table.totals?.presentDays).toBe(20);
    expect(table.totals?.employeeName).toBe('2 employee(s)');
  });
});

describe('grouped reports', () => {
  const people = [
    employee(),
    employee({ id: 'emp-2', employeeNumber: 'E-002', name: 'Bilal Ahmed' }),
    // Nobody forces an employee into a team.
    employee({
      id: 'emp-3',
      employeeNumber: 'E-003',
      name: 'Sana Iqbal',
      teamId: null,
      teamName: null,
      departmentId: 'dep-2',
      departmentName: 'Finance',
    }),
  ];

  const attendance = {
    'emp-1': days(20),
    'emp-2': [...days(18), ...days(2, { status: 'ABSENT', workedMinutes: null })],
    'emp-3': days(20),
  };

  it('groups by department and counts employees, not days', () => {
    const table = report('department', people, attendance);

    const engineering = table.rows.find((r) => r.groupName === 'Engineering')!;
    expect(engineering.employeeCount).toBe(2);
    // 38 present of 40 scored
    expect(engineering.attendancePercentage).toBe(95);
    expect(engineering.absentDays).toBe(2);
  });

  it('groups employees with no team as Unassigned rather than dropping them', () => {
    const table = report('team', people, attendance);

    const unassigned = table.rows.find((r) => r.groupName === 'Unassigned');
    expect(unassigned).toBeDefined();
    expect(unassigned!.employeeCount).toBe(1);

    // Every employee appears exactly once, somewhere.
    const counted = table.rows.reduce((sum, r) => sum + Number(r.employeeCount), 0);
    expect(counted).toBe(3);
    expect(table.totals?.employeeCount).toBe(3);
  });
});

describe('exception reports', () => {
  const person = employee();

  it('the late report lists only flagged days, with the minutes', () => {
    const table = report('late', [person], {
      'emp-1': [
        ...days(3),
        day({ date: '2026-06-10', flags: ['LATE'], lateMinutes: 35 }),
        day({ date: '2026-06-11', flags: ['LATE'], lateMinutes: 12 }),
      ],
    });

    expect(table.rows).toHaveLength(2);
    expect(table.rows.map((r) => r.date)).toEqual(['2026-06-10', '2026-06-11']);
    expect(table.totals?.lateMinutes).toBe(47);
  });

  it('the absence report lists absences and nothing else', () => {
    const table = report('absence', [person], {
      'emp-1': [
        ...days(3),
        day({ date: '2026-06-10', status: 'ABSENT', workedMinutes: null }),
        // Leave is not absence, and neither is a weekend.
        day({ date: '2026-06-11', status: 'ON_LEAVE', workedMinutes: null }),
        day({ date: '2026-06-12', status: 'WEEKEND', workedMinutes: null }),
      ],
    });

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.date).toBe('2026-06-10');
  });

  it('the overtime report lists days with minutes, not days with the flag alone', () => {
    const table = report('overtime', [person], {
      'emp-1': [
        day({ date: '2026-06-10', overtimeMinutes: 90, flags: ['OVERTIME'] }),
        day({ date: '2026-06-11', overtimeMinutes: 0 }),
      ],
    });

    expect(table.rows).toHaveLength(1);
    expect(table.totals?.overtimeMinutes).toBe(90);
  });

  it('the missing-punch report finds a day with one punch and not the other', () => {
    const table = report('missing-punch', [person], {
      'emp-1': [
        day({ date: '2026-06-10', checkOutAt: null, flags: ['MISSING_PUNCH'] }),
        day({ date: '2026-06-11' }),
      ],
    });

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.checkOutAt).toBeNull();
  });
});

describe('the daily report', () => {
  it('gives one row per employee per day, sorted by date', () => {
    const table = report(
      'daily',
      [employee(), employee({ id: 'emp-2', employeeNumber: 'E-002', name: 'Bilal Ahmed' })],
      {
        'emp-1': [day({ date: '2026-06-02' })],
        'emp-2': [day({ date: '2026-06-01' })],
      },
    );

    expect(table.rows).toHaveLength(2);
    expect(table.rows.map((r) => r.date)).toEqual(['2026-06-01', '2026-06-02']);
  });
});

describe('the summary report', () => {
  it('gives one row per calendar day across everybody', () => {
    const table = report(
      'summary',
      [employee(), employee({ id: 'emp-2', employeeNumber: 'E-002', name: 'Bilal Ahmed' })],
      {
        'emp-1': [day({ date: '2026-06-01' }), day({ date: '2026-06-02' })],
        'emp-2': [
          day({ date: '2026-06-01', status: 'ABSENT', workedMinutes: null }),
          day({ date: '2026-06-02' }),
        ],
      },
    );

    expect(table.rows).toHaveLength(2);
    const first = table.rows.find((r) => r.date === '2026-06-01')!;
    expect(first.presentDays).toBe(1);
    expect(first.absentDays).toBe(1);
    expect(first.attendancePercentage).toBe(50);
  });
});

describe('every report type', () => {
  it('builds a titled table with columns, for all of them', () => {
    const types: AttendanceReportType[] = [
      'daily',
      'monthly',
      'employee',
      'department',
      'team',
      'late',
      'early-leave',
      'absence',
      'overtime',
      'missing-punch',
      'leave-vs-attendance',
      'summary',
    ];

    for (const type of types) {
      const table = report(type, [employee()], { 'emp-1': days(5) });
      expect(table.type, type).toBe(type);
      expect(table.title.length, type).toBeGreaterThan(0);
      expect(table.columns.length, type).toBeGreaterThan(0);
      expect(table.from, type).toBe('2026-06-01');
    }
  });
});
