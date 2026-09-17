// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EmployeeTimelinePage, TimelineEvent } from '@hrms/shared';

/**
 * The Timeline tab.
 *
 * Three properties are pinned here, and none of them is cosmetic.
 *
 * The first is that the screen never invents a category. The filter chips come
 * from the response, because the API omits a category the reader may not open -
 * and a "Salary" chip that returned nothing would read as "this person has
 * never had a raise", which is a statement about the employee rather than
 * about the reader.
 *
 * The second is that filtering, ordering and paging are all questions for the
 * server. A client that filtered a page it already held would be filtering
 * twenty events out of two thousand and calling the answer a timeline.
 *
 * The third is the empty state: "no history is available yet" is a sentence,
 * not a large blank card.
 */

import { api } from '@/lib/api';
import { EmployeeTimeline } from './employee-timeline';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), getPage: vi.fn(), getEnvelope: vi.fn() },
  };
});

const getEnvelope = vi.mocked(api.getEnvelope);

function event(overrides: Partial<TimelineEvent> & Pick<TimelineEvent, 'id'>): TimelineEvent {
  return {
    category: 'EMPLOYMENT',
    type: 'EMPLOYEE_JOINED',
    occurredAt: '2022-06-15T00:00:00.000Z',
    day: '2022-06-15',
    year: 2022,
    dateOnly: true,
    title: 'Joined company',
    description: 'Development · Game Developer',
    details: [{ label: 'Department', value: 'Development' }],
    actorName: null,
    link: 'Overview',
    ...overrides,
  };
}

const JOINED = event({ id: 'employee:joined' });

const SALARY = event({
  id: 'salary:sal-2',
  category: 'SALARY',
  type: 'SALARY_UPDATED',
  occurredAt: '2026-08-01T00:00:00.000Z',
  day: '2026-08-01',
  year: 2026,
  dateOnly: true,
  title: 'Salary updated',
  description: 'PKR 120,000 → PKR 135,000',
  details: [
    { label: 'Previous', value: 'PKR 120,000' },
    { label: 'New', value: 'PKR 135,000' },
    { label: 'Effective', value: '01 Aug 2026' },
  ],
  actorName: 'HR Admin',
  link: 'Salary & Payroll',
});

function page(
  data: TimelineEvent[],
  meta: Partial<EmployeeTimelinePage['meta']> = {},
): EmployeeTimelinePage {
  return {
    data,
    meta: {
      limit: 20,
      order: 'desc',
      total: data.length,
      hasMore: false,
      nextCursor: null,
      years: [2026, 2022],
      categories: ['EMPLOYMENT', 'SALARY'],
      ...meta,
    },
  };
}

function renderTimeline(onOpenTab?: (tab: string) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EmployeeTimeline
        employeeId="emp-1"
        employeeName="Awais Zahid"
        photoUrl={null}
        onOpenTab={onOpenTab as never}
      />
    </QueryClientProvider>,
  );
}

/** The query string the component last asked the API for. */
function lastQuery(): Record<string, unknown> {
  const call = getEnvelope.mock.calls.at(-1);
  return ((call?.[1] as { query?: Record<string, unknown> })?.query ?? {}) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  getEnvelope.mockResolvedValue(page([SALARY, JOINED]));
});

afterEach(cleanup);

describe('rendering', () => {
  it('lists events newest first, under a separator for each year', async () => {
    renderTimeline();

    await screen.findByText('Salary updated');

    const headings = screen.getAllByRole('heading', { level: 4 });
    expect(headings.map((node) => node.textContent)).toEqual(['2026', '2022']);

    const items = screen.getAllByRole('listitem');
    const order = items
      .map((node) => node.textContent ?? '')
      .filter((text) => text.includes('Salary updated') || text.includes('Joined company'));
    expect(order[0]).toContain('Salary updated');
    expect(order[1]).toContain('Joined company');
  });

  it('shows the description, the date and who made the change', async () => {
    renderTimeline();

    const row = (await screen.findByText('Salary updated')).closest('button')!;
    expect(within(row).getByText('PKR 120,000 → PKR 135,000')).toBeInTheDocument();
    expect(row.textContent).toContain('Changed by: HR Admin');
  });

  it('gives an effective-dated event no time of day it never had', async () => {
    renderTimeline();

    const row = (await screen.findByText('Salary updated')).closest('button')!;
    expect(row.textContent).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('asks the server for the newest twenty by default', async () => {
    renderTimeline();
    await screen.findByText('Salary updated');

    expect(lastQuery()).toMatchObject({ order: 'desc', limit: 20 });
    expect(lastQuery().cursor).toBeUndefined();
    expect(lastQuery().category).toBeUndefined();
    expect(lastQuery().year).toBeUndefined();
  });
});

describe('filters', () => {
  it('offers only the categories the response carried', async () => {
    renderTimeline();
    await screen.findByText('Salary updated');

    const group = screen.getByRole('group', { name: 'Filter by category' });
    expect(within(group).getByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Salary' })).toBeInTheDocument();
    // Nothing the reader cannot open is advertised.
    expect(within(group).queryByRole('button', { name: 'Medical' })).not.toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: 'Loans' })).not.toBeInTheDocument();
  });

  it('sends the category to the server rather than filtering what it holds', async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByText('Salary updated');

    getEnvelope.mockResolvedValue(page([SALARY], { total: 1 }));
    const group = screen.getByRole('group', { name: 'Filter by category' });
    await user.click(within(group).getByRole('button', { name: 'Salary' }));

    await waitFor(() => expect(lastQuery()).toMatchObject({ category: 'SALARY' }));
    // The chips stay put while the next page is in flight: the control the
    // reader just clicked must not vanish under their cursor.
    expect(within(group).getByRole('button', { name: 'Salary' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('sends the year, and keeps every year on offer', async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByText('Salary updated');

    getEnvelope.mockResolvedValue(page([SALARY], { total: 1 }));
    const group = screen.getByRole('group', { name: 'Filter by year' });
    await user.click(within(group).getByRole('button', { name: '2026' }));

    await waitFor(() => expect(lastQuery()).toMatchObject({ year: 2026 }));
    // The chips describe the timeline, not the view: 2022 is still reachable.
    expect(within(group).getByRole('button', { name: '2022' })).toBeInTheDocument();
  });

  it('turns the order around on request', async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByText('Salary updated');

    getEnvelope.mockResolvedValue(page([JOINED, SALARY], { order: 'asc' }));
    await user.click(screen.getByRole('button', { name: /newest first/i }));

    await waitFor(() => expect(lastQuery()).toMatchObject({ order: 'asc' }));
    expect(screen.getByRole('button', { name: /oldest first/i })).toBeInTheDocument();
  });
});

describe('paging', () => {
  it('loads more with the cursor the server issued, and appends', async () => {
    const user = userEvent.setup();
    getEnvelope.mockResolvedValueOnce(
      page([SALARY], { hasMore: true, nextCursor: 'cursor-2', total: 2 }),
    );
    renderTimeline();
    await screen.findByText('Salary updated');

    getEnvelope.mockResolvedValueOnce(page([JOINED], { total: 2 }));
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByText('Joined company');
    expect(lastQuery()).toMatchObject({ cursor: 'cursor-2' });
    // The first page is still on screen - Load more appends, it does not replace.
    expect(screen.getByText('Salary updated')).toBeInTheDocument();
  });

  it('offers no Load more when the server says there is nothing after this', async () => {
    renderTimeline();
    await screen.findByText('Salary updated');

    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

describe('the empty state', () => {
  it('says so in a sentence rather than showing a blank card', async () => {
    getEnvelope.mockResolvedValue(page([], { years: [], categories: [] }));
    renderTimeline();

    expect(await screen.findByText('No history is available yet.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Filter by category' })).not.toBeInTheDocument();
  });

  it('distinguishes "nothing here" from "nothing matching that filter"', async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByText('Salary updated');

    getEnvelope.mockResolvedValue(page([], { total: 0 }));
    const group = screen.getByRole('group', { name: 'Filter by year' });
    await user.click(within(group).getByRole('button', { name: '2022' }));

    expect(
      await screen.findByText('Nothing was recorded that matches these filters.'),
    ).toBeInTheDocument();
  });
});

describe('the detail drawer', () => {
  it('opens on the event and shows the rows the API formatted', async () => {
    const user = userEvent.setup();
    renderTimeline();

    await user.click((await screen.findByText('Salary updated')).closest('button')!);

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('heading', { name: 'Salary updated' })).toBeInTheDocument();
    expect(within(drawer).getByText('PKR 120,000')).toBeInTheDocument();
    expect(within(drawer).getByText('PKR 135,000')).toBeInTheDocument();
    expect(within(drawer).getByText('HR Admin')).toBeInTheDocument();
  });

  it('hands the reader to the tab that owns the record', async () => {
    const user = userEvent.setup();
    const onOpenTab = vi.fn();
    renderTimeline(onOpenTab);

    await user.click((await screen.findByText('Salary updated')).closest('button')!);
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: /open salary & payroll/i }));

    expect(onOpenTab).toHaveBeenCalledWith('Salary & Payroll');
  });
});

describe('failure', () => {
  it('reports a refusal as a refusal rather than as a broken screen', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    getEnvelope.mockRejectedValue(
      new ApiError(403, { code: 'FORBIDDEN', message: 'You do not have permission to do that.' }),
    );
    renderTimeline();

    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
  });
});
