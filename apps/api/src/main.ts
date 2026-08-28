import { buildApp } from './app.js';
import { env } from './config/env.js';
import { assertDatabaseConnection, prisma } from './core/db.js';
import { pruneExpiredSessions } from './auth/session.js';
import { pruneExpiredResetTokens } from './auth/password-reset.service.js';
import { markAbsencesForPreviousDay } from './modules/time/absence.service.js';
import { syncDueDevices } from './modules/attendance-device/sync.service.js';
import { verifyEmailProvider } from './core/mail/index.js';

async function main(): Promise<void> {
  await assertDatabaseConnection();

  const app = await buildApp();

  // A broken mail configuration is reported but never blocks startup - in-app
  // notifications keep working regardless.
  await verifyEmailProvider(app.log);

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
      for (const outcome of await syncDueDevices()) {
        if (outcome.status === 'FAILED') {
          app.log.warn(
            { deviceId: outcome.deviceId, error: outcome.error },
            'attendance device sync failed',
          );
        } else if (outcome.inserted > 0 || outcome.unmapped > 0) {
          app.log.info(
            {
              deviceId: outcome.deviceId,
              fetched: outcome.fetched,
              inserted: outcome.inserted,
              duplicates: outcome.duplicates,
              unmapped: outcome.unmapped,
              rejected: outcome.rejected,
              recalculatedDays: outcome.recalculatedDays,
            },
            'attendance device sync',
          );
        }
      }
    } catch (error) {
      app.log.error({ err: error }, 'attendance device sync tick failed');
    }
  };
  const deviceTimer = setInterval(() => void syncDevices(), 60 * 1000);
  deviceTimer.unref();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(pruneTimer);
    clearInterval(deviceTimer);
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
