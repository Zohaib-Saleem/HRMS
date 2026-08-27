import { PrismaClient } from '@prisma/client';
import { env, isDevelopment } from '../config/env.js';

/**
 * One Prisma client for the process. In dev, `tsx watch` reloads the module
 * graph on every save, so the instance is cached on globalThis to avoid
 * exhausting Postgres connections after a few dozen edits.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isDevelopment ? ['warn', 'error'] : ['error'],
    datasources: { db: { url: env.DATABASE_URL } },
  });

if (isDevelopment) globalForPrisma.prisma = prisma;

/** Fails fast at boot with an actionable message rather than on first request. */
export async function assertDatabaseConnection(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      [
        'Could not connect to the database.',
        '',
        `  ${message}`,
        '',
        'Checklist:',
        '  1. Is the PostgreSQL service running?  (services.msc -> postgresql-x64-18)',
        '  2. Has the database been created?      npm run db:setup',
        '  3. Have migrations been applied?       npm run db:migrate',
        '  4. Does DATABASE_URL in .env match?',
        '',
      ].join('\n'),
    );
  }
}

export type Db = typeof prisma;
