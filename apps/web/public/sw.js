/*
 * HRMS service worker - browser push notifications, and nothing else.
 *
 * No `fetch` handler and no caching, deliberately. The SPA's deploy model
 * (Caddyfile.web: hashed assets immutable, the document always revalidated)
 * depends on the network answering every request; a worker that cached would
 * reintroduce exactly the stale-bundle failures that file exists to prevent.
 *
 * Served from /sw.js with `Cache-Control: no-cache`, so a deploy that changes
 * this file reaches browsers on their next update check.
 *
 * Trust: a push payload says what to show and which notification it is about.
 * It never says where to go. A click opens /notifications/<id> on this origin
 * and the app reads that notification back from the signed-in user's own
 * inbox before deciding the destination - so a payload cannot send anybody to
 * an arbitrary URL, and an id that is not the viewer's goes nowhere.
 */

const NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_TITLE = 'HRMS';
const DEFAULT_BODY = 'You have a new notification.';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take over open tabs now, so a click can reach the tab already open.
  event.waitUntil(self.clients.claim());
});

/** The payload, checked field by field. Anything malformed shows the defaults. */
function readPayload(event) {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  const text = (value, max) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
  const id =
    data && typeof data.notificationId === 'string' && NOTIFICATION_ID.test(data.notificationId)
      ? data.notificationId
      : null;
  return {
    title: text(data && data.title, 120) || DEFAULT_TITLE,
    body: text(data && data.body, 300) || DEFAULT_BODY,
    tag: text(data && data.tag, 160),
    notificationId: id,
  };
}

/** Where a click goes. Only ever a path on this origin. */
function destination(notificationId) {
  return notificationId && NOTIFICATION_ID.test(notificationId)
    ? `/notifications/${encodeURIComponent(notificationId)}`
    : '/';
}

self.addEventListener('push', (event) => {
  // A push must always show something: browsers penalise, and eventually
  // revoke, a site that receives pushes without displaying them.
  const payload = readPayload(event);
  const options = {
    body: payload.body,
    data: { notificationId: payload.notificationId },
  };
  if (payload.tag) {
    // A newer push about the same record replaces the older one, and still
    // alerts rather than updating silently.
    options.tag = payload.tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const path = destination(data.notificationId);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => {
        try {
          return new URL(client.url).origin === self.location.origin;
        } catch {
          return false;
        }
      });
      if (open) {
        // Reuse the tab the person already has: focus it and let the app
        // route in place, keeping whatever else it holds in memory.
        await open.focus();
        open.postMessage({ type: 'hrms:open-notification', path });
        return;
      }
      await self.clients.openWindow(new URL(path, self.location.origin).href);
    })(),
  );
});

/*
 * The browser rotated this subscription. Register the new one against the
 * same account, naming the old endpoint so the server can move the row - the
 * request carries the session cookie, so it is the signed-in person's own.
 * If nobody is signed in it simply fails, and the next visit re-syncs.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const previous = event.oldSubscription || null;
      let next = event.newSubscription || null;
      if (!next && previous && previous.options && previous.options.applicationServerKey) {
        next = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: previous.options.applicationServerKey,
        });
      }
      if (!next) return;
      const body = next.toJSON();
      await fetch('/api/v1/notifications/push/subscription', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: body.endpoint,
          keys: body.keys,
          mode: 'sync',
          previousEndpoint: previous ? previous.endpoint : undefined,
        }),
      });
    })().catch(() => undefined),
  );
});
