# Roadmap

Derived from [feature-map.md](feature-map.md), which is the source of truth for scope.
Only items marked **KEEP** are scheduled. **OPTIONAL** items sit in the backlog at the
bottom. **EXCLUDE** items are not listed at all.

One phase at a time. Each phase ends with a working, tested application and an approval
gate before the next begins.

---

## Phase structure

The suggested ordering was adjusted in three places, for reasons given below.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Foundation | ✅ Complete |
| 2 | Organization & Employees | ✅ Complete |
| 3 | Approvals engine & Notifications | ✅ Complete |
| 4 | Leave & Holidays | ✅ Complete |
| 5 | Attendance & Shifts | ✅ Complete |
| 6 | Documents | ← next |
| 7 | Payroll | |
| 8 | Advanced permissions & field security | |
| 9 | Reports & Analytics | |
| 10 | Performance | |
| 11 | Security hardening, testing & desktop packaging | |

### Why the order changed

**Approvals moved to Phase 3 (was: not scheduled).** The feature map shows approvals are
cross-cutting infrastructure — leave, attendance regularization, shift changes, timesheets
and profile edits all need the same engine. Building it once before the first consumer is
far cheaper than retrofitting it three times. Notifications ride along because an approval
nobody is told about is useless.

**Leave moved ahead of Attendance.** Leave is self-contained; attendance depends on holiday
calendars and leave status to decide whether an absence is authorised. Building attendance
first would mean building it twice.

**Performance moved to Phase 10 (was: 6).** It does not exist in the reference system, so
there are no derived requirements — it needs your specification first. Everything ahead of
it is fully specified.

**Expenses dropped from the numbered phases.** Also absent from the reference, and lower
value than the rest. Backlogged.

---

## Phase 1 — Foundation ✅

Application shell, authentication, role and permission system, company settings, database
and migrations, audit logging, and the error/loading/empty state conventions every later
screen reuses.

---

## Phase 2 — Organization & Employees ✅

**Schema**
- `Designation` as a first-class entity, replacing free-text `jobTitle`
- `Location` entity; employees assigned to one
- `parentDepartmentId` on Department for hierarchy
- Employee: expand to the full field set — personal, contact, emergency contact, identity,
  education, experience
- `EmployeeWorkExperience` child table (previous company, job title, from, to)
- Secondary reporting manager (dual reporting)
- Configurable employee statuses

**Organization**
- Department CRUD, with lead and parent department
- Team CRUD, scoped to a department
- Designation CRUD
- Location CRUD
- Department directory and department tree views

**Employees**
- Employee list: search, filter (department, team, designation, status, employment type,
  location), sortable columns, pagination
- Create / edit via drawer form, with validation shared between client and server
- Employee detail page with tabbed sections, extensible by later modules
- Terminate / reactivate — never hard delete
- Employee number auto-generation with configurable prefix
- Profile photo upload
- Reporting-line (employee tree) view

**Permissions**
- Introduce the **data scope** dimension: No data · My data · Reportees · Reportees + own ·
  All. This is the first module where scope actually matters.

**Cross-cutting**
- Audit logging on every mutation (inherited from core)
- Bulk CSV import/export, permission-gated

**Not in this phase:** attendance, leave, payroll, field-level permissions.

---

## Phase 3 — Approvals engine & Notifications ✅

- Generic, reusable approval engine in `core/` — any module can register an approvable record
- Multi-level chains; approver resolved as reporting manager or named role
- Approve / reject with comment; full approval history on the record
- Pending-approvals inbox
- In-app notification centre with unread count
- Email notification delivery
- First consumer: employee profile change requests

---

## Phase 4 — Leave & Holidays ✅

- Configurable leave types per company
- Accrual, carry-forward and balance tracking per type per year
- Leave request → approval (uses Phase 3 engine)
- Leave summary: list and calendar views
- Team availability calendar
- Holiday calendars, location-aware
- Work calendar and weekend definition
- Loss-of-pay tracking

---

## Phase 5 — Attendance & Shifts ✅

- Check-in / check-out with timestamp, notes and location mode (office / remote) ✅
- Attendance summary: list, tabular and calendar views ✅
- Daily status derivation: present / half-day / absent / weekend / holiday / on-leave ✅
- Hours-worked calculation ✅
- Regularization requests with approval, writing through to the record ✅
- Attendance policy: grace period, early-leave grace, half-day and full-day
  thresholds — all stored on the company and editable in settings ✅
- Overtime: configurable threshold and daily cap, stored per day as a labelled
  portion of worked minutes rather than time added to it ✅
- Absent auto-marking: nightly job plus an on-demand admin action, idempotent
  and never overwriting an existing record ✅
- Weekend configuration, read by both attendance and leave ✅
- Shift definitions and employee assignment ✅
- Team attendance view for managers, scoped by the existing data scope ✅
- Optional check-in geofence: per-location coordinates and radius, enforced on
  the server and off by default ✅
- Pay period configuration — **not built**, deferred to payroll

### Known limits carried forward

- `lateMinutes` and `earlyLeaveMinutes` are only computed when a shift is
  assigned; without one they stay null rather than guessing a start time.
- Overnight shifts (end at or before start) are not scored for early leave.
- The overtime threshold is the company value, not the assigned shift length.
- Timesheets are still independent of captured attendance.
- Date handling is UTC throughout, so "yesterday" in the nightly job means the
  previous UTC day.

---

## Phase 6 — Attendance depth ✅

Attendance was carried from "it works" to "it is configurable and auditable".

- Scoped attendance policies: named threshold sets assigned to an individual,
  a team, a department or the whole company, most specific winning ✅
- Effective dates on every assignment, so rescoring a past day uses the policy
  that was in force on that day rather than today's ✅
- Company baseline retained as the fallback, so a company that creates no
  policy behaves exactly as before ✅
- Check-in IP restriction: company-configurable allow-list of addresses and
  IPv4 CIDR ranges, enforced server-side and fail-closed ✅
- Attendance → timesheet: a draft timesheet can be filled from captured
  attendance, keeping manual lines and skipping days with no check-out ✅
- Pay-period data: worked, overtime, regular, day counts and exceptions per
  employee — figures only, no payroll calculation ✅
- Team attendance filtering by department and team, plus drill-through to one
  employee's calendar, history and the policy in force ✅

### Deliberately not built

- **Payroll calculation.** Phase 6 prepares the input; deciding what anyone is
  paid is a module nobody has specified.
- **Documents.** Moved to Phase 7 below. It needs a storage decision and has no
  dependency on the attendance work, so it was not started.

---

## Attendance terminals — ZKTeco integration ✅

Real biometric hardware feeding the existing attendance engine, rather than a
second attendance system beside it.

- ZKTeco standalone SDK protocol implemented from the wire format: framing,
  session handshake, comm-key authentication, chunked bulk transfer ✅
- Device registry, encrypted comm keys, connection test, device user listing
  and device-user-to-employee mapping ✅
- Raw punches stored verbatim and preserved, then paired into attendance days
  by the existing policy engine ✅
- Timezone handling rebuilt: `Company.timezone` was stored but never read, so
  every derived day was a UTC day. Punch instants now come from the device
  zone, working days from the company zone ✅
- A terminal simulator that speaks the real protocol over a real socket, so the
  adapter is exercised end to end without hardware ✅

## Phase 7 — Production reliability ✅

Hardening the integration before a physical device is connected.

- Persistent socket error handling: a failure after connect no longer risks an
  uncaught exception ✅
- Bounded retry with backoff, and the attempt count reported even on total
  failure ✅
- Cursor safety: the watermark never advances past a record that was not
  actually stored, so a failed import is retried rather than skipped ✅
- Per-record isolation: one malformed transaction costs its own import and
  nothing else, with permanent and retryable failures distinguished ✅
- Idempotent import, per-device sync locking, sync history with diagnostics ✅
- Manual attendance is never overwritten by a device sync ✅

**The physical K50 is still pending.** The reliability layer is ready for
physical-device testing; nothing here has been verified against real hardware.

## Phase 8 — ADMS push ✅

Terminals that post to the server instead of being polled, which is the only
way a device behind NAT or on a mobile link can be integrated.

- `/iclock` endpoints: configuration handshake, attendance push, command poll
  and command result — unauthenticated by necessity, gated on a registered
  serial, an optional encrypted path token and an optional network allow-list ✅
- The ATTLOG text format parsed tolerantly: spaces for tabs, `
`, short
  records and trailing fields all handled, with one bad line failing alone ✅
- Pushed batches go through the *same* ingest as polled ones — the pairing,
  scoring and duplicate rules are shared code, not a second copy ✅
- Push batches appear in the ordinary sync history with a `PUSH` trigger ✅
- The poll scheduler skips pushing devices, so a healthy terminal is no longer
  recorded as failing every interval ✅
- No route here can read data back out, and the server never issues a device
  command ✅

See `docs/attendance-devices.md` for setup.

---

## Later — Documents

- Employee document storage with categories
- Company-wide document library
- Expiry tracking and reminders for passport, visa and national ID
- Requires a **storage decision** — see open decisions

---

## Later — Payroll

Blocked on your specification (see feature map §14).

- Salary structures: basic, allowances, deductions
- Compensation history per employee
- Payroll runs per pay period
- Loss-of-pay integration from leave
- Attendance-driven calculation
- Payslip generation

---

## Phase 8 — Advanced permissions & field security

- Field-level permissions: per role, per field, view / edit
- Sensitive fields restricted by default: national ID, bank account, passport, visa, salary
- Every read of a sensitive field audited
- Import / export permissions
- Specific (department- or location-scoped) roles

---

## Phase 9 — Reports & Analytics

- Headcount, addition trend, attrition trend, distribution
- Daily attendance and leave status
- Muster roll, consecutive absences
- Payroll extract reports
- Scope-aware reporting (my / team / organization)
- CSV and XLSX export
- Report access permissions

---

## Phase 10 — Performance

Blocked on your specification (see feature map §14).

- Review cycles, goals/KPIs, ratings, appraisal workflow

---

## Phase 11 — Hardening, testing & packaging

- Automated test suite, starting with the permission guard
- Security review: rate limiting, session handling, sensitive-field access
- Route-level code splitting (the bundle is currently one ~600 kB chunk)
- Performance pass on list queries
- Desktop packaging, if still wanted

---

## Backlog (OPTIONAL — not scheduled)

Onboarding · Employee Exit · Cases / HR help desk · Tasks · Time Tracker with project and
client billing · Expenses · Automation and workflow engine · Announcements · Policy library ·
Compensatory off · Leave encashment · Shift patterns, rotation and auto-assignment ·
Overtime policies · Scheduled report delivery · Custom report builder · Delegation ·
Acknowledgement and consent receipts · Business Unit and Division · Applicability groups ·
New hires and birthday widgets · Operations bulk-admin console

---

## Open decisions

| Decision | Needed by | Notes |
| --- | --- | --- |
| **Payroll rules** | Phase 7 | Pay cycle, components, tax treatment, payslip format |
| **Performance model** | Phase 10 | Cycle, rating scale, goal model |
| **Document storage** | Phase 6 | Local disk vs object storage |
| **Email delivery** | Phase 3 | SMTP provider for notifications, invitations, password reset |
| **Multi-location** | Phase 2 | Reference has one location — do you need several? |
| **Multi-company** | — | Schema supports it; UI does not expose it |
| **Time Tracker** | — | Backlogged. Confirm whether project/client time logging is needed |
| **Desktop packaging** | Phase 11 | Tauri needs a Rust toolchain installed first |
