// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PERMISSIONS } from '@hrms/shared';

/**
 * The recruitment screens.
 *
 * Four claims are pinned here, and each is one a screen could plausibly get
 * wrong on its own while every endpoint behind it stays correct:
 *
 *   - THE DASHBOARD'S FIGURES COME FROM THE ENDPOINT. The test serves a
 *     summary that deliberately disagrees with the list of interviews beside
 *     it, and expects the summary to win. "Interviews today" is a question
 *     about the office's calendar, answered by the server in the company's
 *     zone; a browser in another country counting the rows on screen would be
 *     wrong by a day twice a year and by five hours permanently.
 *   - A CLASH IS NEVER BOOKED OVER SILENTLY. While the conflict check reports
 *     somebody busy, the submit button is disabled and says so. Ticking "book
 *     it anyway" is what sends `allowConflicts`, so there is no path through
 *     this form that double-books without the person having read who they are
 *     double-booking.
 *   - AN EVALUATION IS ADDRESSED TO NOBODY. The request carries scores and a
 *     recommendation and no participant, employee or interviewer id at all -
 *     the server resolves the caller's own seat - so there is no shape this
 *     form can send that overwrites a colleague's feedback.
 *   - THE RESTRICTED BLOCK IS ABSENT, NOT BLANK. A reader without
 *     `candidate.manage` is sent no `restricted` key, and the page must then
 *     render no card - not a card of dashes, which invites a guess.
 *
 * Plus the conversion guard: while somebody on the roster looks like this
 * candidate, the form will not submit until a person says they have looked.
 */

let permissions = new Set<string>();

vi.mock('@/features/auth/session-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth/session-context')>();
  return {
    ...actual,
    usePermissions: () => ({
      has: (p: string) => permissions.has(p),
      hasAny: (...list: string[]) => list.some((p) => permissions.has(p)),
      hasAll: (...list: string[]) => list.every((p) => permissions.has(p)),
    }),
    useSession: () => ({
      session: {
        employeeLinked: true,
        user: {},
        company: { name: 'Example Ltd', currency: 'PKR', timezone: 'Asia/Karachi' },
      },
      permissions,
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => Promise.resolve(),
      clear: () => {},
    }),
    /*
     * `Can` reads the session through the module's own hook rather than
     * through the exported one, so it has to be replaced here too - otherwise
     * it looks for a provider this test deliberately does not mount.
     */
    Can: ({
      permission,
      mode = 'all',
      fallback = null,
      children,
    }: {
      permission: string | string[];
      mode?: 'all' | 'any';
      fallback?: React.ReactNode;
      children: React.ReactNode;
    }) => {
      const list = Array.isArray(permission) ? permission : [permission];
      const allowed =
        mode === 'any'
          ? list.some((p) => permissions.has(p))
          : list.every((p) => permissions.has(p));
      return <>{allowed ? children : fallback}</>;
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { RecruitmentDashboardPage } from './recruitment-dashboard-page';
import { CandidateDetailPage } from './candidate-detail-page';
import { InterviewScheduleDialog } from './interview-schedule-dialog';
import { EvaluationDialog } from './evaluation-dialog';
import { ConvertToEmployeeDialog } from './convert-to-employee-dialog';

const HR = [
  PERMISSIONS.RECRUITMENT_READ,
  PERMISSIONS.RECRUITMENT_MANAGE,
  PERMISSIONS.CANDIDATE_READ,
  PERMISSIONS.CANDIDATE_MANAGE,
  PERMISSIONS.INTERVIEW_READ,
  PERMISSIONS.INTERVIEW_MANAGE,
  PERMISSIONS.INTERVIEW_EVALUATE,
  PERMISSIONS.RECRUITMENT_OFFER_MANAGE,
  PERMISSIONS.RECRUITMENT_CONVERT_EMPLOYEE,
];

/** A hiring manager: reads recruitment and interviews, and no candidates. */
const MANAGER = [
  PERMISSIONS.RECRUITMENT_READ,
  PERMISSIONS.INTERVIEW_READ,
  PERMISSIONS.INTERVIEW_EVALUATE,
];

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

/** The dashboard's own figures. Deliberately unlike the rows served with them. */
const DASHBOARD = {
  openPositions: 6,
  openVacancies: 11,
  activeCandidates: 42,
  candidatesInInterview: 9,
  interviewsToday: 5,
  upcomingInterviews: 13,
  offersPending: 3,
  hiredThisMonth: 2,
  today: '2026-09-18',
  timezone: 'Asia/Karachi',
};

const UPCOMING = [
  {
    id: 'int-1',
    startsAt: '2026-09-18T05:00:00.000Z',
    endsAt: '2026-09-18T06:00:00.000Z',
    timezone: 'Asia/Karachi',
    candidateId: 'cand-1',
    candidateName: 'Muhammad Ali',
    jobTitle: 'Senior Unity Developer',
    type: 'TECHNICAL',
    round: 'ROUND_1',
    status: 'SCHEDULED',
    interviewerNames: ['Ahmed Khan', 'Muhammad Zohaib'],
    when: 'TODAY',
  },
  {
    id: 'int-2',
    startsAt: '2026-09-22T05:00:00.000Z',
    endsAt: '2026-09-22T06:00:00.000Z',
    timezone: 'Asia/Karachi',
    candidateId: 'cand-2',
    candidateName: 'Fatima Noor',
    jobTitle: null,
    type: 'HR',
    round: 'ROUND_2',
    status: 'CONFIRMED',
    interviewerNames: [],
    when: 'UPCOMING',
  },
];

const INTERVIEWERS = [
  {
    employeeId: 'emp-ahmed',
    fullName: 'Ahmed Khan',
    jobTitle: 'Senior Unity Developer',
    departmentName: 'Development',
    hasLogin: true,
  },
  {
    employeeId: 'emp-bilal',
    fullName: 'Bilal Aslam',
    jobTitle: 'Artist',
    departmentName: 'Art',
    hasLogin: false,
  },
];

const CANDIDATE = {
  id: 'cand-1',
  reference: 'CAN-0001',
  fullName: 'Muhammad Ali',
  email: 'muhammad.ali@example.com',
  phone: '+92 300 1234567',
  currentLocation: 'Lahore',
  linkedinUrl: null,
  portfolioUrl: null,
  skills: 'Unity, C#',
  experienceYears: 5,
  currentCompany: 'Another Studio',
  currentTitle: 'Unity Developer',
  noticePeriodDays: 30,
  source: 'Referral',
  recruiter: { id: 'emp-hr', fullName: 'Sana Iqbal' },
  stage: 'INTERVIEW',
  applications: [
    {
      id: 'app-1',
      candidateId: 'cand-1',
      jobOpeningId: 'job-1',
      jobTitle: 'Senior Unity Developer',
      jobReference: 'JOB-0001',
      departmentName: 'Development',
      stage: 'INTERVIEW',
      stageChangedAt: '2026-09-15T05:00:00.000Z',
      outcomeReason: null,
      appliedAt: '2026-09-10T05:00:00.000Z',
    },
  ],
  documentCount: 2,
  interviewCount: 1,
  hiredEmployeeId: null,
  hiredAt: null,
  createdAt: '2026-09-10T05:00:00.000Z',
  updatedAt: '2026-09-15T05:00:00.000Z',
  restricted: {
    currentSalary: 300000,
    expectedSalary: 450000,
    salaryCurrency: 'PKR',
    notes: 'Asking above band.',
  },
};

const INTERVIEW = {
  id: 'int-1',
  candidateId: 'cand-1',
  candidateName: 'Muhammad Ali',
  candidateReference: 'CAN-0001',
  jobOpeningId: 'job-1',
  jobTitle: 'Senior Unity Developer',
  applicationId: 'app-1',
  type: 'TECHNICAL',
  round: 'ROUND_1',
  startsAt: '2026-09-18T05:00:00.000Z',
  endsAt: '2026-09-18T06:00:00.000Z',
  timezone: 'Asia/Karachi',
  location: 'Meeting room 2',
  meetingLink: null,
  notes: null,
  status: 'COMPLETED',
  completedAt: '2026-09-18T06:05:00.000Z',
  cancelledAt: null,
  cancelledReason: null,
  interviewers: [],
  createdAt: '2026-09-15T05:00:00.000Z',
  updatedAt: '2026-09-18T06:05:00.000Z',
};

const PREVIEW = {
  candidateId: 'cand-1',
  suggested: {
    employeeNumber: 'EMP-0042',
    firstName: 'Muhammad',
    lastName: 'Ali',
    workEmail: null,
    personalEmail: 'muhammad.ali@example.com',
    phone: '+92 300 1234567',
    departmentId: 'dept-dev',
    teamId: null,
    designationId: null,
    locationId: null,
    jobTitle: 'Senior Unity Developer',
    employmentType: 'FULL_TIME',
    employmentStatus: 'PROBATION',
    hireDate: '2026-10-01',
    sourceOfHire: 'Referral',
    linkedinUrl: null,
  },
  duplicates: [],
  alreadyConvertedEmployeeId: null,
};

interface ServeOptions {
  dashboard?: unknown;
  upcoming?: unknown[];
  mySummary?: unknown;
  candidate?: unknown;
  conflicts?: unknown[];
  preview?: unknown;
}

let fetchMock: ReturnType<typeof vi.fn>;
let calls: { method: string; url: string; body: unknown }[] = [];

function serve(options: ServeOptions = {}) {
  calls = [];

  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split('?')[0] ?? '';
    calls.push({
      method: init?.method ?? 'GET',
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (path.endsWith('/recruitment/dashboard/interviewers')) {
      return respond({ data: INTERVIEWERS });
    }
    if (path.endsWith('/recruitment/dashboard/upcoming-interviews')) {
      return respond({ data: options.upcoming ?? UPCOMING });
    }
    if (path.endsWith('/recruitment/dashboard')) {
      return respond({ data: options.dashboard ?? DASHBOARD });
    }
    if (path.endsWith('/recruitment/interviews/my-summary')) {
      return respond({ data: options.mySummary ?? null });
    }
    if (path.endsWith('/recruitment/interviews/conflicts')) {
      return respond({ data: options.conflicts ?? [] });
    }
    if (path.endsWith('/conversion-preview')) {
      return respond({ data: options.preview ?? PREVIEW });
    }
    if (path.endsWith('/convert')) {
      return respond({ data: { employee: { id: 'emp-new' }, candidateId: 'cand-1' } });
    }
    if (path.endsWith('/evaluations')) {
      return respond({ data: { id: 'eval-1' } }, 201);
    }
    if (path.endsWith('/recruitment/interviews')) {
      return respond(
        { data: { interview: INTERVIEW, notified: 2, emailStatus: 'skipped', conflicts: [] } },
        201,
      );
    }
    if (path.endsWith('/departments/lookups')) {
      return respond({
        data: {
          departments: [{ id: 'dept-dev', name: 'Development' }],
          teams: [],
          designations: [],
          locations: [],
        },
      });
    }
    if (/\/recruitment\/candidates\/[^/]+$/.test(path)) {
      return respond({ data: options.candidate ?? CANDIDATE });
    }

    return respond({ data: [], meta: { page: 1, limit: 50, total: 0, totalPages: 0 } });
  });

  vi.stubGlobal('fetch', fetchMock);
}

function renderPage(ui: React.ReactNode, route = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The body of the last request to a path ending in `suffix`. */
function lastBody(suffix: string): unknown {
  return [...calls].reverse().find((call) => call.url.split('?')[0]?.endsWith(suffix))?.body;
}

beforeEach(() => {
  permissions = new Set(HR);
  serve();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// --- the dashboard -----------------------------------------------------------

describe('the recruitment dashboard', () => {
  it('shows the server’s figures, not a count of the rows beside them', async () => {
    renderPage(<RecruitmentDashboardPage />);

    // Two interviews are listed. The server says five are on today and
    // thirteen are booked after it, and the server is the one that knows.
    expect(await screen.findByText('42')).toBeInTheDocument();

    const today = screen.getByText('Interviews today');
    expect(within(today.closest('div.p-5') as HTMLElement).getByText('5')).toBeInTheDocument();

    const upcoming = screen.getByText('Upcoming interviews', { selector: 'p' });
    expect(within(upcoming.closest('div.p-5') as HTMLElement).getByText('13')).toBeInTheDocument();

    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('11 vacancies to fill')).toBeInTheDocument();
  });

  it('says which day, and in whose time zone, in the heading', async () => {
    renderPage(<RecruitmentDashboardPage />);

    await screen.findByText(/Asia\/Karachi/);
    expect(screen.getByText(/Hiring as it stands on/)).toHaveTextContent('Asia/Karachi');
  });

  it('asks for the figures and the panel as two separate reads', async () => {
    renderPage(<RecruitmentDashboardPage />);

    await screen.findByText('Muhammad Ali');
    const paths = calls.map((call) => call.url);
    expect(paths.some((p) => p.endsWith('/api/v1/recruitment/dashboard'))).toBe(true);
    expect(paths.some((p) => p.includes('/recruitment/dashboard/upcoming-interviews'))).toBe(true);
  });

  it('marks today’s interview as today and dates the rest', async () => {
    renderPage(<RecruitmentDashboardPage />);

    await screen.findByText('Muhammad Ali');
    expect(screen.getByText(/Today/)).toBeInTheDocument();
    expect(screen.getByText('Fatima Noor')).toBeInTheDocument();
    // A panel nobody has been added to says so rather than leaving a gap.
    expect(screen.getByText('No panel')).toBeInTheDocument();
  });

  it('offers no candidate link to a reader who cannot open candidates', async () => {
    permissions = new Set(MANAGER);
    renderPage(<RecruitmentDashboardPage />);

    await screen.findByText('Muhammad Ali');
    expect(screen.queryByRole('link', { name: 'Candidates' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Job openings' })).toBeInTheDocument();
  });

  it('says nothing is booked rather than showing an empty list', async () => {
    serve({ upcoming: [] });
    renderPage(<RecruitmentDashboardPage />);

    expect(await screen.findByText('Nothing booked')).toBeInTheDocument();
  });
});

// --- booking over a clash ----------------------------------------------------

describe('scheduling an interview', () => {
  const CLASH = [
    {
      employeeId: 'emp-ahmed',
      fullName: 'Ahmed Khan',
      interviewId: 'int-9',
      candidateName: 'Usman Ahmed',
      startsAt: '2026-09-18T05:00:00.000Z',
      endsAt: '2026-09-18T06:00:00.000Z',
      status: 'SCHEDULED',
    },
  ];

  function openDialog() {
    return renderPage(
      <InterviewScheduleDialog
        open
        candidateId="cand-1"
        candidateName="Muhammad Ali"
        applications={CANDIDATE.applications as never}
        onClose={() => {}}
      />,
    );
  }

  it('blocks the submit while somebody is already busy, and names them', async () => {
    serve({ conflicts: CLASH });
    const user = userEvent.setup();
    openDialog();

    await user.click(await screen.findByRole('checkbox', { name: /Ahmed Khan/ }));

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent('Ahmed Khan');
    expect(warning).toHaveTextContent('Usman Ahmed');

    const submit = screen.getByRole('button', { name: 'Resolve the clash first' });
    expect(submit).toBeDisabled();
  });

  it('sends allowConflicts only once somebody has ticked the box', async () => {
    serve({ conflicts: CLASH });
    const user = userEvent.setup();
    openDialog();

    await user.click(await screen.findByRole('checkbox', { name: /Ahmed Khan/ }));
    await screen.findByRole('alert');

    await user.click(screen.getByRole('checkbox', { name: /Book it anyway/ }));

    const submit = await screen.findByRole('button', { name: 'Book anyway' });
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => {
      expect(lastBody('/recruitment/interviews')).toMatchObject({
        candidateId: 'cand-1',
        allowConflicts: true,
        interviewerIds: ['emp-ahmed'],
      });
    });
  });

  it('books a free slot without any override at all', async () => {
    const user = userEvent.setup();
    openDialog();

    await user.click(await screen.findByRole('checkbox', { name: /Ahmed Khan/ }));

    const submit = await screen.findByRole('button', { name: 'Schedule interview' });
    await user.click(submit);

    await waitFor(() => {
      expect(lastBody('/recruitment/interviews')).toMatchObject({ allowConflicts: false });
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sends a day, two wall-clock times and a zone - never an instant', async () => {
    const user = userEvent.setup();
    openDialog();

    await user.click(await screen.findByRole('checkbox', { name: /Ahmed Khan/ }));
    await user.click(await screen.findByRole('button', { name: 'Schedule interview' }));

    await waitFor(() => {
      const body = lastBody('/recruitment/interviews') as Record<string, unknown>;
      expect(body).toMatchObject({
        startTime: '10:00',
        endTime: '11:00',
        timezone: 'Asia/Karachi',
      });
      expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(body).not.toHaveProperty('startsAt');
    });
  });

  it('warns that a panellist with no login will not be told', async () => {
    openDialog();

    const row = (await screen.findByText('Bilal Aslam')).closest('label') as HTMLElement;
    expect(within(row).getByText('No login')).toBeInTheDocument();
  });
});

// --- filing feedback ---------------------------------------------------------

describe('the evaluation dialog', () => {
  function openDialog(existing: unknown = null) {
    return renderPage(
      <EvaluationDialog
        open
        interview={INTERVIEW as never}
        existing={existing as never}
        onClose={() => {}}
      />,
    );
  }

  it('addresses the interview and nobody’s seat, so nothing can overwrite anybody', async () => {
    const user = userEvent.setup();
    openDialog();

    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

    await waitFor(() => {
      const body = lastBody('/evaluations') as Record<string, unknown>;
      expect(body).toBeDefined();
      // No seat, no employee, no interviewer: the server resolves the caller's
      // own participant row from the session and upserts against that.
      expect(Object.keys(body).sort()).toEqual(
        [
          'comments',
          'communicationScore',
          'cultureFitScore',
          'experienceScore',
          'problemSolvingScore',
          'recommendation',
          'technicalScore',
        ].sort(),
      );
    });
    const posted = calls.filter((call) => call.method === 'POST');
    expect(posted[0]?.url).toContain('/recruitment/interviews/int-1/evaluations');
  });

  it('sends an unscored criterion as null, never as zero', async () => {
    const user = userEvent.setup();
    openDialog();

    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

    await waitFor(() => {
      expect(lastBody('/evaluations')).toMatchObject({
        technicalScore: null,
        communicationScore: null,
        // The one thing that is required, and therefore never null.
        recommendation: 'YES',
      });
    });
  });

  it('offers "Not assessed" ahead of any number', async () => {
    openDialog();

    const select = screen.getByLabelText(/Technical/) as HTMLSelectElement;
    expect(select.options[0]?.text).toBe('Not assessed');
    expect(select.value).toBe('');
  });

  it('revises your own rather than filing a second one', async () => {
    openDialog({
      id: 'eval-mine',
      technicalScore: 8,
      problemSolvingScore: null,
      communicationScore: null,
      experienceScore: null,
      cultureFitScore: null,
      recommendation: 'STRONG_YES',
      comments: 'Knows the engine.',
    });

    expect(screen.getByText('Revise your feedback')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update feedback' })).toBeInTheDocument();
    expect((screen.getByLabelText(/Technical/) as HTMLSelectElement).value).toBe('8');
    expect(screen.getByDisplayValue('Knows the engine.')).toBeInTheDocument();
  });
});

// --- the restricted block ----------------------------------------------------

describe('what a candidate’s page shows about money', () => {
  function openCandidate() {
    return renderPage(
      <Routes>
        <Route path="/recruitment/candidates/:id" element={<CandidateDetailPage />} />
      </Routes>,
      '/recruitment/candidates/cand-1',
    );
  }

  it('shows the confidential card to somebody who manages candidates', async () => {
    openCandidate();

    expect(await screen.findByText('Confidential')).toBeInTheDocument();
    expect(screen.getByText('Asking above band.')).toBeInTheDocument();
  });

  it('shows no card at all when the server omitted the block', async () => {
    const { restricted: _restricted, ...withoutRestricted } = CANDIDATE;
    serve({ candidate: withoutRestricted });
    permissions = new Set(MANAGER);
    openCandidate();

    await screen.findByText('CAN-0001');
    // Absent rather than blank: a row of dashes invites a guess at the number.
    expect(screen.queryByText('Confidential')).not.toBeInTheDocument();
    expect(screen.queryByText('Expected salary')).not.toBeInTheDocument();
    expect(screen.queryByText('Asking above band.')).not.toBeInTheDocument();
  });
});

// --- converting a hire -------------------------------------------------------

describe('converting a candidate to an employee', () => {
  const DUPLICATE = {
    ...PREVIEW,
    duplicates: [
      {
        employeeId: 'emp-77',
        fullName: 'Muhammad Ali',
        employeeNumber: 'EMP-0007',
        workEmail: 'muhammad.ali@example.com',
        matchedOn: 'EMAIL',
      },
    ],
  };

  function openDialog() {
    return renderPage(
      <ConvertToEmployeeDialog open candidate={CANDIDATE as never} onClose={() => {}} />,
    );
  }

  it('proposes the mapping for a person to check, and defaults to probation', async () => {
    openDialog();

    expect(await screen.findByDisplayValue('EMP-0042')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Muhammad')).toBeInTheDocument();
    const status = screen.getByLabelText(/Employment status/) as HTMLSelectElement;
    expect(status.value).toBe('PROBATION');
  });

  it('says plainly that no login is created', async () => {
    openDialog();

    await screen.findByDisplayValue('EMP-0042');
    expect(screen.getByText(/and no login/i)).toBeInTheDocument();
  });

  it('will not write while somebody on the roster looks like this person', async () => {
    serve({ preview: DUPLICATE });
    const user = userEvent.setup();
    openDialog();

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent('EMP-0007');
    expect(warning).toHaveTextContent('matched on email address');

    const submit = screen.getByRole('button', { name: 'Check the duplicates first' });
    expect(submit).toBeDisabled();
    await user.click(submit);

    // Nothing was posted: the acknowledgement is unticked.
    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith('/convert'))).toBe(false);
    });
  });

  it('writes once a person says they have checked', async () => {
    serve({ preview: DUPLICATE });
    const user = userEvent.setup();
    openDialog();

    await screen.findByRole('alert');
    await user.click(screen.getByRole('checkbox', { name: /I have checked/ }));
    await user.click(await screen.findByRole('button', { name: 'Create employee record' }));

    await waitFor(() => {
      expect(lastBody('/convert')).toMatchObject({
        firstName: 'Muhammad',
        lastName: 'Ali',
        employmentStatus: 'PROBATION',
        acknowledgeDuplicates: true,
      });
    });
  });

  it('refuses a second record for somebody already converted', async () => {
    serve({ preview: { ...PREVIEW, alreadyConvertedEmployeeId: 'emp-77' } });
    openDialog();

    expect(await screen.findByText(/has already been converted/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open their employee record/ })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Employee number/)).not.toBeInTheDocument();
  });
});
