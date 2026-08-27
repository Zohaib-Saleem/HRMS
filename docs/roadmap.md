# Roadmap

Modules are built one phase at a time and reviewed before the next begins. Nothing below
phase 1 is started without explicit approval.

## Phase 1 — Foundation ✅

Application shell, authentication, role and permission system, company settings, database
and migrations, audit logging, and the error/loading/empty state conventions every later
screen reuses.

## Phase 2 — Employee Management

- Employee list: search, filter by department, team, status and employment type, pagination
- Create, edit and deactivate employees via drawer forms
- Department and team CRUD, promoting the current read-only endpoints
- Manager assignment and a reporting-line view
- Employee detail page with tabs, ready for later modules to add their own

## Phase 3 — Attendance and Shifts

Clock in/out, shift definitions and assignment, daily and monthly timesheets, late and
overtime derivation, manual correction with an audit trail.

## Phase 4 — Leave and Holidays

Leave types and accrual policies, balances, request and approval workflow, holiday
calendars, and a team leave calendar.

## Phase 5 — Documents

Employee document storage with expiry tracking and reminders. Needs a storage decision:
local disk versus object storage.

## Phase 6 — Payroll

Salary structures, allowances and deductions, payroll runs, payslip generation, and
integration with attendance and leave data.

## Phase 7 — Performance and Expenses

Review cycles, goals and appraisals; expense claims and approval.

## Phase 8 — Reporting and Analytics

Report builder, exports, headcount and attrition analytics, notification system, and
scope-based permissions (own / team / department / company) layered onto the existing
permission model.

---

## Decisions still open

- **Desktop application.** The web app runs unchanged inside Electron or Tauri. Worth doing
  once the feature set justifies it; Tauri needs a Rust toolchain installed first.
- **Multi-company.** The schema supports it; the UI does not expose it. Turning it on needs a
  company switcher and tenant scoping in the session resolver.
- **File storage.** Required before phase 5.
- **Email delivery.** Required for invitations and password reset, which are not yet built.
- **The reference feature map.** The original analysis was not saved to disk. It should be
  captured in `docs/feature-map.md` before phase 2 scoping.
