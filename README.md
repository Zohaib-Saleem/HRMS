# HRMS

An independent human resources management platform. Built from scratch — no third-party
application code, branding or data is used.

**Status:** Phase 1 (foundation) complete.

---

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 20+ | Developed on 24.18.0 |
| npm | 10+ | Workspaces are used; pnpm/yarn are not required |
| PostgreSQL | 14+ | Developed against a local PostgreSQL 18 service |

---

## First-time setup

```bash
npm install
```

```bash
cp .env.example .env
```

Create the application database and role. The script prompts for your PostgreSQL
**superuser** password — it is used only for this one command and is never stored.

```bash
npm run db:setup
```

Apply the schema and load development data:

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

---

## Running it

```bash
npm run dev
```

| Service | URL |
| --- | --- |
| Web app | http://localhost:5173 |
| API | http://127.0.0.1:4000/api/v1 |
| Health check | http://127.0.0.1:4000/health |

The web dev server proxies `/api` to the API, so the browser stays on one origin and the
session cookie behaves exactly as it would in production.

### Development account

```
email     admin@hrms.local
password  Admin@12345
```

Created by the seed script. **Local development only** — never reuse these credentials
anywhere else, and never seed this account outside a development machine.

---

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | Runs the API and web app together |
| `npm run build` | Production build of every workspace |
| `npm run typecheck` | Type-checks every workspace |
| `npm run db:setup` | Creates the database and application role (one time) |
| `npm run db:migrate` | Creates and applies a migration |
| `npm run db:seed` | Loads development data (idempotent) |
| `npm run db:reset` | Drops, re-migrates and re-seeds — destroys local data |
| `npm run db:studio` | Opens Prisma Studio to browse the database |

---

## Layout

```
packages/shared     Zod schemas, permission registry and types shared by both apps
apps/api            Fastify + Prisma REST API
apps/web            React + Vite single-page application
scripts             One-off setup scripts
docs                Architecture notes and the feature roadmap
```

See [docs/architecture.md](docs/architecture.md) for the design decisions behind this
structure and [docs/roadmap.md](docs/roadmap.md) for what is planned next.

---

## Adding a module

The architecture is designed so a new HRMS module touches four files, not forty:

1. Add the model to `apps/api/prisma/schema.prisma`, then `npm run db:migrate`.
2. Add its permissions to `packages/shared/src/permissions.ts`.
3. Add `apps/api/src/modules/<name>/<name>.routes.ts` and register it in
   `apps/api/src/modules/index.ts`.
4. Add the screen under `apps/web/src/features/<name>/` and an entry in
   `apps/web/src/navigation/nav-config.ts`.

Auditing, error handling, pagination and permission enforcement come from the core layer
and do not need to be re-implemented per module.
