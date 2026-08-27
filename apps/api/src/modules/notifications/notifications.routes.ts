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

/**
 * Notifications are always personal: every query is scoped to the caller's own
 * user id, so there is no permission to check and no way to read someone
 * else's inbox. That is why these routes need `requireAuth` and nothing more.
 */
export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

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

    const data: NotificationRecord[] = rows.map((row) => ({
      id: row.id,
      type: row.type as NotificationType,
      title: row.title,
      message: row.message,
      entityType: row.entityType,
      entityId: row.entityId,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  app.get('/unread-count', async (request, reply) => {
    const auth = requireAuthContext(request);
    const count = await prisma.notification.count({
      where: { userId: auth.userId, readAt: null },
    });
    return reply.send({ data: { count } });
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
