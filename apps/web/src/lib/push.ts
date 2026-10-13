import { api } from '@/lib/api';

/**
 * Browser push, from the page's side.
 *
 * Everything that touches `Notification`, `navigator.serviceWorker` or
 * `PushManager` lives here, so the screens ask questions ("can this browser do
 * it?", "is it on here?") and never feature-detect for themselves.
 *
 * The permission prompt is only ever raised by `enablePush`, which the profile
 * screen calls from the Enable button - never on sign-in, and never again once
 * the person has said no: a denied permission can only be changed in the
 * browser's own site settings, and the screen says so instead of asking.
 */

export type PushSupport =
  | 'supported'
  /** Not https (or localhost). Browsers refuse push outright. */
  | 'insecure'
  /** iPhone/iPad Safari outside a Home Screen web app: push is not offered. */
  | 'ios-needs-install'
  | 'unsupported';

const SW_PATH = '/sw.js';

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support gives it away.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  const capable =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (capable) return 'supported';
  if (isIos() && !isStandalone()) return 'ios-needs-install';
  return 'unsupported';
}

/** The browser's own answer for this site, or null where there is none. */
export function pushPermission(): NotificationPermission | null {
  return typeof Notification === 'undefined' ? null : Notification.permission;
}

/** VAPID keys travel as base64url; `subscribe` wants the raw bytes. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(current: ArrayBuffer | null | undefined, publicKey: string): boolean {
  if (!current) return false;
  const a = new Uint8Array(current);
  const b = base64UrlToBytes(publicKey);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function subscriptionBody(subscription: PushSubscription) {
  const json = subscription.toJSON();
  return { endpoint: json.endpoint ?? subscription.endpoint, keys: json.keys };
}

async function existingRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (pushSupport() !== 'supported') return undefined;
  return navigator.serviceWorker.getRegistration('/');
}

/** This browser's push subscription, if it has one. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  const registration = await existingRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

/**
 * Asks for permission, subscribes, and registers this browser to the signed-in
 * person. Must be called straight from a click: Safari and Firefox only show
 * the prompt for a user gesture, so nothing is awaited before it.
 */
export async function enablePush(publicKey: string): Promise<NotificationPermission> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;

  await navigator.serviceWorker.register(SW_PATH, { scope: '/' });
  const registration = await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();
  // A subscription made under another server key cannot receive from this one.
  if (subscription && !sameKey(subscription.options.applicationServerKey, publicKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(publicKey),
  });

  await api.put('/notifications/push/subscription', {
    ...subscriptionBody(subscription),
    mode: 'enable',
  });
  return permission;
}

/** Turns push off in this browser: the server forgets it, then the browser does. */
export async function disablePushHere(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  await api.post('/notifications/push/unsubscribe', { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

/**
 * Refreshes this browser's registration on each visit, without prompting.
 *
 * Picks up a rotated key, revives a registration the server had to expire,
 * and keeps the worker file current. It never turns push on where the person
 * has not: `sync` only touches a registration that already exists for them.
 */
export async function syncPush(): Promise<void> {
  if (pushPermission() !== 'granted') return;
  const registration = await existingRegistration();
  if (!registration) return;
  void registration.update().catch(() => undefined);
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await api.put('/notifications/push/subscription', {
    ...subscriptionBody(subscription),
    mode: 'sync',
  });
}

/**
 * Called on sign-out, while the session still exists. The next person to use
 * this browser must not receive the previous person's notifications. Bounded,
 * so a slow push service never holds up signing out.
 */
export async function releasePushOnSignOut(): Promise<void> {
  const attempt = disablePushHere().catch(() => undefined);
  await Promise.race([attempt, new Promise((resolve) => setTimeout(resolve, 2000))]);
}

/** The only paths a click on a push may route to inside the app. */
export function isNotificationOpenPath(path: unknown): path is string {
  return typeof path === 'string' && (path === '/' || /^\/notifications\/[A-Za-z0-9_-]{1,64}$/.test(path));
}

/**
 * Routes the app when the service worker reports a click on a push and this
 * tab was the one it focused. Returns the unsubscribe.
 */
export function onPushClick(navigate: (path: string) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => undefined;
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; path?: unknown } | null;
    if (data?.type === 'hrms:open-notification' && isNotificationOpenPath(data.path)) {
      navigate(data.path);
    }
  };
  navigator.serviceWorker.addEventListener('message', listener);
  navigator.serviceWorker.startMessages?.();
  return () => navigator.serviceWorker.removeEventListener('message', listener);
}
