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
  momentGreeting: { findMany: vi.fn(), count: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const {
  companyMomentsFor,
  occasionDateFor,
  resolveGreetableOccasion,
  workingDaysElapsed,
  WELCOME_WORKING_DAYS,
} = await import('./company-moments.service.js');

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

/** A greeting already on file, as the greeting query returns one. */
interface Greeting {
  recipientEmployeeId: string;
  senderEmployeeId: string;
  occasion: 'BIRTHDAY' | 'ANNIVERSARY' | 'NEW_JOINER';
  occasionDate: Date;
}

let roster: Person[] = [];
let holidays: string[] = [];
let greetings: Greeting[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  roster = [];
  holidays = [];
  greetings = [];

  db.employee.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    roster.filter((p) => matches(p, args.where)),
  );
  db.holiday.findMany.mockImplementation(async () => holidays.map((h) => ({ date: day(h) })));

  /**
   * The greeting lookup, filtered the way the real one is.
   *
   * Honouring the `in` clauses rather than returning the whole fixture is what
   * makes "a greeting for a different day is not counted" a statement about the
   * query the service sends.
   */
  db.momentGreeting.findMany.mockImplementation(
    async (args: {
      where: {
        recipientEmployeeId: { in: string[] };
        occasionDate: { in: Date[] };
      };
    }) => {
      const ids = new Set(args.where.recipientEmployeeId.in);
      const days = new Set(args.where.occasionDate.in.map((d) => d.getTime()));
      return greetings.filter(
        (g) => ids.has(g.recipientEmployeeId) && days.has(g.occasionDate.getTime()),
      );
    },
  );
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
    // The two greeting fields are counts and a boolean about the VIEWER; they
    // say nothing about the person beyond what the card already shows, and in
    // particular no sender is ever named here - see `attachGreetings`.
    expect(Object.keys(birthday!).sort()).toEqual([
      'departmentName',
      'designationName',
      'employeeId',
      'fullName',
      'greetedByMe',
      'greetingCount',
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

// ------------------------------------------------------------------ greetings

/**
 * Counting the greetings a celebration has, and deciding who may send one.
 *
 * Two rules carry the weight here. A greeting belongs to an OCCASION, not to
 * the day it was typed - which is why a new joiner's welcome is filed under
 * their hire date and cannot be sent afresh on each day of their first week.
 * And the right to greet somebody is derived from the sender's own dashboard
 * rather than checked as a permission, so an employee id in a request body
 * buys nothing: if the server would not have shown you that person today, it
 * will not let you greet them today either.
 */
describe('greetings on a celebration', () => {
  const AYESHA = person({ id: 'a', firstName: 'Ayesha', dateOfBirth: day('1994-09-15') });

  it('reports no greetings, and none of mine, before anybody has sent one', async () => {
    roster = [VIEWER, AYESHA];

    const [birthday] = (await moments(TUE)).birthdays;
    expect(birthday?.greetingCount).toBe(0);
    expect(birthday?.greetedByMe).toBe(false);
  });

  it('counts every colleague who has greeted them', async () => {
    roster = [VIEWER, AYESHA];
    greetings = [
      { recipientEmployeeId: 'a', senderEmployeeId: 'x', occasion: 'BIRTHDAY', occasionDate: day(TUE) },
      { recipientEmployeeId: 'a', senderEmployeeId: 'y', occasion: 'BIRTHDAY', occasionDate: day(TUE) },
    ];

    const [birthday] = (await moments(TUE)).birthdays;
    expect(birthday?.greetingCount).toBe(2);
    // Counted, but not sent by the viewer - the button should still say "Greet".
    expect(birthday?.greetedByMe).toBe(false);
  });

  it('knows when the greeting was the viewer\'s own', async () => {
    roster = [VIEWER, AYESHA];
    greetings = [
      { recipientEmployeeId: 'a', senderEmployeeId: VIEWER.id, occasion: 'BIRTHDAY', occasionDate: day(TUE) },
    ];

    const [birthday] = (await moments(TUE)).birthdays;
    expect(birthday?.greetedByMe).toBe(true);
    expect(birthday?.greetingCount).toBe(1);
  });

  it('does not count last year\'s birthday greetings against this one', async () => {
    roster = [VIEWER, AYESHA];
    greetings = [
      {
        recipientEmployeeId: 'a',
        senderEmployeeId: VIEWER.id,
        occasion: 'BIRTHDAY',
        occasionDate: day('2025-09-15'),
      },
    ];

    const [birthday] = (await moments(TUE)).birthdays;
    expect(birthday?.greetingCount).toBe(0);
    expect(birthday?.greetedByMe).toBe(false);
  });

  it('keeps a birthday and an anniversary on the same day apart', async () => {
    // Hired on this day five years ago, and born on this day - both cards show
    // the same person, and greeting one is not greeting the other.
    roster = [
      VIEWER,
      person({ id: 'both', dateOfBirth: day('1994-09-15'), hireDate: day('2021-09-15') }),
    ];
    greetings = [
      {
        recipientEmployeeId: 'both',
        senderEmployeeId: VIEWER.id,
        occasion: 'BIRTHDAY',
        occasionDate: day(TUE),
      },
    ];

    const view = await moments(TUE);
    expect(view.birthdays[0]?.greetedByMe).toBe(true);
    expect(view.anniversaries[0]?.greetedByMe).toBe(false);
  });

  it("files a new joiner's welcome under their hire date, not today", async () => {
    // Started Monday; it is now Tuesday, day 2 of the welcome window.
    roster = [VIEWER, person({ id: 'j', hireDate: day(MON) })];
    greetings = [
      {
        recipientEmployeeId: 'j',
        senderEmployeeId: VIEWER.id,
        occasion: 'NEW_JOINER',
        occasionDate: day(MON),
      },
    ];

    const [joiner] = (await moments(TUE)).newJoiners;
    // Monday's welcome still counts on Tuesday: one welcome per joiner, not one
    // per day of their first week.
    expect(joiner?.greetedByMe).toBe(true);
    expect(joiner?.greetingCount).toBe(1);
  });

  it('dates a birthday to today and a welcome to the hire date', () => {
    expect(occasionDateFor({ occasion: 'BIRTHDAY', today: day(TUE), hireDate: day(MON) })).toEqual(
      day(TUE),
    );
    expect(
      occasionDateFor({ occasion: 'ANNIVERSARY', today: day(TUE), hireDate: day(MON) }),
    ).toEqual(day(TUE));
    expect(occasionDateFor({ occasion: 'NEW_JOINER', today: day(TUE), hireDate: day(MON) })).toEqual(
      day(MON),
    );
  });
});

describe('who may be greeted', () => {
  it('allows greeting somebody on the list for that occasion', async () => {
    roster = [VIEWER, person({ id: 'a', dateOfBirth: day('1994-09-15') })];
    const view = await moments(TUE);

    await expect(
      resolveGreetableOccasion({
        moments: view,
        recipientEmployeeId: 'a',
        occasion: 'BIRTHDAY',
        today: day(TUE),
      }),
    ).resolves.toEqual(day(TUE));
  });

  it('refuses an occasion the person is not having today', async () => {
    // A real colleague, a real birthday - but they are on the birthday list,
    // not the anniversary one, and the body claims an anniversary.
    roster = [VIEWER, person({ id: 'a', dateOfBirth: day('1994-09-15') })];
    const view = await moments(TUE);

    await expect(
      resolveGreetableOccasion({
        moments: view,
        recipientEmployeeId: 'a',
        occasion: 'ANNIVERSARY',
        today: day(TUE),
      }),
    ).resolves.toBeNull();
  });

  it('refuses a colleague who is not celebrating anything at all', async () => {
    roster = [VIEWER, person({ id: 'quiet', dateOfBirth: day('1994-03-02') })];
    const view = await moments(TUE);

    await expect(
      resolveGreetableOccasion({
        moments: view,
        recipientEmployeeId: 'quiet',
        occasion: 'BIRTHDAY',
        today: day(TUE),
      }),
    ).resolves.toBeNull();
  });

  it('refuses somebody who has left, because they are not on the list', async () => {
    roster = [
      VIEWER,
      person({
        id: 'gone',
        dateOfBirth: day('1994-09-15'),
        status: 'TERMINATED',
        terminationDate: day('2026-08-31'),
      }),
    ];
    const view = await moments(TUE);

    await expect(
      resolveGreetableOccasion({
        moments: view,
        recipientEmployeeId: 'gone',
        occasion: 'BIRTHDAY',
        today: day(TUE),
      }),
    ).resolves.toBeNull();
  });

  it('refuses the caller greeting themselves', async () => {
    // The viewer's own birthday is today, and the viewer is excluded from
    // every list - so their own id resolves to nothing.
    roster = [VIEWER];
    const view = await moments(TUE);

    await expect(
      resolveGreetableOccasion({
        moments: view,
        recipientEmployeeId: VIEWER.id,
        occasion: 'BIRTHDAY',
        today: day(TUE),
      }),
    ).resolves.toBeNull();
  });

  it("dates a joiner's welcome to their hire date, not the day it is sent", async () => {
    roster = [VIEWER, person({ id: 'j', hireDate: day(MON) })];
    const view = await moments(TUE);

    await expect(
      resolveGreetableOccasion({
        moments: view,
        recipientEmployeeId: 'j',
        occasion: 'NEW_JOINER',
        today: day(TUE),
      }),
    ).resolves.toEqual(day(MON));
  });
});
