// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  MEDICAL_POLICY_DEFAULTS,
  PERMISSIONS,
  defaultCategoryLimits,
  type MedicalPolicyInput,
  type MedicalPolicyRecord,
  type Permission,
} from '@hrms/shared';
import { TABS, visibleTabs } from './settings-layout';

/**
 * The Medical Policy settings screen.
 *
 * Who can reach it, what the confirmation says before a rule moves, and the
 * fact that a reader without `medical.policy.manage` gets a form they cannot
 * submit. The endpoint is the real gate in every case - these assert that the
 * screen agrees with it rather than that it replaces it.
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
  };
});

/*
 * `fetch` is mocked here, NOT `@/lib/api`.
 *
 * Feeding raw envelopes to the real client is the only version of this test
 * that can fail when the response contract is misread - mocking the api client
 * would hand the page whatever shape the test author believed in, and the test
 * and the bug would agree with each other.
 */
import { ConfirmProvider } from '@/components/feedback/confirm-dialog';
import { MedicalPolicyPage, changedFields, toFormValues } from './medical-policy-page';

/** Exactly what the API sends, byte for byte. */
function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

// Typed as the record the API returns, so the literal types `as const` gives
// MEDICAL_POLICY_DEFAULTS widen back to the contract's booleans and numbers.
const POLICY: MedicalPolicyRecord = {
  id: 'pol-1',
  ...MEDICAL_POLICY_DEFAULTS,
  categories: defaultCategoryLimits(),
  effectiveFrom: '2020-01-01T00:00:00.000Z',
  createdAt: '2020-01-01T00:00:00.000Z',
  createdByName: null,
  isCurrent: true,
};

function view(canManage: boolean) {
  return { policy: POLICY, scheduled: null, canManage, currency: 'PKR' };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConfirmProvider>
          <MedicalPolicyPage />
        </ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  permissions = new Set<string>();
  fetchMock = vi.fn((url: string) =>
    String(url).includes('history')
      ? respond({ data: [], meta: { page: 1, limit: 20, total: 0, pages: 1 } })
      : respond({ data: view(true) }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('who is offered the tab', () => {
  const holding =
    (...list: Permission[]) =>
    (permission: Permission) =>
      list.includes(permission);

  const labels = (has: (p: Permission) => boolean) =>
    visibleTabs(TABS, { has, capabilities: { attendanceRules: 'available' } }).map((t) => t.label);

  it('offers Medical policy to a holder of medical.policy.read', () => {
    expect(labels(holding(PERMISSIONS.MEDICAL_POLICY_READ))).toContain('Medical policy');
  });

  it('does not offer it to an employee, who holds only medical.read', () => {
    expect(labels(holding(PERMISSIONS.MEDICAL_READ))).not.toContain('Medical policy');
  });

  it('does not offer it to a manager', () => {
    expect(
      labels(holding(PERMISSIONS.MEDICAL_READ, PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.LEAVE_READ)),
    ).not.toContain('Medical policy');
  });
});

describe('the policy form', () => {
  it('loads and shows Super Admin the saved values', async () => {
    permissions = new Set([PERMISSIONS.MEDICAL_POLICY_READ, PERMISSIONS.MEDICAL_POLICY_MANAGE]);
    renderPage();

    await waitFor(() => expect(screen.getByText('Eligibility')).toBeInTheDocument());

    expect(screen.getByLabelText('Annual medical limit per employee')).toHaveValue(100_000);
    expect(screen.getByLabelText('Minimum employment period')).toHaveValue(3);
    expect(screen.getByLabelText('Policy name')).toHaveValue('Company Medical Benefit');
    expect(screen.getByRole('button', { name: /save policy/i })).toBeInTheDocument();
  });

  it('renders every section the policy is grouped into', async () => {
    permissions = new Set([PERMISSIONS.MEDICAL_POLICY_READ, PERMISSIONS.MEDICAL_POLICY_MANAGE]);
    renderPage();

    await waitFor(() => expect(screen.getByText('General')).toBeInTheDocument());

    for (const section of [
      'General',
      'Eligibility',
      'Annual benefit',
      'Medical categories',
      'Dependents',
      'Claim rules',
      'Document requirements',
      'Carry forward',
      'Policy history',
    ]) {
      expect(screen.getByText(section)).toBeInTheDocument();
    }
  });

  it('lists all seven medical categories', async () => {
    permissions = new Set([PERMISSIONS.MEDICAL_POLICY_READ, PERMISSIONS.MEDICAL_POLICY_MANAGE]);
    renderPage();

    await waitFor(() => expect(screen.getByText('Medical categories')).toBeInTheDocument());

    for (const label of [
      'OPD',
      'Hospitalization',
      'Medicines',
      'Diagnostics / Laboratory',
      'Dental',
      'Optical',
      'Emergency',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('gives a reader without manage a form with no save button', async () => {
    permissions = new Set([PERMISSIONS.MEDICAL_POLICY_READ]);
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('history')
        ? respond({ data: [], meta: { page: 1, limit: 20, total: 0, pages: 1 } })
        : respond({ data: view(false) }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText('Eligibility')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /save policy/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Annual medical limit per employee')).toBeDisabled();
  });

  it('hides the save button when the SERVER says the caller cannot manage', async () => {
    // The permission alone is not the answer; the server's canManage is.
    permissions = new Set([PERMISSIONS.MEDICAL_POLICY_READ, PERMISSIONS.MEDICAL_POLICY_MANAGE]);
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('history')
        ? respond({ data: [], meta: { page: 1, limit: 20, total: 0, pages: 1 } })
        : respond({ data: view(false) }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText('Eligibility')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /save policy/i })).not.toBeInTheDocument();
  });

  it('shows the currency the company actually uses', async () => {
    permissions = new Set([PERMISSIONS.MEDICAL_POLICY_READ, PERMISSIONS.MEDICAL_POLICY_MANAGE]);
    renderPage();

    await waitFor(() => expect(screen.getByText('Annual benefit')).toBeInTheDocument());

    expect(screen.getByText(/In PKR, per employee/)).toBeInTheDocument();
  });
});

describe('validation the screen enforces before anything is sent', () => {
  const openForm = async () => {
    permissions = new Set([PERMISSIONS.MEDICAL_POLICY_READ, PERMISSIONS.MEDICAL_POLICY_MANAGE]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Eligibility')).toBeInTheDocument());
    return userEvent.setup();
  };

  const putCalls = () =>
    fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'PUT',
    );

  it('refuses a negative annual limit and says so', async () => {
    const user = await openForm();
    const limit = screen.getByLabelText('Annual medical limit per employee');

    await user.clear(limit);
    await user.type(limit, '-5');
    await user.click(screen.getByRole('button', { name: /save policy/i }));

    expect(await screen.findByText('An amount cannot be negative.')).toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
  });

  it('refuses a negative minimum employment period', async () => {
    const user = await openForm();
    const months = screen.getByLabelText('Minimum employment period');

    await user.clear(months);
    await user.type(months, '-1');
    await user.click(screen.getByRole('button', { name: /save policy/i }));

    expect(await screen.findByText('This cannot be negative.')).toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
  });

  it('refuses a contribution split that does not total 100', async () => {
    const user = await openForm();
    // The first category on the screen is OPD.
    const [companyShare] = screen.getAllByLabelText('Company %');

    await user.clear(companyShare!);
    await user.type(companyShare!, '60');
    await user.click(screen.getByRole('button', { name: /save policy/i }));

    // The message lands on the pair, so both percentage fields point at it.
    expect((await screen.findAllByText(/have to total 100%/)).length).toBeGreaterThan(0);
    expect(putCalls()).toHaveLength(0);
  });

  it('refuses an empty policy name', async () => {
    const user = await openForm();
    await user.clear(screen.getByLabelText('Policy name'));
    await user.click(screen.getByRole('button', { name: /save policy/i }));

    expect(await screen.findByText('Give the policy a name.')).toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
  });
});

describe('saving', () => {
  it('confirms, sends the whole policy, and keeps the saved values on reload', async () => {
    permissions = new Set([PERMISSIONS.MEDICAL_POLICY_READ, PERMISSIONS.MEDICAL_POLICY_MANAGE]);

    // The server accepts the change and then answers with it, exactly as a real
    // reload would - which is what makes "save then reload preserves values" a
    // real assertion rather than a re-read of the form's own state.
    let saved = view(true);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as MedicalPolicyInput;
        saved = {
          ...saved,
          policy: { ...saved.policy, ...body, categories: body.categories },
        };
        return respond({ data: saved.policy });
      }
      return String(url).includes('history')
        ? respond({ data: [], meta: { page: 1, limit: 20, total: 0, pages: 1 } })
        : respond({ data: saved });
    });

    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Eligibility')).toBeInTheDocument());

    const limit = screen.getByLabelText('Annual medical limit per employee');
    await user.clear(limit);
    await user.type(limit, '250000');
    await user.click(screen.getByRole('button', { name: /save policy/i }));

    // The confirmation names the rule, its current value and its new one.
    // Scoped to the dialog: the same label is on the form behind it.
    expect(await screen.findByText('Save the medical policy?')).toBeInTheDocument();
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Annual medical limit per employee')).toBeInTheDocument();
    expect(dialog.getByText('100000')).toBeInTheDocument();
    expect(dialog.getByText('250000')).toBeInTheDocument();

    await user.click(dialog.getByRole('button', { name: 'Save policy' }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === 'PUT',
      );
      expect(put).toBeDefined();
      const body = JSON.parse(String((put![1] as RequestInit).body)) as MedicalPolicyInput;
      expect(body.annualLimitPerEmployee).toBe(250_000);
      // The category rows travel with it, all seven, each still identified.
      expect(body.categories).toHaveLength(7);
      expect(body.categories.map((c) => c.category)).toContain('DENTAL');
    });

    await waitFor(() =>
      expect(screen.getByLabelText('Annual medical limit per employee')).toHaveValue(250_000),
    );
  });

  it('saves with the effective-date field left blank', async () => {
    // The field starts empty and most saves leave it that way. A blank date
    // means "from now", so it must not block the form.
    permissions = new Set([PERMISSIONS.MEDICAL_POLICY_READ, PERMISSIONS.MEDICAL_POLICY_MANAGE]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Eligibility')).toBeInTheDocument());

    expect(screen.getByLabelText('Effective from')).toHaveValue('');

    const months = screen.getByLabelText('Minimum employment period');
    await user.clear(months);
    await user.type(months, '6');
    await user.click(screen.getByRole('button', { name: /save policy/i }));

    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Save policy' }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === 'PUT',
      );
      expect(put).toBeDefined();
      const body = JSON.parse(String((put![1] as RequestInit).body)) as MedicalPolicyInput;
      expect(body.minEmploymentMonths).toBe(6);
      expect(body.effectiveFrom).toBeUndefined();
    });
  });

  it('does not send anything when nothing has changed', async () => {
    permissions = new Set([PERMISSIONS.MEDICAL_POLICY_READ, PERMISSIONS.MEDICAL_POLICY_MANAGE]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Eligibility')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /save policy/i }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          (call) => (call[1] as RequestInit | undefined)?.method === 'PUT',
        ),
      ).toHaveLength(0),
    );
  });
});

describe('what the confirmation will say', () => {
  const saved: MedicalPolicyInput = toFormValues(POLICY);

  it('reports nothing when nothing moved', () => {
    expect(changedFields(saved, { ...saved })).toEqual([]);
  });

  it('names the rule, what it was and what it becomes', () => {
    const changes = changedFields(saved, { ...saved, annualLimitPerEmployee: 250_000 });

    expect(changes).toEqual([
      { label: 'Annual medical limit per employee', from: '100000', to: '250000' },
    ]);
  });

  it('reads a switch as Yes and No rather than true and false', () => {
    const changes = changedFields(saved, { ...saved, allowProbation: true });

    expect(changes).toEqual([{ label: 'Allow probation employees', from: 'No', to: 'Yes' }]);
  });

  it('names the category a category setting belongs to', () => {
    const categories = saved.categories.map((c) =>
      c.category === 'DENTAL' ? { ...c, enabled: false } : c,
    );
    const changes = changedFields(saved, { ...saved, categories });

    expect(changes).toEqual([{ label: 'Dental - enabled', from: 'Yes', to: 'No' }]);
  });

  it('reads a blank category cap as "No cap"', () => {
    const categories = saved.categories.map((c) =>
      c.category === 'OPD' ? { ...c, annualLimit: 20_000 } : c,
    );
    const changes = changedFields(saved, { ...saved, categories });

    expect(changes).toEqual([{ label: 'OPD - annual limit', from: 'No cap', to: '20000' }]);
  });

  it('lists every rule that moved, not just the first', () => {
    const changes = changedFields(saved, {
      ...saved,
      annualLimitPerEmployee: 250_000,
      minEmploymentMonths: 6,
      parentsCovered: true,
    });

    expect(changes.map((c) => c.label).sort()).toEqual([
      'Annual medical limit per employee',
      'Minimum employment period',
      'Parents covered',
    ]);
  });
});
