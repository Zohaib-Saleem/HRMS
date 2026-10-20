import type { FastifyBaseLogger } from 'fastify';
import {
  PERMISSIONS,
  caseMentionToken,
  type CaseMentionCandidate,
  type CaseMentionFeed,
  type CaseStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { ValidationError } from '../../core/errors.js';
import { notify } from '../../core/notifications/notification.service.js';
import type { AuthContext } from '../../auth/session.js';
import { resolveDeskAgent } from './case-desk.service.js';
import { CASE_DESK_ENTITY } from './case-notify.service.js';

/**
 * Tagging people in case messages.
 *
 * A tag tells somebody and records that they were named. That is all it does:
 * it never assigns the case, never moves its status, and never widens who may
 * open it. The rules that keep it that way all live here, so the routes only
 * have to call them:
 *
 *   - Only an id the server re-reads becomes a mention. "@Somebody" typed by
 *     hand is text; the id list comes from the candidate search and every id in
 *     it is looked up again on save.
 *   - The tagged person must be able to open THE MESSAGE, by exactly the rules
 *     the case routes already apply: a desk read grant whose scope reaches the
 *     case (all cases; their own department's; or assigned to them), or - for a
 *     reply, never an internal note - being the requester. Anybody else is
 *     refused with a sentence saying so, because a notification that leads to a
 *     404 is worse than none and quietly letting them in is worse still.
 *   - One notification per person per message, claimed atomically on the
 *     mention row before it is sent, so a retried dispatch cannot send twice.
 */

/** In-app title of a mention. The push wording is built in `push-content.ts`. */
export const CASE_MENTION_TITLE = 'You were mentioned in a case';

const PREVIEW_MAX = 140;

/** One line, clipped: what a notification or the dashboard shows of a message. */
export function mentionPreview(text: string, max = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const fullName = (u: { firstName: string; lastName: string }) =>
  `${u.firstName} ${u.lastName}`.trim();

/** The slice of a case the access rules need. `CaseRow` satisfies it. */
export interface MentionCase {
  id: string;
  companyId: string;
  caseNumber: string;
  subject: string;
  departmentId: string;
  assignedUserId: string | null;
  requester: { userId: string | null };
}

/** Which view of the case a person reaches it through. */
export type MentionAccess = 'desk' | 'requester';

const PERSON_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  employee: {
    select: {
      id: true,
      departmentId: true,
      jobTitle: true,
      department: { select: { name: true } },
      designation: { select: { name: true } },
    },
  },
  userRoles: {
    select: {
      role: {
        select: {
          name: true,
          rolePermissions: { select: { permission: { select: { key: true } } } },
        },
      },
    },
  },
} as const;

interface PersonRow {
  id: string;
  firstName: string;
  lastName: string;
  employee: {
    id: string;
    departmentId: string | null;
    jobTitle: string | null;
    department: { name: string } | null;
    designation: { name: string } | null;
  } | null;
  userRoles: Array<{
    role: { name: string; rolePermissions: Array<{ permission: { key: string } }> };
  }>;
}

/** Active accounts in the company, optionally narrowed to some ids. */
async function loadPeople(companyId: string, ids?: string[]): Promise<PersonRow[]> {
  return (await prisma.user.findMany({
    where: { companyId, status: 'ACTIVE', ...(ids ? { id: { in: ids } } : {}) },
    select: PERSON_SELECT,
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  })) as PersonRow[];
}

function grantsOf(person: PersonRow): Set<string> {
  return new Set(
    person.userRoles.flatMap((ur) => ur.role.rolePermissions.map((rp) => rp.permission.key)),
  );
}

/**
 * How `person` could open a message on this case, or null if they cannot.
 *
 * The same answer `deskScopeFilter` and `ownCaseOrThrow` give, worked out for
 * somebody other than the caller: the routes read the caller's grants from the
 * session, and here they are read from the person's roles.
 */
export function mentionAccess(
  person: PersonRow,
  row: MentionCase,
  internal: boolean,
): MentionAccess | null {
  const grants = grantsOf(person);
  if (grants.has(PERMISSIONS.CASE_READ_ALL)) return 'desk';
  if (
    grants.has(PERMISSIONS.CASE_READ_DEPARTMENT) &&
    (person.employee?.departmentId === row.departmentId || row.assignedUserId === person.id)
  ) {
    return 'desk';
  }
  if (!internal && row.requester.userId === person.id && grants.has(PERMISSIONS.CASE_READ_OWN)) {
    return 'requester';
  }
  return null;
}

function refusalReason(person: PersonRow, row: MentionCase, internal: boolean): string {
  const name = fullName(person);
  if (internal && row.requester.userId === person.id) {
    return `${name} raised this case and cannot see internal notes.`;
  }
  return `${name} cannot open this case. Tagging does not give access - assign the case to them or route it to their department first.`;
}

// --- the @ dropdown ----------------------------------------------------------

const CANDIDATE_LIMIT = 20;

/**
 * Who the `@` dropdown offers, searched by name, department, job title or role.
 *
 * People who cannot open the message are listed too, disabled and with the
 * reason, so the author learns why "@Accountant" is greyed out rather than
 * concluding the person does not exist. The author is never offered.
 */
export async function mentionCandidates(
  row: MentionCase,
  callerUserId: string,
  query: { q: string; internal: boolean },
): Promise<CaseMentionCandidate[]> {
  const needle = query.q.toLowerCase();
  const people = await loadPeople(row.companyId);

  const candidates = people
    .filter((person) => person.id !== callerUserId)
    .map((person) => {
      const access = mentionAccess(person, row, query.internal);
      const roleNames = [...new Set(person.userRoles.map((ur) => ur.role.name))];
      const candidate: CaseMentionCandidate = {
        userId: person.id,
        name: fullName(person),
        departmentName: person.employee?.department?.name ?? null,
        jobTitle: person.employee?.designation?.name ?? person.employee?.jobTitle ?? null,
        roleNames,
        canAccess: access !== null,
        reason: access === null ? refusalReason(person, row, query.internal) : null,
      };
      return candidate;
    })
    .filter((c) =>
      needle === ''
        ? true
        : [c.name, c.departmentName, c.jobTitle, ...c.roleNames].some((field) =>
            field?.toLowerCase().includes(needle),
          ),
    );

  // People who can be tagged first; the greyed-out ones after them.
  candidates.sort((a, b) => Number(b.canAccess) - Number(a.canAccess) || a.name.localeCompare(b.name));
  return candidates.slice(0, CANDIDATE_LIMIT);
}

// --- saving ------------------------------------------------------------------

export interface MentionTarget {
  userId: string;
  name: string;
  access: MentionAccess;
}

/**
 * Proves every tagged id is somebody who may be tagged in this message.
 *
 * Refused as a whole rather than trimmed, and before anything is written: a
 * message that silently dropped a tag would leave the author believing
 * somebody had been told. The author's own id is dropped rather than refused -
 * tagging yourself is harmless and telling yourself is noise.
 */
export async function resolveMentions(
  row: MentionCase,
  input: { authorUserId: string; message: string; internal: boolean; userIds: readonly string[] },
): Promise<MentionTarget[]> {
  const ids = [...new Set(input.userIds)].filter((id) => id !== input.authorUserId);
  if (ids.length === 0) return [];

  const people = await loadPeople(row.companyId, ids);
  const byId = new Map(people.map((person) => [person.id, person]));

  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new ValidationError({
      mentionUserIds: ['Somebody you tagged is not an active user. Pick people from the list.'],
    });
  }

  const targets: MentionTarget[] = [];
  const problems: string[] = [];
  for (const id of ids) {
    const person = byId.get(id)!;
    const name = fullName(person);
    if (!input.message.includes(caseMentionToken(name))) {
      problems.push(`${name} is tagged but not named in the message. Tag them again from the list.`);
      continue;
    }
    const access = mentionAccess(person, row, input.internal);
    if (!access) {
      problems.push(refusalReason(person, row, input.internal));
      continue;
    }
    targets.push({ userId: id, name, access });
  }

  if (problems.length > 0) throw new ValidationError({ mentionUserIds: problems });
  return targets;
}

/** The nested write that records the tags with the message, in the same insert. */
export function mentionRows(
  row: Pick<MentionCase, 'id' | 'companyId'>,
  targets: readonly MentionTarget[],
) {
  return targets.length === 0
    ? undefined
    : {
        create: targets.map((t) => ({
          companyId: row.companyId,
          caseId: row.id,
          mentionedUserId: t.userId,
        })),
      };
}

/**
 * Tells each person tagged in a saved message, once.
 *
 * Each mention row is claimed (`notifiedAt` set where it was null) before its
 * notification is written, so running this twice for the same message - a
 * retry, or a second caller - sends nothing the second time. A claim whose
 * notification then fails is released, so a later run can still deliver it.
 * Never throws: the message is already saved, and that must stand.
 */
export async function notifyMentions(input: {
  row: MentionCase;
  messageId: string;
  authorUserId: string;
  message: string;
  targets: readonly MentionTarget[];
  logger?: FastifyBaseLogger;
}): Promise<string[]> {
  const told: string[] = [];
  if (input.targets.length === 0) return told;

  try {
    const author = await prisma.user.findFirst({
      where: { id: input.authorUserId, companyId: input.row.companyId },
      select: { firstName: true, lastName: true },
    });
    const authorName = author ? fullName(author) : 'A colleague';
    const access = new Map(input.targets.map((t) => [t.userId, t.access]));

    const pending = await prisma.caseMessageMention.findMany({
      where: { messageId: input.messageId, notifiedAt: null },
      select: { id: true, mentionedUserId: true },
    });

    for (const mention of pending) {
      const via = access.get(mention.mentionedUserId);
      if (!via || mention.mentionedUserId === input.authorUserId) continue;

      const claimed = await prisma.caseMessageMention.updateMany({
        where: { id: mention.id, notifiedAt: null },
        data: { notifiedAt: new Date() },
      });
      if (claimed.count !== 1) continue;

      try {
        const result = await notify({
          companyId: input.row.companyId,
          userId: mention.mentionedUserId,
          type: 'CASE_MENTION',
          title: CASE_MENTION_TITLE,
          message: `${authorName} mentioned you in ${input.row.caseNumber} (${mentionPreview(input.row.subject, 80)}): "${mentionPreview(input.message)}"`,
          entityType: via === 'desk' ? CASE_DESK_ENTITY : 'Case',
          entityId: input.row.id,
          logger: input.logger,
        });
        await prisma.caseMessageMention.update({
          where: { id: mention.id },
          data: { notificationId: result.id },
        });
        told.push(mention.mentionedUserId);
      } catch (error) {
        await prisma.caseMessageMention
          .updateMany({ where: { id: mention.id }, data: { notifiedAt: null } })
          .catch(() => undefined);
        input.logger?.error(
          { err: error, mentionId: mention.id },
          'could not notify a tagged person; the message itself was saved',
        );
      }
    }
  } catch (error) {
    input.logger?.error(
      { err: error, messageId: input.messageId },
      'could not dispatch mention notifications; the message itself was saved',
    );
  }

  return told;
}

// --- reading -----------------------------------------------------------------

/** What every conversation read selects about a message's tags. */
export const MESSAGE_MENTIONS_SELECT = {
  orderBy: { createdAt: 'asc' },
  select: {
    mentionedUserId: true,
    mentionedUser: {
      select: { firstName: true, lastName: true, employee: { select: { id: true } } },
    },
  },
} as const;

/**
 * The reader's own mentions, newest first, for the dashboard.
 *
 * Access is re-checked here rather than trusted from when the tag was made. A
 * case routed away since keeps its row - reference, who, when - and loses its
 * subject, preview and link, so the list cannot become a side door into a case
 * the reader can no longer open.
 */
export async function mentionFeed(auth: AuthContext, limit: number): Promise<CaseMentionFeed> {
  const where = { companyId: auth.companyId, mentionedUserId: auth.userId };

  const [rows, unread, agent] = await Promise.all([
    prisma.caseMessageMention.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        caseId: true,
        createdAt: true,
        notificationId: true,
        notification: { select: { readAt: true } },
        case: {
          select: {
            caseNumber: true,
            subject: true,
            status: true,
            departmentId: true,
            assignedUserId: true,
            requester: { select: { userId: true } },
          },
        },
        message: {
          select: {
            message: true,
            isInternal: true,
            sender: { select: { firstName: true, lastName: true } },
          },
        },
      },
    }),
    prisma.caseMessageMention.count({
      where: { ...where, notification: { is: { readAt: null } } },
    }),
    resolveDeskAgent(auth),
  ]);

  const items = rows.map((row) => {
    const deskReach =
      agent !== null &&
      (agent.scope === 'ALL' ||
        (agent.scope === 'DEPARTMENT' &&
          (agent.departmentIds.includes(row.case.departmentId) ||
            row.case.assignedUserId === auth.userId)));
    const requesterReach =
      !row.message.isInternal &&
      row.case.requester.userId === auth.userId &&
      auth.permissions.has(PERMISSIONS.CASE_READ_OWN);

    const link = deskReach
      ? `/case-queue/${row.caseId}`
      : requesterReach
        ? `/cases/${row.caseId}`
        : null;

    return {
      id: row.id,
      caseId: row.caseId,
      caseNumber: row.case.caseNumber,
      caseStatus: row.case.status as CaseStatus,
      caseSubject: link ? row.case.subject : null,
      mentionedByName: row.message.sender ? fullName(row.message.sender) : null,
      preview: link ? mentionPreview(row.message.message) : null,
      createdAt: row.createdAt.toISOString(),
      readAt: row.notification?.readAt?.toISOString() ?? null,
      notificationId: row.notificationId,
      link,
    };
  });

  return { items, unread };
}
