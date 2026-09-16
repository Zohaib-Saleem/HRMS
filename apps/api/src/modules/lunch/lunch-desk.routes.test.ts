import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PERMISSIONS,
  canOperatorCancelLunchOrder,
  formatLunchOrderNumber,
  summariseLunchCollection,
  summariseLunchFood,
  type DataScope,
  type Permission,
} from '@hrms/shared';

/**
 * Lunch, from the office boy's side.
 *
 * This is the half that touches money, and what is pinned here is the
 * arithmetic and the boundaries around it:
 *
 *   - the day's six figures. Expected, collected and remaining, over the
 *     orders that count - and CANCELLED orders count for nothing, in every one
 *     of them. An order nobody will eat is not a debt, and a "remaining" that
 *     included one sends somebody looking for money nobody owes at six o'clock;
 *   - marking paid records WHEN, WHO took it and HOW it arrived, together. The
 *     amount is the order's own total and is not in the request;
 *   - nobody marks their own lunch paid. The office boy holds the grant and
 *     also eats, so the rule is a comparison rather than a permission, and it
 *     is enforced at the endpoint rather than only on the button;
 *   - a correction is its own grant, needs a written reason, and is audited
 *     with both the before and the after - it is the one action that rewrites
 *     money already counted;
 *   - an employee with every employee grant reaches none of this.
 *
 * And one absence, asserted rather than assumed: nothing in this module writes
 * to payroll, to a salary, to a loan or to an approval. The office boy's screen
 * is the end of the process.
 */

const { table } = await import('../cases/case-store.test-kit.js');

const COMPANY = 'company-1';
const TIMEZONE = 'Asia/Karachi';
const NOW = new Date('2026-09-16T08:00:00.000Z');
const TODAY = '2026-09-16';
const TODAY_COLUMN = new Date(Date.UTC(2026, 8, 16));
const YESTERDAY_COLUMN = new Date(Date.UTC(2026, 8, 15));

/** The office boy, and two people who owe him for lunch. */
const BOY = { id: 'emp-boy', userId: 'user-boy' };
const ALI = { id: 'emp-ali', userId: 'user-ali' };
const AHMED = { id: 'emp-ahmed', userId: 'user-ahmed' };

const NAMES: Record<string, { firstName: string; lastName: string; employeeNumber: string }> = {
  [BOY.id]: { firstName: 'Usman', lastName: 'Ghani', employeeNumber: '1000' },
  [ALI.id]: { firstName: 'Ali', lastName: 'Raza', employeeNumber: '1001' },
  [AHMED.id]: { firstName: 'Ahmed', lastName: 'Khan', employeeNumber: '1002' },
};

const db = vi.hoisted(() => ({
  company: { findUnique: vi.fn() },
  employee: { findFirst: vi.fn() },
  lunchOrder: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  auditLog: { create: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { lunchDeskRoutes } = await import('./lunch-desk.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

/** What the person running the lunch round holds. */
const OPERATOR: Permission[] = [
  PERMISSIONS.LUNCH_COLLECTION_READ,
  PERMISSIONS.LUNCH_PAYMENT_MARK,
];

/** The operator's cancel, which is its own grant and arrives with neither of those. */
const CANCELLER: Permission[] = [
  PERMISSIONS.LUNCH_COLLECTION_READ,
  PERMISSIONS.LUNCH_ORDER_CANCEL_ANY,
];

/** Moving an order along the round: the kitchen's grant, not the cash box's. */
const KITCHEN: Permission[] = [
  PERMISSIONS.LUNCH_COLLECTION_READ,
  PERMISSIONS.LUNCH_ORDER_FULFIL,
];

/** Everything an ordinary member of staff holds. None of it opens this plugin. */
const EATER: Permission[] = [
  PERMISSIONS.LUNCH_ORDER_CREATE,
  PERMISSIONS.LUNCH_ORDER_READ_OWN,
  PERMISSIONS.LUNCH_ORDER_CANCEL_OWN,
];

async function appAs(
  permissions: Permission[] = OPERATOR,
  userId: string = BOY.userId,
  dataScope: DataScope = 'ALL',
): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId,
      companyId: COMPANY,
      email: 'someone@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(lunchDeskRoutes, { prefix: '/lunch/desk' });
  await app.ready();
  return app;
}

let orderTable: ReturnType<typeof table>;

let sequence = 0;

function orderRow(over: Record<string, unknown> = {}) {
  const employeeId = (over.employeeId as string) ?? ALI.id;
  sequence += 1;

  return {
    id: `order-${sequence}`,
    companyId: COMPANY,
    orderNumber: formatLunchOrderNumber(TODAY, sequence),
    employeeId,
    serviceDate: TODAY_COLUMN,
    status: 'ORDERED',
    totalAmount: 290,
    paymentStatus: 'UNPAID',
    paymentMethod: null,
    paidAt: null,
    paidByUserId: null,
    note: null,
    cancelledAt: null,
    cancelledByUserId: null,
    cancellationReason: null,
    refundStatus: 'NONE',
    refundedAt: null,
    refundedByUserId: null,
    refundReason: null,
    cancelledBy: null,
    refundedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    employee: { id: employeeId, displayName: null, ...NAMES[employeeId] },
    paidBy: null,
    items: [
      { id: `line-${sequence}`, menuItemId: 'item-karahi', itemName: 'Chicken Karahi', unitPrice: 250, quantity: 1, lineTotal: 250 },
      { id: `line-${sequence}b`, menuItemId: 'item-chapati', itemName: 'Chapati', unitPrice: 20, quantity: 2, lineTotal: 40 },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Date only; faking the whole timer set makes Fastify's inject hang.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  sequence = 0;

  orderTable = table([]);

  db.company.findUnique.mockResolvedValue({ timezone: TIMEZONE });
  db.employee.findFirst.mockImplementation(async (args: { where: { userId?: string } }) => {
    const found = [BOY, ALI, AHMED].find((person) => person.userId === args.where.userId);
    return found ? { id: found.id } : null;
  });

  db.lunchOrder.findFirst.mockImplementation((args) => orderTable.findFirst(args));
  db.lunchOrder.findMany.mockImplementation((args) => orderTable.findMany(args));
  db.lunchOrder.count.mockImplementation((args) => orderTable.count(args));
  db.lunchOrder.update.mockImplementation((args) => orderTable.update(args));
});

afterEach(() => {
  vi.useRealTimers();
});

// --- the day's collection ----------------------------------------------------

describe("today's collection", () => {
  it('adds up expected, collected and remaining over the day', async () => {
    orderTable.rows.push(
      orderRow({ totalAmount: 290, paymentStatus: 'PAID' }),
      orderRow({ totalAmount: 310, paymentStatus: 'PAID', employeeId: AHMED.id }),
      orderRow({ totalAmount: 250, paymentStatus: 'UNPAID' }),
    );

    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/lunch/desk/collection' });

    expect(response.json().data).toEqual({
      day: TODAY,
      totalOrders: 3,
      paidOrders: 2,
      unpaidOrders: 1,
      expectedCollection: 850,
      collectedAmount: 600,
      remainingAmount: 250,
      cancelledOrders: 0,
      cancelledUnpaidOrders: 0,
      cancelledUnpaidAmount: 0,
      cancelledPaidOrders: 0,
      cancelledPaidAmount: 0,
      refundedAmount: 0,
      retainedAmount: 0,
      cashInHand: 600,
    });
  });

  it('leaves cancelled orders out of every figure, not just the expected one', async () => {
    orderTable.rows.push(
      orderRow({ totalAmount: 290, paymentStatus: 'PAID' }),
      orderRow({ totalAmount: 250, paymentStatus: 'UNPAID' }),
      // Called off before anybody paid. It is not a debt and never was.
      orderRow({ totalAmount: 500, status: 'CANCELLED', cancelledAt: NOW }),
    );

    const app = await appAs();
    const summary = (await app.inject({ method: 'GET', url: '/lunch/desk/collection' })).json().data;

    expect(summary.totalOrders).toBe(2);
    expect(summary.cancelledOrders).toBe(1);
    expect(summary.expectedCollection).toBe(540);
    expect(summary.remainingAmount).toBe(250);
  });

  it('counts one day and not the one before it', async () => {
    orderTable.rows.push(
      orderRow({ totalAmount: 290, paymentStatus: 'UNPAID' }),
      orderRow({ totalAmount: 999, serviceDate: YESTERDAY_COLUMN, paymentStatus: 'UNPAID' }),
    );

    const app = await appAs();

    const today = (await app.inject({ method: 'GET', url: '/lunch/desk/collection' })).json().data;
    expect(today.expectedCollection).toBe(290);

    const yesterday = (
      await app.inject({ method: 'GET', url: '/lunch/desk/collection?day=2026-09-15' })
    ).json().data;
    expect(yesterday.day).toBe('2026-09-15');
    expect(yesterday.expectedCollection).toBe(999);
  });

  it('answers zeroes for a day nobody ordered on', async () => {
    const app = await appAs();
    const summary = (
      await app.inject({ method: 'GET', url: '/lunch/desk/collection?day=2026-09-14' })
    ).json().data;

    expect(summary).toEqual({
      day: '2026-09-14',
      totalOrders: 0,
      paidOrders: 0,
      unpaidOrders: 0,
      expectedCollection: 0,
      collectedAmount: 0,
      remainingAmount: 0,
      cancelledOrders: 0,
      cancelledUnpaidOrders: 0,
      cancelledUnpaidAmount: 0,
      cancelledPaidOrders: 0,
      cancelledPaidAmount: 0,
      refundedAmount: 0,
      retainedAmount: 0,
      cashInHand: 0,
    });
  });

  it('reads the day in the company’s zone, not the server’s', async () => {
    // 21:00 UTC is already the 17th in Karachi, so "today" has moved on.
    vi.setSystemTime(new Date('2026-09-16T21:00:00.000Z'));
    orderTable.rows.push(orderRow({ totalAmount: 290 }));

    const app = await appAs();
    const summary = (await app.inject({ method: 'GET', url: '/lunch/desk/collection' })).json().data;

    expect(summary.day).toBe('2026-09-17');
    expect(summary.totalOrders).toBe(0);
  });
});

// --- the day's list ----------------------------------------------------------

describe("the day's orders", () => {
  beforeEach(() => {
    orderTable.rows.push(
      orderRow({ employeeId: ALI.id }),
      orderRow({ employeeId: AHMED.id, paymentStatus: 'PAID', paymentMethod: 'CASH', paidAt: NOW, paidByUserId: BOY.userId }),
      orderRow({ employeeId: ALI.id, serviceDate: YESTERDAY_COLUMN }),
    );
  });

  it('lists one day, with the employee and what they ordered', async () => {
    const app = await appAs();
    const rows = (await app.inject({ method: 'GET', url: '/lunch/desk/orders' })).json().data;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      employeeName: 'Ali Raza',
      itemSummary: 'Chicken Karahi + 2 Chapati',
      totalAmount: 290,
      paymentStatus: 'UNPAID',
    });
    expect(rows[1]).toMatchObject({ paymentStatus: 'PAID', paymentMethod: 'CASH' });
  });

  it('filters to who has not paid, in the database', async () => {
    const app = await appAs();
    const rows = (
      await app.inject({ method: 'GET', url: '/lunch/desk/orders?paymentStatus=UNPAID' })
    ).json().data;

    expect(rows).toHaveLength(1);
    expect(rows[0].employeeName).toBe('Ali Raza');
  });

  it('finds an order by the name of whoever is standing there', async () => {
    const app = await appAs();
    const rows = (await app.inject({ method: 'GET', url: '/lunch/desk/orders?q=ahmed' })).json().data;

    expect(rows.map((row: { employeeName: string }) => row.employeeName)).toEqual(['Ahmed Khan']);
  });
});

// --- marking paid ------------------------------------------------------------

describe('marking an order paid', () => {
  it('records when, who took it and how it arrived', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/pay',
      payload: { paymentMethod: 'CASH' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ paymentStatus: 'PAID', paymentMethod: 'CASH' });

    const row = orderTable.rows[0] as Record<string, unknown>;
    expect(row.paymentStatus).toBe('PAID');
    expect(row.paymentMethod).toBe('CASH');
    expect(row.paidByUserId).toBe(BOY.userId);
    expect(row.paidAt).toBeInstanceOf(Date);
    // The amount is the order's own total. Nothing in the request touched it.
    expect(row.totalAmount).toBe(290);
  });

  it('takes no amount from the request', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id, totalAmount: 290 }));
    const app = await appAs();

    await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/pay',
      payload: { paymentMethod: 'CASH', amount: 10, totalAmount: 10 },
    });

    expect(orderTable.rows[0]).toMatchObject({ totalAmount: 290 });
  });

  it('defaults to cash, because that is what nearly always happens', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs();

    await app.inject({ method: 'POST', url: '/lunch/desk/orders/order-1/pay', payload: {} });

    expect(orderTable.rows[0]).toMatchObject({ paymentMethod: 'CASH' });
  });

  it('refuses to mark the same order paid twice', async () => {
    orderTable.rows.push(
      orderRow({ employeeId: ALI.id, paymentStatus: 'PAID', paymentMethod: 'CASH', paidAt: NOW }),
    );
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/pay',
      payload: { paymentMethod: 'CASH' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('already');
  });

  it('refuses to take money for a cancelled order', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id, status: 'CANCELLED', cancelledAt: NOW }));
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/pay',
      payload: { paymentMethod: 'CASH' },
    });

    expect(response.statusCode).toBe(409);
    expect(orderTable.rows[0]).toMatchObject({ paymentStatus: 'UNPAID' });
  });

  it('will not let the operator mark their OWN lunch paid', async () => {
    orderTable.rows.push(orderRow({ employeeId: BOY.id }));
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/pay',
      payload: { paymentMethod: 'CASH' },
    });

    expect(response.statusCode).toBe(403);
    expect(orderTable.rows[0]).toMatchObject({ paymentStatus: 'UNPAID' });
  });

  it('does not offer the button on the operator’s own order either', async () => {
    orderTable.rows.push(orderRow({ employeeId: BOY.id }), orderRow({ employeeId: ALI.id }));
    const app = await appAs();

    const rows = (await app.inject({ method: 'GET', url: '/lunch/desk/orders' })).json().data;
    expect(rows.find((row: { employeeId: string }) => row.employeeId === BOY.id).canMarkPaid).toBe(false);
    expect(rows.find((row: { employeeId: string }) => row.employeeId === ALI.id).canMarkPaid).toBe(true);
  });

  it('answers 404 for an order in another company', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id, companyId: 'company-2' }));
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/pay',
      payload: { paymentMethod: 'CASH' },
    });

    expect(response.statusCode).toBe(404);
  });
});

// --- correcting a payment ----------------------------------------------------

describe('correcting a payment', () => {
  const CORRECTOR: Permission[] = [
    PERMISSIONS.LUNCH_COLLECTION_READ,
    PERMISSIONS.LUNCH_PAYMENT_CORRECT,
  ];

  it('unmarks a payment and clears when, who and how together', async () => {
    orderTable.rows.push(
      orderRow({ employeeId: ALI.id, paymentStatus: 'PAID', paymentMethod: 'CASH', paidAt: NOW, paidByUserId: BOY.userId }),
    );
    const app = await appAs(CORRECTOR);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/payment-correction',
      payload: { paymentStatus: 'UNPAID', reason: 'Marked the wrong Ali paid.' },
    });

    expect(response.statusCode).toBe(200);
    expect(orderTable.rows[0]).toMatchObject({
      paymentStatus: 'UNPAID',
      paymentMethod: null,
      paidAt: null,
      paidByUserId: null,
    });
  });

  it('writes the reason, the before and the after into the audit trail', async () => {
    orderTable.rows.push(
      orderRow({ employeeId: ALI.id, paymentStatus: 'PAID', paymentMethod: 'CASH', paidAt: NOW, paidByUserId: BOY.userId }),
    );
    const app = await appAs(CORRECTOR);

    await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/payment-correction',
      payload: { paymentStatus: 'UNPAID', reason: 'Marked the wrong Ali paid.' },
    });

    const entry = db.auditLog.create.mock.calls.at(-1)?.[0].data;
    expect(entry).toMatchObject({
      action: 'lunch.payment.correct',
      entityType: 'LunchOrder',
      entityId: 'order-1',
    });
    expect(entry.summary).toContain('Marked the wrong Ali paid.');
    expect(entry.before).toMatchObject({ paymentStatus: 'PAID', paymentMethod: 'CASH' });
    expect(entry.after).toMatchObject({ paymentStatus: 'UNPAID', reason: 'Marked the wrong Ali paid.' });
  });

  it('needs a reason', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id, paymentStatus: 'PAID', paymentMethod: 'CASH' }));
    const app = await appAs(CORRECTOR);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/payment-correction',
      payload: { paymentStatus: 'UNPAID' },
    });

    expect(response.statusCode).toBe(422);
    expect(orderTable.rows[0]).toMatchObject({ paymentStatus: 'PAID' });
  });

  it('needs to know how the money arrived when it is being marked paid', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs(CORRECTOR);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/payment-correction',
      payload: { paymentStatus: 'PAID', reason: 'He did pay, I missed it.' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.paymentMethod).toBeTruthy();
  });

  it('is refused to somebody who can only mark orders paid', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id, paymentStatus: 'PAID', paymentMethod: 'CASH' }));
    const app = await appAs(OPERATOR);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/payment-correction',
      payload: { paymentStatus: 'UNPAID', reason: 'Wrong person.' },
    });

    expect(response.statusCode).toBe(403);
    expect(orderTable.rows[0]).toMatchObject({ paymentStatus: 'PAID' });
  });

  it('will not let somebody correct the payment on their own lunch', async () => {
    orderTable.rows.push(orderRow({ employeeId: BOY.id, paymentStatus: 'PAID', paymentMethod: 'CASH' }));
    const app = await appAs(CORRECTOR);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/payment-correction',
      payload: { paymentStatus: 'UNPAID', reason: 'I did not really pay.' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses to correct a cancelled order into being paid', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id, status: 'CANCELLED', cancelledAt: NOW }));
    const app = await appAs(CORRECTOR);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/payment-correction',
      payload: { paymentStatus: 'PAID', paymentMethod: 'CASH', reason: 'He paid anyway.' },
    });

    expect(response.statusCode).toBe(409);
    expect(orderTable.rows[0]).toMatchObject({ paymentStatus: 'UNPAID' });
  });

  it('will not use a correction to erase the payment on a cancelled order', async () => {
    // The other direction, and the more dangerous one: a cancelled order that
    // was paid for and whose money was RETAINED must not be walked back to
    // UNPAID here, because that erases the record of cash that really did
    // change hands. What happened to the money was decided at cancellation.
    orderTable.rows.push(
      orderRow({
        employeeId: ALI.id,
        status: 'CANCELLED',
        cancelledAt: NOW,
        paymentStatus: 'PAID',
        paymentMethod: 'CASH',
        paidAt: NOW,
        paidByUserId: BOY.userId,
        refundStatus: 'RETAINED',
      }),
    );
    const app = await appAs(CORRECTOR);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/payment-correction',
      payload: { paymentStatus: 'UNPAID', reason: 'Trying to undo it the other way.' },
    });

    expect(response.statusCode).toBe(409);
    expect(orderTable.rows[0]).toMatchObject({
      paymentStatus: 'PAID',
      paymentMethod: 'CASH',
      refundStatus: 'RETAINED',
    });
  });

  it('does not offer the correction on a cancelled order', async () => {
    orderTable.rows.push(
      orderRow({
        employeeId: ALI.id,
        status: 'CANCELLED',
        cancelledAt: NOW,
        paymentStatus: 'PAID',
        paymentMethod: 'CASH',
        refundStatus: 'RETAINED',
      }),
    );
    const app = await appAs(CORRECTOR);

    const [row] = (await app.inject({ method: 'GET', url: '/lunch/desk/orders' })).json().data;
    // The flag and the endpoint agree, which is the point of the flag.
    expect(row.canCorrectPayment).toBe(false);
  });

  it('refuses a correction that changes nothing', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs(CORRECTOR);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/payment-correction',
      payload: { paymentStatus: 'UNPAID', reason: 'Nothing to undo.' },
    });

    expect(response.statusCode).toBe(409);
  });
});

// --- who gets in -------------------------------------------------------------

describe('who reaches the desk at all', () => {
  it('refuses every route to somebody holding only the employee grants', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs(EATER, ALI.userId);

    for (const [method, url] of [
      ['GET', '/lunch/desk/collection'],
      ['GET', '/lunch/desk/orders'],
      ['POST', '/lunch/desk/orders/order-1/pay'],
      ['POST', '/lunch/desk/orders/order-1/payment-correction'],
    ] as const) {
      const response = await app.inject({ method, url, payload: { paymentMethod: 'CASH', paymentStatus: 'PAID', reason: 'x' } });
      expect(response.statusCode).toBe(403);
    }

    expect(orderTable.rows[0]).toMatchObject({ paymentStatus: 'UNPAID' });
  });

  it('lets an administrator read the figures without being able to write off a debt', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs([PERMISSIONS.LUNCH_COLLECTION_READ], AHMED.userId);

    expect((await app.inject({ method: 'GET', url: '/lunch/desk/collection' })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/lunch/desk/orders/order-1/pay',
          payload: { paymentMethod: 'CASH' },
        })
      ).statusCode,
    ).toBe(403);
  });
});

// --- the arithmetic itself ---------------------------------------------------

describe('the collection arithmetic', () => {
  it('is the office boy’s own sum, written once', () => {
    const summary = summariseLunchCollection(TODAY, [
      { status: 'DELIVERED', paymentStatus: 'PAID', refundStatus: 'NONE', totalAmount: 17_100 },
      { status: 'READY', paymentStatus: 'UNPAID', refundStatus: 'NONE', totalAmount: 1_350 },
      { status: 'CANCELLED', paymentStatus: 'UNPAID', refundStatus: 'NONE', totalAmount: 400 },
    ]);

    expect(summary).toEqual({
      day: TODAY,
      totalOrders: 2,
      paidOrders: 1,
      unpaidOrders: 1,
      expectedCollection: 18_450,
      collectedAmount: 17_100,
      remainingAmount: 1_350,
      cancelledOrders: 1,
      cancelledUnpaidOrders: 1,
      cancelledUnpaidAmount: 400,
      cancelledPaidOrders: 0,
      cancelledPaidAmount: 0,
      refundedAmount: 0,
      retainedAmount: 0,
      cashInHand: 17_100,
    });
  });

  it('keeps the three figures adding up to each other', () => {
    const summary = summariseLunchCollection(TODAY, [
      { status: 'ORDERED', paymentStatus: 'PAID', refundStatus: 'NONE', totalAmount: 33.33 },
      { status: 'ORDERED', paymentStatus: 'UNPAID', refundStatus: 'NONE', totalAmount: 33.33 },
      { status: 'ORDERED', paymentStatus: 'UNPAID', refundStatus: 'NONE', totalAmount: 33.34 },
    ]);

    expect(summary.expectedCollection).toBe(100);
    expect(summary.collectedAmount + summary.remainingAmount).toBe(summary.expectedCollection);
  });
});

// --- moving an order along ---------------------------------------------------

describe('the lunch round', () => {
  it('moves an order one step at a time', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs(KITCHEN);

    for (const status of ['PREPARING', 'READY', 'DELIVERED'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/lunch/desk/orders/order-1/status',
        payload: { status },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.status).toBe(status);
    }
  });

  it('refuses a skipped step', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs(KITCHEN);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/status',
      payload: { status: 'DELIVERED' },
    });

    expect(response.statusCode).toBe(409);
    expect(orderTable.rows[0]).toMatchObject({ status: 'ORDERED' });
  });

  it('refuses to walk an order backwards', async () => {
    // Which is what stops the delivered rule below being stepped around by
    // moving an order back to READY and cancelling it there.
    orderTable.rows.push(orderRow({ employeeId: ALI.id, status: 'DELIVERED' }));
    const app = await appAs(KITCHEN);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/status',
      payload: { status: 'READY' },
    });

    expect(response.statusCode).toBe(409);
    expect(orderTable.rows[0]).toMatchObject({ status: 'DELIVERED' });
  });

  it('will not cook a cancelled order', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id, status: 'CANCELLED', cancelledAt: NOW }));
    const app = await appAs(KITCHEN);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/status',
      payload: { status: 'PREPARING' },
    });

    expect(response.statusCode).toBe(409);
  });

  it('is refused to somebody who only collects the money', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs(OPERATOR);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/status',
      payload: { status: 'PREPARING' },
    });

    expect(response.statusCode).toBe(403);
  });
});

// --- the operator's cancel ---------------------------------------------------

describe('the operator cancelling an order', () => {
  it('cancels an unpaid order, recording who and why', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs(CANCELLER);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'Employee requested cancellation' },
    });

    expect(response.statusCode).toBe(200);

    const row = orderTable.rows[0] as Record<string, unknown>;
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelledByUserId).toBe(BOY.userId);
    expect(row.cancellationReason).toBe('Employee requested cancellation');
    expect(row.cancelledAt).toBeInstanceOf(Date);
    // Nothing was ever paid, so there is no decision to record.
    expect(row.paymentStatus).toBe('UNPAID');
    expect(row.refundStatus).toBe('NONE');
  });

  it('never deletes the order', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs(CANCELLER);

    await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'Employee requested cancellation' },
    });

    // Still there, still numbered, still carrying its lines.
    expect(orderTable.rows).toHaveLength(1);
    expect(orderTable.rows[0]).toMatchObject({
      orderNumber: formatLunchOrderNumber(TODAY, 1),
      totalAmount: 290,
    });
    expect((orderTable.rows[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('demands a reason', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs(CANCELLER);

    for (const payload of [{}, { reason: '' }, { reason: '  ' }, { reason: 'x' }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/lunch/desk/orders/order-1/cancel',
        payload,
      });
      expect(response.statusCode).toBe(422);
    }

    expect(orderTable.rows[0]).toMatchObject({ status: 'ORDERED' });
  });

  it('cancels an order that is already being prepared, and one that is ready', async () => {
    orderTable.rows.push(
      orderRow({ employeeId: ALI.id, status: 'PREPARING' }),
      orderRow({ employeeId: AHMED.id, status: 'READY' }),
    );
    const app = await appAs(CANCELLER);

    for (const id of ['order-1', 'order-2']) {
      const response = await app.inject({
        method: 'POST',
        url: `/lunch/desk/orders/${id}/cancel`,
        payload: { reason: 'Kitchen ran out.' },
      });
      expect(response.statusCode).toBe(200);
    }

    expect(orderTable.rows.every((row) => (row as { status: string }).status === 'CANCELLED')).toBe(true);
  });

  it('refuses to cancel an order that has been delivered', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id, status: 'DELIVERED' }));
    const app = await appAs(CANCELLER);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'He changed his mind.' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('delivered');
    expect(orderTable.rows[0]).toMatchObject({ status: 'DELIVERED' });
  });

  it('refuses to cancel the same order twice', async () => {
    orderTable.rows.push(
      orderRow({ employeeId: ALI.id, status: 'CANCELLED', cancelledAt: NOW, cancellationReason: 'The first reason' }),
    );
    const app = await appAs(CANCELLER);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'A second reason that must not overwrite the first.' },
    });

    expect(response.statusCode).toBe(409);
    expect(orderTable.rows[0]).toMatchObject({ cancellationReason: 'The first reason' });
  });
});

// --- a paid order, and where the money went ----------------------------------

describe('cancelling an order somebody has already paid for', () => {
  const paidOrder = () =>
    orderRow({
      employeeId: ALI.id,
      paymentStatus: 'PAID',
      paymentMethod: 'CASH',
      paidAt: NOW,
      paidByUserId: BOY.userId,
    });

  it('refuses to cancel it without a decision about the money', async () => {
    orderTable.rows.push(paidOrder());
    const app = await appAs(CANCELLER);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'Employee went home.' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.resolution[0]).toContain('already been paid');
    expect(orderTable.rows[0]).toMatchObject({ status: 'ORDERED', paymentStatus: 'PAID' });
  });

  it('records a refund without touching the payment record', async () => {
    orderTable.rows.push(paidOrder());
    const app = await appAs(CANCELLER);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: {
        reason: 'Employee requested cancellation',
        resolution: 'REFUND',
        refundReason: 'Gave him the 290 back from the box.',
      },
    });

    expect(response.statusCode).toBe(200);

    const row = orderTable.rows[0] as Record<string, unknown>;
    expect(row.status).toBe('CANCELLED');
    // The payment is NOT erased. That is the whole rule.
    expect(row.paymentStatus).toBe('PAID');
    expect(row.paymentMethod).toBe('CASH');
    expect(row.paidByUserId).toBe(BOY.userId);
    // And the refund is recorded beside it.
    expect(row.refundStatus).toBe('REFUNDED');
    expect(row.refundedAt).toBeInstanceOf(Date);
    expect(row.refundedByUserId).toBe(BOY.userId);
    expect(row.refundReason).toBe('Gave him the 290 back from the box.');
  });

  it('records a retained payment as the decision it was', async () => {
    orderTable.rows.push(paidOrder());
    const app = await appAs(CANCELLER);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'Food was already bought.', resolution: 'RETAIN' },
    });

    expect(response.statusCode).toBe(200);

    const row = orderTable.rows[0] as Record<string, unknown>;
    expect(row.status).toBe('CANCELLED');
    expect(row.paymentStatus).toBe('PAID');
    expect(row.refundStatus).toBe('RETAINED');
    // Nothing went back, so there is no refund instant and nobody recorded one.
    expect(row.refundedAt).toBeNull();
    expect(row.refundedByUserId).toBeNull();
    expect(row.cancelledByUserId).toBe(BOY.userId);
    expect(row.cancellationReason).toBe('Food was already bought.');
  });

  it('writes the whole financial story into one audit entry', async () => {
    orderTable.rows.push(paidOrder());
    const app = await appAs(CANCELLER);

    await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'Employee requested cancellation', resolution: 'RETAIN' },
    });

    const entry = db.auditLog.create.mock.calls.at(-1)?.[0].data;
    expect(entry).toMatchObject({
      action: 'lunch.order.cancel.operator',
      entityType: 'LunchOrder',
      entityId: 'order-1',
      actorId: BOY.userId,
    });
    expect(entry.before).toMatchObject({ status: 'ORDERED', paymentStatus: 'PAID', refundStatus: 'NONE' });
    expect(entry.after).toMatchObject({
      orderId: 'order-1',
      employeeId: ALI.id,
      status: 'CANCELLED',
      paymentStatus: 'PAID',
      refundStatus: 'RETAINED',
      amount: 290,
      resolution: 'RETAIN',
      cancellationReason: 'Employee requested cancellation',
      cancelledByUserId: BOY.userId,
    });
    expect(entry.after.cancelledAt).toBeTruthy();
  });
});

// --- what a cancellation does to the day's figures ---------------------------

describe('a cancelled order and the day', () => {
  it('leaves the expected collection the moment it is cancelled', async () => {
    orderTable.rows.push(
      orderRow({ employeeId: ALI.id, totalAmount: 290 }),
      orderRow({ employeeId: AHMED.id, totalAmount: 310 }),
    );
    const app = await appAs(CANCELLER);

    const before = (await app.inject({ method: 'GET', url: '/lunch/desk/collection' })).json().data;
    expect(before.expectedCollection).toBe(600);
    expect(before.remainingAmount).toBe(600);

    await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'Employee went home.' },
    });

    const after = (await app.inject({ method: 'GET', url: '/lunch/desk/collection' })).json().data;
    expect(after.expectedCollection).toBe(310);
    expect(after.remainingAmount).toBe(310);
    expect(after.totalOrders).toBe(1);
    // And it is not thrown away: it shows up in the cancelled figures.
    expect(after.cancelledOrders).toBe(1);
    expect(after.cancelledUnpaidOrders).toBe(1);
    expect(after.cancelledUnpaidAmount).toBe(290);
  });

  it('keeps a cancelled PAID order visible for reconciliation', async () => {
    orderTable.rows.push(
      // Live and paid: ordinary collected money.
      orderRow({ employeeId: AHMED.id, totalAmount: 310, paymentStatus: 'PAID', paymentMethod: 'CASH' }),
      // Cancelled, paid, money kept: still in the box, not in `collected`.
      orderRow({
        employeeId: ALI.id,
        totalAmount: 290,
        status: 'CANCELLED',
        cancelledAt: NOW,
        paymentStatus: 'PAID',
        paymentMethod: 'CASH',
        refundStatus: 'RETAINED',
      }),
      // Cancelled, paid, money returned: gone from the box entirely.
      orderRow({
        employeeId: ALI.id,
        totalAmount: 250,
        status: 'CANCELLED',
        cancelledAt: NOW,
        paymentStatus: 'PAID',
        paymentMethod: 'CASH',
        refundStatus: 'REFUNDED',
        refundedAt: NOW,
      }),
    );

    const app = await appAs(CANCELLER);
    const summary = (await app.inject({ method: 'GET', url: '/lunch/desk/collection' })).json().data;

    // The active day is untouched by either cancellation.
    expect(summary.totalOrders).toBe(1);
    expect(summary.expectedCollection).toBe(310);
    expect(summary.collectedAmount).toBe(310);
    expect(summary.remainingAmount).toBe(0);

    // And the cancelled money is reported apart from it, split by what happened.
    expect(summary.cancelledPaidOrders).toBe(2);
    expect(summary.cancelledPaidAmount).toBe(540);
    expect(summary.retainedAmount).toBe(290);
    expect(summary.refundedAmount).toBe(250);

    // What should actually be in the box: 310 collected plus 290 kept.
    expect(summary.cashInHand).toBe(600);
  });

  it('takes its plates out of the kitchen count immediately', async () => {
    orderTable.rows.push(
      orderRow({ employeeId: ALI.id }),
      orderRow({ employeeId: AHMED.id }),
    );
    const app = await appAs(CANCELLER);

    const before = (await app.inject({ method: 'GET', url: '/lunch/desk/food' })).json().data;
    expect(before.totalOrders).toBe(2);
    expect(before.totalPlates).toBe(6); // two orders of 1 karahi + 2 chapati
    expect(before.items).toEqual([
      { menuItemId: 'item-chapati', itemName: 'Chapati', quantity: 4, amount: 80 },
      { menuItemId: 'item-karahi', itemName: 'Chicken Karahi', quantity: 2, amount: 500 },
    ]);

    await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'Employee went home.' },
    });

    const after = (await app.inject({ method: 'GET', url: '/lunch/desk/food' })).json().data;
    expect(after.totalOrders).toBe(1);
    expect(after.totalPlates).toBe(3);
    expect(after.items).toEqual([
      { menuItemId: 'item-chapati', itemName: 'Chapati', quantity: 2, amount: 40 },
      { menuItemId: 'item-karahi', itemName: 'Chicken Karahi', quantity: 1, amount: 250 },
    ]);
  });

  it('takes the plates out even when the payment was retained', async () => {
    orderTable.rows.push(
      orderRow({ employeeId: ALI.id, paymentStatus: 'PAID', paymentMethod: 'CASH', paidAt: NOW }),
    );
    const app = await appAs(CANCELLER);

    await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'Employee went home.', resolution: 'RETAIN' },
    });

    const food = (await app.inject({ method: 'GET', url: '/lunch/desk/food' })).json().data;
    expect(food.totalPlates).toBe(0);
    expect(food.items).toEqual([]);
    // Keeping the cash is a decision about the box, not an instruction to cook.
    const summary = (await app.inject({ method: 'GET', url: '/lunch/desk/collection' })).json().data;
    expect(summary.retainedAmount).toBe(290);
  });
});

// --- who may cancel ----------------------------------------------------------

describe('who may cancel somebody else’s lunch', () => {
  it('is refused to an employee holding every employee grant', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs(EATER, ALI.userId);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'I changed my mind.' },
    });

    expect(response.statusCode).toBe(403);
    expect(orderTable.rows[0]).toMatchObject({ status: 'ORDERED' });
  });

  it('is refused to an operator who can only take money', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs(OPERATOR);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'Employee went home.' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('is refused to somebody who can only read the collection', async () => {
    orderTable.rows.push(orderRow({ employeeId: ALI.id }));
    const app = await appAs([PERMISSIONS.LUNCH_COLLECTION_READ], AHMED.userId);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'Employee went home.' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('answers 404 for an order in another company, whatever the grants', async () => {
    // The IDOR case: a real id, a real grant, and the wrong tenant. The company
    // clause is in the WHERE rather than checked after the read, so this cannot
    // be reached by guessing an id.
    orderTable.rows.push(orderRow({ employeeId: ALI.id, companyId: 'company-2' }));
    const app = await appAs(CANCELLER);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-1/cancel',
      payload: { reason: 'Trying my luck.' },
    });

    expect(response.statusCode).toBe(404);
    expect(orderTable.rows[0]).toMatchObject({ status: 'ORDERED' });
  });

  it('answers 404 for an id that is not an order at all', async () => {
    const app = await appAs(CANCELLER);

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/desk/orders/order-invented/cancel',
      payload: { reason: 'Trying my luck.' },
    });

    expect(response.statusCode).toBe(404);
  });
});

// --- the shared rules --------------------------------------------------------

describe('the cancellation rules themselves', () => {
  it('stops at the point the food is handed over', () => {
    expect(canOperatorCancelLunchOrder('ORDERED')).toBe(true);
    expect(canOperatorCancelLunchOrder('PREPARING')).toBe(true);
    expect(canOperatorCancelLunchOrder('READY')).toBe(true);
    expect(canOperatorCancelLunchOrder('DELIVERED')).toBe(false);
    expect(canOperatorCancelLunchOrder('CANCELLED')).toBe(false);
  });

  it('counts a cancelled paid order as retained until somebody says otherwise', () => {
    // A refund nobody recorded is not a refund. Assuming one is how a report
    // tells an office boy he is short when the money is in his hand.
    const summary = summariseLunchCollection(TODAY, [
      { status: 'CANCELLED', paymentStatus: 'PAID', refundStatus: 'NONE', totalAmount: 290 },
    ]);

    expect(summary.retainedAmount).toBe(290);
    expect(summary.refundedAmount).toBe(0);
    expect(summary.cashInHand).toBe(290);
    expect(summary.expectedCollection).toBe(0);
  });

  it('leaves cancelled plates out of the kitchen, whatever the money did', () => {
    const food = summariseLunchFood(TODAY, [
      { status: 'DELIVERED', items: [{ menuItemId: 'a', itemName: 'Biryani', quantity: 2, lineTotal: 560 }] },
      { status: 'CANCELLED', items: [{ menuItemId: 'a', itemName: 'Biryani', quantity: 5, lineTotal: 1400 }] },
    ]);

    expect(food.totalPlates).toBe(2);
    expect(food.items).toEqual([
      { menuItemId: 'a', itemName: 'Biryani', quantity: 2, amount: 560 },
    ]);
  });
});
