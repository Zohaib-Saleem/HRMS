// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PERMISSIONS } from '@hrms/shared';

/**
 * The lunch screens.
 *
 * Three things are pinned here, and each is something a screen could plausibly
 * get wrong on its own:
 *
 *   - the employee's page has NO way to record a payment. Not a disabled
 *     button, not a hidden one: there is no control, because the endpoint
 *     behind this screen does not exist. A screen that grew one would fail
 *     these;
 *   - the operator's six figures come from the COLLECTION endpoint, not from
 *     the rows on screen. The test serves a summary that deliberately does not
 *     match the page of orders beside it, and expects the summary to win -
 *     because the list is one page and the day is the whole day;
 *   - what somebody may do to an order is the SERVER'S answer. `canCancel`,
 *     `canMarkPaid` and `canCorrectPayment` arrive on the record already
 *     resolved, and these tests move those flags and expect the controls to
 *     move with them. A screen that started deciding for itself from a
 *     permission list would fail.
 *
 * And the vocabulary: nothing on either screen says deduction, payroll,
 * salary, invoice or approval, because none of those happens. That is asserted
 * rather than left to review.
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
      session: { employeeLinked: true, user: {}, company: { currency: 'PKR' } },
      permissions,
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => Promise.resolve(),
      clear: () => {},
    }),
  };
});

import { ConfirmProvider } from '@/components/feedback/confirm-dialog';
import { LunchPage } from './lunch-page';
import { LunchCollectionPage } from './lunch-collection-page';
import { LunchTodayCard } from './lunch-today-card';

const EATER = [
  PERMISSIONS.LUNCH_ORDER_CREATE,
  PERMISSIONS.LUNCH_ORDER_READ_OWN,
  PERMISSIONS.LUNCH_ORDER_CANCEL_OWN,
];

const OPERATOR = [PERMISSIONS.LUNCH_COLLECTION_READ, PERMISSIONS.LUNCH_PAYMENT_MARK];

const CANCELLER = [PERMISSIONS.LUNCH_COLLECTION_READ, PERMISSIONS.LUNCH_ORDER_CANCEL_ANY];

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const order = (overrides: Record<string, unknown> = {}) => ({
  id: 'order-1',
  orderNumber: 'LUNCH-2026-09-16-00042',
  day: '2026-09-16',
  employeeId: 'emp-ali',
  employeeName: 'Ali Raza',
  employeeNumber: '1001',
  status: 'ORDERED',
  items: [
    { id: 'l1', menuItemId: 'item-chapati', itemName: 'Chapati', unitPrice: 20, quantity: 2, lineTotal: 40 },
    { id: 'l2', menuItemId: 'item-karahi', itemName: 'Chicken Karahi', unitPrice: 250, quantity: 1, lineTotal: 250 },
  ],
  itemSummary: '2 Chapati + Chicken Karahi',
  totalAmount: 290,
  paymentStatus: 'UNPAID',
  paymentMethod: null,
  paidAt: null,
  paidByName: null,
  note: null,
  createdAt: '2026-09-16T07:30:00.000Z',
  cancelledAt: null,
  cancelledByName: null,
  cancelledBySelf: false,
  cancellationReason: null,
  refundStatus: 'NONE',
  refundedAt: null,
  refundReason: null,
  canCancel: true,
  canMarkPaid: false,
  canCorrectPayment: false,
  canOperatorCancel: false,
  canAdvance: false,
  nextStatus: null,
  ...overrides,
});

const MENU = [
  { id: 'item-chapati', name: 'Chapati', description: null, price: 20, isActive: true, sortOrder: 0, createdAt: '', updatedAt: '' },
  { id: 'item-karahi', name: 'Chicken Karahi', description: null, price: 250, isActive: true, sortOrder: 1, createdAt: '', updatedAt: '' },
];

/** The day's figures. Deliberately larger than any page of rows served with them. */
const SUMMARY = {
  day: '2026-09-16',
  totalOrders: 62,
  paidOrders: 57,
  unpaidOrders: 5,
  expectedCollection: 18_450,
  collectedAmount: 17_100,
  remainingAmount: 1_350,
  cancelledOrders: 2,
  cancelledUnpaidOrders: 1,
  cancelledUnpaidAmount: 200,
  cancelledPaidOrders: 1,
  cancelledPaidAmount: 290,
  refundedAmount: 0,
  retainedAmount: 290,
  cashInHand: 17_390,
};

/** What the kitchen is making, which the collection screen reads separately. */
const FOOD = {
  day: '2026-09-16',
  totalOrders: 62,
  totalPlates: 93,
  items: [
    { menuItemId: 'item-chapati', itemName: 'Chapati', quantity: 62, amount: 1_240 },
    { menuItemId: 'item-karahi', itemName: 'Chicken Karahi', quantity: 31, amount: 7_750 },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
let calls: string[] = [];

interface ServeOptions {
  todayOrders?: unknown[];
  outstanding?: number;
  deskOrders?: unknown[];
  summary?: unknown;
  food?: unknown;
}

function serve(options: ServeOptions = {}) {
  calls = [];

  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}${init?.body ? ` ${String(init.body)}` : ''}`);
    const path = url.split('?')[0] ?? '';

    if (path.endsWith('/lunch/menu')) return respond({ data: MENU });

    if (path.endsWith('/lunch/today')) {
      const orders = options.todayOrders ?? [order()];
      return respond({
        data: {
          day: '2026-09-16',
          orders,
          outstandingAmount: options.outstanding ?? 290,
          canOrder: true,
        },
      });
    }

    if (path.endsWith('/lunch/desk/collection')) {
      return respond({ data: options.summary ?? SUMMARY });
    }

    if (path.endsWith('/lunch/desk/food')) {
      return respond({ data: options.food ?? FOOD });
    }

    if (/\/lunch\/desk\/orders\/[^/]+\/cancel$/.test(path)) {
      return respond({ data: order({ status: 'CANCELLED' }) });
    }
    if (/\/lunch\/desk\/orders\/[^/]+\/status$/.test(path)) {
      return respond({ data: order({ status: 'PREPARING' }) });
    }

    if (/\/lunch\/desk\/orders\/[^/]+\/pay$/.test(path)) {
      return respond({ data: order({ paymentStatus: 'PAID', paymentMethod: 'CASH' }) });
    }
    if (/\/lunch\/desk\/orders\/[^/]+\/payment-correction$/.test(path)) {
      return respond({ data: order() });
    }
    if (/\/lunch\/orders\/[^/]+\/cancel$/.test(path)) {
      return respond({ data: order({ status: 'CANCELLED' }) });
    }

    const rows =
      path.endsWith('/lunch/desk/orders') ? (options.deskOrders ?? [order()]) : [order()];

    return respond({
      data: rows,
      meta: { page: 1, limit: 50, total: rows.length, totalPages: 1 },
    });
  });

  vi.stubGlobal('fetch', fetchMock);
}

function renderPage(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  permissions = new Set(EATER);
  serve();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// --- the employee's screen ---------------------------------------------------

describe("the employee's lunch page", () => {
  it('shows what was ordered, what it costs and whether it is paid for', async () => {
    renderPage(<LunchPage />);

    await screen.findAllByText('2 Chapati + Chicken Karahi');
    expect(screen.getAllByText('LUNCH-2026-09-16-00042').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PKR 290').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThan(0);
  });

  it('shows a paid order as paid, with the method the money arrived in', async () => {
    serve({
      todayOrders: [
        order({
          paymentStatus: 'PAID',
          paymentMethod: 'CASH',
          paidAt: '2026-09-16T08:10:00.000Z',
          paidByName: 'Usman Ghani',
          canCancel: false,
        }),
      ],
      outstanding: 0,
    });

    renderPage(<LunchPage />);

    await screen.findByText('Paid PKR 290 · Cash');
  });

  it('offers no way at all to record a payment', async () => {
    permissions = new Set([...EATER, PERMISSIONS.LUNCH_PAYMENT_MARK]);
    renderPage(<LunchPage />);

    await screen.findAllByText('2 Chapati + Chicken Karahi');

    // Even holding the operator's grant, this screen has no such control.
    expect(screen.queryByRole('button', { name: /mark paid/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm payment/i })).not.toBeInTheDocument();
  });

  it('never talks about payroll, salary or a deduction', async () => {
    renderPage(<LunchPage />);
    await screen.findAllByText('2 Chapati + Chicken Karahi');

    const text = document.body.textContent ?? '';
    for (const word of ['payroll', 'salary', 'deduct', 'invoice', 'approval', 'finance']) {
      expect(text.toLowerCase()).not.toContain(word);
    }
  });

  it('hides Cancel on an order the server says cannot be cancelled', async () => {
    serve({ todayOrders: [order({ paymentStatus: 'PAID', paymentMethod: 'CASH', canCancel: false })] });
    renderPage(<LunchPage />);

    await screen.findAllByText('2 Chapati + Chicken Karahi');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('cancels an unpaid order once the confirmation is accepted', async () => {
    const user = userEvent.setup();
    renderPage(<LunchPage />);

    await screen.findAllByText('2 Chapati + Chicken Karahi');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    await waitFor(() =>
      expect(calls.some((call) => call.includes('POST') && call.includes('/cancel'))).toBe(true),
    );
  });

  it('sends only items and quantities when ordering', async () => {
    const user = userEvent.setup();
    renderPage(<LunchPage />);

    await screen.findAllByText('2 Chapati + Chicken Karahi');
    await user.click(screen.getAllByRole('button', { name: /order lunch/i })[0]!);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'One more Chapati' }));
    await user.click(within(dialog).getByRole('button', { name: 'One more Chapati' }));
    await user.click(within(dialog).getByRole('button', { name: 'Place order' }));

    const post = await waitFor(() => {
      const found = calls.find((call) => call.startsWith('POST') && call.includes('/lunch/orders'));
      expect(found).toBeTruthy();
      return found!;
    });

    const body = JSON.parse(post.slice(post.indexOf('{')));
    expect(body).toEqual({ items: [{ menuItemId: 'item-chapati', quantity: 2 }] });
    // No price, no total, no employee, no payment. There is nothing else to send.
    expect(Object.keys(body)).toEqual(['items']);
  });

  it('previews the total from the menu while choosing', async () => {
    const user = userEvent.setup();
    renderPage(<LunchPage />);

    await screen.findAllByText('2 Chapati + Chicken Karahi');
    await user.click(screen.getAllByRole('button', { name: /order lunch/i })[0]!);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'One more Chicken Karahi' }));
    await user.click(within(dialog).getByRole('button', { name: 'One more Chapati' }));

    expect(within(dialog).getByText('PKR 270')).toBeInTheDocument();
  });
});

// --- the operator's screen ---------------------------------------------------

describe("the collection screen", () => {
  beforeEach(() => {
    permissions = new Set(OPERATOR);
  });

  it("shows the day's figures from the collection endpoint, not from the page of rows", async () => {
    // One row on screen, sixty-two orders in the day. The figures are the day's.
    serve({ deskOrders: [order({ canMarkPaid: true })] });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('PKR 18,450'); // expected
    expect(screen.getByText('PKR 17,100')).toBeInTheDocument(); // collected
    expect(screen.getByText('PKR 1,350')).toBeInTheDocument(); // remaining
    // The orders tile, and the hint that splits it. Both from the day, not
    // from the single row served beside them.
    expect(screen.getAllByText('62').length).toBeGreaterThan(0);
    expect(screen.getByText(/57 paid · 5 unpaid/)).toBeInTheDocument();
  });

  it('lists the employee, the order, what it is and what it costs', async () => {
    serve({ deskOrders: [order({ canMarkPaid: true })] });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    expect(screen.getByText('1001')).toBeInTheDocument();
    expect(screen.getByText('LUNCH-2026-09-16-00042')).toBeInTheDocument();
    // Compact, one line: `4× Tandoori Roti · 2× Coke`. The desk reads sixty of
    // these standing up, so an order is written the way a receipt is, not the
    // way a sentence is.
    expect(screen.getAllByText('2× Chapati · 1× Chicken Karahi').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PKR 290').length).toBeGreaterThan(0);
  });

  it('writes a short order out in full, with nothing to expand', async () => {
    serve({ deskOrders: [order()] });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('2× Chapati · 1× Chicken Karahi');
    expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });

  it('counts off a long order rather than letting the row grow', async () => {
    serve({
      deskOrders: [
        order({
          items: [
            { id: 'l1', menuItemId: 'm1', itemName: 'Tandoori Roti', unitPrice: 20, quantity: 4, lineTotal: 80 },
            { id: 'l2', menuItemId: 'm2', itemName: '1/2 Ltr Coke', unitPrice: 80, quantity: 2, lineTotal: 160 },
            { id: 'l3', menuItemId: 'm3', itemName: 'Deal mash', unitPrice: 300, quantity: 2, lineTotal: 600 },
            { id: 'l4', menuItemId: 'm4', itemName: 'Chicken biryani', unitPrice: 350, quantity: 4, lineTotal: 1_400 },
            { id: 'l5', menuItemId: 'm5', itemName: 'Chicken pulao', unitPrice: 340, quantity: 4, lineTotal: 1_360 },
          ],
        }),
      ],
    });
    renderPage(<LunchCollectionPage />);

    // Four inline, the fifth counted - an exact number, not a guess at wrapping.
    await screen.findByText(
      '4× Tandoori Roti · 2× 1/2 Ltr Coke · 2× Deal mash · 4× Chicken biryani',
    );
    expect(screen.getByText('+ 1 more')).toBeInTheDocument();
  });

  it('keeps the whole order one click away', async () => {
    const user = userEvent.setup();
    serve({
      deskOrders: [
        order({
          items: [
            { id: 'l1', menuItemId: 'm1', itemName: 'Tandoori Roti', unitPrice: 20, quantity: 4, lineTotal: 80 },
            { id: 'l2', menuItemId: 'm2', itemName: '1/2 Ltr Coke', unitPrice: 80, quantity: 2, lineTotal: 160 },
            { id: 'l3', menuItemId: 'm3', itemName: 'Deal mash', unitPrice: 300, quantity: 2, lineTotal: 600 },
            { id: 'l4', menuItemId: 'm4', itemName: 'Chicken biryani', unitPrice: 350, quantity: 4, lineTotal: 1_400 },
            { id: 'l5', menuItemId: 'm5', itemName: 'Chicken pulao', unitPrice: 340, quantity: 4, lineTotal: 1_360 },
          ],
        }),
      ],
    });
    renderPage(<LunchCollectionPage />);

    await user.click(await screen.findByRole('button', { name: 'View all' }));

    // Nothing is truncated permanently: the item counted off the row is here,
    // with its own money beside it.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('4× Chicken pulao')).toBeInTheDocument();
    expect(within(dialog).getByText('4× Tandoori Roti')).toBeInTheDocument();
    expect(within(dialog).getByText('PKR 1,360')).toBeInTheDocument();
  });

  it('offers Mark paid only where the server says it may be marked', async () => {
    serve({
      deskOrders: [
        order({ id: 'order-1', canMarkPaid: true }),
        order({
          id: 'order-2',
          orderNumber: 'LUNCH-2026-09-16-00043',
          employeeName: 'Usman Ghani',
          paymentStatus: 'PAID',
          paymentMethod: 'CASH',
          canMarkPaid: false,
        }),
      ],
    });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    expect(screen.getAllByRole('button', { name: 'Mark paid' })).toHaveLength(1);
  });

  it('names the amount and the person before taking the money', async () => {
    const user = userEvent.setup();
    serve({ deskOrders: [order({ canMarkPaid: true })] });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    await user.click(screen.getByRole('button', { name: 'Mark paid' }));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Mark PKR 290 as paid by Ali Raza?'),
    ).toBeInTheDocument();
  });

  it('sends the method and nothing that could change the amount', async () => {
    const user = userEvent.setup();
    serve({ deskOrders: [order({ canMarkPaid: true })] });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    await user.click(screen.getByRole('button', { name: 'Mark paid' }));

    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Payment method'), 'BANK_TRANSFER');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm payment' }));

    const post = await waitFor(() => {
      const found = calls.find((call) => call.startsWith('POST') && call.includes('/pay'));
      expect(found).toBeTruthy();
      return found!;
    });

    expect(JSON.parse(post.slice(post.indexOf('{')))).toEqual({ paymentMethod: 'BANK_TRANSFER' });
  });

  it('offers no correction without the grant for it', async () => {
    serve({
      deskOrders: [
        order({ paymentStatus: 'PAID', paymentMethod: 'CASH', canMarkPaid: false, canCorrectPayment: false }),
      ],
    });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    expect(screen.queryByRole('button', { name: /correct/i })).not.toBeInTheDocument();
  });

  it('will not correct a payment without a reason', async () => {
    const user = userEvent.setup();
    serve({
      deskOrders: [
        order({ paymentStatus: 'PAID', paymentMethod: 'CASH', canMarkPaid: false, canCorrectPayment: true }),
      ],
    });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    await user.click(screen.getByRole('button', { name: /correct/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Mark unpaid' })).toBeDisabled();

    await user.type(
      within(dialog).getByLabelText(/why is this being corrected/i),
      'Marked the wrong Ali paid.',
    );
    expect(within(dialog).getByRole('button', { name: 'Mark unpaid' })).toBeEnabled();

    await user.click(within(dialog).getByRole('button', { name: 'Mark unpaid' }));

    const post = await waitFor(() => {
      const found = calls.find((call) => call.includes('/payment-correction'));
      expect(found).toBeTruthy();
      return found!;
    });

    expect(JSON.parse(post.slice(post.indexOf('{')))).toEqual({
      paymentStatus: 'UNPAID',
      reason: 'Marked the wrong Ali paid.',
    });
  });

  it('asks the server for one day, and sends the filters with it', async () => {
    const user = userEvent.setup();
    serve({ deskOrders: [order({ canMarkPaid: true })] });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    await user.selectOptions(screen.getByLabelText('Payment status'), 'UNPAID');

    await waitFor(() => {
      const last = calls.filter((call) => call.includes('/lunch/desk/orders?')).at(-1) ?? '';
      expect(last).toContain('paymentStatus=UNPAID');
    });
  });
});

// --- the operator's cancel ---------------------------------------------------

describe('cancelling somebody else\u2019s order', () => {
  beforeEach(() => {
    permissions = new Set(CANCELLER);
  });

  it('offers Cancel only where the server says it may be cancelled', async () => {
    serve({
      deskOrders: [
        order({ id: 'order-1', canOperatorCancel: true }),
        // Delivered: the food has been eaten, so there is nothing to call off.
        order({
          id: 'order-2',
          orderNumber: 'LUNCH-2026-09-16-00043',
          employeeName: 'Usman Ghani',
          status: 'DELIVERED',
          canOperatorCancel: false,
        }),
      ],
    });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    expect(screen.getAllByRole('button', { name: /^cancel$/i })).toHaveLength(1);
  });

  it('will not send a cancellation without a reason', async () => {
    const user = userEvent.setup();
    serve({ deskOrders: [order({ canOperatorCancel: true })] });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Cancel order' })).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/reason/i), 'Employee requested cancellation');
    expect(within(dialog).getByRole('button', { name: 'Cancel order' })).toBeEnabled();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    const post = await waitFor(() => {
      const found = calls.find((call) => call.includes('/lunch/desk/orders/') && call.includes('/cancel'));
      expect(found).toBeTruthy();
      return found!;
    });

    expect(JSON.parse(post.slice(post.indexOf('{')))).toEqual({
      reason: 'Employee requested cancellation',
    });
  });

  it('names the employee, the order and the amount before cancelling', async () => {
    const user = userEvent.setup();
    serve({ deskOrders: [order({ canOperatorCancel: true })] });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Ali Raza · LUNCH-2026-09-16-00042 · PKR 290'),
    ).toBeInTheDocument();
  });

  it('will not cancel a PAID order until the money is decided', async () => {
    const user = userEvent.setup();
    serve({
      deskOrders: [
        order({
          paymentStatus: 'PAID',
          paymentMethod: 'CASH',
          canOperatorCancel: true,
          canMarkPaid: false,
        }),
      ],
    });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('This order has already been paid.')).toBeInTheDocument();

    // A reason alone is not enough here, which is the difference from an
    // unpaid order.
    await user.type(within(dialog).getByLabelText(/reason/i), 'Employee went home.');
    expect(within(dialog).getByRole('button', { name: 'Cancel order' })).toBeDisabled();

    await user.click(within(dialog).getByRole('radio', { name: /Cancel \+ Refund/ }));
    expect(within(dialog).getByRole('button', { name: 'Cancel order' })).toBeEnabled();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    const post = await waitFor(() => {
      const found = calls.find((call) => call.includes('/lunch/desk/orders/') && call.includes('/cancel'));
      expect(found).toBeTruthy();
      return found!;
    });

    expect(JSON.parse(post.slice(post.indexOf('{')))).toEqual({
      reason: 'Employee went home.',
      resolution: 'REFUND',
    });
  });

  it('sends a retained payment as the decision it is', async () => {
    const user = userEvent.setup();
    serve({
      deskOrders: [
        order({ paymentStatus: 'PAID', paymentMethod: 'CASH', canOperatorCancel: true }),
      ],
    });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/reason/i), 'Food was already bought.');
    await user.click(within(dialog).getByRole('radio', { name: /Payment retained/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    const post = await waitFor(() => {
      const found = calls.find((call) => call.includes('/lunch/desk/orders/') && call.includes('/cancel'));
      expect(found).toBeTruthy();
      return found!;
    });

    expect(JSON.parse(post.slice(post.indexOf('{'))).resolution).toBe('RETAIN');
  });

  it('does not offer the money question on an unpaid order', async () => {
    const user = userEvent.setup();
    serve({ deskOrders: [order({ canOperatorCancel: true })] });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('This order has already been paid.')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
  });

  it('reports cancelled money apart from the active day', async () => {
    serve({ deskOrders: [order()] });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Cancelled paid orders');
    // Expected and collected are the ACTIVE day, and the retained money is
    // reported beside them rather than inside them.
    expect(screen.getByText('PKR 18,450')).toBeInTheDocument();
    expect(screen.getByText('PKR 17,100')).toBeInTheDocument();
    expect(screen.getByText(/Retained/)).toBeInTheDocument();
    // Collected 17,100 plus 290 retained is what should be in the box.
    expect(screen.getByText('PKR 17,390')).toBeInTheDocument();
  });

  it('leaves cancelled plates out of what the kitchen is told to make', async () => {
    serve({
      deskOrders: [order()],
      food: {
        day: '2026-09-16',
        totalOrders: 61,
        totalPlates: 91,
        items: [{ menuItemId: 'item-chapati', itemName: 'Chapati', quantity: 61, amount: 1_220 }],
      },
    });
    renderPage(<LunchCollectionPage />);

    // The heading is static; the figures arrive with the query, so wait on one
    // of them rather than on the card.
    await screen.findByText(/91 plates/);
    expect(screen.getByText('61')).toBeInTheDocument();
  });

  it('shows no Cancel button at all without the grant', async () => {
    permissions = new Set(OPERATOR);
    // The server would not set the flag for this caller; the screen draws from
    // the flag rather than from the permission, so the row simply has no
    // control.
    serve({ deskOrders: [order({ canOperatorCancel: false, canMarkPaid: true })] });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark paid' })).toBeInTheDocument();
  });

  it('moves an order along the round one step at a time', async () => {
    const user = userEvent.setup();
    permissions = new Set([PERMISSIONS.LUNCH_COLLECTION_READ, PERMISSIONS.LUNCH_ORDER_FULFIL]);
    serve({ deskOrders: [order({ canAdvance: true, nextStatus: 'PREPARING' })] });
    renderPage(<LunchCollectionPage />);

    await screen.findByText('Ali Raza');
    await user.click(screen.getByRole('button', { name: 'Preparing' }));

    const post = await waitFor(() => {
      const found = calls.find((call) => call.includes('/status'));
      expect(found).toBeTruthy();
      return found!;
    });

    expect(JSON.parse(post.slice(post.indexOf('{')))).toEqual({ status: 'PREPARING' });
  });
});

// --- what the employee is told -----------------------------------------------

describe('an employee whose order was cancelled', () => {
  it('is told who cancelled it and why', async () => {
    serve({
      todayOrders: [
        order({
          status: 'CANCELLED',
          cancelledAt: '2026-09-16T08:00:00.000Z',
          cancelledByName: 'Usman Ghani',
          cancellationReason: 'Employee requested cancellation',
          canCancel: false,
        }),
      ],
      outstanding: 0,
    });
    renderPage(<LunchPage />);

    await screen.findAllByText('2 Chapati + Chicken Karahi');
    expect(
      screen.getByText('Cancelled by Usman Ghani · Employee requested cancellation'),
    ).toBeInTheDocument();
  });

  it('still sees that it was paid for, and what became of the money', async () => {
    serve({
      todayOrders: [
        order({
          status: 'CANCELLED',
          cancelledAt: '2026-09-16T08:00:00.000Z',
          cancelledByName: 'Usman Ghani',
          cancellationReason: 'Employee requested cancellation',
          paymentStatus: 'PAID',
          paymentMethod: 'CASH',
          paidAt: '2026-09-16T07:45:00.000Z',
          refundStatus: 'REFUNDED',
          refundedAt: '2026-09-16T08:00:00.000Z',
          canCancel: false,
        }),
      ],
      outstanding: 0,
    });
    renderPage(<LunchPage />);

    await screen.findAllByText('2 Chapati + Chicken Karahi');
    // The payment is not dropped off the card because the lunch is not
    // happening - that is how somebody comes to believe they were never charged.
    expect(screen.getAllByText('Refunded').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
  });

  it('is told when the money was kept', async () => {
    serve({
      todayOrders: [
        order({
          status: 'CANCELLED',
          cancelledByName: 'Usman Ghani',
          cancellationReason: 'Food was already bought.',
          paymentStatus: 'PAID',
          paymentMethod: 'CASH',
          refundStatus: 'RETAINED',
          canCancel: false,
        }),
      ],
      outstanding: 0,
    });
    renderPage(<LunchPage />);

    await screen.findAllByText('2 Chapati + Chicken Karahi');
    expect(screen.getAllByText('Payment retained').length).toBeGreaterThan(0);
  });

  it('says so plainly when they cancelled it themselves', async () => {
    serve({
      todayOrders: [
        order({ status: 'CANCELLED', cancelledBySelf: true, cancelledByName: 'Ali Raza', canCancel: false }),
      ],
      outstanding: 0,
    });
    renderPage(<LunchPage />);

    await screen.findAllByText('2 Chapati + Chicken Karahi');
    expect(screen.getByText('Cancelled by you')).toBeInTheDocument();
  });
});

// ------------------------------------------------- lunch on the dashboard

/**
 * The dashboard's lunch card.
 *
 * Lunch is the one thing on an employee's dashboard that is useless once it is
 * late, and it had no presence there at all - an employee had to remember lunch
 * existed and go and find it in the sidebar. These pin the three states it can
 * be in and, just as importantly, that it stays SMALL in the state it is in
 * every morning: a quarter-screen box reading "you have not ordered lunch" is
 * the same mistake as burying it.
 */
describe('the lunch card on the dashboard', () => {
  it('invites an order when the employee has not placed one', async () => {
    serve({ todayOrders: [] });
    renderPage(<LunchTodayCard />);

    await screen.findByText('Not ordered');
    expect(screen.getByRole('link', { name: 'Order lunch' })).toHaveAttribute('href', '/lunch');
  });

  it('shows what was ordered, what it costs and what is still owed', async () => {
    serve({ todayOrders: [order()] });
    renderPage(<LunchTodayCard />);

    await screen.findByText('2× Chapati · 1× Chicken Karahi');
    expect(screen.getByText(/PKR 290/)).toBeInTheDocument();
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'View order' })).toBeInTheDocument();
  });

  it('says paid once the money has been handed over', async () => {
    serve({
      todayOrders: [order({ paymentStatus: 'PAID', paymentMethod: 'CASH' })],
      outstanding: 0,
    });
    renderPage(<LunchTodayCard />);

    await screen.findByText('2× Chapati · 1× Chicken Karahi');
    expect(screen.getByText('Paid')).toBeInTheDocument();
    // Nothing outstanding, so the card does not ask for money.
    expect(screen.queryByText(/to pay/)).not.toBeInTheDocument();
  });

  it('treats a cancelled order as no order, and offers to order again', async () => {
    serve({ todayOrders: [order({ status: 'CANCELLED' })], outstanding: 0 });
    renderPage(<LunchTodayCard />);

    // A lunch nobody is bringing is not lunch. The desk drops it from the day's
    // cooking and its collection, and this card agrees with the desk.
    await screen.findByText('Not ordered');
    expect(screen.getByRole('link', { name: 'Order lunch' })).toBeInTheDocument();
  });

  it('sums a second plate rather than showing only the first', async () => {
    serve({
      todayOrders: [
        order({ id: 'o1' }),
        order({ id: 'o2', orderNumber: 'LUNCH-2026-09-16-00043', totalAmount: 250 }),
      ],
      outstanding: 540,
    });
    renderPage(<LunchTodayCard />);

    await screen.findByText('2 orders · 6 items');
    expect(screen.getByText(/PKR 540/)).toBeInTheDocument();
  });

  it('is absent entirely for somebody who may not read their own orders', () => {
    permissions = new Set();
    serve();
    const { container } = renderPage(<LunchTodayCard />);

    expect(container).toBeEmptyDOMElement();
  });

  it('never offers to record a payment - that is the office boy\u2019s screen', async () => {
    serve({ todayOrders: [order()] });
    renderPage(<LunchTodayCard />);

    await screen.findByText('2× Chapati · 1× Chicken Karahi');
    expect(screen.queryByRole('button', { name: /mark paid/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/deduct/i)).not.toBeInTheDocument();
  });
});
