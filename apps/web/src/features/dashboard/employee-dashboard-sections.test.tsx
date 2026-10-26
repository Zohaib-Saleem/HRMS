// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type {
  AnniversaryMoment,
  AttendanceDay,
  BirthdayMoment,
  CompanyMomentsView,
  MedicalBenefitView,
  NewJoinerMoment,
} from '@hrms/shared';

/**
 * The employee portal's dashboard sections.
 *
 * Four rules are worth pinning, because each of them is the sort of thing that
 * regresses quietly:
 *
 *   1. A celebration section with nobody in it is not rendered AT ALL - not an
 *      empty card, not a heading. An employee's dashboard should be quiet on a
 *      quiet day.
 *   2. The celebrations are near the TOP, above attendance and leave. They
 *      spent a release at the foot of the page, where nobody saw them.
 *   3. The medical card disappears for somebody the server says is not
 *      eligible, rather than telling them so every morning.
 *   4. The bars are the attendance page's own component, drawing the days the
 *      dashboard already fetched, with height taken from worked minutes.
 */

const SESSION = {
  user: {
    firstName: 'Ada',
    fullName: 'Ada Lovelace',
    employee: { id: 'e-ada', employeeNumber: 'E-1', jobTitle: 'Engineer' },
  },
  company: { name: 'Example Ltd' },
  employeeLinked: true,
};

vi.mock('@/features/auth/session-context', () => ({
  usePermissions: () => ({ has: () => true, hasAny: () => true, hasAll: () => true }),
  useSession: () => ({ session: SESSION, isLoading: false }),
  useAuthenticatedSession: () => SESSION,
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

import { CompanyMoments } from './company-moments';
import { EmployeeDashboard } from './employee-dashboard';
import { MyAttendanceBarsCard } from './my-attendance-bars-card';
import { MyMedicalCard } from '@/features/medical/my-medical-card';
import { api } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), getEnvelope: vi.fn(), getPage: vi.fn() } };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * A router and a fresh query client per test.
 *
 * Fresh because a cache shared between cases would let an eligible answer from
 * one test satisfy the "hidden" assertion in the next, which is precisely the
 * bug these are here to catch.
 */
const view = (ui: React.ReactElement) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
};

const person = (over: Partial<BirthdayMoment> & { employeeId: string }): BirthdayMoment => ({
  fullName: 'Ayesha Khan',
  photoUrl: null,
  departmentName: 'Engineering',
  teamName: 'Platform',
  designationName: 'Engineer',
  greetedByMe: false,
  greetingCount: 0,
  ...over,
});

const moments = (over: Partial<CompanyMomentsView> = {}): CompanyMomentsView => ({
  birthdays: [],
  anniversaries: [],
  newJoiners: [],
  ...over,
});

// ------------------------------------------------------------------ birthdays

describe('birthdays on the dashboard', () => {
  it("shows today's birthday with a friendly message", () => {
    view(<CompanyMoments moments={moments({ birthdays: [person({ employeeId: 'a' })] })} />);

    expect(screen.getByText('Birthdays today')).toBeInTheDocument();
    expect(screen.getByText('Ayesha Khan')).toBeInTheDocument();
    expect(screen.getByText('Birthday today')).toBeInTheDocument();
  });

  it('shows where the person sits, to help place a name to a face', () => {
    view(<CompanyMoments moments={moments({ birthdays: [person({ employeeId: 'a' })] })} />);
    expect(screen.getByText('Engineer · Engineering')).toBeInTheDocument();
  });

  it('lists everybody when several share the day', () => {
    view(
      <CompanyMoments
        moments={moments({
          birthdays: [
            person({ employeeId: 'a', fullName: 'Ayesha Khan' }),
            person({ employeeId: 'b', fullName: 'Bilal Ahmed' }),
            person({ employeeId: 'c', fullName: 'Chen Wei' }),
          ],
        })}
      />,
    );

    expect(screen.getAllByText('Birthday today')).toHaveLength(3);
  });

  it('hides the section entirely when nobody has a birthday', () => {
    view(<CompanyMoments moments={moments({ anniversaries: [{ ...person({ employeeId: 'x' }), years: 2 }] })} />);
    expect(screen.queryByText('Birthdays today')).not.toBeInTheDocument();
  });

  it('never renders a date of birth, because the API does not send one', () => {
    const { container } = view(
      <CompanyMoments moments={moments({ birthdays: [person({ employeeId: 'a' })] })} />,
    );
    expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

// -------------------------------------------------------------- anniversaries

describe('work anniversaries on the dashboard', () => {
  const anniversary = (years: number): AnniversaryMoment => ({
    ...person({ employeeId: `a${years}` }),
    years,
  });

  it('celebrates the years completed', () => {
    view(<CompanyMoments moments={moments({ anniversaries: [anniversary(3)] })} />);
    expect(screen.getByText('Work anniversaries')).toBeInTheDocument();
    expect(screen.getByText('Celebrating 3 years')).toBeInTheDocument();
  });

  it('says "year" rather than "years" at one', () => {
    view(<CompanyMoments moments={moments({ anniversaries: [anniversary(1)] })} />);
    expect(screen.getByText('Celebrating 1 year')).toBeInTheDocument();
  });

  it('hides the section entirely when nobody has an anniversary', () => {
    view(<CompanyMoments moments={moments({ birthdays: [person({ employeeId: 'a' })] })} />);
    expect(screen.queryByText('Work anniversaries')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- new joiners

describe('welcome new joiner', () => {
  const joiner = (over: Partial<NewJoinerMoment> = {}): NewJoinerMoment => ({
    ...person({ employeeId: 'n1', fullName: 'Noor Fatima' }),
    hireDate: '2026-09-14',
    workingDay: 1,
    ...over,
  });

  it('welcomes the new person by name', () => {
    view(<CompanyMoments moments={moments({ newJoiners: [joiner()] })} />);
    expect(screen.getByText('New joiners')).toBeInTheDocument();
    expect(screen.getByText('Noor Fatima')).toBeInTheDocument();
    expect(screen.getByText('Welcome to the team!')).toBeInTheDocument();
  });

  it('shows several joiners at once', () => {
    view(
      <CompanyMoments
        moments={moments({
          newJoiners: [
            joiner({ employeeId: 'n1', fullName: 'Noor Fatima' }),
            joiner({ employeeId: 'n2', fullName: 'Omar Sheikh', workingDay: 4 }),
          ],
        })}
      />,
    );
    expect(screen.getByText('Noor Fatima')).toBeInTheDocument();
    expect(screen.getByText('Omar Sheikh')).toBeInTheDocument();
    expect(screen.getAllByText('Welcome to the team!')).toHaveLength(2);
  });

  it('hides the section entirely when nobody has just joined', () => {
    view(<CompanyMoments moments={moments({ birthdays: [person({ employeeId: 'a' })] })} />);
    expect(screen.queryByText('New joiners')).not.toBeInTheDocument();
  });
});

// --------------------------------------------------------- the whole block

describe('the celebrations block', () => {
  it('renders nothing at all on a quiet day', () => {
    const { container } = view(<CompanyMoments moments={moments()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the request is still in flight or has failed', () => {
    const { container } = view(<CompanyMoments moments={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('heads the block with the company the employee works for', () => {
    view(
      <CompanyMoments
        moments={moments({ birthdays: [person({ employeeId: 'a' })] })}
        companyName="GamEmpires"
      />,
    );
    expect(screen.getByText('Today at GamEmpires')).toBeInTheDocument();
  });

  it('describes itself when the session does not name the company', () => {
    view(<CompanyMoments moments={moments({ birthdays: [person({ employeeId: 'a' })] })} />);
    expect(screen.getByText('Celebrations & new joiners')).toBeInTheDocument();
  });

  it('lays the cards out in one row that wraps rather than overflowing', () => {
    const { container } = view(
      <CompanyMoments
        moments={moments({
          birthdays: [person({ employeeId: 'a' })],
          anniversaries: [{ ...person({ employeeId: 'b' }), years: 5 }],
          newJoiners: [
            { ...person({ employeeId: 'c' }), hireDate: '2026-09-14', workingDay: 2 },
          ],
        })}
      />,
    );
    // Wrapping, not a fixed column count: three cards share a wide dashboard
    // and stack on a phone without either one being dropped or clipped.
    const row = container.querySelector('.flex-wrap');
    expect(row).toBeTruthy();
    expect(row?.children).toHaveLength(3);
  });
});

// -------------------------------------------------------------------- medical

describe('the medical card follows server-side eligibility', () => {
  const benefit = (eligible: boolean): MedicalBenefitView =>
    ({
      eligibility: { eligible, reasons: eligible ? [] : ['Probation employees are not eligible'] },
      annualLimit: 100000,
      used: 25000,
      remaining: 75000,
      currency: 'PKR',
    }) as unknown as MedicalBenefitView;

  it('shows nothing at all until the server has answered', () => {
    // A pending request must not flash a Medical box at somebody who will turn
    // out to be ineligible.
    vi.mocked(api.get).mockReturnValue(new Promise(() => {}));
    const { container } = view(<MyMedicalCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the card for an eligible employee', async () => {
    vi.mocked(api.get).mockResolvedValue(benefit(true));
    view(<MyMedicalCard />);

    // Wait for the loaded state, not the header, which renders immediately.
    expect(await screen.findByText('Eligible')).toBeInTheDocument();
    expect(screen.getByText('Medical')).toBeInTheDocument();
  });

  it('hides the card completely for an ineligible employee', async () => {
    vi.mocked(api.get).mockResolvedValue(benefit(false));
    const { container } = view(<MyMedicalCard />);

    // Wait for the resolved query to have been rendered, not merely issued.
    await waitFor(() => expect(screen.queryByText('Medical')).not.toBeInTheDocument());
    expect(container.textContent).toBe('');
  });

  it('never tells an ineligible employee why - the card is simply absent', async () => {
    vi.mocked(api.get).mockResolvedValue(benefit(false));
    view(<MyMedicalCard />);

    await waitFor(() => expect(screen.queryByText('Medical')).not.toBeInTheDocument());
    expect(screen.queryByText(/not eligible/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/probation/i)).not.toBeInTheDocument();
  });

  it('shows no claim actions when the card is hidden', async () => {
    vi.mocked(api.get).mockResolvedValue(benefit(false));
    view(<MyMedicalCard />);

    await waitFor(() => expect(screen.queryByText('Medical')).not.toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument();
  });

  /**
   * The decision is the server's, and this is the whole point of the design:
   * the card reads one boolean and re-states none of the policy. Probation,
   * Permanent and Internee differ only in what the server answers.
   */
  it.each([
    ['a probationer the policy excludes', false],
    ['a permanent employee the policy includes', true],
    ['an internee the policy includes', true],
  ])('renders %s according to the server alone', async (_label, eligible) => {
    vi.mocked(api.get).mockResolvedValue(benefit(eligible));
    view(<MyMedicalCard />);

    if (eligible) {
      expect(await screen.findByText('Medical')).toBeInTheDocument();
    } else {
      await waitFor(() => expect(screen.queryByText('Medical')).not.toBeInTheDocument());
    }
  });
});

// ----------------------------------------------------------------- attendance

describe('my attendance bars', () => {
  const TODAY = '2026-09-15';

  const day = (over: Partial<AttendanceDay> = {}): AttendanceDay =>
    ({
      date: TODAY,
      status: 'PRESENT',
      flags: [],
      checkInAt: `${TODAY}T09:00:00.000Z`,
      checkOutAt: `${TODAY}T18:00:00.000Z`,
      workedMinutes: 480,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
      hasRecord: true,
      ...over,
    }) as AttendanceDay;

  const days: AttendanceDay[] = [
    day({ date: '2026-09-14', workedMinutes: 480 }),
    day({ date: '2026-09-15', workedMinutes: 240, status: 'HALF_DAY' }),
    day({ date: '2026-09-16', workedMinutes: 0, status: 'ABSENT' }),
    day({ date: '2026-09-17', workedMinutes: 0, status: 'WEEKEND' }),
    day({ date: '2026-09-18', workedMinutes: 0, status: 'UPCOMING', hasRecord: false }),
  ];

  it('renders the current month with a bar for every day it was given', () => {
    const { container } = view(
      <MyAttendanceBarsCard days={days} employeeName="Ada Lovelace" month="2026-09" />,
    );
    expect(container.querySelectorAll('[data-bar-key]')).toHaveLength(days.length);
  });

  it('names the month it is showing', () => {
    view(<MyAttendanceBarsCard days={days} employeeName="Ada" month="2026-09" />);
    expect(screen.getByText('September 2026')).toBeInTheDocument();
  });

  it('offers a way through to the full attendance page', () => {
    view(<MyAttendanceBarsCard days={days} employeeName="Ada" month="2026-09" />);
    const link = screen.getByRole('link', { name: /view attendance/i });
    expect(link).toHaveAttribute('href', '/attendance');
  });

  it('keeps every status distinguishable, including the ones with no worked time', () => {
    const { container } = view(
      <MyAttendanceBarsCard days={days} employeeName="Ada" month="2026-09" />,
    );
    // Each day is present as its own column regardless of status: an absence,
    // a weekend and a day still to come are all drawn, never dropped.
    for (const d of days) {
      expect(container.querySelector(`[data-bar-key="${d.date}"]`)).toBeTruthy();
    }
  });

  it('stays usable on a narrow screen by scrolling rather than shrinking away', () => {
    const { container } = view(
      <MyAttendanceBarsCard days={days} employeeName="Ada" month="2026-09" />,
    );
    // The track lives inside a horizontal scroller, which is what keeps a
    // 31-day month legible on a phone instead of squeezing it to nothing.
    expect(container.querySelector('.overflow-x-auto')).toBeTruthy();
  });

  it('renders an empty month without crashing', () => {
    const { container } = view(
      <MyAttendanceBarsCard days={[]} employeeName="Ada" month="2026-09" />,
    );
    expect(container.querySelectorAll('[data-bar-key]')).toHaveLength(0);
  });
});

// ------------------------------------------------------- where things sit

/**
 * Position, not just presence.
 *
 * The celebration cards were at the very bottom of the dashboard, under leave
 * balances and holidays, and an employee reliably missed them. These cases pin
 * the order itself: birthdays, anniversaries and joiners render above the
 * attendance month and the leave balance, exactly once each, and only on a day
 * when there is something to say.
 */
describe('the employee dashboard in the order an employee reads it', () => {
  const PAGED = { data: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } };

  const routeApi = (served: CompanyMomentsView) => {
    vi.mocked(api.getPage).mockResolvedValue(PAGED as never);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === '/me/company-moments') return Promise.resolve(served as never);
      if (path === '/attendance/summary')
        return Promise.resolve({
          days: [],
          totals: {
            present: 12,
            halfDay: 0,
            absent: 1,
            onLeave: 0,
            holiday: 0,
            weekend: 4,
            upcoming: 3,
            offDay: 0,
            workedMinutes: 5760,
            expectedMinutes: 6240,
            lateMinutes: 0,
          },
        } as never);
      if (path === '/leave/balances/me')
        return Promise.resolve([
          {
            leaveTypeId: 'lt-1',
            leaveTypeName: 'Annual',
            isPaid: true,
            annualEntitlementDays: 20,
            usedDays: 5,
            pendingDays: 2,
            availableDays: 15,
          },
          // Leave without pay with an HR-granted allowance of 10. It is not
          // paid leave, so it must not add 10 to "days remaining".
          {
            leaveTypeId: 'lt-lwp',
            leaveTypeName: 'Leave Without Pay',
            isPaid: false,
            annualEntitlementDays: 0,
            usedDays: 0,
            pendingDays: 0,
            availableDays: 10,
          },
        ] as never);
      if (path === '/lunch/today')
        return Promise.resolve({
          day: '2026-09-17',
          orders: [],
          outstandingAmount: 0,
          canOrder: true,
        } as never);
      if (path === '/cases/summary')
        return Promise.resolve({
          counts: { OPEN: 2, IN_PROGRESS: 1, PENDING: 1, RESOLVED: 0, CLOSED: 0 },
          openCount: 3,
          awaitingMeCount: 1,
        } as never);
      // No check-in widget and no medical card in these cases: neither is what
      // is being measured, and both render themselves away when absent.
      if (path === '/attendance/today') return Promise.resolve(null as never);
      if (path === '/medical/benefit')
        return Promise.resolve({ eligibility: { eligible: false, reasons: [] } } as never);
      return Promise.resolve({} as never);
    });
  };

  const celebrations = moments({
    birthdays: [person({ employeeId: 'b1', fullName: 'Ayesha Khan' })],
    anniversaries: [{ ...person({ employeeId: 'a1', fullName: 'Kaleem Maqbool' }), years: 5 }],
    newJoiners: [
      {
        ...person({ employeeId: 'n1', fullName: 'Noor Fatima' }),
        hireDate: '2026-09-14',
        workingDay: 2,
      },
    ],
  });

  /**
   * The whole dashboard, read as text once every one of its requests has
   * settled.
   *
   * Waiting on the query client rather than on a piece of copy is what makes
   * the "nothing to celebrate" case trustworthy: a card that is merely still
   * loading is indistinguishable from one that is absent, and asserting
   * absence too early would pass no matter what this screen rendered.
   */
  const dashboardText = async (served: CompanyMomentsView): Promise<string> => {
    routeApi(served);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <EmployeeDashboard />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(client.isFetching()).toBe(0));
    return container.textContent ?? '';
  };

  /*
   * The order is the feature here, so it is asserted as an order rather than as
   * a set of things that happen to be present. Lunch and cases spent a release
   * in the last row of this page, under the leave balance and the holiday list,
   * which is the same as not being on it: an employee who has to scroll past
   * four reference cards to find lunch has already missed lunch.
   */
  const LUNCH = 'Today\u2019s lunch';

  it("leads with today's actions - lunch and cases above the month", async () => {
    const text = await dashboardText(celebrations);

    const lunch = text.indexOf(LUNCH);
    const cases = text.indexOf('My cases');
    const month = text.indexOf('My attendance');

    expect(lunch).toBeGreaterThan(-1);
    expect(cases).toBeGreaterThan(-1);
    expect(lunch).toBeLessThan(month);
    expect(cases).toBeLessThan(month);
  });

  it('puts leave remaining in the top row, above the detailed balance', async () => {
    const text = await dashboardText(celebrations);

    const tile = text.indexOf('15 days remaining');
    expect(tile).toBeGreaterThan(-1);
    expect(tile).toBeLessThan(text.indexOf('Leave balance'));
  });

  it('keeps the celebrations upper-middle: below the month, above the reference cards', async () => {
    const text = await dashboardText(celebrations);

    const moment = text.indexOf('Today at Example Ltd');
    expect(moment).toBeGreaterThan(-1);
    // Below today's actions and the month...
    expect(moment).toBeGreaterThan(text.indexOf(LUNCH));
    expect(moment).toBeGreaterThan(text.indexOf('My attendance'));
    // ...and still well above the foot of the page, which is where they began.
    expect(moment).toBeLessThan(text.indexOf('Leave balance'));
    expect(moment).toBeLessThan(text.indexOf('Coming up'));
  });

  it('reads top to bottom in the order an employee needs it', async () => {
    const text = await dashboardText(celebrations);

    const sequence = [
      LUNCH,
      'My cases',
      'My attendance',
      'Today at Example Ltd',
      'Leave balance',
      'Coming up',
    ].map((heading) => {
      const at = text.indexOf(heading);
      expect(at, `${heading} is missing from the dashboard`).toBeGreaterThan(-1);
      return at;
    });

    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
  });

  it('renders the cases card exactly once - it moved up, it was not copied', async () => {
    const text = await dashboardText(celebrations);

    expect(text.split('My cases').length - 1).toBe(1);
  });

  it('renders each celebration card exactly once - none left at the bottom', async () => {
    const text = await dashboardText(celebrations);

    for (const title of ['Birthdays today', 'Work anniversaries', 'New joiners']) {
      expect(text.split(title).length - 1).toBe(1);
    }
  });

  it('shows nothing of the block on a day with nothing to celebrate', async () => {
    const text = await dashboardText(moments());

    expect(text).not.toContain('Today at Example Ltd');
    expect(text).not.toContain('Birthdays today');
    expect(text).not.toContain('Work anniversaries');
    expect(text).not.toContain('New joiners');
    // The rest of the dashboard is untouched by a quiet day.
    expect(text).toContain('Leave balance');
    expect(text).toContain('Coming up');
  });
});
