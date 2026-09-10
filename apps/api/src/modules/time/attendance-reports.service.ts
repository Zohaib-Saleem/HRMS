import type {
  AttendanceReport,
  AttendanceReportColumn,
  AttendanceReportType,
  ATTENDANCE_REPORT_LABELS as Labels,
} from '@hrms/shared';
import { ATTENDANCE_REPORT_LABELS } from '@hrms/shared';
import type { DerivedDay } from './attendance.service.js';

/**
 * Attendance reporting.
 *
 * Every report here is built from the same derived days the screens read -
 * `deriveRangeForEmployees` and nothing else. A report that re-derived a day
 * from punches, or read the record table directly and skipped the leave and
 * holiday calendars, would eventually disagree with the attendance page about
 * the same person on the same date, and there would be no way to tell which
 * was right.
 *
 * So: one derivation, several presentations. The functions below only count.
 */

export interface ReportEmployee {
  id: string;
  name: string;
  employeeNumber: string;
  departmentId: string | null;
  departmentName: string | null;
  teamId: string | null;
  teamName: string | null;
  designationName: string | null;
  shiftName: string | null;
}

export interface ReportInput {
  type: AttendanceReportType;
  from: string;
  to: string;
  employees: readonly ReportEmployee[];
  days: Map<string, DerivedDay[]>;
  truncated: boolean;
}

/** Present + half-day credit over the days that were actually scored. */
export interface Counted {
  scheduledDays: number;
  presentDays: number;
  halfDays: number;
  absentDays: number;
  leaveDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  holidayDays: number;
  weekendDays: number;
  offDays: number;
  upcomingDays: number;
  lateCount: number;
  lateMinutes: number;
  earlyLeaveCount: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  missingPunchDays: number;
  irregularDays: number;
  manualDays: number;
  workedMinutes: number;
  expectedMinutes: number;
}

export function emptyCount(): Counted {
  return {
    scheduledDays: 0,
    presentDays: 0,
    halfDays: 0,
    absentDays: 0,
    leaveDays: 0,
    paidLeaveDays: 0,
    unpaidLeaveDays: 0,
    holidayDays: 0,
    weekendDays: 0,
    offDays: 0,
    upcomingDays: 0,
    lateCount: 0,
    lateMinutes: 0,
    earlyLeaveCount: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    missingPunchDays: 0,
    irregularDays: 0,
    manualDays: 0,
    workedMinutes: 0,
    expectedMinutes: 0,
  };
}

/**
 * Counts one day into a bucket.
 *
 * A half day counts as half a present day *and* as a half day, deliberately:
 * "present days" is what payroll and the attendance percentage read, and "half
 * days" is what HR wants to see listed. Reporting only one of them would make
 * one of those two readers wrong.
 */
export function countInto(bucket: Counted, day: DerivedDay): void {
  switch (day.status) {
    case 'WEEKEND':
      bucket.weekendDays += 1;
      break;
    case 'OFF_DAY':
      bucket.offDays += 1;
      break;
    case 'HOLIDAY':
      bucket.holidayDays += 1;
      break;
    case 'UPCOMING':
      bucket.upcomingDays += 1;
      break;
    case 'ON_LEAVE':
      bucket.scheduledDays += 1;
      bucket.leaveDays += 1;
      if (day.leaveIsPaid === true) bucket.paidLeaveDays += 1;
      else bucket.unpaidLeaveDays += 1;
      break;
    case 'PRESENT':
      bucket.scheduledDays += 1;
      bucket.presentDays += 1;
      break;
    case 'HALF_DAY':
      bucket.scheduledDays += 1;
      bucket.halfDays += 1;
      bucket.presentDays += 0.5;
      break;
    default:
      bucket.scheduledDays += 1;
      bucket.absentDays += 1;
      break;
  }

  bucket.workedMinutes += day.workedMinutes ?? 0;
  bucket.expectedMinutes += day.expectedMinutes ?? 0;
  bucket.lateMinutes += day.lateMinutes ?? 0;
  bucket.earlyLeaveMinutes += day.earlyLeaveMinutes ?? 0;
  bucket.overtimeMinutes += day.overtimeMinutes ?? 0;

  for (const flag of day.flags) {
    if (flag === 'LATE') bucket.lateCount += 1;
    else if (flag === 'EARLY_LEAVE') bucket.earlyLeaveCount += 1;
    else if (flag === 'MISSING_PUNCH') bucket.missingPunchDays += 1;
    else if (flag === 'IRREGULAR') bucket.irregularDays += 1;
    else if (flag === 'MANUAL') bucket.manualDays += 1;
  }
}

/**
 * Attendance percentage.
 *
 * Present and half days over the days that were scored - present, half,
 * absent and leave. Weekends, holidays, off days and days still to come are
 * excluded from both sides: a month that is a week old is not 75% absent.
 * Null rather than zero when nothing was scored, so "no data" and "nobody
 * came" stay different answers.
 */
export function attendancePercent(bucket: Counted): number | null {
  const scored = bucket.scheduledDays;
  if (scored <= 0) return null;
  return Math.round((bucket.presentDays / scored) * 1000) / 10;
}

const hours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

const col = (
  key: string,
  label: string,
  kind: AttendanceReportColumn['kind'] = 'text',
): AttendanceReportColumn => ({
  key,
  label,
  kind,
  align: kind === 'number' || kind === 'minutes' || kind === 'percent' ? 'right' : 'left',
});

const IDENTITY_COLUMNS: AttendanceReportColumn[] = [
  col('employeeNumber', 'Employee code'),
  col('employeeName', 'Employee'),
  col('departmentName', 'Department'),
  col('teamName', 'Team'),
];

/** The daily report: one row per employee for each day of the range. */
function dailyReport(input: ReportInput): Pick<AttendanceReport, 'columns' | 'rows' | 'totals'> {
  const columns: AttendanceReportColumn[] = [
    col('date', 'Date', 'date'),
    ...IDENTITY_COLUMNS,
    col('shiftName', 'Shift'),
    col('status', 'Status'),
    col('checkInAt', 'Check-in', 'time'),
    col('checkOutAt', 'Check-out', 'time'),
    col('workedMinutes', 'Worked', 'minutes'),
    col('lateMinutes', 'Late', 'minutes'),
    col('earlyLeaveMinutes', 'Early leave', 'minutes'),
    col('overtimeMinutes', 'Overtime', 'minutes'),
    col('flags', 'Flags'),
  ];

  const rows: AttendanceReport['rows'] = [];
  const totals = emptyCount();

  for (const employee of input.employees) {
    for (const day of input.days.get(employee.id) ?? []) {
      countInto(totals, day);
      rows.push({
        date: day.date,
        employeeNumber: employee.employeeNumber,
        employeeName: employee.name,
        departmentName: employee.departmentName,
        teamName: employee.teamName,
        shiftName: day.shiftName,
        status: day.status,
        checkInAt: day.checkInAt,
        checkOutAt: day.checkOutAt,
        workedMinutes: day.workedMinutes,
        lateMinutes: day.lateMinutes,
        earlyLeaveMinutes: day.earlyLeaveMinutes,
        overtimeMinutes: day.overtimeMinutes,
        flags: day.flags.join(', ') || null,
      });
    }
  }

  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return {
    columns,
    rows,
    totals: {
      date: `${input.from} to ${input.to}`,
      employeeName: `${rows.length} day(s)`,
      workedMinutes: totals.workedMinutes,
      lateMinutes: totals.lateMinutes,
      earlyLeaveMinutes: totals.earlyLeaveMinutes,
      overtimeMinutes: totals.overtimeMinutes,
      status: null,
    },
  };
}

/** The monthly report: one row per employee, the whole range summarised. */
function monthlyReport(input: ReportInput): Pick<AttendanceReport, 'columns' | 'rows' | 'totals'> {
  const columns: AttendanceReportColumn[] = [
    ...IDENTITY_COLUMNS,
    col('designationName', 'Designation'),
    col('presentDays', 'Present days', 'number'),
    col('halfDays', 'Half days', 'number'),
    col('absentDays', 'Absent days', 'number'),
    col('leaveDays', 'Leave days', 'number'),
    col('paidLeaveDays', 'Paid leave', 'number'),
    col('unpaidLeaveDays', 'Unpaid leave', 'number'),
    col('holidayDays', 'Holidays', 'number'),
    col('weekendDays', 'Weekends', 'number'),
    col('offDays', 'Off days', 'number'),
    col('lateCount', 'Late count', 'number'),
    col('lateMinutes', 'Late minutes', 'minutes'),
    col('earlyLeaveCount', 'Early-leave count', 'number'),
    col('earlyLeaveMinutes', 'Early-leave minutes', 'minutes'),
    col('overtimeHours', 'OT hours', 'number'),
    col('attendancePercentage', 'Attendance %', 'percent'),
  ];

  const rows: AttendanceReport['rows'] = [];
  const grand = emptyCount();

  for (const employee of input.employees) {
    const bucket = emptyCount();
    for (const day of input.days.get(employee.id) ?? []) {
      countInto(bucket, day);
      countInto(grand, day);
    }

    rows.push({
      /**
       * Carried for screens that need to link a row back to a person, and
       * deliberately not in `columns`: the CSV and the report table are both
       * built from the column list, so an id here is invisible to every
       * existing consumer and changes no export.
       */
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      employeeName: employee.name,
      departmentName: employee.departmentName,
      teamName: employee.teamName,
      designationName: employee.designationName,
      presentDays: bucket.presentDays,
      halfDays: bucket.halfDays,
      absentDays: bucket.absentDays,
      leaveDays: bucket.leaveDays,
      paidLeaveDays: bucket.paidLeaveDays,
      unpaidLeaveDays: bucket.unpaidLeaveDays,
      holidayDays: bucket.holidayDays,
      weekendDays: bucket.weekendDays,
      offDays: bucket.offDays,
      lateCount: bucket.lateCount,
      lateMinutes: bucket.lateMinutes,
      earlyLeaveCount: bucket.earlyLeaveCount,
      earlyLeaveMinutes: bucket.earlyLeaveMinutes,
      overtimeHours: hours(bucket.overtimeMinutes),
      attendancePercentage: attendancePercent(bucket),
    });
  }

  return {
    columns,
    rows,
    totals: {
      employeeName: `${rows.length} employee(s)`,
      presentDays: grand.presentDays,
      halfDays: grand.halfDays,
      absentDays: grand.absentDays,
      leaveDays: grand.leaveDays,
      paidLeaveDays: grand.paidLeaveDays,
      unpaidLeaveDays: grand.unpaidLeaveDays,
      holidayDays: grand.holidayDays,
      weekendDays: grand.weekendDays,
      offDays: grand.offDays,
      lateCount: grand.lateCount,
      lateMinutes: grand.lateMinutes,
      earlyLeaveCount: grand.earlyLeaveCount,
      earlyLeaveMinutes: grand.earlyLeaveMinutes,
      overtimeHours: hours(grand.overtimeMinutes),
      attendancePercentage: attendancePercent(grand),
    },
  };
}

/**
 * Grouped attendance: by department or by team.
 *
 * Employees with no department or no team are grouped as "Unassigned" rather
 * than dropped. Teams in particular are optional in this HRMS - the
 * specification is explicit that employees are not forced into one - and a
 * department report that silently omitted everybody outside a team would
 * understate the company.
 */
function groupedReport(
  input: ReportInput,
  by: 'department' | 'team',
): Pick<AttendanceReport, 'columns' | 'rows' | 'totals'> {
  const columns: AttendanceReportColumn[] = [
    col('groupName', by === 'department' ? 'Department' : 'Team'),
    col('employeeCount', 'Employees', 'number'),
    col('attendancePercentage', 'Attendance %', 'percent'),
    col('presentDays', 'Present days', 'number'),
    col('absentDays', 'Absence days', 'number'),
    col('leaveDays', 'Leave days', 'number'),
    col('lateCount', 'Late', 'number'),
    col('lateMinutes', 'Late minutes', 'minutes'),
    col('earlyLeaveCount', 'Early', 'number'),
    col('earlyLeaveMinutes', 'Early-leave minutes', 'minutes'),
    col('overtimeHours', 'OT hours', 'number'),
  ];

  const groups = new Map<string, { name: string; employees: Set<string>; bucket: Counted }>();
  const grand = emptyCount();
  const everyone = new Set<string>();

  for (const employee of input.employees) {
    const id = by === 'department' ? employee.departmentId : employee.teamId;
    const name = (by === 'department' ? employee.departmentName : employee.teamName) ?? 'Unassigned';
    const key = id ?? '__unassigned__';

    let group = groups.get(key);
    if (!group) groups.set(key, (group = { name, employees: new Set(), bucket: emptyCount() }));
    group.employees.add(employee.id);
    everyone.add(employee.id);

    for (const day of input.days.get(employee.id) ?? []) {
      countInto(group.bucket, day);
      countInto(grand, day);
    }
  }

  const rows = [...groups.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((group) => ({
      groupName: group.name,
      employeeCount: group.employees.size,
      attendancePercentage: attendancePercent(group.bucket),
      presentDays: group.bucket.presentDays,
      absentDays: group.bucket.absentDays,
      leaveDays: group.bucket.leaveDays,
      lateCount: group.bucket.lateCount,
      lateMinutes: group.bucket.lateMinutes,
      earlyLeaveCount: group.bucket.earlyLeaveCount,
      earlyLeaveMinutes: group.bucket.earlyLeaveMinutes,
      overtimeHours: hours(group.bucket.overtimeMinutes),
    }));

  return {
    columns,
    rows,
    totals: {
      groupName: 'All',
      employeeCount: everyone.size,
      attendancePercentage: attendancePercent(grand),
      presentDays: grand.presentDays,
      absentDays: grand.absentDays,
      leaveDays: grand.leaveDays,
      lateCount: grand.lateCount,
      lateMinutes: grand.lateMinutes,
      earlyLeaveCount: grand.earlyLeaveCount,
      earlyLeaveMinutes: grand.earlyLeaveMinutes,
      overtimeHours: hours(grand.overtimeMinutes),
    },
  };
}

/**
 * The exception reports: late, early leave, absence, overtime, missing punch.
 *
 * All the same shape - the days that match one condition - so they share one
 * implementation rather than five that drift.
 */
function exceptionReport(
  input: ReportInput,
  match: (day: DerivedDay) => boolean,
  extra: AttendanceReportColumn[],
  cell: (day: DerivedDay) => Record<string, string | number | null>,
): Pick<AttendanceReport, 'columns' | 'rows' | 'totals'> {
  const columns: AttendanceReportColumn[] = [
    col('date', 'Date', 'date'),
    ...IDENTITY_COLUMNS,
    col('shiftName', 'Shift'),
    ...extra,
  ];

  const rows: AttendanceReport['rows'] = [];
  for (const employee of input.employees) {
    for (const day of input.days.get(employee.id) ?? []) {
      if (!match(day)) continue;
      rows.push({
        date: day.date,
        employeeNumber: employee.employeeNumber,
        employeeName: employee.name,
        departmentName: employee.departmentName,
        teamName: employee.teamName,
        shiftName: day.shiftName,
        ...cell(day),
      });
    }
  }

  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const sum = (key: string): number =>
    rows.reduce((total, row) => total + (typeof row[key] === 'number' ? (row[key] as number) : 0), 0);

  const totals: AttendanceReport['totals'] = { date: `${rows.length} day(s)` };
  for (const column of extra) {
    if (column.kind === 'minutes' || column.kind === 'number') totals[column.key] = sum(column.key);
  }

  return { columns, rows, totals };
}

/** Leave taken beside attendance, for the month somebody queries a balance. */
function leaveVsAttendance(
  input: ReportInput,
): Pick<AttendanceReport, 'columns' | 'rows' | 'totals'> {
  const columns: AttendanceReportColumn[] = [
    ...IDENTITY_COLUMNS,
    col('scheduledDays', 'Working days', 'number'),
    col('presentDays', 'Present', 'number'),
    col('paidLeaveDays', 'Paid leave', 'number'),
    col('unpaidLeaveDays', 'Unpaid leave', 'number'),
    col('absentDays', 'Absent', 'number'),
    col('holidayDays', 'Holidays', 'number'),
    col('attendancePercentage', 'Attendance %', 'percent'),
  ];

  const rows: AttendanceReport['rows'] = [];
  const grand = emptyCount();

  for (const employee of input.employees) {
    const bucket = emptyCount();
    for (const day of input.days.get(employee.id) ?? []) {
      countInto(bucket, day);
      countInto(grand, day);
    }
    rows.push({
      employeeNumber: employee.employeeNumber,
      employeeName: employee.name,
      departmentName: employee.departmentName,
      teamName: employee.teamName,
      scheduledDays: bucket.scheduledDays,
      presentDays: bucket.presentDays,
      paidLeaveDays: bucket.paidLeaveDays,
      unpaidLeaveDays: bucket.unpaidLeaveDays,
      absentDays: bucket.absentDays,
      holidayDays: bucket.holidayDays,
      attendancePercentage: attendancePercent(bucket),
    });
  }

  return {
    columns,
    rows,
    totals: {
      employeeName: `${rows.length} employee(s)`,
      scheduledDays: grand.scheduledDays,
      presentDays: grand.presentDays,
      paidLeaveDays: grand.paidLeaveDays,
      unpaidLeaveDays: grand.unpaidLeaveDays,
      absentDays: grand.absentDays,
      holidayDays: grand.holidayDays,
      attendancePercentage: attendancePercent(grand),
    },
  };
}

/** One line per calendar day: the company's shape of a week. */
function summaryReport(input: ReportInput): Pick<AttendanceReport, 'columns' | 'rows' | 'totals'> {
  const columns: AttendanceReportColumn[] = [
    col('date', 'Date', 'date'),
    col('presentDays', 'Present', 'number'),
    col('halfDays', 'Half day', 'number'),
    col('absentDays', 'Absent', 'number'),
    col('leaveDays', 'Leave', 'number'),
    col('holidayDays', 'Holiday', 'number'),
    col('weekendDays', 'Weekend', 'number'),
    col('lateCount', 'Late', 'number'),
    col('earlyLeaveCount', 'Early', 'number'),
    col('overtimeHours', 'OT hours', 'number'),
    col('missingPunchDays', 'Missing punch', 'number'),
    col('attendancePercentage', 'Attendance %', 'percent'),
  ];

  const byDate = new Map<string, Counted>();
  const grand = emptyCount();

  for (const employee of input.employees) {
    for (const day of input.days.get(employee.id) ?? []) {
      let bucket = byDate.get(day.date);
      if (!bucket) byDate.set(day.date, (bucket = emptyCount()));
      countInto(bucket, day);
      countInto(grand, day);
    }
  }

  const rows = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => ({
      date,
      presentDays: bucket.presentDays,
      halfDays: bucket.halfDays,
      absentDays: bucket.absentDays,
      leaveDays: bucket.leaveDays,
      holidayDays: bucket.holidayDays,
      weekendDays: bucket.weekendDays,
      lateCount: bucket.lateCount,
      earlyLeaveCount: bucket.earlyLeaveCount,
      overtimeHours: hours(bucket.overtimeMinutes),
      missingPunchDays: bucket.missingPunchDays,
      attendancePercentage: attendancePercent(bucket),
    }));

  return {
    columns,
    rows,
    totals: {
      date: 'All',
      presentDays: grand.presentDays,
      halfDays: grand.halfDays,
      absentDays: grand.absentDays,
      leaveDays: grand.leaveDays,
      holidayDays: grand.holidayDays,
      weekendDays: grand.weekendDays,
      lateCount: grand.lateCount,
      earlyLeaveCount: grand.earlyLeaveCount,
      overtimeHours: hours(grand.overtimeMinutes),
      missingPunchDays: grand.missingPunchDays,
      attendancePercentage: attendancePercent(grand),
    },
  };
}

/** Builds one report. The single switch; every type resolves to a table. */
export function buildAttendanceReport(input: ReportInput): AttendanceReport {
  const body = ((): Pick<AttendanceReport, 'columns' | 'rows' | 'totals'> => {
    switch (input.type) {
      case 'daily':
        return dailyReport(input);
      case 'employee':
      case 'monthly':
        return input.type === 'employee' ? dailyReport(input) : monthlyReport(input);
      case 'department':
        return groupedReport(input, 'department');
      case 'team':
        return groupedReport(input, 'team');
      case 'late':
        return exceptionReport(
          input,
          (d) => d.flags.includes('LATE'),
          [
            col('checkInAt', 'Check-in', 'time'),
            col('lateMinutes', 'Late minutes', 'minutes'),
            col('status', 'Status'),
          ],
          (d) => ({ checkInAt: d.checkInAt, lateMinutes: d.lateMinutes, status: d.status }),
        );
      case 'early-leave':
        return exceptionReport(
          input,
          (d) => d.flags.includes('EARLY_LEAVE'),
          [
            col('checkOutAt', 'Check-out', 'time'),
            col('earlyLeaveMinutes', 'Early-leave minutes', 'minutes'),
            col('status', 'Status'),
          ],
          (d) => ({
            checkOutAt: d.checkOutAt,
            earlyLeaveMinutes: d.earlyLeaveMinutes,
            status: d.status,
          }),
        );
      case 'absence':
        return exceptionReport(
          input,
          (d) => d.status === 'ABSENT',
          [col('status', 'Status'), col('notes', 'Notes')],
          (d) => ({ status: d.status, notes: d.notes }),
        );
      case 'overtime':
        return exceptionReport(
          input,
          (d) => (d.overtimeMinutes ?? 0) > 0,
          [
            col('checkInAt', 'Check-in', 'time'),
            col('checkOutAt', 'Check-out', 'time'),
            col('overtimeMinutes', 'Overtime minutes', 'minutes'),
            col('status', 'Status'),
          ],
          (d) => ({
            checkInAt: d.checkInAt,
            checkOutAt: d.checkOutAt,
            overtimeMinutes: d.overtimeMinutes,
            status: d.status,
          }),
        );
      case 'missing-punch':
        return exceptionReport(
          input,
          (d) => d.flags.includes('MISSING_PUNCH'),
          [
            col('checkInAt', 'Check-in', 'time'),
            col('checkOutAt', 'Check-out', 'time'),
            col('status', 'Status'),
          ],
          (d) => ({ checkInAt: d.checkInAt, checkOutAt: d.checkOutAt, status: d.status }),
        );
      case 'leave-vs-attendance':
        return leaveVsAttendance(input);
      default:
        return summaryReport(input);
    }
  })();

  const labels: typeof Labels = ATTENDANCE_REPORT_LABELS;

  return {
    type: input.type,
    title: labels[input.type],
    from: input.from,
    to: input.to,
    generatedAt: new Date().toISOString(),
    truncated: input.truncated,
    ...body,
  };
}
