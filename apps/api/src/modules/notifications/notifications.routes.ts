import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  type NotificationRecord,
  type NotificationType,
  idParamSchema,
  notificationQuerySchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { NotFoundError } from '../../core/errors.js';
import { requireAuth, requireAuthContext } from '../../auth/guards.js';
import { pushRoutes } from './push.routes.js';

function toRecord(row: {
  id: string;
  type: string;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationRecord {
  return {
    id: row.id,
    type: row.type as NotificationType,
    title: row.title,
    message: row.message,
    entityType: row.entityType,
    entityId: row.entityId,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Notifications are always personal: every query is scoped to the caller's own
 * user id, so there is no permission to check and no way to read someone
 * else's inbox. That is why these routes need `requireAuth` and nothing more.
 */
export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  // Browser push: this person's registrations and preferences.
  await app.register(pushRoutes, { prefix: '/push' });

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(notificationQuerySchema, request.query);

    const where: Prisma.NotificationWhereInput = {
      userId: auth.userId,
      ...(query.unreadOnly === 'true' ? { readAt: null } : {}),
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.notification.count({ where }),
      prisma.notification.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const data: NotificationRecord[] = rows.map(toRecord);

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  app.get('/unread-count', async (request, reply) => {
    const auth = requireAuthContext(request);
    const count = await prisma.notification.count({
      where: { userId: auth.userId, readAt: null },
    });
    return reply.send({ data: { count } });
  });

  /**
   * One notification, for whoever is signed in. This is where a clicked
   * browser push lands: the push carries only the notification's id, and the
   * app reads it back here before deciding where to go. Another person's id is
   * a 404 - which is also what a push shown in a browser somebody else has
   * since signed in to will get.
   */
  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const row = await prisma.notification.findFirst({ where: { id, userId: auth.userId } });
    if (!row) throw new NotFoundError('Notification');
    return reply.send({ data: toRecord(row) });
  });

  app.post('/:id/read', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    // Scoped by userId, so another user's id simply does not match.
    const result = await prisma.notification.updateMany({
      where: { id, userId: auth.userId, readAt: null },
      data: { readAt: new Date() },
    });

    if (result.count === 0) {
      const exists = await prisma.notification.findFirst({
        where: { id, userId: auth.userId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundError('Notification');
      // Already read - idempotent, not an error.
    }

    return reply.send({ data: { id, read: true } });
  });

  app.post('/read-all', async (request, reply) => {
    const auth = requireAuthContext(request);
    const result = await prisma.notification.updateMany({
      where: { userId: auth.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return reply.send({ data: { updated: result.count } });
  });
};
