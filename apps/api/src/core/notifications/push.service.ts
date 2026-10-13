import webpush from 'web-push';
import { env } from '../../config/env.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../secrets.js';
import {
  buildPushContent,
  PUSH_TEST_ENTITY,
  type PushApprovalContext,
  type PushSourceNotification,
} from './push-content.js';

/**
 * Browser push delivery.
 *
 * The in-app notification is the record; this is a second way of telling
 * somebody about it. The flow is an outbox:
 *
 *   1. `notify()` writes the notification row (unchanged).
 *   2. `enqueuePush()` writes one `push_deliveries` row per active browser the
 *      recipient has, unless they muted the category. Unique per
 *      (notification, browser), so enqueueing twice is harmless.
 *   3. The worker below sends PENDING rows, records what the push service
 *      said, retries the transient failures with backoff, and marks a
 *      subscription EXPIRED when the service says it is gone.
 *
 * Nothing here throws into a caller. A push service being down delays a push;
 * it never fails the leave approval or the case that caused it, and the bell
 * shows the notification either way.
 *
 * `SENT` means the push service accepted the message. That is as far as the
 * protocol can see: whether the device was on, and whether the person looked,
 * is not reported back, and nothing here claims otherwise.
 */

/** Attempts per delivery, including the first. */
export const PUSH_MAX_ATTEMPTS = 5;
/** Wait before attempt 2, 3, 4, 5. */
export const PUSH_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000] as const;
/**
 * A push older than this is not sent. "Your leave was approved" a day late on
 * a lock screen is noise; the bell already has it.
 */
export const PUSH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How long the push service should hold a message for an offline browser. */
const PUSH_TTL_SECONDS = 12 * 60 * 60;
/** A row claimed this long ago by a worker that never finished is handed back. */
const STALE_CLAIM_MS = 5 * 60_000;
/**
 * The same person told the same thing about the same record within this
 * window is a retried business event, not news. The notification row is kept;
 * only the second push is skipped.
 */
export const PUSH_DUPLICATE_WINDOW_MS = 2 * 60_000;
const BATCH_SIZE = 50;
const MAX_BATCHES_PER_RUN = 20;

// ------------------------------------------------------------------ sender

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** What the push service answered. Thrown errors carry `statusCode` when HTTP. */
export interface PushSender {
  send(target: PushTarget, payload: string): Promise<void>;
}

const webPushSender: PushSender = {
  async send(target, payload) {
    await webpush.sendNotification(target, payload, {
      vapidDetails: {
        subject: env.VAPID_SUBJECT!,
        publicKey: env.VAPID_PUBLIC_KEY!,
        privateKey: env.VAPID_PRIVATE_KEY!,
      },
      TTL: PUSH_TTL_SECONDS,
      urgency: 'normal',
      timeout: 15_000,
    });
  },
};

let sender: PushSender = webPushSender;
let configuredOverride: boolean | null = null;

/** Tests swap the transport and the configured flag; nothing else may. */
export function setPushTransportForTests(next: { sender?: PushSender; configured?: boolean | null }): void {
  if (next.sender) sender = next.sender;
  if (next.configured !== undefined) configuredOverride = next.configured;
}

/** True when the server holds a VAPID key pair. Without one, push is off. */
export function pushConfigured(): boolean {
  if (configuredOverride !== null) return configuredOverride;
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

/** The key browsers subscribe with. Public by design. */
export function vapidPublicKey(): string | null {
  return pushConfigured() ? (env.VAPID_PUBLIC_KEY ?? null) : null;
}

// ----------------------------------------------------------------- content

const NOTIFICATION_SELECT = {
  id: true,
  userId: true,
  type: true,
  title: true,
  message: true,
  entityType: true,
  entityId: true,
  createdAt: true,
} as const;

async function approvalContext(
  source: Pick<PushSourceNotification, 'entityType' | 'entityId'>,
): Promise<PushApprovalContext | null> {
  if (source.entityType !== 'ApprovalRequest' || !source.entityId) return null;
  const approval = await prisma.approvalRequest.findUnique({
    where: { id: source.entityId },
    select: {
      subjectType: true,
      title: true,
      summary: true,
      requesterEmployee: { select: { firstName: true, lastName: true } },
    },
  });
  if (!approval) return null;
  const person = approval.requesterEmployee;
  return {
    subjectType: approval.subjectType,
    title: approval.title,
    summary: approval.summary,
    requesterName: person ? `${person.firstName} ${person.lastName}`.trim() : null,
  };
}

async function contentFor(source: PushSourceNotification) {
  return buildPushContent(source, await approvalContext(source));
}

// ----------------------------------------------------------------- enqueue

/**
 * Queues a push of one notification to each of its recipient's browsers.
 * Returns how many were queued. Never throws.
 */
export async function enqueuePush(notificationId: string): Promise<number> {
  if (!pushConfigured()) return 0;

  try {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
      select: NOTIFICATION_SELECT,
    });
    if (!notification) return 0;

    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId: notification.userId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (subscriptions.length === 0) return 0;

    const content = await contentFor(notification);
    if (!content) return 0;

    if (content.category !== 'TEST') {
      const preference = await prisma.notificationPreference.findUnique({
        where: { userId: notification.userId },
        select: { pushMutedCategories: true },
      });
      if (preference?.pushMutedCategories.includes(content.category)) return 0;

      const duplicate = await prisma.pushDelivery.findFirst({
        where: {
          notification: {
            id: { not: notification.id },
            userId: notification.userId,
            type: notification.type,
            title: notification.title,
            entityType: notification.entityType,
            entityId: notification.entityId,
            createdAt: { gte: new Date(notification.createdAt.getTime() - PUSH_DUPLICATE_WINDOW_MS) },
          },
        },
        select: { id: true },
      });
      if (duplicate) return 0;
    }

    const created = await prisma.pushDelivery.createMany({
      data: subscriptions.map((s) => ({ notificationId: notification.id, subscriptionId: s.id })),
      skipDuplicates: true,
    });

    if (created.count > 0) kickPushWorker();
    return created.count;
  } catch (error) {
    logger.error(
      { event: 'PUSH_ENQUEUE_FAILED', notificationId, err: errorSummary(error) },
      'could not queue browser push; the in-app notification is unaffected',
    );
    return 0;
  }
}

// ------------------------------------------------------------------ worker

export interface PushRunStats {
  sent: number;
  retried: number;
  failed: number;
  expired: number;
}

let running = false;
let rerun = false;

/** Starts the worker if it is idle, or asks the running one to go round again. */
export function kickPushWorker(): void {
  if (!pushConfigured()) return;
  void processPushQueue().catch((error) =>
    logger.error({ event: 'PUSH_WORKER_FAILED', err: errorSummary(error) }, 'browser push worker failed'),
  );
}

/**
 * Sends everything that is due. One run at a time per process; a call while
 * one is in flight makes it loop once more instead of starting a second.
 * Claims are atomic (`updateMany` on PENDING), so even two processes would
 * not send the same row twice.
 */
export async function processPushQueue(now: () => Date = () => new Date()): Promise<PushRunStats> {
  const stats: PushRunStats = { sent: 0, retried: 0, failed: 0, expired: 0 };
  if (!pushConfigured()) return stats;
  if (running) {
    rerun = true;
    return stats;
  }

  running = true;
  try {
    await prisma.pushDelivery.updateMany({
      where: { status: 'SENDING', updatedAt: { lt: new Date(now().getTime() - STALE_CLAIM_MS) } },
      data: { status: 'PENDING' },
    });

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      rerun = false;
      const handled = await processBatch(now, stats);
      if (handled < BATCH_SIZE && !rerun) break;
    }
  } finally {
    running = false;
  }

  if (stats.sent + stats.retried + stats.failed + stats.expired > 0) {
    logger.info({ event: 'PUSH_RUN', ...stats }, 'browser push run');
  }
  return stats;
}

async function processBatch(now: () => Date, stats: PushRunStats): Promise<number> {
  const due = await prisma.pushDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now() } },
    orderBy: { nextAttemptAt: 'asc' },
    take: BATCH_SIZE,
    select: {
      id: true,
      attempts: true,
      notification: { select: NOTIFICATION_SELECT },
      subscription: {
        select: { id: true, endpoint: true, p256dh: true, authSecret: true, status: true },
      },
    },
  });

  const contents = new Map<string, Awaited<ReturnType<typeof contentFor>>>();

  for (const row of due) {
    const claimed = await prisma.pushDelivery.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: 'SENDING', attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;
    const attempt = row.attempts + 1;

    const finish = (status: 'SENT' | 'FAILED' | 'EXPIRED', code: string | null) =>
      prisma.pushDelivery.update({
        where: { id: row.id },
        data: { status, lastErrorCode: code, sentAt: status === 'SENT' ? now() : null },
      });

    if (row.subscription.status !== 'ACTIVE') {
      await finish('FAILED', 'SUBSCRIPTION_INACTIVE');
      stats.failed += 1;
      continue;
    }
    if (now().getTime() - row.notification.createdAt.getTime() > PUSH_MAX_AGE_MS) {
      await finish('FAILED', 'STALE');
      stats.failed += 1;
      continue;
    }

    if (!contents.has(row.notification.id)) {
      contents.set(row.notification.id, await contentFor(row.notification));
    }
    const content = contents.get(row.notification.id);
    if (!content) {
      await finish('FAILED', 'NOT_PUSHED');
      stats.failed += 1;
      continue;
    }

    const auth = decryptSecret(row.subscription.authSecret);
    if (!auth) {
      // Encrypted under a SESSION_SECRET that has since changed. The browser
      // re-registers on its next visit and gets a fresh row.
      await expireSubscription(row.subscription.id, 'KEY_UNREADABLE', now());
      await finish('EXPIRED', 'KEY_UNREADABLE');
      stats.expired += 1;
      continue;
    }

    // The payload says what to show and which notification it is. No link:
    // the service worker opens /notifications/<id>, and the app resolves the
    // destination from the signed-in user's own inbox.
    const payload = JSON.stringify({
      v: 1,
      notificationId: row.notification.id,
      title: content.title,
      body: content.body,
      tag: content.tag,
    });

    try {
      await sender.send(
        { endpoint: row.subscription.endpoint, keys: { p256dh: row.subscription.p256dh, auth } },
        payload,
      );
      await finish('SENT', null);
      await prisma.pushSubscription.update({
        where: { id: row.subscription.id },
        data: { lastSuccessAt: now(), lastErrorCode: null },
      });
      stats.sent += 1;
    } catch (error) {
      const status = httpStatus(error);
      const network = !status && isNetworkError(error);
      const code = status ? String(status) : network ? 'NETWORK' : 'LOCAL';
      const outcome = classifyFailure(status, network);

      logger.warn(
        {
          event: 'PUSH_SEND_FAILED',
          deliveryId: row.id,
          subscriptionId: row.subscription.id,
          code,
          attempt,
          outcome,
        },
        'browser push was not accepted',
      );

      if (outcome === 'expire') {
        await expireSubscription(row.subscription.id, code, now());
        await finish('EXPIRED', code);
        stats.expired += 1;
        continue;
      }

      await prisma.pushSubscription.update({
        where: { id: row.subscription.id },
        data: { lastFailureAt: now(), lastErrorCode: code },
      });

      if (outcome === 'retry' && attempt < PUSH_MAX_ATTEMPTS) {
        const delay = PUSH_RETRY_DELAYS_MS[attempt - 1] ?? PUSH_RETRY_DELAYS_MS.at(-1)!;
        await prisma.pushDelivery.update({
          where: { id: row.id },
          data: {
            status: 'PENDING',
            lastErrorCode: code,
            nextAttemptAt: new Date(now().getTime() + delay),
          },
        });
        stats.retried += 1;
      } else {
        await finish('FAILED', code);
        stats.failed += 1;
      }
    }
  }

  return due.length;
}

/**
 * What a failed send means.
 *
 *   404, 410  the subscription is gone - the person unsubscribed, cleared the
 *             site's data, or the browser rotated it.
 *   403       the push service does not recognise our VAPID key for this
 *             subscription: it was made under a key pair we no longer hold.
 *   400, 413  our request was wrong; sending it again will not help.
 *   429, 5xx  transient - try again later.
 *   no status, network error (ECONNRESET, ETIMEDOUT...)  transient too.
 *   no status, anything else  it failed before leaving this process - a key
 *             the encryption step refused, say. Retrying changes nothing.
 */
export function classifyFailure(status: number | null, network = false): 'expire' | 'retry' | 'drop' {
  if (status === 404 || status === 410 || status === 403) return 'expire';
  if (status === 429 || (status !== null && status >= 500)) return 'retry';
  if (status === null) return network ? 'retry' : 'drop';
  return 'drop';
}

/** A Node system error from the socket, as opposed to one thrown by our own code. */
function isNetworkError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^(E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(code);
}

async function expireSubscription(id: string, code: string, at: Date): Promise<void> {
  await prisma.pushSubscription.update({
    where: { id },
    data: { status: 'EXPIRED', lastFailureAt: at, lastErrorCode: code },
  });
}

function httpStatus(error: unknown): number | null {
  const value = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof value === 'number' && value > 0 ? value : null;
}

/**
 * A loggable shape for an error. Never the error itself: a web-push error
 * carries the subscription endpoint and the push service's response body.
 */
function errorSummary(error: unknown): { name: string; message?: string } {
  if (error instanceof Error) {
    return httpStatus(error) ? { name: error.name } : { name: error.name, message: error.message };
  }
  return { name: typeof error };
}

// ------------------------------------------------------------------- tests

/** The test push from the profile screen: a real notification, never muted. */
export const PUSH_TEST_NOTIFICATION = {
  type: 'SYSTEM' as const,
  title: 'HRMS notifications are on',
  message: 'Browser notifications are working. You will be told here about approvals, cases and other work.',
  entityType: PUSH_TEST_ENTITY,
};

/**
 * Forgets finished deliveries after a month. The diagnostics are for "why did
 * my phone not buzz on Tuesday", not for history - the notification row is.
 */
export async function prunePushDeliveries(now = new Date()): Promise<number> {
  const result = await prisma.pushDelivery.deleteMany({
    where: {
      status: { in: ['SENT', 'FAILED', 'EXPIRED'] },
      updatedAt: { lt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
    },
  });
  return result.count;
}
