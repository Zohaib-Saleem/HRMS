import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PERMISSIONS,
  canEmployeeCancelLunchOrder,
  formatLunchOrderNumber,
  lunchItemSummary,
  lunchOrderTotal,
  parseLunchOrderNumberSequence,
  type DataScope,
  type Permission,
} from '@hrms/shared';

/**
 * Lunch, from the employee's side.
 *
 * An employee gets three things here - order, look, cancel - and the claims
 * worth pinning are the ones no screen can enforce:
 *
 *   - the ORDER IS PRICED BY THE SERVER. The body carries ids and quantities
 *     and nothing else counts; a request that also carries a total, a price, a
 *     payment status or a payment method changes none of them. This is the
 *     rule "an employee cannot change the payment amount", and these tests
 *     send exactly those hostile bodies;
 *   - an order is placed FOR the caller. There is no employee id in the
 *     payload, and adding one does nothing;
 *   - one employee cannot read or cancel another's order, with a valid id. A
 *     guessed id answers 404, not 403 - a 403 would confirm the id exists;
 *   - a PAID order is out of the employee's hands entirely. Cancelling it is
 *     refused, and there is no endpoint on this plugin that could pay it;
 *   - the three permissions are three permissions. Reading your orders does not
 *     let you place one, and placing one does not let you cancel it.
 *
 * The Prisma stand-in evaluates the route's real `where` against real rows (see
 * `case-store.test-kit`, which models query semantics rather than one module),
 * so a route that dropped the employee id would fail these rather than passing
 * them with a wider query.
 */

const { table } = await import('../cases/case-store.test-kit.js');

const COMPANY = 'company-1';
const TIMEZONE = 'Asia/Karachi';

/** 13:00 in Karachi on the 16th, which is 08:00 UTC. */
const NOW = new Date('2026-09-16T08:00:00.000Z');
const TODAY = '2026-09-16';
const TODAY_COLUMN = new Date(Date.UTC(2026, 8, 16));

/** Two employees in one company. Everything below is about the gap between them. */
const ME = { id: 'emp-me', userId: 'user-me' };
const COLLEAGUE = { id: 'emp-colleague', userId: 'user-colleague' };

const MENU = [
  { id: 'item-chapati', companyId: COMPANY, name: 'Chapati', description: null, price: 20, sortOrder: 0, isActive: true, createdAt: NOW, updatedAt: NOW },
  { id: 'item-karahi', companyId: COMPANY, name: 'Chicken Karahi', description: null, price: 250, sortOrder: 1, isActive: true, createdAt: NOW, updatedAt: NOW },
  { id: 'item-biryani', companyId: COMPANY, name: 'Biryani', description: null, price: 280, sortOrder: 2, isActive: true, createdAt: NOW, updatedAt: NOW },
  // Taken off the menu. It must not be orderable, and must not be on the form.
  { id: 'item-nihari', companyId: COMPANY, name: 'Nihari', description: null, price: 300, sortOrder: 3, isActive: false, createdAt: NOW, updatedAt: NOW },
];

const db = vi.hoisted(() => ({
  company: { findUnique: vi.fn() },
  employee: { findFirst: vi.fn() },
  lunchMenuItem: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
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

const { lunchOrderRoutes } = await import('./lunch-orders.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

/** What every system role holds for lunch: their own, and only their own. */
const EATER: Permission[] = [
  PERMISSIONS.LUNCH_ORDER_CREATE,
  PERMISSIONS.LUNCH_ORDER_READ_OWN,
  PERMISSIONS.LUNCH_ORDER_CANCEL_OWN,
];

async function appAs(
  permissions: Permission[] = EATER,
  userId: string = ME.userId,
  dataScope: DataScope = 'OWN',
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
  await app.register(lunchOrderRoutes, { prefix: '/lunch' });
  await app.ready();
  return app;
}

// --- the world the routes see ------------------------------------------------

const employeeRow = (id: string) => ({
  id,
  firstName: id === ME.id ? 'Ali' : 'Ahmed',
  lastName: id === ME.id ? 'Raza' : 'Khan',
  displayName: null,
  employeeNumber: id === ME.id ? '1001' : '1002',
});

let orderTable: ReturnType<typeof table>;
let itemTable: ReturnType<typeof table>;

/** One order row, shaped the way `LUNCH_ORDER_INCLUDE` returns it. */
function orderRow(over: Record<string, unknown> = {}) {
  const employeeId = (over.employeeId as string) ?? ME.id;
  const items = (over.items as Array<Record<string, unknown>>) ?? [
    { id: 'line-1', menuItemId: 'item-karahi', itemName: 'Chicken Karahi', unitPrice: 250, quantity: 1, lineTotal: 250 },
    { id: 'line-2', menuItemId: 'item-chapati', itemName: 'Chapati', unitPrice: 20, quantity: 2, lineTotal: 40 },
  ];

  return {
    id: 'order-1',
    companyId: COMPANY,
    orderNumber: formatLunchOrderNumber(TODAY, 42),
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
    createdAt: NOW,
    updatedAt: NOW,
    employee: employeeRow(employeeId),
    paidBy: null,
    cancelledBy: null,
    refundedBy: null,
    ...over,
    items,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  /*
   * Only `Date` is faked. Fastify's own inject path uses real timers, and
   * replacing those as well makes every request in this file hang - so the
   * clock moves and the calendar does not.
   */
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);

  orderTable = table([]);
  itemTable = table([]);

  db.company.findUnique.mockResolvedValue({ timezone: TIMEZONE });

  db.employee.findFirst.mockImplementation(async (args: { where: { userId?: string } }) => {
    const userId = args.where.userId;
    if (userId === ME.userId) return { id: ME.id };
    if (userId === COLLEAGUE.userId) return { id: COLLEAGUE.id };
    // A login with no employee record behind it.
    return null;
  });

  db.lunchMenuItem.findMany.mockImplementation(async (args: { where?: Record<string, unknown> }) =>
    table(MENU).findMany(args),
  );

  db.lunchOrder.findFirst.mockImplementation((args) => orderTable.findFirst(args));
  db.lunchOrder.findMany.mockImplementation((args) => orderTable.findMany(args));
  db.lunchOrder.count.mockImplementation((args) => orderTable.count(args));
  db.lunchOrder.update.mockImplementation((args) => orderTable.update(args));

  /*
   * The order and its lines arrive as one nested create, because an order row
   * with no lines is an order for nothing at a price somebody owes. The
   * stand-in splits them back out so the lines can be asserted on as rows.
   */
  db.lunchOrder.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    const { items, ...rest } = args.data as { items?: { create: Array<Record<string, unknown>> } };
    const created = await orderTable.create({ data: { ...rest, updatedAt: NOW } });
    const lines = (items?.create ?? []).map((line, index) => ({
      id: `line-${itemTable.rows.length + index + 1}`,
      orderId: created.id,
      ...line,
    }));
    itemTable.rows.push(...lines);

    return {
      ...created,
      employee: employeeRow((created as Record<string, unknown>).employeeId as string),
      paidBy: null,
      items: lines,
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// --- placing an order --------------------------------------------------------

describe('placing an order', () => {
  it('prices the order from the menu, ignoring anything the body claims', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/orders',
      payload: {
        items: [
          { menuItemId: 'item-karahi', quantity: 1 },
          { menuItemId: 'item-chapati', quantity: 2 },
        ],
        // Everything below is hostile and everything below is ignored: the
        // price, the total, whose order it is and whether it is paid for.
        totalAmount: 1,
        price: 1,
        employeeId: COLLEAGUE.id,
        paymentStatus: 'PAID',
        paymentMethod: 'CASH',
        paidAt: NOW.toISOString(),
      },
    });

    expect(response.statusCode).toBe(201);
    const order = response.json().data;

    // 250 + (20 x 2), from the menu rows and from nothing else.
    expect(order.totalAmount).toBe(290);
    expect(order.employeeId).toBe(ME.id);
    expect(order.paymentStatus).toBe('UNPAID');
    expect(order.paymentMethod).toBeNull();
    expect(order.paidAt).toBeNull();
    expect(order.paidByName).toBeNull();

    const written = orderTable.rows[0] as Record<string, unknown>;
    expect(written.totalAmount).toBe(290);
    expect(written.employeeId).toBe(ME.id);
    // Written as UNPAID at the call site, never inferred from a default.
    expect(written.paymentStatus).toBe('UNPAID');
    expect(written.status).toBe('ORDERED');
  });

  it('writes one line per item, at the price it was ordered at', async () => {
    const app = await appAs();

    await app.inject({
      method: 'POST',
      url: '/lunch/orders',
      payload: { items: [{ menuItemId: 'item-chapati', quantity: 2 }] },
    });

    expect(itemTable.rows).toHaveLength(1);
    expect(itemTable.rows[0]).toMatchObject({
      itemName: 'Chapati',
      unitPrice: 20,
      quantity: 2,
      lineTotal: 40,
    });
  });

  it('numbers the order for the day, from the highest issued today', async () => {
    orderTable.rows.push(
      orderRow({ id: 'order-a', orderNumber: formatLunchOrderNumber(TODAY, 1) }),
      orderRow({ id: 'order-b', orderNumber: formatLunchOrderNumber(TODAY, 7) }),
      // Yesterday's highest must not move today's sequence on.
      orderRow({ id: 'order-c', orderNumber: formatLunchOrderNumber('2026-09-15', 99) }),
    );

    const app = await appAs();
    const response = await app.inject({
      method: 'POST',
      url: '/lunch/orders',
      payload: { items: [{ menuItemId: 'item-biryani', quantity: 1 }] },
    });

    expect(response.json().data.orderNumber).toBe('LUNCH-2026-09-16-00008');
  });

  it('files the order under the company’s today, not the server’s', async () => {
    // 21:00 UTC on the 16th is already 02:00 on the 17th in Karachi.
    vi.setSystemTime(new Date('2026-09-16T21:00:00.000Z'));

    const app = await appAs();
    const response = await app.inject({
      method: 'POST',
      url: '/lunch/orders',
      payload: { items: [{ menuItemId: 'item-biryani', quantity: 1 }] },
    });

    expect(response.json().data.day).toBe('2026-09-17');
  });

  it('refuses an item that has been taken off the menu', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/orders',
      payload: { items: [{ menuItemId: 'item-nihari', quantity: 1 }] },
    });

    expect(response.statusCode).toBe(422);
    expect(orderTable.rows).toHaveLength(0);
  });

  it('refuses an item that belongs to no menu at all', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/orders',
      payload: { items: [{ menuItemId: 'item-invented', quantity: 1 }] },
    });

    expect(response.statusCode).toBe(422);
    expect(orderTable.rows).toHaveLength(0);
  });

  it('refuses the same item twice rather than merging the lines', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/orders',
      payload: {
        items: [
          { menuItemId: 'item-chapati', quantity: 1 },
          { menuItemId: 'item-chapati', quantity: 1 },
        ],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.items[0]).toContain('twice');
  });

  it('refuses an empty order', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'POST', url: '/lunch/orders', payload: { items: [] } });
    expect(response.statusCode).toBe(422);
  });

  it('tells a login with no employee record why it cannot order', async () => {
    const app = await appAs(EATER, 'user-nobody');

    const response = await app.inject({
      method: 'POST',
      url: '/lunch/orders',
      payload: { items: [{ menuItemId: 'item-chapati', quantity: 1 }] },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.items[0]).toContain('employee record');
  });
});

// --- reading -----------------------------------------------------------------

describe('reading your own orders', () => {
  beforeEach(() => {
    orderTable.rows.push(
      orderRow({ id: 'mine-1' }),
      orderRow({ id: 'mine-2', orderNumber: formatLunchOrderNumber(TODAY, 43), paymentStatus: 'PAID', paymentMethod: 'CASH', paidAt: NOW, paidByUserId: 'user-boy' }),
      orderRow({ id: 'theirs', employeeId: COLLEAGUE.id, orderNumber: formatLunchOrderNumber(TODAY, 44) }),
    );
  });

  it('returns the caller’s own orders and nobody else’s', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/lunch/orders' });

    const ids = response.json().data.map((row: { id: string }) => row.id);
    expect(ids).toEqual(expect.arrayContaining(['mine-1', 'mine-2']));
    expect(ids).not.toContain('theirs');
  });

  it('shows today’s lunch with what is still owed for it', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/lunch/today' });

    const view = response.json().data;
    expect(view.day).toBe(TODAY);
    expect(view.orders.map((row: { id: string }) => row.id)).toEqual(['mine-1', 'mine-2']);
    // The paid one is not outstanding; the unpaid one is.
    expect(view.outstandingAmount).toBe(290);
    expect(view.canOrder).toBe(true);
  });

  it('leaves a paid order with nothing the employee can do to it', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/lunch/today' });

    const [unpaid, paid] = response.json().data.orders;
    expect(unpaid.canCancel).toBe(true);
    expect(paid.canCancel).toBe(false);
    // And neither is ever theirs to take money for.
    expect(unpaid.canMarkPaid).toBe(false);
    expect(paid.canMarkPaid).toBe(false);
  });

  it('answers an empty day for a login with no employee record', async () => {
    const app = await appAs(EATER, 'user-nobody');
    const response = await app.inject({ method: 'GET', url: '/lunch/today' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ orders: [], outstandingAmount: 0, canOrder: false });
  });

  it('offers only what is actually on the menu', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/lunch/menu' });

    const names = response.json().data.map((row: { name: string }) => row.name);
    expect(names).toEqual(['Chapati', 'Chicken Karahi', 'Biryani']);
    expect(names).not.toContain('Nihari');
  });

  it('filters by payment status in the database, not in the browser', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/lunch/orders?paymentStatus=PAID' });

    expect(response.json().data.map((row: { id: string }) => row.id)).toEqual(['mine-2']);
  });
});

// --- cancelling --------------------------------------------------------------

describe('cancelling your own order', () => {
  it('cancels an unpaid order and takes it out of the day', async () => {
    orderTable.rows.push(orderRow({ id: 'order-1' }));
    const app = await appAs();

    const response = await app.inject({ method: 'POST', url: '/lunch/orders/order-1/cancel', payload: {} });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('CANCELLED');
    expect(orderTable.rows[0]).toMatchObject({ status: 'CANCELLED' });
    expect((orderTable.rows[0] as { cancelledAt: Date }).cancelledAt).toBeInstanceOf(Date);
  });

  it('refuses to cancel an order that has been paid for', async () => {
    orderTable.rows.push(
      orderRow({ id: 'order-1', paymentStatus: 'PAID', paymentMethod: 'CASH', paidAt: NOW }),
    );
    const app = await appAs();

    const response = await app.inject({ method: 'POST', url: '/lunch/orders/order-1/cancel', payload: {} });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('paid');
    expect(orderTable.rows[0]).toMatchObject({ status: 'ORDERED' });
  });

  it('refuses to cancel the same order twice', async () => {
    orderTable.rows.push(orderRow({ id: 'order-1', status: 'CANCELLED', cancelledAt: NOW }));
    const app = await appAs();

    const response = await app.inject({ method: 'POST', url: '/lunch/orders/order-1/cancel', payload: {} });
    expect(response.statusCode).toBe(409);
  });

  it('answers 404 - not 403 - for somebody else’s order', async () => {
    orderTable.rows.push(orderRow({ id: 'order-1', employeeId: COLLEAGUE.id }));
    const app = await appAs();

    const response = await app.inject({ method: 'POST', url: '/lunch/orders/order-1/cancel', payload: {} });

    expect(response.statusCode).toBe(404);
    expect(orderTable.rows[0]).toMatchObject({ status: 'ORDERED' });
  });
});

// --- what the employee is told about a cancellation --------------------------

describe('an order the operator cancelled', () => {
  const OPERATOR_USER = { id: 'user-boy', email: 'usman@example.com' };

  const cancelledByOperator = (over: Record<string, unknown> = {}) =>
    orderRow({
      id: 'order-1',
      status: 'CANCELLED',
      cancelledAt: NOW,
      cancelledByUserId: OPERATOR_USER.id,
      cancellationReason: 'Employee requested cancellation',
      cancelledBy: {
        id: OPERATOR_USER.id,
        email: OPERATOR_USER.email,
        employee: { firstName: 'Usman', lastName: 'Ghani', displayName: null },
      },
      ...over,
    });

  it('tells the employee it was cancelled, by whom, and why', async () => {
    orderTable.rows.push(cancelledByOperator());
    const app = await appAs();

    const [order] = (await app.inject({ method: 'GET', url: '/lunch/today' })).json().data.orders;

    expect(order.status).toBe('CANCELLED');
    expect(order.cancelledByName).toBe('Usman Ghani');
    expect(order.cancelledBySelf).toBe(false);
    expect(order.cancellationReason).toBe('Employee requested cancellation');
  });

  it('shows the refund decision on an order that had been paid for', async () => {
    orderTable.rows.push(
      cancelledByOperator({
        paymentStatus: 'PAID',
        paymentMethod: 'CASH',
        paidAt: NOW,
        refundStatus: 'REFUNDED',
        refundedAt: NOW,
        refundReason: 'Gave him the 290 back from the box.',
      }),
    );
    const app = await appAs();

    const [order] = (await app.inject({ method: 'GET', url: '/lunch/today' })).json().data.orders;

    // The payment record survives the cancellation, which is the point of it.
    expect(order.paymentStatus).toBe('PAID');
    expect(order.refundStatus).toBe('REFUNDED');
    expect(order.refundedAt).toBeTruthy();
    // But the operator's own working on the money is not theirs to read. It is
    // ABSENT from the response rather than hidden by the screen.
    expect(order.refundReason).toBeNull();
  });

  it('says so when the employee cancelled it themselves', async () => {
    orderTable.rows.push(
      orderRow({
        id: 'order-1',
        status: 'CANCELLED',
        cancelledAt: NOW,
        cancelledByUserId: ME.userId,
        cancellationReason: null,
        cancelledBy: {
          id: ME.userId,
          email: 'ali@example.com',
          employee: { firstName: 'Ali', lastName: 'Raza', displayName: null },
        },
      }),
    );
    const app = await appAs();

    const [order] = (await app.inject({ method: 'GET', url: '/lunch/today' })).json().data.orders;
    expect(order.cancelledBySelf).toBe(true);
  });

  it('leaves a cancelled order outstanding to nobody', async () => {
    orderTable.rows.push(cancelledByOperator());
    const app = await appAs();

    const view = (await app.inject({ method: 'GET', url: '/lunch/today' })).json().data;
    expect(view.outstandingAmount).toBe(0);
  });

  it('records the employee as the canceller on their own cancel', async () => {
    orderTable.rows.push(orderRow({ id: 'order-1' }));
    const app = await appAs();

    await app.inject({
      method: 'POST',
      url: '/lunch/orders/order-1/cancel',
      payload: { reason: 'Not hungry after all.' },
    });

    expect(orderTable.rows[0]).toMatchObject({
      status: 'CANCELLED',
      cancelledByUserId: ME.userId,
      cancellationReason: 'Not hungry after all.',
    });
  });

  it('still lets them cancel without giving a reason', async () => {
    // Unchanged: somebody calling off their own unpaid lunch owes nobody an
    // explanation. Only the OPERATOR's cancel demands one.
    orderTable.rows.push(orderRow({ id: 'order-1' }));
    const app = await appAs();

    const response = await app.inject({ method: 'POST', url: '/lunch/orders/order-1/cancel', payload: {} });

    expect(response.statusCode).toBe(200);
    expect(orderTable.rows[0]).toMatchObject({ status: 'CANCELLED', cancellationReason: null });
  });

  it('refuses their own cancel once the kitchen has started', async () => {
    orderTable.rows.push(orderRow({ id: 'order-1', status: 'PREPARING' }));
    const app = await appAs();

    const response = await app.inject({ method: 'POST', url: '/lunch/orders/order-1/cancel', payload: {} });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('being prepared');
    expect(orderTable.rows[0]).toMatchObject({ status: 'PREPARING' });
  });
});

// --- what this plugin cannot do ----------------------------------------------

describe('what an employee has no endpoint for', () => {
  it('has no way to pay for an order on this plugin', async () => {
    orderTable.rows.push(orderRow({ id: 'order-1' }));
    const app = await appAs([...EATER, PERMISSIONS.LUNCH_PAYMENT_MARK]);

    // Even holding the operator's grant, the employee's own plugin exposes no
    // route that could write a payment onto an order.
    for (const url of ['/lunch/orders/order-1/pay', '/lunch/orders/order-1/payment-correction']) {
      const response = await app.inject({ method: 'POST', url, payload: { paymentMethod: 'CASH' } });
      expect(response.statusCode).toBe(404);
    }

    expect(orderTable.rows[0]).toMatchObject({ paymentStatus: 'UNPAID' });
  });

  it('has no operator cancel on this plugin, whatever grants are held', async () => {
    orderTable.rows.push(orderRow({ id: 'order-1', employeeId: COLLEAGUE.id }));
    const app = await appAs([
      ...EATER,
      PERMISSIONS.LUNCH_ORDER_CANCEL_ANY,
      PERMISSIONS.LUNCH_ORDER_FULFIL,
    ]);

    // The employee's own cancel route reaches only their OWN order, and this
    // one is somebody else's - so it answers 404, not 403, and holding
    // `lunch.order.cancel.any` changes nothing about that. The operator's
    // cancel lives on the desk plugin, behind its own gate.
    const cancelled = await app.inject({
      method: 'POST',
      url: '/lunch/orders/order-1/cancel',
      payload: { reason: 'Reaching for somebody else’s lunch.' },
    });
    expect(cancelled.statusCode).toBe(404);

    // And there is no fulfilment route here at all.
    const advanced = await app.inject({
      method: 'POST',
      url: '/lunch/orders/order-1/status',
      payload: { status: 'PREPARING' },
    });
    expect(advanced.statusCode).toBe(404);

    expect(orderTable.rows[0]).toMatchObject({ status: 'ORDERED' });
  });

  it('cannot change an order once it exists - there is no update route', async () => {
    orderTable.rows.push(orderRow({ id: 'order-1' }));
    const app = await appAs();

    const response = await app.inject({
      method: 'PATCH',
      url: '/lunch/orders/order-1',
      payload: { totalAmount: 1 },
    });

    expect(response.statusCode).toBe(404);
    expect(orderTable.rows[0]).toMatchObject({ totalAmount: 290 });
  });
});

// --- the three permissions are three permissions -----------------------------

describe('permissions', () => {
  it('lets somebody read their orders without being able to place one', async () => {
    const app = await appAs([PERMISSIONS.LUNCH_ORDER_READ_OWN]);

    expect((await app.inject({ method: 'GET', url: '/lunch/orders' })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/lunch/orders',
          payload: { items: [{ menuItemId: 'item-chapati', quantity: 1 }] },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('lets somebody place an order without being able to cancel one', async () => {
    orderTable.rows.push(orderRow({ id: 'order-1' }));
    const app = await appAs([PERMISSIONS.LUNCH_ORDER_CREATE]);

    const response = await app.inject({ method: 'POST', url: '/lunch/orders/order-1/cancel', payload: {} });
    expect(response.statusCode).toBe(403);
  });
});

// --- the vocabulary itself ---------------------------------------------------

describe('the shared rules', () => {
  it('reads an order number back only for the day it was issued on', () => {
    const number = formatLunchOrderNumber(TODAY, 42);
    expect(number).toBe('LUNCH-2026-09-16-00042');
    expect(parseLunchOrderNumberSequence(number, TODAY)).toBe(42);
    expect(parseLunchOrderNumberSequence(number, '2026-09-15')).toBeNull();
    expect(parseLunchOrderNumberSequence('CASE-2026-000001', TODAY)).toBeNull();
  });

  it('lets the employee cancel only what nobody has paid for', () => {
    expect(canEmployeeCancelLunchOrder('ORDERED', 'UNPAID')).toBe(true);
    expect(canEmployeeCancelLunchOrder('ORDERED', 'PAID')).toBe(false);
    expect(canEmployeeCancelLunchOrder('CANCELLED', 'UNPAID')).toBe(false);
    // Unchanged by the operator's cancel arriving, and deliberately not
    // widened: food already in a pan is a conversation, not a button.
    expect(canEmployeeCancelLunchOrder('PREPARING', 'UNPAID')).toBe(false);
    expect(canEmployeeCancelLunchOrder('READY', 'UNPAID')).toBe(false);
    expect(canEmployeeCancelLunchOrder('DELIVERED', 'UNPAID')).toBe(false);
  });

  it('totals an order the way a receipt does', () => {
    expect(lunchOrderTotal([{ unitPrice: 20, quantity: 2 }, { unitPrice: 250, quantity: 1 }])).toBe(290);
    // Two decimals, once, so the total is the sum of what is printed.
    expect(lunchOrderTotal([{ unitPrice: 33.33, quantity: 3 }])).toBe(99.99);
  });

  it('writes the order out the way a person says it', () => {
    expect(
      lunchItemSummary([
        { itemName: 'Chapati', quantity: 2 },
        { itemName: 'Chicken Karahi', quantity: 1 },
      ]),
    ).toBe('2 Chapati + Chicken Karahi');
  });
});
