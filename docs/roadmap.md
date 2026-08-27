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
| 5 | Attendance & Shifts | ← next |
| 6 | Documents | |
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

## Phase 5 — Attendance & Shifts

- Check-in / check-out with timestamp, notes and location mode (office / remote)
- Attendance summary: list, tabular and calendar views
- Daily status derivation: present / absent / weekend / holiday / on-leave
- Hours-worked calculation
- Regularization requests with approval
- Attendance policy: grace period, half-day rules, minimum hours
- Absent auto-marking scheduler
- Shift definitions and employee assignment
- Team attendance view for managers
- Pay period configuration

---

## Phase 6 — Documents

- Employee document storage with categories
- Company-wide document library
- Expiry tracking and reminders for passport, visa and national ID
- Requires a **storage decision** — see open decisions

---

## Phase 7 — Payroll

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
