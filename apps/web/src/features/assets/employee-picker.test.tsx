// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AssetEmployeeLookupItem } from '@hrms/shared';

/**
 * The picker the asset dialogs choose a person from.
 *
 * One claim, and it is the reason the lookup endpoint exists: THIS CONTROL
 * MUST NOT READ THE EMPLOYEE DIRECTORY. It used to call `GET /employees`, which
 * is gated on `employee.read` - the grant that also opens People, Team
 * attendance, Attendance reports and the Employee Master Report. So the person
 * whose job is the asset register either could not use this control at all
 * (which is what happened: the picker 403'd and reported "Nobody matches that
 * search") or had to be handed the whole HR surface to make it work.
 *
 * So the assertion is on the REQUEST, not on the options. A picker that
 * rendered the right six fields while still fetching them from `/employees`
 * would be the same permission problem with a nicer label.
 */

import { api } from '@/lib/api';
import { EmployeePicker } from './employee-picker';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), getPage: vi.fn() } };
});

const AHMED: AssetEmployeeLookupItem = {
  id: 'emp-ahmed',
  employeeNumber: 'GE-014',
  fullName: 'Ahmed Raza',
  departmentName: 'Engineering',
  teamName: 'Platform',
  isActive: true,
  status: 'ACTIVE',
  workEmail: 'ahmed@example.com',
};

const HIRA: AssetEmployeeLookupItem = {
  ...AHMED,
  id: 'emp-hira',
  employeeNumber: 'GE-002',
  fullName: 'Hira Khan',
  isActive: false,
  status: 'RESIGNED',
};

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue([AHMED] as never);
  vi.mocked(api.getPage).mockResolvedValue({
    data: [],
    meta: { page: 1, limit: 20, total: 0, totalPages: 1 },
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const view = (props: Partial<React.ComponentProps<typeof EmployeePicker>> = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <EmployeePicker id="pick" value="" onChange={() => {}} {...props} />
    </QueryClientProvider>,
  );
};

describe('where the picker gets its people', () => {
  it('reads the asset lookup, never the employee directory', async () => {
    view();

    await waitFor(() => expect(api.get).toHaveBeenCalled());

    expect(vi.mocked(api.get).mock.calls[0]?.[0]).toBe('/assets/employee-lookup');
    // Not by a different method either: the directory is paginated and this is
    // not, so a regression to `/employees` would show up here as well.
    expect(api.getPage).not.toHaveBeenCalled();
    for (const [path] of vi.mocked(api.get).mock.calls) {
      expect(String(path)).not.toContain('/employees');
    }
  });

  it('asks for the living roster by default', async () => {
    view();

    await waitFor(() => expect(api.get).toHaveBeenCalled());

    const options = vi.mocked(api.get).mock.calls[0]?.[1] as { query: Record<string, unknown> };
    expect(options.query.includeInactive).toBeUndefined();
  });

  it('asks for leavers too when the dialog is a return or a disposal', async () => {
    vi.mocked(api.get).mockResolvedValue([HIRA] as never);
    view({ includeInactive: true });

    await waitFor(() => expect(api.get).toHaveBeenCalled());

    const options = vi.mocked(api.get).mock.calls[0]?.[1] as { query: Record<string, unknown> };
    expect(options.query.includeInactive).toBe('true');
  });
});

describe('what the picker shows', () => {
  it('names the person, their number and their department', async () => {
    view();

    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Ahmed Raza/ })).toBeInTheDocument(),
    );
    const option = screen.getByRole('option', { name: /Ahmed Raza/ });
    expect(option).toHaveTextContent('GE-014');
    expect(option).toHaveTextContent('Engineering');
  });

  it('says so when somebody has left, rather than listing them as staff', async () => {
    vi.mocked(api.get).mockResolvedValue([HIRA] as never);
    view({ includeInactive: true });

    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Hira Khan/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole('option', { name: /Hira Khan/ })).toHaveTextContent('Resigned');
  });
});
