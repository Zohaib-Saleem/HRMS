import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * public/sw.js, run in a sandbox with a fake `self`.
 *
 * It is plain JavaScript served as-is, so it cannot import the app's code and
 * the app's type checker never sees it. These tests are its only check, and
 * they pin the two things that matter about a file that reacts to data from
 * outside: a push always shows something, and a click only ever opens a path
 * on this origin built from a notification id - never a URL from the payload.
 */

const SOURCE = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');
const ORIGIN = 'https://hrms.gamempires.com';

type Listener = (event: Record<string, unknown>) => void;

function loadWorker(windows: Array<{ url: string; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }> = []) {
  const listeners = new Map<string, Listener>();
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn().mockResolvedValue(undefined), pushManager: { subscribe: vi.fn() } },
    clients: {
      claim: vi.fn().mockResolvedValue(undefined),
      matchAll: vi.fn().mockResolvedValue(windows),
      openWindow: vi.fn().mockResolvedValue(undefined),
    },
  };
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  runInNewContext(SOURCE, { self, URL, JSON, fetch, encodeURIComponent });
  return { self, fetch, fire: (type: string, event: Record<string, unknown>) => listeners.get(type)!(event) };
}

/** Fires an event and waits for what it handed to waitUntil. */
async function dispatch(worker: ReturnType<typeof loadWorker>, type: string, event: Record<string, unknown>) {
  let pending: Promise<unknown> = Promise.resolve();
  worker.fire(type, { ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
  await pending;
}

const pushOf = (data: unknown) => ({
  data: {
    json: () => {
      if (typeof data === 'string') return JSON.parse(data);
      return data;
    },
  },
});

describe('a push arriving', () => {
  it('shows the title and body, tagged so a newer one replaces it', async () => {
    const worker = loadWorker();
    await dispatch(worker, 'push', pushOf({ v: 1, notificationId: 'cm1abc', title: 'Leave Approval Required', body: 'Hira Javed requested Casual Leave.', tag: 'ApprovalRequest:a1' }));

    expect(worker.self.registration.showNotification).toHaveBeenCalledWith('Leave Approval Required', {
      body: 'Hira Javed requested Casual Leave.',
      data: { notificationId: 'cm1abc' },
      tag: 'ApprovalRequest:a1',
      renotify: true,
    });
  });

  it('still shows something for a payload it cannot read', async () => {
    const worker = loadWorker();
    await dispatch(worker, 'push', pushOf('{not json'));
    expect(worker.self.registration.showNotification).toHaveBeenCalledWith('HRMS', {
      body: 'You have a new notification.',
      data: { notificationId: null },
    });
  });

  it('drops a notification id that is not a plain id', async () => {
    const worker = loadWorker();
    await dispatch(worker, 'push', pushOf({ title: 't', body: 'b', notificationId: '../../admin' }));
    const options = worker.self.registration.showNotification.mock.calls[0]![1];
    expect(options.data).toEqual({ notificationId: null });
  });
});

describe('a push clicked', () => {
  const click = (notificationId: unknown) => ({
    notification: { close: vi.fn(), data: { notificationId } },
  });

  it('opens /notifications/<id> on this origin when no HRMS tab is open', async () => {
    const worker = loadWorker();
    await dispatch(worker, 'notificationclick', click('cm1abc'));
    expect(worker.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/notifications/cm1abc`);
  });

  it('focuses the open HRMS tab and lets it route in place', async () => {
    const tab = { url: `${ORIGIN}/leave/me`, focus: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn() };
    const elsewhere = { url: 'https://mail.example.com/', focus: vi.fn(), postMessage: vi.fn() };
    const worker = loadWorker([elsewhere, tab]);

    await dispatch(worker, 'notificationclick', click('cm1abc'));

    expect(tab.focus).toHaveBeenCalled();
    expect(tab.postMessage).toHaveBeenCalledWith({ type: 'hrms:open-notification', path: '/notifications/cm1abc' });
    expect(elsewhere.focus).not.toHaveBeenCalled();
    expect(worker.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it.each(['https://evil.example/', '//evil.example', '../settings', null])(
    'goes to the dashboard, never elsewhere, for %s',
    async (id) => {
      const worker = loadWorker();
      await dispatch(worker, 'notificationclick', click(id));
      expect(worker.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
    },
  );
});

describe('a rotated subscription', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-registers the new one, naming the old so the server can move it', async () => {
    const worker = loadWorker();
    await dispatch(worker, 'pushsubscriptionchange', {
      oldSubscription: { endpoint: 'https://push.example/old', options: {} },
      newSubscription: { toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }) },
    });

    const [url, init] = worker.fetch.mock.calls[0]!;
    expect(url).toBe('/api/v1/notifications/push/subscription');
    expect(init).toMatchObject({ method: 'PUT', credentials: 'same-origin' });
    expect(JSON.parse(init.body)).toEqual({
      endpoint: 'https://push.example/new',
      keys: { p256dh: 'p', auth: 'a' },
      mode: 'sync',
      previousEndpoint: 'https://push.example/old',
    });
  });
});

describe('what it does not do', () => {
  it('has no fetch handler - it never caches or intercepts the app', () => {
    expect(SOURCE).not.toMatch(/addEventListener\(\s*['"]fetch['"]/);
    expect(SOURCE).not.toMatch(/caches\./);
  });
});
