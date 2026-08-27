import { buildApp } from './app.js';
import { env } from './config/env.js';
import { assertDatabaseConnection, prisma } from './core/db.js';
import { pruneExpiredSessions } from './auth/session.js';

async function main(): Promise<void> {
  await assertDatabaseConnection();

  const app = await buildApp();

  // Housekeeping: clear long-expired sessions at boot and once a day after.
  const prune = async () => {
    try {
      const removed = await pruneExpiredSessions();
      if (removed > 0) app.log.info({ removed }, 'pruned expired sessions');
    } catch (error) {
      app.log.error({ err: error }, 'session prune failed');
    }
  };
  await prune();
  const pruneTimer = setInterval(() => void prune(), 24 * 60 * 60 * 1000);
  pruneTimer.unref();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(pruneTimer);
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
