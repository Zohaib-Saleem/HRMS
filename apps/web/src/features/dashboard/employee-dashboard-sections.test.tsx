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
 * The employee portal's new dashboard sections.
 *
 * Three rules are worth pinning, because each of them is the sort of thing that
 * regresses quietly:
 *
 *   1. A celebration section with nobody in it is not rendered AT ALL - not an
 *      empty card, not a heading. An employee's dashboard should be quiet on a
 *      quiet day.
 *   2. The medical card disappears for somebody the server says is not
 *      eligible, rather than telling them so every morning.
 *   3. The bars are the attendance page's own component, drawing the days the
 *      dashboard already fetched, with height taken from worked minutes.
 */

vi.mock('@/features/auth/session-context', () => ({
  usePermissions: () => ({ has: () => true, hasAny: () => true, hasAll: () => true }),
  useAuthenticatedSession: () => ({
    user: { firstName: 'Ada', fullName: 'Ada Lovelace' },
    company: { name: 'Example Ltd' },
  }),
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

import { CompanyMoments } from './company-moments';
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

    expect(screen.getByText('Birthdays')).toBeInTheDocument();
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
    expect(screen.queryByText('Birthdays')).not.toBeInTheDocument();
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
    expect(screen.getByText('Welcome to the team')).toBeInTheDocument();
    expect(screen.getByText('Welcome Noor Fatima to the team!')).toBeInTheDocument();
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
    expect(screen.getByText('Welcome Noor Fatima to the team!')).toBeInTheDocument();
    expect(screen.getByText('Welcome Omar Sheikh to the team!')).toBeInTheDocument();
  });

  it('hides the section entirely when nobody has just joined', () => {
    view(<CompanyMoments moments={moments({ birthdays: [person({ employeeId: 'a' })] })} />);
    expect(screen.queryByText('Welcome to the team')).not.toBeInTheDocument();
  });
});

// --------------------------------------------------------- the whole block

describe('the company updates block', () => {
  it('renders nothing at all on a quiet day', () => {
    const { container } = view(<CompanyMoments moments={moments()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the request is still in flight or has failed', () => {
    const { container } = view(<CompanyMoments moments={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the heading once anything is worth celebrating', () => {
    view(<CompanyMoments moments={moments({ birthdays: [person({ employeeId: 'a' })] })} />);
    expect(screen.getByText('Company updates')).toBeInTheDocument();
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
