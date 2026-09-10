import { describe, expect, it } from 'vitest';
import { UNASSIGNED_TEAM_ID, UNASSIGNED_TEAM_LABEL, type AttendanceDay } from '@hrms/shared';
import {
  isLateDay,
  isScoredDay,
  summariseByTeam,
  teamFilterClause,
  type TeamGroupable,
} from './team-attendance.service.js';

/** A derived day, with only the fields the grouping actually reads set. */
const day = (over: Partial<AttendanceDay> & Pick<AttendanceDay, 'status'>): AttendanceDay => ({
  date: '2026-09-01',
  flags: [],
  checkInAt: null,
  checkOutAt: null,
  workedMinutes: null,
  lateMinutes: null,
  earlyLeaveMinutes: null,
  overtimeMinutes: null,
  expectedMinutes: null,
  irregular: false,
  mode: null,
  shiftId: null,
  shiftName: null,
  notes: null,
  leaveTypeName: null,
  holidayName: null,
  source: null,
  recordId: null,
  hasRecord: true,
  ...over,
});

const member = (over: Partial<TeamGroupable>): TeamGroupable => ({
  teamId: null,
  teamName: null,
  departmentName: null,
  days: [],
  ...over,
});

describe('teamFilterClause', () => {
  it('does not filter when no team is asked for', () => {
    expect(teamFilterClause(undefined)).toEqual({});
    expect(teamFilterClause('')).toEqual({});
  });

  it('narrows to one team by id', () => {
    expect(teamFilterClause('team_abc')).toEqual({ teamId: 'team_abc' });
  });

  it('narrows to employees on no team for the unassigned sentinel', () => {
    expect(teamFilterClause(UNASSIGNED_TEAM_ID)).toEqual({ teamId: null });
  });

  it('never returns a clause that could widen a query', () => {
    // Every branch is either empty or an equality on teamId - nothing here can
    // add an OR that reaches outside the caller's scope filter.
    for (const input of [undefined, '', 'x', UNASSIGNED_TEAM_ID]) {
      const clause = teamFilterClause(input);
      expect(Object.keys(clause).every((k) => k === 'teamId')).toBe(true);
    }
  });
});

describe('day classification', () => {
  it('counts a day as late only when late minutes were recorded', () => {
    expect(isLateDay(day({ status: 'PRESENT', lateMinutes: 12 }))).toBe(true);
    expect(isLateDay(day({ status: 'PRESENT', lateMinutes: 0 }))).toBe(false);
    expect(isLateDay(day({ status: 'PRESENT', lateMinutes: null }))).toBe(false);
  });

  it('scores only working days, so a short week is not read as absence', () => {
    expect(isScoredDay(day({ status: 'PRESENT' }))).toBe(true);
    expect(isScoredDay(day({ status: 'HALF_DAY' }))).toBe(true);
    expect(isScoredDay(day({ status: 'ABSENT' }))).toBe(true);
    expect(isScoredDay(day({ status: 'ON_LEAVE' }))).toBe(true);
    expect(isScoredDay(day({ status: 'WEEKEND' }))).toBe(false);
    expect(isScoredDay(day({ status: 'HOLIDAY' }))).toBe(false);
    expect(isScoredDay(day({ status: 'UPCOMING' }))).toBe(false);
  });
});

describe('summariseByTeam', () => {
  it('groups employees by their team', () => {
    const rows = summariseByTeam([
      member({ teamId: 't1', teamName: 'Platform', departmentName: 'Engineering' }),
      member({ teamId: 't1', teamName: 'Platform', departmentName: 'Engineering' }),
      member({ teamId: 't2', teamName: 'Web', departmentName: 'Engineering' }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.teamName, r.employees])).toEqual([
      ['Platform', 2],
      ['Web', 1],
    ]);
  });

  it('counts present, late, absent and total from the days', () => {
    const rows = summariseByTeam([
      member({
        teamId: 't1',
        teamName: 'Platform',
        days: [
          day({ status: 'PRESENT' }),
          day({ status: 'PRESENT', lateMinutes: 20 }),
          day({ status: 'ABSENT' }),
          day({ status: 'ON_LEAVE' }),
          day({ status: 'WEEKEND' }),
          day({ status: 'HOLIDAY' }),
          day({ status: 'UPCOMING' }),
        ],
      }),
    ]);

    expect(rows[0]).toMatchObject({
      present: 2,
      late: 1,
      absent: 1,
      // present 2 + absent 1 + onLeave 1; weekend, holiday and upcoming excluded
      total: 4,
    });
  });

  it('counts a half day toward the total without counting it present', () => {
    const rows = summariseByTeam([
      member({ teamId: 't1', teamName: 'Platform', days: [day({ status: 'HALF_DAY' })] }),
    ]);
    expect(rows[0]).toMatchObject({ present: 0, absent: 0, total: 1 });
  });

  it('keeps employees with no team in an Unassigned bucket rather than dropping them', () => {
    const rows = summariseByTeam([
      member({ teamId: 't1', teamName: 'Platform', days: [day({ status: 'PRESENT' })] }),
      member({ teamId: null, days: [day({ status: 'PRESENT' })] }),
      member({ teamId: null, days: [day({ status: 'ABSENT' })] }),
    ]);

    const unassigned = rows.find((r) => r.teamId === null);
    expect(unassigned).toBeDefined();
    expect(unassigned).toMatchObject({
      teamName: UNASSIGNED_TEAM_LABEL,
      employees: 2,
      present: 1,
      absent: 1,
    });

    // Nobody is lost: every employee handed in is counted exactly once.
    expect(rows.reduce((n, r) => n + r.employees, 0)).toBe(3);
  });

  it('puts Unassigned last, after the named teams', () => {
    const rows = summariseByTeam([
      member({ teamId: null }),
      member({ teamId: 't2', teamName: 'Web' }),
      member({ teamId: 't1', teamName: 'Platform' }),
    ]);
    expect(rows.map((r) => r.teamName)).toEqual(['Platform', 'Web', UNASSIGNED_TEAM_LABEL]);
  });

  it('counts an employee with no attendance days at all', () => {
    // The roster is the denominator. Someone who never clocked in is present in
    // the summary with zeroes, not missing from it.
    const rows = summariseByTeam([member({ teamId: 't1', teamName: 'Platform', days: [] })]);
    expect(rows[0]).toMatchObject({ employees: 1, present: 0, late: 0, absent: 0, total: 0 });
  });

  it('returns nothing for an empty roster', () => {
    expect(summariseByTeam([])).toEqual([]);
  });

  it('does not invent a department for the unassigned bucket', () => {
    // A teamless employee may still sit in a department, but "Unassigned" is not
    // in one - showing a department there would imply a team that does not exist.
    const rows = summariseByTeam([member({ teamId: null, departmentName: 'Designing' })]);
    expect(rows[0]?.departmentName).toBeNull();
  });
});
