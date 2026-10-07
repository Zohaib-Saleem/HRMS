import type { FastifyBaseLogger } from 'fastify';
import { PERMISSIONS } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { notify } from '../../core/notifications/notification.service.js';

/**
 * Who is told when an employee reports a problem with their asset.
 *
 * Resolved from grants, never from a name: whoever holds `asset.update` - the
 * grant that decides what the register says about an asset, and so the person
 * who acts on a report - plus every Super Admin. That is the IT Asset Manager
 * role, the hand-made IT Manager role in production, and any role a company
 * builds for the job later, without anybody editing a list here.
 *
 * One notification per account: a Super Admin who also holds the grant
 * through another role is one person and is told once. The reporter is never
 * told about their own report, and suspended or invited accounts are skipped.
 */
export async function assetIssueRecipients(
  companyId: string,
  reporterUserId: string,
): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      companyId,
      status: 'ACTIVE',
      id: { not: reporterUserId },
      userRoles: {
        some: {
          role: {
            companyId,
            OR: [
              { key: 'SUPER_ADMIN' },
              { rolePermissions: { some: { permission: { key: PERMISSIONS.ASSET_UPDATE } } } },
            ],
          },
        },
      },
    },
    select: { id: true },
  });
  return [...new Set(users.map((u) => u.id))];
}

/** The message, in the shape the queue and the inbox both show it. */
export function assetIssueMessage(input: {
  employeeName: string;
  assetName: string;
  assetTag: string;
  reason: string;
}): string {
  return [
    `Employee: ${input.employeeName}`,
    `Asset: ${input.assetName}`,
    `Asset Tag: ${input.assetTag}`,
    `Issue: ${input.reason}`,
  ].join('\n');
}

export const ASSET_ISSUE_TITLE = 'Asset Issue Reported';

/**
 * Tells everybody `assetIssueRecipients` names. Best-effort by construction:
 * `notify` never throws, so a failed notification cannot lose a report that is
 * already written. Returns who was told, for the audit row.
 */
export async function notifyAssetIssue(input: {
  companyId: string;
  reporterUserId: string;
  incidentId: string;
  employeeName: string;
  assetName: string;
  assetTag: string;
  reason: string;
  description: string | null;
  logger?: FastifyBaseLogger;
}): Promise<string[]> {
  const recipients = await assetIssueRecipients(input.companyId, input.reporterUserId);
  if (recipients.length === 0) return [];

  const message = assetIssueMessage(input);
  const emails = new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: recipients } },
        select: { id: true, email: true },
      })
    ).map((u) => [u.id, u.email]),
  );

  for (const userId of recipients) {
    const to = emails.get(userId);
    await notify({
      companyId: input.companyId,
      userId,
      type: 'SYSTEM',
      title: ASSET_ISSUE_TITLE,
      message,
      entityType: 'AssetIncident',
      entityId: input.incidentId,
      logger: input.logger,
      email: to
        ? {
            to,
            subject: `${ASSET_ISSUE_TITLE}: ${input.assetTag} - ${input.assetName}`,
            text: [message, input.description ? `\nDetails: ${input.description}` : '']
              .join('')
              .trim(),
          }
        : undefined,
    });
  }
  return recipients;
}
