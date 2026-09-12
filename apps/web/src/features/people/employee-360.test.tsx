// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { EmployeeDetail, EmployeeProfileSummary } from '@hrms/shared';

/**
 * Employee 360 - one profile, and only the parts the reader may see.
 *
 * Two properties are worth pinning here and neither is cosmetic.
 *
 * The first is that a tab is hidden rather than shown empty. A profile that
 * offers "Salary & Payroll" to somebody who cannot read payroll teaches them
 * the tab is broken; the row of tabs has to be an honest statement of what is
 * behind it.
 *
 * The second is that the Leave tab says so when there is nothing recorded. The
 * leave history for this company was kept on a spreadsheet as monthly counts
 * with no dates, and the one thing this screen must never do is present
 * invented dates as though somebody had recorded them.
 *
 * The figures themselves are not re-asserted here - they belong to the
 * attendance engine, the leave service and the payroll runs, which have their
 * own tests. What is asserted is that this page renders what those hand it.
 */

let permissions = new Set<string>();

vi.mock('@/features/auth/session-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth/session-context')>();
  return {
    ...actual,
    usePermissions: () => ({
      has: (p: string) => permissions.has(p),
      hasAny: (list: string[]) => list.some((p) => permissions.has(p)),
      hasAll: (list: string[]) => list.every((p) => permissions.has(p)),
    }),
    Can: ({ permission, children }: { permission: string; children: React.ReactNode }) =>
      permissions.has(permission) ? <>{children}</> : null,
  };
});

import { api } from '@/lib/api';
import { ConfirmProvider } from '@/components/feedback/confirm-dialog';
import { EmployeeDetailPage } from './employee-detail-page';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), getPage: vi.fn(), getEnvelope: vi.fn() },
  };
});

const ALL = [
  'employee.read',
  'employee.manage',
  'employee.sensitive.read',
  'attendance.read',
  'leave.read',
  'loan.read',
  'payroll.read',
  'payslip.read',
  'contract.read',
  'policy.read',
  'device.read',
];

const EMPLOYEE = {
  id: 'emp-1',
  employeeNumber: '1020',
  firstName: 'Awais',
  lastName: 'Zahid',
  fullName: 'Awais Zahid',
  workEmail: 'awais@example.com',
  phone: null,
  jobTitle: 'Developer',
  photoUrl: null,
  status: 'ACTIVE',
  employmentType: 'FULL_TIME',
  hireDate: '2021-03-01',
  designation: { id: 'd1', name: 'Developer' },
  department: { id: 'dep1', name: 'Engineering' },
  team: { id: 't1', name: 'GamEmpires' },
  location: null,
  manager: null,
  hasLogin: false,
  middleName: null,
  displayName: null,
  personalEmail: null,
  personalPhone: null,
  secondaryManager: null,
  confirmationDate: '2021-06-01',
  nextIncrementDueDate: '2026-12-01',
  terminationDate: null,
  resignationDate: null,
  sourceOfHire: null,
  linkedinUrl: null,
  priorExperienceMonths: 24,
  dateOfBirth: '1995-01-01',
  gender: 'MALE',
  maritalStatus: null,
  nationality: null,
  bloodGroup: null,
  presentAddress: null,
  permanentAddress: null,
  emergencyContactName: null,
  emergencyContactPhone: null,
  emergencyContactRelationship: null,
  notes: null,
  createdAt: '2021-03-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  workExperience: [],
  education: [
    { id: 'edu-1', level: 'Bachelors', degree: 'BSc', institution: 'NCBA&E', yearCompleted: 2019 },
  ],
  directReports: [],
} as unknown as EmployeeDetail;

const SUMMARY: EmployeeProfileSummary = {
  employeeId: 'emp-1',
  punchCodes: ['26'],
  attendance: {
    month: '2026-09',
    present: 6,
    halfDay: 2,
    absent: 1,
    onLeave: 1,
    late: 3,
    earlyLeave: 1,
    missingPunch: 1,
    irregular: 0,
    workedMinutes: 3120,
    expectedMinutes: 3840,
    overtimeMinutes: 95,
    attendancePercentage: 70,
  },
  leave: {
    year: 2026,
    entitlementDays: 20,
    usedDays: 4,
    adjustedDays: 2,
    consumedDays: 6,
    pendingDays: 1,
    availableDays: 10,
  },
  loans: { activeCount: 1, outstandingAmount: 45000, monthlyDeduction: 5000, currency: 'PKR' },
  salary: {
    amount: 120000,
    currency: 'PKR',
    effectiveFrom: '2026-01-01',
    nextIncrementDueDate: '2026-12-01',
  },
};

function renderProfile() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/people/emp-1']}>
          <Routes>
            <Route path="/people/:id" element={<EmployeeDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  permissions = new Set(ALL);

  vi.mocked(api.get).mockImplementation((path: string) => {
    if (path.endsWith('/profile-summary')) return Promise.resolve(SUMMARY as never);
    if (path.startsWith('/employees/')) return Promise.resolve(EMPLOYEE as never);
    if (path.startsWith('/leave/balances/')) return Promise.resolve([] as never);
    // The edit drawer is mounted closed alongside the tabs and reads these.
    if (path === '/departments/lookups') {
      return Promise.resolve({
        departments: [],
        teams: [],
        designations: [],
        locations: [],
        managers: [],
      } as never);
    }
    // Company currency, and anything else a tab asks for.
    return Promise.resolve({ currency: 'PKR' } as never);
  });

  vi.mocked(api.getPage).mockImplementation(() =>
    Promise.resolve({ data: [], meta: { page: 1, limit: 50, total: 0, pages: 0 } } as never),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Employee 360 profile', () => {
  it('offers every section of the record in one place', async () => {
    renderProfile();
    await screen.findByRole('heading', { name: 'Awais Zahid' });

    const tabs = screen.getByRole('navigation', { name: 'Employee sections' });
    for (const label of [
      'Overview',
      'Personal',
      'Attendance',
      'Leave',
      'Loans',
      'Salary & Payroll',
      'Contracts & Policies',
      'Education & Experience',
      'Reports',
    ]) {
      expect(within(tabs).getByRole('button', { name: new RegExp(`^${escape(label)}`) })).toBeInTheDocument();
    }
  });

  it('hides a section the reader has no permission for, rather than showing it empty', async () => {
    permissions = new Set(['employee.read']);
    renderProfile();
    await screen.findByRole('heading', { name: 'Awais Zahid' });

    const tabs = screen.getByRole('navigation', { name: 'Employee sections' });
    expect(within(tabs).getByRole('button', { name: /^Overview/ })).toBeInTheDocument();
    expect(within(tabs).queryByRole('button', { name: /^Attendance/ })).not.toBeInTheDocument();
    expect(within(tabs).queryByRole('button', { name: /^Leave/ })).not.toBeInTheDocument();
    expect(within(tabs).queryByRole('button', { name: /^Loans/ })).not.toBeInTheDocument();
    expect(within(tabs).queryByRole('button', { name: /^Salary/ })).not.toBeInTheDocument();
    expect(within(tabs).queryByRole('button', { name: /^Contracts/ })).not.toBeInTheDocument();
  });

  it('shows the summary strip from the figures the modules produced', async () => {
    renderProfile();

    // Worked against normal, both from the attendance engine's own totals.
    await waitFor(() => expect(screen.getByText('52h 00m')).toBeInTheDocument());
    expect(screen.getByText(/of 64h 00m normal/)).toBeInTheDocument();
    expect(screen.getByText(/1h 35m overtime/)).toBeInTheDocument();
    expect(screen.getByText(/4 used of 20 in 2026/)).toBeInTheDocument();
  });

  it('shows the PunchCode on Overview without offering to change it', async () => {
    renderProfile();
    await waitFor(() => expect(screen.getByText('PunchCode')).toBeInTheDocument());

    expect(screen.getByText('26')).toBeInTheDocument();
    // Read-only: the mapping is edited on the device screen that also
    // re-attributes the punches behind it.
    expect(screen.queryByRole('button', { name: /punchcode/i })).not.toBeInTheDocument();
  });

  it('says leave is unrecorded rather than inventing dates for it', async () => {
    renderProfile();
    await screen.findByRole('heading', { name: 'Awais Zahid' });

    await userEvent.click(screen.getByRole('button', { name: /^Leave/ }));

    expect(await screen.findByText('No leave requests on record')).toBeInTheDocument();
    expect(
      screen.getByText(/Leave taken before the system was in use, or tracked elsewhere/),
    ).toBeInTheDocument();
  });

  it('keeps education on the profile and lets HR correct it', async () => {
    renderProfile();
    await screen.findByRole('heading', { name: 'Awais Zahid' });

    await userEvent.click(screen.getByRole('button', { name: /^Education/ }));

    expect(await screen.findByText('BSc')).toBeInTheDocument();
    expect(screen.getByText('NCBA&E')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit BSc' })).toBeInTheDocument();
  });
});

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
