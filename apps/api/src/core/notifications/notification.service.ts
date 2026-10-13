import type { FastifyBaseLogger } from 'fastify';
import type { NotificationType } from '@prisma/client';
import { prisma } from '../db.js';
import { emailErrorCode, resolveEmailProvider } from '../mail/index.js';
import { enqueuePush } from './push.service.js';

/**
 * Notifications.
 *
 * One service for every module. A caller says who to tell and what about; this
 * decides which channels are used. Business code never touches an email
 * provider directly, so configuring SMTP later changes nothing above this line.
 *
 * In-app delivery is the source of truth and is always written. Browser push
 * (`push.service.ts`) is queued from the row once it exists, so every
 * notification any module sends reaches the recipient's browsers without that
 * module knowing push exists. Email is best-effort: a failing relay must never
 * fail the user's request, because the notification is already durable in the
 * database.
 *
 * Best-effort is not the same as unknown, and that distinction is the point of
 * `NotifyResult`. A caller that fires a notification off to the side does not
 * care what the relay said; a caller whose entire purpose was to put a link in
 * somebody's inbox does, because reporting "sent" when nothing was sent is how
 * a dead relay stays invisible for weeks. Such a caller passes `awaitEmail` and
 * is told what actually happened. Either way this function does not throw.
 */

/**
 * What became of the email half of a notification.
 *
 *   - `skipped`     - no email was asked for, or there was no address.
 *   - `delivered`   - a transport accepted the message for delivery.
 *   - `unconfirmed` - it was handed to a transport that did not deliver it, or
 *                     was dispatched without waiting for the answer. The
 *                     console provider is always this: it logs and drops.
 *   - `failed`      - the transport threw.
 */
export type EmailDeliveryStatus = 'skipped' | 'delivered' | 'unconfirmed' | 'failed';

export interface NotifyResult {
  id: string;
  emailStatus: EmailDeliveryStatus;
  /** Which transport handled it. Never a host, a username or a credential. */
  emailProvider?: string;
  /** Set only when `failed`. A bare code - see `emailErrorCode`. */
  emailErrorCode?: string;
}

export interface NotifyInput {
  companyId: string;
  /** Recipient login account. Employees without a login are simply skipped. */
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  entityType?: string | null;
  entityId?: string | null;
  /** Also send an email. In-app is always recorded regardless. */
  email?: { to: string; subject: string; text: string; html?: string };
  logger?: FastifyBaseLogger;
  /**
   * Wait for the transport and report what it said, instead of dispatching and
   * moving on. For the callers whose request exists in order to send the mail -
   * a password reset link is the whole of one - so the response can describe
   * what really happened. Costs the round trip to the relay; still never turns
   * a mail failure into a failed request.
   */
  awaitEmail?: boolean;
}

export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const notification = await prisma.notification.create({
    data: {
      companyId: input.companyId,
      userId: input.userId,
      type: input.type,
      title: input.title,
      message: input.message,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
    },
    select: { id: true },
  });

  // Queued, not sent: a worker delivers it. Never throws, and returns at once
  // when push is not configured or the recipient has no browser registered.
  await enqueuePush(notification.id);

  if (!input.email || !input.logger) return { id: notification.id, emailStatus: 'skipped' };

  const logger = input.logger;
  const provider = resolveEmailProvider(logger);

  const onFailure = (error: unknown): void => {
    logger.error(
      { err: error, notificationId: notification.id, provider: provider.name },
      'email delivery failed; in-app notification was still recorded',
    );
  };

  if (!input.awaitEmail) {
    // Dispatch and move on. Nothing here can report an outcome, so the caller
    // is told `unconfirmed` rather than a success it has no evidence for.
    void provider.send(input.email).catch(onFailure);
    return { id: notification.id, emailStatus: 'unconfirmed', emailProvider: provider.name };
  }

  try {
    const result = await provider.send(input.email);
    return {
      id: notification.id,
      // A provider that accepted the call without delivering - the console one
      // does exactly this - is not a delivery, and saying so is the difference
      // between a visible misconfiguration and a silent one.
      emailStatus: result.delivered ? 'delivered' : 'unconfirmed',
      emailProvider: result.provider,
    };
  } catch (error) {
    onFailure(error);
    return {
      id: notification.id,
      emailStatus: 'failed',
      emailProvider: provider.name,
      emailErrorCode: emailErrorCode(error),
    };
  }
}

/** Fan-out helper. Recipients without a login account are skipped silently. */
export async function notifyEmployees(
  employeeIds: readonly string[],
  build: (recipient: { userId: string; employeeId: string; email: string }) => Omit<NotifyInput, 'userId' | 'companyId'>,
  companyId: string,
): Promise<number> {
  if (employeeIds.length === 0) return 0;

  const employees = await prisma.employee.findMany({
    where: { id: { in: [...employeeIds] }, companyId, userId: { not: null } },
    select: { id: true, userId: true, workEmail: true, user: { select: { email: true } } },
  });

  let sent = 0;
  for (const employee of employees) {
    if (!employee.userId) continue;
    const email = employee.user?.email ?? employee.workEmail ?? '';
    await notify({
      ...build({ userId: employee.userId, employeeId: employee.id, email }),
      companyId,
      userId: employee.userId,
    });
    sent += 1;
  }

  return sent;
}
