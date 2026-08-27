import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Environment is validated once, at boot. A missing or malformed variable stops
 * the process with a readable message instead of surfacing as a null-pointer
 * three layers deep at request time.
 */

const here = dirname(fileURLToPath(import.meta.url));

// Walk up until we find the monorepo root .env, so the API works whether it is
// started from the repo root or from apps/api.
function findEnvFile(): string | undefined {
  let dir = here;
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, '..');
  }
  return undefined;
}

const envFile = findEnvFile();
if (envFile) loadDotenv({ path: envFile });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required. Run: npm run db:setup'),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters.'),
  SESSION_COOKIE_NAME: z.string().default('hrms_sid'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(8),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  if (!envFile) {
    // eslint-disable-next-line no-console
    console.error('No .env file was found. Copy .env.example to .env and try again.\n');
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
