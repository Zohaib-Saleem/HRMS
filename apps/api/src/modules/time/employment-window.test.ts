import { describe, expect, it } from 'vitest';
import {
  attendancePopulationWhere,
  effectiveLastWorkingDate,
  isEmployedDuringRange,
  isEmployeeInAttendancePopulation,
  type EmploymentWindowFields,
} from './employment-window.js';

/**
 * Who is in the attendance population on a given day.
 *
 * The bug these exist for: Team Attendance for 15 September 2026 listed Hira
 * Javed as ABSENT. She was terminated on the 10th. Nothing was wrong with her
 * record and nothing was wrong with the deriver's arithmetic - the deriver was
 * simply handed every calendar day in the range and told to classify it, and a
 * working day with no punch on it is an absence. Employment had no say.
 *
 * So the assertions below are all the same assertion from different angles: the
 * boundary is the effective last working DAY, it is inclusive, and the
 * lifecycle status only chooses which date to read - it never decides on its
 * own. In particular, "not ACTIVE" is never the test: somebody serving notice
 * carries an exit status and a future last day, and is at work the whole time.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const employee = (over: Partial<EmploymentWindowFields>): EmploymentWindowFields => ({
  status: 'ACTIVE',
  hireDate: day('2024-01-01'),
  terminationDate: null,
  resignationDate: null,
  ...over,
});

/** The record from the bug report, as the HR data model holds it. */
const HIRA = employee({
  status: 'TERMINATED',
  hireDate: day('2023-04-03'),
  terminationDate: day('2026-09-10'),
});

describe('the reported bug: Hira Javed, terminated 2026-09-10', () => {
  it('is not in the attendance population on 2026-09-15', () => {
    expect(isEmployeeInAttendancePopulation(HIRA, day('2026-09-15'))).toBe(false);
  });

  it('is still in it on 2026-09-09, the day before she left', () => {
    expect(isEmployeeInAttendancePopulation(HIRA, day('2026-09-09'))).toBe(true);
  });

  it('is still in it on 2026-09-10 itself - the last working day is inclusive', () => {
    expect(isEmployeeInAttendancePopulation(HIRA, day('2026-09-10'))).toBe(true);
  });

  it('is out of it from 2026-09-11 onwards', () => {
    expect(isEmployeeInAttendancePopulation(HIRA, day('2026-09-11'))).toBe(false);
    expect(isEmployeeInAttendancePopulation(HIRA, day('2026-12-31'))).toBe(false);
  });

  it('keeps every historical day she actually worked', () => {
    for (const d of ['2026-09-01', '2026-09-04', '2026-09-08', '2026-09-10']) {
      expect(isEmployeeInAttendancePopulation(HIRA, day(d)), d).toBe(true);
    }
  });

  it('is still worth a row in a range that ends after she left but starts before', () => {
    // September as a whole is her month: ten days of it were hers.
    expect(isEmployedDuringRange(HIRA, day('2026-09-01'), day('2026-09-30'))).toBe(true);
    // A range entirely after the exit is not.
    expect(isEmployedDuringRange(HIRA, day('2026-09-11'), day('2026-09-30'))).toBe(false);
  });
});

describe('boundary dates', () => {
  const cases: Array<{
    name: string;
    person: EmploymentWindowFields;
    included: string[];
    excluded: string[];
  }> = [
    {
      name: 'terminated mid-month',
      person: employee({ status: 'TERMINATED', terminationDate: day('2026-09-10') }),
      included: ['2026-09-09', '2026-09-10'],
      excluded: ['2026-09-11'],
    },
    {
      name: 'a future termination date - still at work until it arrives',
      person: employee({ status: 'TERMINATED', terminationDate: day('2026-12-31') }),
      included: ['2026-09-15', '2026-12-30', '2026-12-31'],
      excluded: ['2027-01-01'],
    },
    {
      name: 'notice period, modelled as an exit status with a future last day',
      person: employee({
        status: 'RESIGNED',
        resignationDate: day('2026-09-01'),
        terminationDate: day('2026-09-30'),
      }),
      // The whole notice period is worked, which is exactly what filtering on
      // `status !== ACTIVE` would have thrown away.
      included: ['2026-09-01', '2026-09-15', '2026-09-30'],
      excluded: ['2026-10-01'],
    },
    {
      name: 'notice period recorded without an exit status',
      person: employee({ status: 'ACTIVE', terminationDate: day('2026-09-30') }),
      included: ['2026-09-30'],
      excluded: ['2026-10-01'],
    },
    {
      name: 'resigned, with a last working day of its own',
      person: employee({
        status: 'RESIGNED',
        resignationDate: day('2026-08-01'),
        terminationDate: day('2026-08-31'),
      }),
      // The resignation date is when notice was handed in, and is NOT the
      // boundary: August was worked in full.
      included: ['2026-08-01', '2026-08-15', '2026-08-31'],
      excluded: ['2026-09-01'],
    },
    {
      name: 'resigned and left the same day, so only a resignation date exists',
      person: employee({ status: 'RESIGNED', resignationDate: day('2026-08-31') }),
      included: ['2026-08-31'],
      excluded: ['2026-09-01'],
    },
    {
      name: 'still employed, still working, no leaving date of any kind',
      person: employee({ status: 'ACTIVE' }),
      included: ['2024-01-01', '2026-09-15', '2030-01-01'],
      excluded: ['2023-12-31'],
    },
    {
      name: 'on leave and suspended are not exits',
      person: employee({ status: 'ON_LEAVE' }),
      included: ['2026-09-15'],
      excluded: [],
    },
    {
      name: 'not yet started',
      person: employee({ hireDate: day('2026-09-16') }),
      included: ['2026-09-16', '2026-09-17'],
      excluded: ['2026-09-15'],
    },
    {
      name: 'no hire date recorded - nothing to exclude by',
      person: employee({ hireDate: null }),
      included: ['1999-01-01', '2026-09-15'],
      excluded: [],
    },
  ];

  for (const { name, person, included, excluded } of cases) {
    it(name, () => {
      for (const d of included) {
        expect(isEmployeeInAttendancePopulation(person, day(d)), `${d} should be in`).toBe(true);
      }
      for (const d of excluded) {
        expect(isEmployeeInAttendancePopulation(person, day(d)), `${d} should be out`).toBe(false);
      }
    });
  }
});

describe('the employment status feature is not a lifecycle field', () => {
  /**
   * Probation / Permanent / Internee says how far through an arrangement
   * somebody is, not whether the arrangement existed. A probationer who comes
   * to work is present, and must be scored.
   */
  it('scores a probationer exactly like anybody else', () => {
    const probationer = { ...employee({}), employmentStatus: 'PROBATION' };
    const permanent = { ...employee({}), employmentStatus: 'PERMANENT' };
    const internee = { ...employee({}), employmentStatus: 'INTERNEE' };

    for (const person of [probationer, permanent, internee]) {
      expect(isEmployeeInAttendancePopulation(person, day('2026-09-15'))).toBe(true);
    }
  });

  it('reads none of employmentType either', () => {
    const contractor = { ...employee({}), employmentType: 'CONTRACT' };
    expect(isEmployeeInAttendancePopulation(contractor, day('2026-09-15'))).toBe(true);
  });
});

describe('effectiveLastWorkingDate', () => {
  it('prefers the termination date, which is the last day worked', () => {
    const person = employee({
      status: 'RESIGNED',
      resignationDate: day('2026-09-01'),
      terminationDate: day('2026-09-30'),
    });
    expect(effectiveLastWorkingDate(person)).toEqual(day('2026-09-30'));
  });

  it('falls back to the resignation date only once somebody has left', () => {
    expect(
      effectiveLastWorkingDate(employee({ status: 'RESIGNED', resignationDate: day('2026-09-01') })),
    ).toEqual(day('2026-09-01'));

    // Notice handed in, last day not yet agreed: the person is still at work,
    // and the day they announced it is not the day they stop being counted.
    expect(
      effectiveLastWorkingDate(employee({ status: 'ACTIVE', resignationDate: day('2026-09-01') })),
    ).toBeNull();
  });

  it('invents nothing for an exit with no date on it', () => {
    expect(effectiveLastWorkingDate(employee({ status: 'TERMINATED' }))).toBeNull();
    // ...and such a person keeps their history rather than vanishing from it.
    expect(
      isEmployeeInAttendancePopulation(employee({ status: 'TERMINATED' }), day('2026-09-15')),
    ).toBe(true);
  });
});

/**
 * The SQL clause and the predicate have to mean the same thing.
 *
 * They are two implementations of one rule - one for `WHERE`, so a page's
 * `total` counts the population its rows came from, and one for the deriver,
 * which works a day at a time. If they ever drift, a row appears with no days
 * in it, or a row that should exist is missing from a report.
 *
 * So the clause is evaluated here against the same fixtures, by an interpreter
 * that understands only the handful of operators it actually uses.
 */
type Clause = Record<string, unknown>;

function matches(person: EmploymentWindowFields, clause: Clause): boolean {
  return Object.entries(clause).every(([key, value]) => {
    if (key === 'AND') return (value as Clause[]).every((c) => matches(person, c));
    if (key === 'OR') return (value as Clause[]).some((c) => matches(person, c));

    const actual = person[key as keyof EmploymentWindowFields];
    if (value === null) return actual === null;

    const op = value as { lte?: Date; gte?: Date; notIn?: string[] };
    if (op.notIn) return !op.notIn.includes(actual as string);
    if (op.lte) return actual !== null && (actual as Date).getTime() <= op.lte.getTime();
    if (op.gte) return actual !== null && (actual as Date).getTime() >= op.gte.getTime();
    return actual === value;
  });
}

describe('attendancePopulationWhere says the same thing in SQL', () => {
  const people: EmploymentWindowFields[] = [
    employee({}),
    employee({ hireDate: null }),
    employee({ hireDate: day('2026-09-20') }),
    HIRA,
    employee({ status: 'TERMINATED', terminationDate: day('2026-12-31') }),
    employee({ status: 'TERMINATED' }),
    employee({ status: 'RESIGNED', resignationDate: day('2026-08-01') }),
    employee({ status: 'RESIGNED', resignationDate: day('2026-09-20') }),
    employee({
      status: 'RESIGNED',
      resignationDate: day('2026-09-01'),
      terminationDate: day('2026-09-30'),
    }),
    employee({ status: 'ACTIVE', resignationDate: day('2026-09-01') }),
    employee({ status: 'ACTIVE', terminationDate: day('2026-09-30') }),
    employee({ status: 'ON_LEAVE' }),
    employee({ status: 'SUSPENDED' }),
    employee({ status: 'INACTIVE' }),
  ];

  const ranges: Array<[string, string]> = [
    ['2026-09-15', '2026-09-15'],
    ['2026-09-09', '2026-09-09'],
    ['2026-09-10', '2026-09-10'],
    ['2026-09-11', '2026-09-11'],
    ['2026-09-01', '2026-09-30'],
    ['2026-09-11', '2026-09-30'],
    ['2026-08-01', '2026-08-31'],
    ['2027-01-01', '2027-01-31'],
  ];

  for (const [fromIso, toIso] of ranges) {
    it(`agrees with isEmployedDuringRange over ${fromIso}..${toIso}`, () => {
      const from = day(fromIso);
      const to = day(toIso);
      const clause = attendancePopulationWhere(from, to) as Clause;

      for (const person of people) {
        expect(matches(person, clause), JSON.stringify(person)).toBe(
          isEmployedDuringRange(person, from, to),
        );
      }
    });
  }

  it('narrows and never widens: every branch is an AND of conditions on lifecycle columns', () => {
    const clause = attendancePopulationWhere(day('2026-09-15'), day('2026-09-15'));
    expect(Object.keys(clause)).toEqual(['AND']);
  });
});
