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

  /**
   * The address attendance terminals can reach this server on.
   *
   * Separate from API_HOST because that is usually 127.0.0.1, which a device on
   * the LAN cannot use. Only affects the URL shown to administrators; leaving it
   * unset does not stop a correctly configured device from pushing.
   */
  DEVICE_PUSH_ORIGIN: z.string().url().optional(),

  /**
   * Terminal serials whose records the bare `/connector` endpoint may store.
   *
   * A comma-separated allow-list, empty by default. A serial that is not listed
   * is authenticated and validated as normal and then answered 503 with nothing
   * written, so an agent holding a long backlog keeps it rather than delivering
   * it the moment a route appears. Releasing one terminal is a deliberate edit
   * here plus an API restart - there is no code path that opens ingest on its
   * own, and forgetting this setting holds records rather than releasing them.
   */
  CONNECTOR_INGEST_LIVE_SERIALS: z.string().optional(),

  // --- Mail -----------------------------------------------------------------
  // `console` writes the message to the log instead of sending it, which is the
  // right behaviour for development. Switching to `smtp` requires the SMTP_*
  // variables below; the refinement further down enforces that, so a
  // half-configured mail setup fails at boot rather than at first send.
  MAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().default('HRMS <no-reply@hrms.local>'),
  /// Base URL the web app is reachable at, used to build links inside emails.
  APP_URL: z.string().url().default('http://localhost:5173'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
});

/**
 * Mail configuration rules, all enforced at boot.
 *
 * Three separate mistakes, each of which would otherwise only surface the first
 * time somebody requested a password reset - by which point the link has
 * already gone somewhere it should not have, or nowhere at all:
 *
 *   - `smtp` without a host or port. Half a transport is not a transport.
 *   - `console` in production. The console provider writes the whole message
 *     body to the log and delivers nothing, so a production system running on
 *     it silently drops every password reset and approval while printing live
 *     reset links to disk. It is a development tool and the only safe thing to
 *     do with it in production is refuse to start.
 *   - a username with no password, or a password with no username. Nodemailer
 *     would authenticate with an empty string and the relay would reject every
 *     message, which reads in the logs like a network fault rather than a
 *     typo in the environment.
 */
const schemaWithMailRules = schema.superRefine((value, ctx) => {
  if (value.NODE_ENV === 'production' && value.MAIL_PROVIDER === 'console') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAIL_PROVIDER'],
      message:
        'MAIL_PROVIDER=console cannot be used when NODE_ENV=production: it delivers no mail and writes password reset links to the log. Set MAIL_PROVIDER=smtp and supply SMTP_HOST and SMTP_PORT.',
    });
  }

  // A username and a password only mean anything together. Checked for every
  // provider, so the mistake is caught even before SMTP is switched on.
  if (value.SMTP_USER && !value.SMTP_PASSWORD) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_PASSWORD'],
      message: 'SMTP_PASSWORD is required when SMTP_USER is set.',
    });
  }
  if (value.SMTP_PASSWORD && !value.SMTP_USER) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_USER'],
      message: 'SMTP_USER is required when SMTP_PASSWORD is set.',
    });
  }

  if (value.MAIL_PROVIDER !== 'smtp') return;
  if (!value.SMTP_HOST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_HOST'],
      message: 'SMTP_HOST is required when MAIL_PROVIDER=smtp.',
    });
  }
  if (!value.SMTP_PORT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_PORT'],
      message: 'SMTP_PORT is required when MAIL_PROVIDER=smtp.',
    });
  }
});

/**
 * Validates a candidate environment without touching `process.env` or exiting.
 *
 * Exported so the rules above can be tested directly. The module-level boot
 * path below is the only caller that turns a failure into `process.exit`.
 */
export function validateEnv(raw: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  return schemaWithMailRules.safeParse(raw);
}

const parsed = validateEnv(process.env);

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
