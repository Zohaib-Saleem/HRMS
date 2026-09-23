// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EmployeeDetail } from '@hrms/shared';

/**
 * The punch code on the employee create/edit form.
 *
 * The bug this exists for: HR could create an employee but had nowhere to say
 * which PIN the terminal knows them by, so every punch that person made landed
 * on the Device Punches page as "Unmapped" and no amount of correct ZKTeco
 * polling could fix it.
 *
 * The two properties worth pinning are both about the difference between an
 * employee number and a punch code. The field must exist while the employee is
 * being CREATED - a code entered a week later is a week of orphaned punches -
 * and it must never be prefilled from the employee number, because 1021 punches
 * as 51 in this company and quietly copying one into the other would file a
 * stranger's attendance against somebody's record.
 */

let permissions = new Set<string>();
let mappings: unknown[] = [];

vi.mock('@/features/auth/session-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth/session-context')>();
  return {
    ...actual,
    usePermissions: () => ({
      has: (p: string) => permissions.has(p),
      hasAny: (list: string[]) => list.some((p) => permissions.has(p)),
      hasAll: (list: string[]) => list.every((p) => permissions.has(p)),
    }),
  };
});

import { api } from '@/lib/api';
import { EmployeeFormDrawer } from './employee-form-drawer';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), getPage: vi.fn(), post: vi.fn(), patch: vi.fn() },
  };
});

const DEVICE = { id: 'dev-office', name: 'Office', serialNumber: 'ANM4243900452' };

const AAMIR = {
  id: 'emp-284',
  employeeNumber: '284',
  firstName: 'Muhammad',
  lastName: 'Aamir',
  fullName: 'Muhammad Aamir',
  workEmail: null,
  phone: null,
  jobTitle: null,
  photoUrl: null,
  status: 'ACTIVE',
  employmentType: 'FULL_TIME',
  employmentStatus: null,
  hireDate: null,
  designation: null,
  department: null,
  team: null,
  location: null,
  manager: null,
  secondaryManager: null,
  teamManagers: [],
  hasLogin: false,
  excludedFromAttendance: false,
  education: [],
  workExperience: [],
  directReports: [],
} as unknown as EmployeeDetail;

function mount(employee: EmployeeDetail | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EmployeeFormDrawer open employee={employee} onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

/** Opens the Attendance tab and hands back the punch code input. */
async function openAttendance(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Attendance' }));
  return screen.getByLabelText(/punch code/i);
}

beforeEach(() => {
  permissions = new Set(['employee.read', 'employee.manage', 'device.read', 'device.manage']);
  vi.mocked(api.getPage).mockResolvedValue({ data: [DEVICE], meta: {} } as never);
  mappings = [];
  // One mock, two endpoints: the organisation lookups every employee form
  // needs, and this employee's device mappings.
  vi.mocked(api.get).mockImplementation((path: string) =>
    Promise.resolve(
      (path.startsWith('/departments/lookups')
        ? { departments: [], teams: [], designations: [], locations: [], managers: [], teamManagers: [] }
        : mappings) as never,
    ),
  );
  vi.mocked(api.post).mockResolvedValue(AAMIR as never);
  vi.mocked(api.patch).mockResolvedValue(AAMIR as never);
});

afterEach(cleanup);

describe('creating an employee', () => {
  it('offers the punch code while the employee is being created, not afterwards', async () => {
    const user = userEvent.setup();
    mount(null);

    const field = await openAttendance(user);
    expect(field).toBeInTheDocument();
    expect(screen.getByText(/different from Employee ID/i)).toBeInTheDocument();
  });

  it('starts blank - a punch code is never derived from the employee number', async () => {
    const user = userEvent.setup();
    mount(null);

    // Typed on the Job tab first, so the punch code has every chance to copy it.
    await user.type(screen.getByLabelText(/employee number/i), '284');

    expect(await openAttendance(user)).toHaveValue('');
  });

  it('is optional: an employee can be created with no punch code at all', async () => {
    const user = userEvent.setup();
    mount(null);

    await user.type(screen.getByLabelText(/first name/i), 'Muhammad');
    await user.type(screen.getByLabelText(/last name/i), 'Aamir');
    await user.click(screen.getByRole('button', { name: /create employee|save/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, body] = vi.mocked(api.post).mock.calls[0]!;
    expect((body as { punchCode?: string | null }).punchCode).toBeNull();
  });

  it('sends the punch code the user typed, as a string', async () => {
    const user = userEvent.setup();
    mount(null);

    await user.type(screen.getByLabelText(/first name/i), 'Muhammad');
    await user.type(screen.getByLabelText(/last name/i), 'Aamir');
    const field = await openAttendance(user);
    await user.type(field, '284');
    await user.click(screen.getByRole('button', { name: /create employee|save/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, body] = vi.mocked(api.post).mock.calls[0]!;
    expect(body).toMatchObject({ employeeNumber: null, punchCode: '284' });
  });
});

describe('editing an employee', () => {
  it('prefills the code the employee already punches under', async () => {
    mappings = [{ id: 'map-1', deviceId: DEVICE.id, deviceUserId: '51', isActive: true }];

    const user = userEvent.setup();
    mount(AAMIR);

    await waitFor(async () => expect(await openAttendance(user)).toHaveValue('51'));
  });

  it('shows a blank field, not the employee number, for somebody with no code', async () => {
    const user = userEvent.setup();
    mount(AAMIR);

    expect(screen.getByLabelText(/employee number/i)).toHaveValue('284');
    expect(await openAttendance(user)).toHaveValue('');
  });
});

describe('without the device grant', () => {
  it('hides the field rather than showing one that cannot be saved', async () => {
    permissions = new Set(['employee.read', 'employee.manage']);
    const user = userEvent.setup();
    mount(null);

    await user.click(screen.getByRole('button', { name: 'Attendance' }));
    expect(screen.queryByLabelText(/punch code/i)).not.toBeInTheDocument();
    // The section still exists - "Does not punch in" lives there too.
    expect(screen.getByText('Does not punch in')).toBeInTheDocument();
  });

  it('omits the key entirely, so a blank it never showed cannot clear a mapping', async () => {
    permissions = new Set(['employee.read', 'employee.manage']);
    const user = userEvent.setup();
    mount(AAMIR);

    await user.click(screen.getByRole('button', { name: /save|update/i }));

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const [, body] = vi.mocked(api.patch).mock.calls[0]!;
    expect(body).not.toHaveProperty('punchCode');
    expect(body).not.toHaveProperty('punchDeviceId');
  });
});
