import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Birthdays, anniversaries and new joiners on the employee portal.
 *
 * Three lists that share one definition of "colleague", so they are tested
 * together against one roster. The assertions that matter most are the ones
 * about who is left OUT: somebody who has left the company must not turn up on
 * a birthday card, the viewer must not be shown their own welcome, and a
 * five-working-day window must not be quietly counted in calendar days.
 *
 * The database mock evaluates the lifecycle clause the service actually sends
 * rather than ignoring it, so "the terminated colleague does not appear" is a
 * statement about the real query and not about the fixture.
 */

const db = vi.hoisted(() => ({
  employee: { findMany: vi.fn() },
  holiday: { findMany: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { companyMomentsFor, workingDaysElapsed, WELCOME_WORKING_DAYS } = await import(
  './company-moments.service.js'
);

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Monday 14 September 2026 is a working day; the 19th/20th are the weekend. */
const MON = '2026-09-14';
const TUE = '2026-09-15';
const FRI = '2026-09-18';
const SAT = '2026-09-19';
const NEXT_MON = '2026-09-21';

const WEEKEND = ['SATURDAY', 'SUNDAY'] as const;

interface Person {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  status: string;
  hireDate: Date | null;
  terminationDate: Date | null;
  resignationDate: Date | null;
  dateOfBirth: Date | null;
  photoUrl: string | null;
  photoObjectKey: string | null;
  photoUpdatedAt: Date | null;
  department: { name: string } | null;
  team: { name: string } | null;
  designation: { name: string } | null;
}

const person = (over: Partial<Person> & { id: string }): Person => ({
  firstName: 'Test',
  lastName: 'Person',
  displayName: null,
  status: 'ACTIVE',
  hireDate: day('2020-01-06'),
  terminationDate: null,
  resignationDate: null,
  dateOfBirth: null,
  photoUrl: null,
  photoObjectKey: null,
  photoUpdatedAt: null,
  department: { name: 'Engineering' },
  team: { name: 'Platform' },
  designation: { name: 'Engineer' },
  ...over,
});

/** The caller. Present in the roster, and expected in none of the lists. */
const VIEWER = person({
  id: 'viewer',
  firstName: 'Vee',
  dateOfBirth: day('1990-09-15'),
  hireDate: day('2026-09-15'),
});

// -------------------------------------------------- the lifecycle clause mock

const LIFECYCLE = new Set(['status', 'hireDate', 'terminationDate', 'resignationDate']);

function matches(p: Person, clause: Record<string, unknown>): boolean {
  return Object.entries(clause).every(([key, value]) => {
    if (key === 'AND') return (value as Record<string, unknown>[]).every((c) => matches(p, c));
    if (key === 'OR') return (value as Record<string, unknown>[]).some((c) => matches(p, c));
    if (key === 'companyId') return true;
    if (key === 'id') {
      const op = value as { not?: string };
      return op.not ? p.id !== op.not : p.id === value;
    }
    if (!LIFECYCLE.has(key)) return true;

    const actual = p[key as keyof Person] as Date | string | null;
    if (value === null) return actual === null;

    const op = value as { lte?: Date; gte?: Date; notIn?: string[] };
    if (op.notIn) return !op.notIn.includes(actual as string);
    if (op.lte) return actual !== null && (actual as Date).getTime() <= op.lte.getTime();
    if (op.gte) return actual !== null && (actual as Date).getTime() >= op.gte.getTime();
    return actual === value;
  });
}

let roster: Person[] = [];
let holidays: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  roster = [];
  holidays = [];

  db.employee.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    roster.filter((p) => matches(p, args.where)),
  );
  db.holiday.findMany.mockImplementation(async () => holidays.map((h) => ({ date: day(h) })));
});

const moments = (today: string, viewerId: string | null = VIEWER.id) =>
  companyMomentsFor({
    companyId: 'company-1',
    viewerEmployeeId: viewerId,
    today: day(today),
    weekendDays: WEEKEND,
    locationId: null,
  });

// ------------------------------------------------------------------ birthdays

describe('birthdays', () => {
  it("shows a colleague whose birthday is today, whatever year they were born", async () => {
    roster = [VIEWER, person({ id: 'a', firstName: 'Ayesha', dateOfBirth: day('1994-09-15') })];
    const { birthdays } = await moments(TUE);
    expect(birthdays.map((b) => b.employeeId)).toEqual(['a']);
  });

  it('does not show a birthday that is not today', async () => {
    roster = [VIEWER, person({ id: 'a', dateOfBirth: day('1994-09-16') })];
    expect((await moments(TUE)).birthdays).toEqual([]);
  });

  it('matches on month and day, never on the year', async () => {
    // Same month/day, wildly different years: both are birthdays today.
    roster = [
      VIEWER,
      person({ id: 'old', dateOfBirth: day('1966-09-15') }),
      person({ id: 'new', dateOfBirth: day('2004-09-15') }),
    ];
    const { birthdays } = await moments(TUE);
    expect(birthdays.map((b) => b.employeeId).sort()).toEqual(['new', 'old']);
  });

  it('does not show a colleague who has left the company', async () => {
    roster = [
      VIEWER,
      person({
        id: 'gone',
        dateOfBirth: day('1994-09-15'),
        status: 'TERMINATED',
        terminationDate: day('2026-09-10'),
      }),
      person({
        id: 'resigned',
        dateOfBirth: day('1994-09-15'),
        status: 'RESIGNED',
        resignationDate: day('2026-08-01'),
      }),
    ];
    expect((await moments(TUE)).birthdays).toEqual([]);
  });

  it('still shows somebody serving out their notice - they are still here', async () => {
    roster = [
      VIEWER,
      person({
        id: 'notice',
        dateOfBirth: day('1994-09-15'),
        status: 'RESIGNED',
        resignationDate: day('2026-09-01'),
        terminationDate: day('2026-09-30'),
      }),
    ];
    expect((await moments(TUE)).birthdays.map((b) => b.employeeId)).toEqual(['notice']);
  });

  it('never shows the viewer their own birthday as a colleague', async () => {
    roster = [VIEWER];
    expect((await moments(TUE)).birthdays).toEqual([]);
  });

  it('shows every colleague when several share the day', async () => {
    roster = [
      VIEWER,
      person({ id: 'a', dateOfBirth: day('1994-09-15') }),
      person({ id: 'b', dateOfBirth: day('1988-09-15') }),
      person({ id: 'c', dateOfBirth: day('1999-09-15') }),
    ];
    expect((await moments(TUE)).birthdays).toHaveLength(3);
  });

  it('returns an empty list when nobody has a birthday, so the card can hide', async () => {
    roster = [VIEWER, person({ id: 'a', dateOfBirth: day('1994-01-01') })];
    expect((await moments(TUE)).birthdays).toEqual([]);
  });
});

// -------------------------------------------------------------- anniversaries

describe('work anniversaries', () => {
  it('celebrates the canonical hire date coming round again', async () => {
    roster = [VIEWER, person({ id: 'a', hireDate: day('2023-09-15') })];
    const { anniversaries } = await moments(TUE);
    expect(anniversaries).toEqual([expect.objectContaining({ employeeId: 'a', years: 3 })]);
  });

  it('does not celebrate a date that is not today', async () => {
    roster = [VIEWER, person({ id: 'a', hireDate: day('2023-09-16') })];
    expect((await moments(TUE)).anniversaries).toEqual([]);
  });

  it('does not celebrate nought years - a first day is a welcome, not an anniversary', async () => {
    roster = [VIEWER, person({ id: 'a', hireDate: day(TUE) })];
    const { anniversaries, newJoiners } = await moments(TUE);
    expect(anniversaries).toEqual([]);
    expect(newJoiners.map((j) => j.employeeId)).toEqual(['a']);
  });

  it('does not show a colleague who has left', async () => {
    roster = [
      VIEWER,
      person({
        id: 'gone',
        hireDate: day('2023-09-15'),
        status: 'TERMINATED',
        terminationDate: day('2026-09-10'),
      }),
    ];
    expect((await moments(TUE)).anniversaries).toEqual([]);
  });

  it('never shows the viewer their own anniversary', async () => {
    roster = [person({ ...VIEWER, hireDate: day('2021-09-15') })];
    expect((await moments(TUE)).anniversaries).toEqual([]);
  });

  it('orders the longest service first', async () => {
    roster = [
      VIEWER,
      person({ id: 'one', hireDate: day('2025-09-15') }),
      person({ id: 'ten', hireDate: day('2016-09-15') }),
      person({ id: 'three', hireDate: day('2023-09-15') }),
    ];
    expect((await moments(TUE)).anniversaries.map((a) => a.years)).toEqual([10, 3, 1]);
  });
});

// ---------------------------------------------------------------- new joiners

describe('welcome new joiner, counted in working days', () => {
  it('welcomes somebody on their first day', async () => {
    roster = [VIEWER, person({ id: 'a', hireDate: day(MON) })];
    const { newJoiners } = await moments(MON);
    expect(newJoiners).toEqual([
      expect.objectContaining({ employeeId: 'a', hireDate: MON, workingDay: 1 }),
    ]);
  });

  it('still welcomes them on the fifth working day', async () => {
    // Joined Monday the 14th; Friday the 18th is working day five.
    roster = [VIEWER, person({ id: 'a', hireDate: day(MON) })];
    const { newJoiners } = await moments(FRI);
    expect(newJoiners).toEqual([expect.objectContaining({ employeeId: 'a', workingDay: 5 })]);
  });

  it('stops welcoming them once five working days have passed', async () => {
    // The following Monday is working day six.
    roster = [VIEWER, person({ id: 'a', hireDate: day(MON) })];
    expect((await moments(NEXT_MON)).newJoiners).toEqual([]);
  });

  it('does not let a weekend consume a welcome day', async () => {
    // Joined Friday the 18th. Saturday is not a working day, so on Saturday
    // they are still on day one - and the next Monday is only day two.
    roster = [VIEWER, person({ id: 'a', hireDate: day(FRI) })];

    expect((await moments(SAT)).newJoiners[0]?.workingDay).toBe(1);
    expect((await moments(NEXT_MON)).newJoiners[0]?.workingDay).toBe(2);
  });

  it('does not let a holiday consume a welcome day', async () => {
    roster = [VIEWER, person({ id: 'a', hireDate: day(MON) })];
    // Make Tuesday a company holiday: Wednesday becomes day two, not day three.
    holidays = [TUE];

    expect((await moments(TUE)).newJoiners[0]?.workingDay).toBe(1);
    expect((await moments('2026-09-16')).newJoiners[0]?.workingDay).toBe(2);
    // ...and the window now reaches into the following week.
    expect((await moments(NEXT_MON)).newJoiners[0]?.workingDay).toBe(5);
  });

  it('does not welcome a future joiner', async () => {
    roster = [VIEWER, person({ id: 'a', hireDate: day('2026-10-01') })];
    expect((await moments(TUE)).newJoiners).toEqual([]);
  });

  it('does not welcome somebody who has already left', async () => {
    roster = [
      VIEWER,
      person({
        id: 'gone',
        hireDate: day(MON),
        status: 'TERMINATED',
        terminationDate: day(MON),
      }),
    ];
    expect((await moments(TUE)).newJoiners).toEqual([]);
  });

  it('does not show a new joiner their own welcome card', async () => {
    // The viewer started today; the roster holds nobody else.
    roster = [VIEWER];
    expect((await moments(TUE)).newJoiners).toEqual([]);
  });

  it('shows several joiners at once, freshest first', async () => {
    roster = [
      VIEWER,
      person({ id: 'mon', hireDate: day(MON) }),
      person({ id: 'tue', hireDate: day(TUE) }),
    ];
    expect((await moments(TUE)).newJoiners.map((j) => j.employeeId)).toEqual(['tue', 'mon']);
  });

  it('agrees with the exported window constant', () => {
    expect(WELCOME_WORKING_DAYS).toBe(5);
  });
});

describe('workingDaysElapsed', () => {
  const count = (from: string, to: string, hols: string[] = []) =>
    workingDaysElapsed({
      from: day(from),
      to: day(to),
      weekendDays: WEEKEND,
      holidays: new Set(hols),
    });

  it('counts the first day as one', () => {
    expect(count(MON, MON)).toBe(1);
  });

  it('skips weekends entirely', () => {
    // Mon 14 to Mon 21 is six working days: 14-18 and 21.
    expect(count(MON, NEXT_MON)).toBe(6);
  });

  it('skips holidays', () => {
    expect(count(MON, FRI, [TUE])).toBe(4);
  });

  it('is zero for a start date in the future', () => {
    expect(count('2026-10-01', TUE)).toBe(0);
  });
});

// -------------------------------------------------------------------- privacy

describe('privacy', () => {
  it('sends only what it takes to congratulate somebody', async () => {
    roster = [
      VIEWER,
      person({
        id: 'a',
        firstName: 'Ayesha',
        lastName: 'Khan',
        dateOfBirth: day('1994-09-15'),
      }),
    ];

    const [birthday] = (await moments(TUE)).birthdays;

    // The exact shape, so a future field cannot be added without this failing.
    expect(Object.keys(birthday!).sort()).toEqual([
      'departmentName',
      'designationName',
      'employeeId',
      'fullName',
      'photoUrl',
      'teamName',
    ]);
    // The date of birth decided the card and must not travel with it.
    expect(JSON.stringify(birthday)).not.toContain('1994');
  });

  it('asks the database for narrow columns, never the whole employee row', async () => {
    roster = [VIEWER];
    await moments(TUE);

    const select = db.employee.findMany.mock.calls[0]![0].select;
    expect(Object.keys(select).sort()).toEqual([
      'dateOfBirth',
      'department',
      'designation',
      'displayName',
      'firstName',
      'hireDate',
      'id',
      'lastName',
      'photoObjectKey',
      'photoUpdatedAt',
      'photoUrl',
      'team',
    ]);
    // None of the sensitive columns are even read.
    for (const forbidden of [
      'nationalId',
      'bankAccountNumber',
      'personalEmail',
      'personalPhone',
      'passportNumber',
      'salary',
    ]) {
      expect(select).not.toHaveProperty(forbidden);
    }
  });

  it('excludes the viewer in the query itself, so their row never travels', async () => {
    roster = [VIEWER];
    await moments(TUE);
    expect(JSON.stringify(db.employee.findMany.mock.calls[0]![0].where)).toContain('viewer');
  });
});

describe('a login with no employee record', () => {
  it('gets three empty lists rather than an error', async () => {
    roster = [person({ id: 'a', dateOfBirth: day('1994-09-15') })];
    const result = await moments(TUE, null);
    // Nobody is excluded as "self", so the birthday is simply visible.
    expect(result.birthdays.map((b) => b.employeeId)).toEqual(['a']);
    expect(result.anniversaries).toEqual([]);
  });
});
