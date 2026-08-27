import type { FastifyBaseLogger } from 'fastify';
import type { NotificationType } from '@prisma/client';
import { prisma } from '../db.js';
import { resolveEmailProvider } from '../mail/index.js';

/**
 * Notifications.
 *
 * One service for every module. A caller says who to tell and what about; this
 * decides which channels are used. Business code never touches an email
 * provider directly, so configuring SMTP later changes nothing above this line.
 *
 * In-app delivery is the source of truth and is always written. Email is
 * best-effort: a failing relay must never fail the user's request, because the
 * notification is already durable in the database.
 */

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
}

export async function notify(input: NotifyInput): Promise<{ id: string }> {
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

  if (input.email && input.logger) {
    const provider = resolveEmailProvider(input.logger);
    // Deliberately not awaited into the caller's failure path.
    void provider.send(input.email).catch((error: unknown) => {
      input.logger?.error(
        { err: error, notificationId: notification.id },
        'email delivery failed; in-app notification was still recorded',
      );
    });
  }

  return notification;
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
