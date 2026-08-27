# Architecture

Notes on why the system is put together the way it is. Kept short on purpose — the code is
the specification, this is the reasoning.

## Stack

| Layer | Choice | Reason |
| --- | --- | --- |
| Monorepo | npm workspaces | npm is already present; no extra package manager to install |
| API | Fastify + TypeScript | Plugin encapsulation maps cleanly onto feature modules |
| ORM | Prisma | First-class migrations, readable relational schema, generated types |
| Database | PostgreSQL | Exact numerics for payroll, `timestamptz` for attendance, JSONB for audit diffs |
| Web | React + Vite | Fast iteration, no framework-level routing constraints |
| Styling | Tailwind CSS v4 + Radix primitives | Semantic tokens in one file; components owned in-repo, not vendored |
| Server state | TanStack Query | Caching, retry policy and loading/error states without hand-rolled reducers |
| Validation | Zod in `packages/shared` | The same schema validates the request and the form |

Deliberately deferred: a desktop wrapper (the web app runs unchanged inside Electron or
Tauri later), background job processing, and file storage.

## Shared contract

`packages/shared` is the seam between the two apps. It holds the permission registry, the
Zod DTOs and the response types. Because both sides import the same module, a renamed field
or a mistyped permission is a compile error rather than a runtime 403.

It compiles to `dist/` before either app starts — `npm run dev` handles this.

## Data model

Three decisions are worth calling out.

**`User` and `Employee` are separate tables.** A login account and an HR record are not the
same thing: contractors and administrators may have one without the other. They are linked
1:1 through an optional `Employee.userId`.

**`companyId` exists on every business table.** The UI assumes a single company today, but
the column is there from the first migration. Adding a second company later becomes a
scoping change rather than a rewrite of every table and query.

**Sessions are rows, not tokens.** The cookie carries an opaque 32-byte value; only its
SHA-256 hash is stored. This buys instant revocation — sign-out-everywhere, disable a
departing employee, invalidate on password change — which a stateless JWT cannot do without
reintroducing a server-side blocklist anyway.

## Request lifecycle

```
request
  -> onRequest hook resolves the session cookie into request.auth (or null)
  -> route preHandler: requirePermission(...) throws 403 if the grant is missing
  -> handler parses the body with a shared Zod schema (parseOrThrow)
  -> service does the work, writes an audit entry
  -> reply: { data } or { data, meta } for lists
  -> any throw lands in the single global error handler
```

Every failure leaves as `{ error: { code, message, details? } }`. Prisma errors, Zod errors
and thrown `AppError`s are all normalised in one place, so the client has exactly one shape
to handle.

## Authorisation

Permissions are flat strings (`employee.read`, `role.manage`) defined once in
`packages/shared/src/permissions.ts` and seeded into the `permissions` table. Roles map to
permissions through `role_permissions`; users hold roles through `user_roles`.

The session resolver flattens a user's roles into a `Set<Permission>` on every request.

- The API enforces with `requirePermission()` — this is the real gate.
- The web app hides what you cannot use with `<Can>` and the nav registry — this is a
  courtesy, never a control.

`SUPER_ADMIN` is marked `isProtected` and always holds every permission. It cannot be edited
through the API, which makes locking the whole company out of settings impossible.

## Auditing

One service (`core/audit.ts`) writes every entry, so any module added later inherits a
consistent trail for free. Writes are fire-and-forget — a failed audit insert logs loudly but
never fails the user's request. Sensitive keys are redacted centrally rather than at each
call site, so a new caller cannot accidentally persist a password hash.

`diff()` narrows `before`/`after` to only the fields that actually changed, which keeps the
log readable at scale.

## Frontend structure

- `components/ui` — primitives with no business knowledge
- `components/layout` — the shell: sidebar, top bar, breadcrumbs, user menu
- `components/feedback` — empty, error and loading states, plus the confirm dialog
- `features/<domain>` — screens, one folder per module
- `navigation/nav-config.ts` — the sidebar is generated from this, filtered by permission

Adding a module means adding a folder and a nav entry. No layout file needs editing.

## Known gaps

Tracked rather than hidden:

- The web bundle is a single ~600 kB chunk. Route-level code splitting is worth doing once
  there are more screens to split.
- Rate limiting is in-process, so it resets on restart and does not span replicas. Fine for
  a single-node deployment; needs a shared store beyond that.
- There is no automated test suite yet. The seam to test first is the permission guard.
