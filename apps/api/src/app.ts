import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env, isDevelopment } from './config/env.js';
import { registerErrorHandler } from './core/error-handler.js';
import { prisma } from './core/db.js';
import { resolveAuthContext } from './auth/session.js';
import { registerModules } from './modules/index.js';
import { admsRoutes } from './modules/attendance-device/adms.routes.js';

/**
 * The secret path segment a pushing terminal is configured with.
 *
 * Matched only when it is followed by one of the endpoints a device actually
 * calls, so an ordinary `/iclock/cdata` request keeps its readable URL.
 */
const PUSH_TOKEN_IN_PATH = /^\/iclock\/[^/?]+(?=\/(?:cdata|getrequest|devicecmd))/;

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(isDevelopment
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname,reqId' },
            },
          }
        : {}),
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      serializers: {
        // A pushing terminal carries its token in the URL path, because that is
        // the only place its firmware can put one. Logging the request line
        // verbatim would write that credential to disk on every poll.
        req(request) {
          return {
            method: request.method,
            url: String(request.url).replace(PUSH_TOKEN_IN_PATH, '/iclock/[redacted]'),
            remoteAddress: request.ip,
          };
        },
      },
    },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  registerErrorHandler(app);

  await app.register(helmet, {
    // The API serves JSON only; CSP belongs to whatever serves the web app.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: [env.WEB_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie, {
    secret: env.SESSION_SECRET,
    parseOptions: { sameSite: 'lax', path: '/' },
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Per-user when signed in, per-IP otherwise.
    keyGenerator: (request) => request.auth?.userId ?? request.ip,
  });

  // Resolve the session once per request. Guards read request.auth; routes that
  // do not need it simply ignore it.
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = await resolveAuthContext(request);
  });

  app.get('/health', async () => {
    let database: 'up' | 'down' = 'up';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }
    return {
      data: {
        status: database === 'up' ? 'ok' : 'degraded',
        database,
        uptimeSeconds: Math.round(process.uptime()),
        environment: env.NODE_ENV,
      },
    };
  });

  // Attendance terminals push to the server root, not the versioned API: the
  // path is set on the device itself and most firmware cannot express a prefix.
  // These routes carry no session; they authenticate the device instead.
  await app.register(admsRoutes);

  await app.register(registerModules, { prefix: '/api/v1' });

  return app;
}
