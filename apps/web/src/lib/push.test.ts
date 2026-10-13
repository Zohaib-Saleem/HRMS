// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The page side of browser push: what the browser can do, and the two places
 * where untrusted input meets the app - the VAPID key the server sends, and
 * the path the service worker posts when a push is clicked.
 */

const api = vi.hoisted(() => ({ put: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api }));

const push = await import('./push');
const { blockerMessage } = await import('@/features/profile/notification-settings');

const original = {
  isSecureContext: Object.getOwnPropertyDescriptor(window, 'isSecureContext'),
  userAgent: navigator.userAgent,
};

function setSecure(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
}
function setUserAgent(value: string) {
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
}

/** jsdom has none of the three; a capable browser has all of them. */
function giveBrowserPush() {
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { getRegistration: vi.fn(), register: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    configurable: true,
  });
  (window as unknown as Record<string, unknown>).PushManager = function PushManager() {};
  (window as unknown as Record<string, unknown>).Notification = { permission: 'default', requestPermission: vi.fn() };
}

function takeBrowserPush() {
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  delete (window as unknown as Record<string, unknown>).PushManager;
  delete (window as unknown as Record<string, unknown>).Notification;
}

beforeEach(() => {
  vi.clearAllMocks();
  setSecure(true);
});

afterEach(() => {
  takeBrowserPush();
  if (original.isSecureContext) Object.defineProperty(window, 'isSecureContext', original.isSecureContext);
  setUserAgent(original.userAgent);
});

describe('what this browser can do', () => {
  it('is supported where the three APIs exist on a secure page', () => {
    giveBrowserPush();
    expect(push.pushSupport()).toBe('supported');
  });

  it('refuses an insecure page before anything else', () => {
    giveBrowserPush();
    setSecure(false);
    expect(push.pushSupport()).toBe('insecure');
  });

  it('tells an iPhone user to add HRMS to the Home Screen', () => {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1');
    expect(push.pushSupport()).toBe('ios-needs-install');
  });

  it('is unsupported where the APIs are missing on a desktop', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0) OldBrowser/1.0');
    expect(push.pushSupport()).toBe('unsupported');
  });
});

describe('the server key', () => {
  it('decodes base64url to the raw bytes subscribe() wants', () => {
    // "hello?" in base64url uses the url-safe alphabet and needs no padding.
    expect([...push.base64UrlToBytes('aGVsbG8_')]).toEqual([104, 101, 108, 108, 111, 63]);
    expect([...push.base64UrlToBytes('-_8')]).toEqual([251, 255]);
  });
});

describe('a clicked push', () => {
  it.each([
    ['/notifications/cm9x1abc', true],
    ['/', true],
    ['https://evil.example/notifications/x', false],
    ['//evil.example', false],
    ['/notifications/../admin', false],
    ['/settings/roles', false],
    ['javascript:alert(1)', false],
    [42, false],
  ])('%s -> %s', (path, allowed) => {
    expect(push.isNotificationOpenPath(path)).toBe(allowed);
  });

  it('routes only a well-formed message from the service worker', () => {
    giveBrowserPush();
    const navigate = vi.fn();
    push.onPushClick(navigate);
    const listener = (navigator.serviceWorker.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0]![1];

    listener(new MessageEvent('message', { data: { type: 'hrms:open-notification', path: 'https://evil.example' } }));
    listener(new MessageEvent('message', { data: { type: 'other', path: '/notifications/n1' } }));
    listener(new MessageEvent('message', { data: { type: 'hrms:open-notification', path: '/notifications/n1' } }));

    expect(navigate.mock.calls).toEqual([['/notifications/n1']]);
  });
});

describe('the silent sync', () => {
  it('does nothing, and never prompts, unless permission was already granted', async () => {
    giveBrowserPush();
    await push.syncPush();
    expect(Notification.requestPermission).not.toHaveBeenCalled();
    expect(navigator.serviceWorker.getRegistration).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('re-sends an existing subscription in sync mode', async () => {
    giveBrowserPush();
    (Notification as unknown as { permission: string }).permission = 'granted';
    const subscription = {
      endpoint: 'https://push.example/abc',
      toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
    };
    (navigator.serviceWorker.getRegistration as ReturnType<typeof vi.fn>).mockResolvedValue({
      update: vi.fn().mockResolvedValue(undefined),
      pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) },
    });

    await push.syncPush();

    expect(api.put).toHaveBeenCalledWith('/notifications/push/subscription', {
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p', auth: 'a' },
      mode: 'sync',
    });
  });
});

describe('why Enable cannot work here', () => {
  it('says the server is not set up before anything about the browser', () => {
    expect(blockerMessage({ support: 'insecure', permission: null, configured: false })).toMatch(/not been set up/);
  });

  it('explains how to unblock a denied permission instead of asking again', () => {
    expect(blockerMessage({ support: 'supported', permission: 'denied', configured: true })).toMatch(
      /blocked for this site.*site settings/,
    );
  });

  it('gives iPhone users the Home Screen route', () => {
    expect(blockerMessage({ support: 'ios-needs-install', permission: null, configured: true })).toMatch(
      /Add to Home Screen/,
    );
  });

  it('has nothing to say when it can just work', () => {
    expect(blockerMessage({ support: 'supported', permission: 'default', configured: true })).toBeNull();
    expect(blockerMessage({ support: 'supported', permission: 'granted', configured: true })).toBeNull();
  });
});
