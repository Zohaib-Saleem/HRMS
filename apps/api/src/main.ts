import { buildApp } from './app.js';
import { env } from './config/env.js';
import { assertDatabaseConnection, prisma } from './core/db.js';
import { useLogger } from './core/logger.js';
import { syncPermissionCatalogueAtBoot } from './core/permission-catalogue.js';
import { pruneExpiredSessions } from './auth/session.js';
import { pruneExpiredResetTokens } from './auth/password-reset.service.js';
import { markAbsencesForPreviousDay } from './modules/time/absence.service.js';
import { reconcileRecentLeaveForAllCompanies } from './modules/leave/leave-reconciliation.service.js';
import { syncDueDevices } from './modules/attendance-device/sync.service.js';
import { verifyEmailProvider } from './core/mail/index.js';
import {
  processPushQueue,
  prunePushDeliveries,
  pushConfigured,
} from './core/notifications/push.service.js';

async function main(): Promise<void> {
  await assertDatabaseConnection();

  const app = await buildApp();

  // Background work - the device sync in particular - runs outside any request,
  // so it needs the application logger rather than a second one of its own.
  useLogger(app.log);

  // A broken mail configuration is reported but never blocks startup - in-app
  // notifications keep working regardless.
  await verifyEmailProvider(app.log);

  /**
   * Bring the permission catalogue up to date with this build, before the
   * first request is served.
   *
   * Migrations have already run by the time the process starts - the deploy
   * applies them against a one-off container - so the tables are whatever this
   * release expects. Additive only: it inserts the permissions the code
   * defines and grants system roles the defaults they lack, and revokes
   * nothing. Idempotent, so every subsequent boot is a no-op.
   */
  await syncPermissionCatalogueAtBoot(app.log);

  // Housekeeping: clear long-expired sessions and reset tokens at boot, then
  // once a day.
  const prune = async () => {
    try {
      const removed = await pruneExpiredSessions();
      if (removed > 0) app.log.info({ removed }, 'pruned expired sessions');

      const tokens = await pruneExpiredResetTokens();
      if (tokens > 0) app.log.info({ removed: tokens }, 'pruned expired reset tokens');

      // Finalise yesterday: anyone with no record on a working day is recorded
      // absent. Idempotent, so running it again on the next boot is harmless.
      for (const run of await markAbsencesForPreviousDay()) {
        if (run.marked > 0) app.log.info({ ...run }, 'marked absences');
      }

      // Approved leave on a recent day that has attendance is given back.
      // Idempotent, and bounded to the last couple of days on purpose.
      const reversed = (await reconcileRecentLeaveForAllCompanies()).filter(
        (o) => o.result === 'REVERSED',
      );
      if (reversed.length > 0) app.log.info({ reversed }, 'reconciled leave against attendance');

      const pushes = await prunePushDeliveries();
      if (pushes > 0) app.log.info({ removed: pushes }, 'pruned finished browser push deliveries');
    } catch (error) {
      app.log.error({ err: error }, 'housekeeping prune failed');
    }
  };
  await prune();
  const pruneTimer = setInterval(() => void prune(), 24 * 60 * 60 * 1000);
  pruneTimer.unref();

  /**
   * Attendance terminals.
   *
   * Ticks every minute and syncs whichever devices are due by their own
   * interval, so one terminal on a five-minute schedule and another on an hour
   * do not need separate timers. A device that is unreachable is logged and
   * retried on the next tick; it never stops the loop, because a terminal being
   * down is an ordinary Tuesday rather than an exceptional condition.
   */
  const syncDevices = async () => {
    try {
      // Each run logs its own SYNC_* events; nothing to add here beyond making
      // sure a thrown error never escapes the timer.
      await syncDueDevices();
    } catch (error) {
      app.log.error({ err: error }, 'attendance device sync tick failed');
    }
  };
  const deviceTimer = setInterval(() => void syncDevices(), 60 * 1000);
  deviceTimer.unref();

  /**
   * Browser push.
   *
   * A notification kicks the worker the moment it is queued, so this tick is
   * for what that cannot cover: retries whose backoff has elapsed, and anything
   * queued just before a restart. Off entirely when no VAPID keys are set.
   */
  app.log.info(
    { configured: pushConfigured() },
    pushConfigured()
      ? 'browser push is configured'
      : 'browser push is off: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are not set',
  );
  const pushTimer = setInterval(() => {
    processPushQueue().catch((error: unknown) =>
      app.log.error({ err: error }, 'browser push tick failed'),
    );
  }, 30 * 1000);
  pushTimer.unref();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(pruneTimer);
    clearInterval(deviceTimer);
    clearInterval(pushTimer);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  app.log.info(`API ready at http://${env.API_HOST}:${env.API_PORT}/api/v1`);
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
