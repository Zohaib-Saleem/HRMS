import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  type PushCategory,
  type PushDeviceRecord,
  type PushSettingsRecord,
  type PushTestResult,
  idParamSchema,
  PUSH_CATEGORIES,
  pushPreferencesSchema,
  pushSubscribeSchema,
  pushUnsubscribeSchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { ConflictError, NotFoundError } from '../../core/errors.js';
import { encryptSecret } from '../../core/secrets.js';
import { requireAuthContext } from '../../auth/guards.js';
import { notify } from '../../core/notifications/notification.service.js';
import {
  PUSH_TEST_NOTIFICATION,
  pushConfigured,
  vapidPublicKey,
} from '../../core/notifications/push.service.js';

/**
 * A person's own browser push registrations and preferences.
 *
 * Registered inside the notification routes, so `requireAuth` already applies.
 * Like the inbox, every query is scoped to the caller's user id: there is no
 * route that names another person's subscription, and an id or endpoint that
 * belongs to somebody else is simply not found.
 *
 * The subscription's auth secret is encrypted at rest and is never returned or
 * logged; the endpoint is accepted from the browser that holds it and is never
 * returned either - the list says "Chrome on Windows", not where it points.
 */

/**
 * `enable` - the person pressed the button: this browser is theirs now.
 * `sync`   - the app refreshing a registration it already has. Never turns on
 *            a browser the person turned off, and never takes a browser over
 *            from whoever registered it.
 */
const subscribeBodySchema = pushSubscribeSchema.extend({
  mode: z.enum(['enable', 'sync']).default('sync'),
  /**
   * The endpoint this one replaces, when the browser rotated its subscription
   * (`pushsubscriptionchange`). Lets the registration follow it, rather than
   * the person finding push quietly off.
   */
  previousEndpoint: z.string().url().max(2048).optional(),
});

const settingsQuerySchema = z.object({ endpoint: z.string().max(2048).optional() });

export const pushRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { endpoint } = parseOrThrow(settingsQuerySchema, request.query);

    const [rows, preference] = await Promise.all([
      prisma.pushSubscription.findMany({
        where: { userId: auth.userId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          endpoint: true,
          userAgent: true,
          status: true,
          createdAt: true,
          lastSuccessAt: true,
          lastFailureAt: true,
          lastErrorCode: true,
        },
      }),
      prisma.notificationPreference.findUnique({
        where: { userId: auth.userId },
        select: { pushMutedCategories: true },
      }),
    ]);

    const devices: PushDeviceRecord[] = rows.map((row) => ({
      id: row.id,
      label: deviceLabel(row.userAgent),
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      isCurrent: Boolean(endpoint) && row.endpoint === endpoint,
    }));

    const data: PushSettingsRecord = {
      configured: pushConfigured(),
      publicKey: vapidPublicKey(),
      devices,
      mutedCategories: knownCategories(preference?.pushMutedCategories ?? []),
    };
    return reply.send({ data });
  });

  app.put(
    '/subscription',
    { config: { rateLimit: { max: 60, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      if (!pushConfigured()) {
        throw new ConflictError('Browser notifications are not set up on this server yet.');
      }
      const input = parseOrThrow(subscribeBodySchema, request.body);
      const userAgent = request.headers['user-agent']?.slice(0, 512) ?? null;

      const existing = await prisma.pushSubscription.findUnique({
        where: { endpoint: input.endpoint },
        select: { id: true, userId: true, status: true },
      });

      const keys = { p256dh: input.keys.p256dh, authSecret: encryptSecret(input.keys.auth) };

      if (input.mode === 'sync') {
        if (!existing && input.previousEndpoint) {
          // Only the caller's own registration, and only one they left on.
          const moved = await prisma.pushSubscription.updateMany({
            where: { endpoint: input.previousEndpoint, userId: auth.userId, status: 'ACTIVE' },
            data: { endpoint: input.endpoint, ...keys, userAgent, lastErrorCode: null },
          });
          return reply.send({ data: { active: moved.count > 0 } });
        }
        if (!existing) return reply.send({ data: { active: false } });

        if (existing.userId !== auth.userId) {
          // Somebody else turned push on in this browser and did not sign out
          // through the app. Their notifications must stop arriving on a
          // machine the current person is using; the current person has not
          // asked for any. Drop the registration and let them choose.
          await prisma.pushSubscription.delete({ where: { id: existing.id } });
          return reply.send({ data: { active: false } });
        }

        const reactivate = existing.status === 'EXPIRED';
        await prisma.pushSubscription.update({
          where: { id: existing.id },
          data: { ...keys, userAgent, ...(reactivate ? { status: 'ACTIVE', lastErrorCode: null } : {}) },
        });
        return reply.send({ data: { active: reactivate || existing.status === 'ACTIVE' } });
      }

      await prisma.pushSubscription.upsert({
        where: { endpoint: input.endpoint },
        create: {
          companyId: auth.companyId,
          userId: auth.userId,
          endpoint: input.endpoint,
          ...keys,
          userAgent,
        },
        // Moves the row to the person who just pressed Enable in this browser.
        update: {
          companyId: auth.companyId,
          userId: auth.userId,
          ...keys,
          userAgent,
          status: 'ACTIVE',
          lastErrorCode: null,
        },
      });
      return reply.send({ data: { active: true } });
    },
  );

  /** This browser is being turned off, or signed out of. Deletes the row. */
  app.post(
    '/unsubscribe',
    { config: { rateLimit: { max: 60, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { endpoint } = parseOrThrow(pushUnsubscribeSchema, request.body);
      const result = await prisma.pushSubscription.deleteMany({
        where: { endpoint, userId: auth.userId },
      });
      return reply.send({ data: { removed: result.count } });
    },
  );

  /** Turns off one of the person's browsers from another - the device list. */
  app.post('/devices/:id/disable', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const result = await prisma.pushSubscription.updateMany({
      where: { id, userId: auth.userId },
      data: { status: 'DISABLED' },
    });
    if (result.count === 0) throw new NotFoundError('Device');
    return reply.send({ data: { id, status: 'DISABLED' } });
  });

  app.put('/preferences', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(pushPreferencesSchema, request.body);
    const muted = [...new Set(input.mutedCategories)];
    await prisma.notificationPreference.upsert({
      where: { userId: auth.userId },
      create: { userId: auth.userId, pushMutedCategories: muted },
      update: { pushMutedCategories: muted },
    });
    return reply.send({ data: { mutedCategories: muted } });
  });

  /**
   * Sends a real notification through the real pipeline: it lands in the bell
   * and is pushed to every active browser of the caller's. The answer says how
   * many pushes were queued - not delivered, which nobody can know yet.
   */
  app.post(
    '/test',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      if (!pushConfigured()) {
        throw new ConflictError('Browser notifications are not set up on this server yet.');
      }
      const active = await prisma.pushSubscription.count({
        where: { userId: auth.userId, status: 'ACTIVE' },
      });
      if (active === 0) {
        throw new ConflictError('Turn on notifications in this browser first.');
      }

      const sent = await notify({
        ...PUSH_TEST_NOTIFICATION,
        companyId: auth.companyId,
        userId: auth.userId,
      });
      const queued = await prisma.pushDelivery.count({ where: { notificationId: sent.id } });

      const data: PushTestResult = { queued };
      return reply.send({ data });
    },
  );
};

/** Drops a category a later release may have removed, so the UI never sees it. */
function knownCategories(values: readonly string[]): PushCategory[] {
  return values.filter((v): v is PushCategory => (PUSH_CATEGORIES as readonly string[]).includes(v));
}

/** "Chrome on Windows". The same reading the active-sessions list gives. */
export function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return 'Unknown browser';
  const browser =
    /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\//.test(userAgent) ? 'Opera'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : 'Browser';
  const os =
    /Windows/.test(userAgent) ? 'Windows'
    : /iPhone|iPad/.test(userAgent) ? 'iOS'
    : /Macintosh|Mac OS/.test(userAgent) ? 'macOS'
    : /Android/.test(userAgent) ? 'Android'
    : /Linux/.test(userAgent) ? 'Linux'
    : '';
  return os ? `${browser} on ${os}` : browser;
}
