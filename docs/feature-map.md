# Feature Map

**Source of truth for HRMS development.** Every feature below is classified so scope
decisions are explicit rather than implied.

---

## About this document

Derived from a structural review of the reference system the company currently runs
(Zoho People, `shopdev` tenant), carried out on 27 August 2026 with Super Administrator
access.

**What was recorded:** module structure, screen inventory, field labels, configuration
options, permission concepts, workflow shapes, report catalogue.

**What was deliberately not recorded:** employee names, emails, identity numbers, bank
details, salary figures, leave balances, documents, or any other personal or confidential
data; the reference system's source code, markup, styling, branding or assets; the
company's internal department list. Nothing in the reference was modified.

This is a **requirements document, not a clone specification.** Our system is an
independent implementation. Where our own design is better, our design wins — those
divergences are recorded in [§13](#13-where-we-deliberately-diverge).

### Classification

| Mark | Meaning |
| --- | --- |
| **KEEP** | Required for our HRMS. Scheduled into a phase. |
| **OPTIONAL** | Useful later. Not scheduled; revisit when the core is stable. |
| **EXCLUDE** | Not required. Reasoning given. |

### Reference tenant scale

Small org — 10 of 15 user licenses in use, ~25 departments, single location. This matters:
the reference is configured for a small company, so heavyweight enterprise features are
mostly unused there and should not be assumed necessary here.

---

## 1. Navigation and module map

The reference uses three navigation planes at once. Ours uses one, deliberately — see §13.

**Plane 1 — module rail (left):** Home, Leave Tracker, Time Tracker, Attendance, Files,
Organization, Travel, More, Operations, Reports

**Plane 2 — context tabs (top):** My Space / Team / Organization — a *data scope* switch
repeated inside most modules

**Plane 3 — screen tabs:** per-module sub-screens

**Additional planes:** Settings (admin configuration), Operations (bulk data administration),
and a Cliq-style social bar (Chats, Channels, Threads, Contacts).

### Complete module inventory

| Module | Enabled in reference | Classification |
| --- | --- | --- |
| Employee Information (employees, departments, designations) | Yes | **KEEP** |
| Leave Tracker | Yes | **KEEP** |
| Attendance | Yes | **KEEP** |
| Shifts | Yes | **KEEP** |
| Time Tracker (time logs, timesheets, jobs, projects) | Yes | **OPTIONAL** |
| Files / Documents | Yes | **KEEP** |
| Reports & Analytics | Yes | **KEEP** |
| Approvals engine | Yes | **KEEP** |
| Automation / workflow engine | Yes | **OPTIONAL** |
| Onboarding | Yes | **OPTIONAL** |
| Employee Exit / offboarding | Yes | **OPTIONAL** |
| Compensation | Yes (form-based only) | **KEEP** (as real payroll — see §7) |
| Cases / HR help desk | Yes | **OPTIONAL** |
| Tasks | Yes | **OPTIONAL** |
| Travel | Yes | **EXCLUDE** |
| Office Readiness (health / vaccination) | Yes | **EXCLUDE** |
| Announcements & Policies | Yes | **OPTIONAL** |
| Org / Department / Employee tree | Yes | **KEEP** |
| Operations (bulk admin console) | Yes | **OPTIONAL** |
| Data Administration (import/export/audit) | Yes | **KEEP** |
| Social feeds, Chats, Channels, Threads | Yes | **EXCLUDE** |
| Performance / Appraisals | **No** | **KEEP** (our own requirement) |
| Recruitment / ATS | **No** | **EXCLUDE** |
| Expenses | **No** | **OPTIONAL** (our own requirement) |
| Learning / LMS | No | **EXCLUDE** |
| Marketplace, Developer Space, Zia AI | Yes | **EXCLUDE** |

> **Note:** Performance and Expenses are **not present in the reference.** They were on our
> own roadmap. They stay in scope as our own requirements, but their design must be
> specified by you — there is nothing to derive them from.

---

## 2. Organization & company structure

### Screens observed

- Organization Details — company profile
- Organization Policy
- Organization Structure
- Locations
- Departments
- Designations
- Domains and Rebranding · From Addresses · Email Authentication

### Company fields

Company name, website, industry, contact person, contact number, contact email,
address lines, location.
**KEEP** — already built in Phase 1.

### Department

| Field | Classification |
| --- | --- |
| Department Name | **KEEP** |
| Department Lead | **KEEP** |
| **Parent Department** (hierarchy) | **KEEP** |
| Mail Alias | **OPTIONAL** |
| Added By / Added time / Modified By / Modified time | **KEEP** (we already audit) |

CRUD: create, read, update, delete. **KEEP** — Phase 2.

### Designation

A first-class record, not a free-text job title. Employees reference it.
**KEEP** — Phase 2. This is a change from our Phase 1 schema, where `jobTitle` is free text.

### Teams

The reference has **no Team entity** — it models sub-structure through *parent departments*.
Our Phase 1 schema already has `Department → Team`.
**KEEP our two-level model**, and add `parentDepartmentId` for deeper nesting. See §13.

### Locations

Physical work locations; employees are assigned one. Drives holiday calendars, shifts and
attendance policies downstream.
**KEEP** — Phase 2.

### Other org structures observed

| Feature | Classification |
| --- | --- |
| Business Unit | **OPTIONAL** |
| Division | **OPTIONAL** |
| Streams (grouping of designations) | **EXCLUDE** — disabled in reference too |
| Applicability groups (rule-based cohorts for policies) | **OPTIONAL** — needed once leave/attendance policies vary by cohort |

### Org views

| Screen | Classification |
| --- | --- |
| Department Directory (search departments → head + member cards) | **KEEP** |
| Department Tree | **KEEP** |
| Employee Tree (reporting hierarchy) | **KEEP** |
| New Hires | **OPTIONAL** |
| Birthday Folks | **OPTIONAL** |
| Announcements | **OPTIONAL** |
| Policies (document library) | **OPTIONAL** |
| Organization Calendar | **OPTIONAL** |

---

## 3. Employee management

### Employee record — observed field groups

**Basic Info** — Employee ID*, First Name*, Last Name*, Official Email*, Photo, Nick Name,
Added/Modified By, Added/Modified time. **KEEP**

**Work** — Department, Designation, Reporting To, Secondary Reporting To (dual reporting),
Date of joining, Date of confirmation, Employee status, Employee type, Resignation Date,
Source of hire, Internship End Date, Business Unit, Division, Stream, LinkedIn Profile.
**KEEP** except Business Unit / Division / Stream (**OPTIONAL**).

**Personal & contact** — Present Address, Permanent Address, Personal contact number,
Emergency Contact Name / Number / Relationship, Date of Birth, Gender, Blood Group,
Marital Status, Nationality, Tags. **KEEP**

**Identity & compliance** *(sensitive)* — CNIC / national ID number, scanned ID front,
scanned ID back, Passport number, Passport expiry, Visa number, Visa expiry,
Bank Account Number, Passport-size photo. **KEEP with restrictions** — see §11.

**Education & experience** — Last Completed Degree (file), Total Experience (years/months),
Experience With Company. **KEEP**

**Work Experience** (tabular/repeating section) — Previous Company, Job Title, From Date,
To Date. **KEEP** — establishes the need for repeating sub-record sections.

**Exit** — Resignation Date, Exit Remarks, Relieved By. **OPTIONAL** (offboarding phase)

**Health** — COVID vaccination status, certificate upload. **EXCLUDE** — pandemic-era.

### Operations

| Operation | Classification |
| --- | --- |
| Create / Read / Update employee | **KEEP** |
| Deactivate / terminate (soft) | **KEEP** |
| Hard delete | **EXCLUDE** — HR records must not vanish; terminate instead |
| Bulk import (CSV) | **KEEP** — later phase |
| Bulk export | **KEEP** — permission-gated |
| Employee ID auto-generation with configurable prefix | **KEEP** |
| Configurable Employee Status values | **KEEP** |
| Dual reporting manager | **KEEP** |
| Profile photo upload | **KEEP** |
| Custom fields / form builder | **EXCLUDE** — see §13 |

### List, search, filter, sort

Observed on the user list: sortable columns (name, date of joining), filter panel, search,
import, export, pagination, row actions, bulk selection via checkboxes.

Columns: photo + employee number + name + email, date of joining, roles, location,
employee status, account status, actions. **KEEP — all of it.**

### Employee ↔ User separation

The reference tracks **Employee status** (Active / Terminated) separately from
**Account status** (Login Enabled / Disabled / Invited / Downgraded).
**KEEP** — this validates the `User` / `Employee` split already built in Phase 1.

---

## 4. Attendance

| Feature | Classification |
| --- | --- |
| Check-in / check-out with timestamp | **KEEP** |
| Check-out notes | **KEEP** |
| Location mode (Office / Remote) | **KEEP** |
| Attendance Summary — list, tabular and calendar views | **KEEP** |
| Week / month period navigation | **KEEP** |
| Per-day status: Present / Absent / Weekend / Holiday | **KEEP** |
| Hours worked per day; Days vs Hours toggle | **KEEP** |
| **Regularization** — request correction of a wrong entry, with approval | **KEEP** |
| Attendance Policy (grace, half-day rules, minimum hours) | **KEEP** |
| Overtime policies | **OPTIONAL** |
| Specific policies (per cohort) | **OPTIONAL** |
| Team view — reportees' attendance | **KEEP** |
| Absent auto-scheduler (marks absentees automatically) | **KEEP** |
| Pay period definition | **KEEP** — needed by payroll |
| Biometric / FTP device import | **BUILT** — ZKTeco pull and ADMS push; see docs/attendance-devices.md |
| IP / geo-restricted check-in | **OPTIONAL** |

---

## 5. Shifts

| Feature | Classification |
| --- | --- |
| Manage Shifts (named shift, start/end time) | **KEEP** |
| Employee ↔ shift assignment | **KEEP** |
| Shift Patterns | **OPTIONAL** |
| Auto Shift Assignment | **OPTIONAL** |
| Shift Rotation automation | **OPTIONAL** |
| Shift change approval | **OPTIONAL** |

Reference runs a single default shift (09:00–18:00). Start simple.

---

## 6. Leave management

| Feature | Classification |
| --- | --- |
| Leave types, configurable per company | **KEEP** |
| Leave balance per type per year (Available / Booked) | **KEEP** |
| Apply for leave (request) | **KEEP** |
| Approval workflow | **KEEP** |
| Leave Summary — list and calendar views | **KEEP** |
| Year period navigation | **KEEP** |
| Team availability calendar | **KEEP** |
| Holiday calendar | **KEEP** |
| Location-specific holidays | **KEEP** |
| Work calendar / weekend definition | **KEEP** |
| Leave accrual and carry-forward policy | **KEEP** |
| Loss of pay (unpaid leave) tracking | **KEEP** — feeds payroll |
| Compensatory off | **OPTIONAL** |
| Leave encashment | **OPTIONAL** |
| Negative balance permission | **OPTIONAL** |

Leave types observed are the standard set: annual, casual, sick, unpaid, parental.
Ours must be **configurable, not hard-coded**.

---

## 7. Payroll and compensation

The reference's **Compensation module is form-based only** — it stores compensation records
as custom forms. There is **no payroll engine** in this tenant (Zoho Payroll is a separate
product that is not enabled).

So the reference gives us **integration requirements, not a payroll design**:

- `Leave data for payroll` report
- `Attendance data for payroll` report
- `Timesheet data for payroll` report
- Pay Period defined in three separate modules
- Loss-of-pay tracking in leave

| Feature | Classification |
| --- | --- |
| Salary structure (basic + allowances + deductions) | **KEEP** |
| Payroll run per pay period | **KEEP** |
| Payslip generation | **KEEP** |
| Loss-of-pay integration from leave | **KEEP** |
| Attendance-driven pay calculation | **KEEP** |
| Pay period configuration | **KEEP** |
| Compensation history per employee | **KEEP** |
| Tax computation | **OPTIONAL** — jurisdiction-specific, needs your input |
| Bank transfer file export | **OPTIONAL** |
| Statutory filings | **EXCLUDE** — out of scope |

> **Decision needed from you:** payroll must be designed from your actual rules
> (pay cycle, allowance/deduction types, tax treatment). Nothing usable can be derived
> from the reference.

---

## 8. Documents and files

| Feature | Classification |
| --- | --- |
| Employee document storage | **KEEP** |
| Company-wide document library | **KEEP** |
| Document categories / folders | **KEEP** |
| Acknowledgement receipts (employee confirms they read a document) | **OPTIONAL** |
| Consent receipts | **OPTIONAL** |
| Document expiry tracking (passport, visa, ID) | **KEEP** — fields already imply it |
| E-signature | **EXCLUDE** |

---

## 9. Approvals

Every service in the reference has its own **Approvals** configuration — it is a
cross-cutting engine, not a per-module feature.

Approval-driven records observed: leave requests, attendance regularization, shift changes,
timesheets, compensation records, onboarding, employee exit, travel, employee profile edits.

| Feature | Classification |
| --- | --- |
| Generic approval engine reusable by any module | **KEEP** |
| Multi-level approval chains | **KEEP** |
| Approver = reporting manager (dynamic) | **KEEP** |
| Approver = named role | **KEEP** |
| Approve / reject with comment | **KEEP** |
| Pending-approvals inbox | **KEEP** |
| Approval history on the record | **KEEP** |
| Conditional routing by criteria | **OPTIONAL** |
| Auto-approval after N days | **OPTIONAL** |
| Delegation of approval authority while away | **OPTIONAL** |

**Architectural consequence:** build the approval engine as shared infrastructure in
`core/`, the way audit logging already is — before the first module needs it.

---

## 10. Reports and analytics

Scoped three ways, mirroring the permission model: **My Reports / Team Reports /
Organization Reports**, plus Analytics and Schedulers.

### Catalogue observed

**Employee Information** — Dashboard, Headcount, Employee addition trend, Employee attrition
trend, Distribution, Diversity, Experience-wise exit

**Leave** — Daily leave status, Resource availability, Employee leave balance, Leave booked
and balance, Leave type-wise summary, Leave encashment details, Loss of pay details,
Leave data for payroll

**Attendance** — Daily attendance status, Early/late check-in and check-out, Employee
present/absent status, Presence hours break-up, Attendance data for payroll, Muster roll,
Consecutive absences

**Time Tracker** — Time logs, Jobs status, Projects status, Logged hours for clients,
Employee logged hours, Scheduled vs worked hours, Timesheet data for payroll

**Files** — Acknowledgement receipts, Consent receipts

| Feature | Classification |
| --- | --- |
| Headcount, addition and attrition trends | **KEEP** |
| Department / designation distribution | **KEEP** |
| Daily attendance and leave status | **KEEP** |
| Payroll extract reports (leave, attendance) | **KEEP** |
| Muster roll | **KEEP** |
| Consecutive absences | **KEEP** |
| Scope-aware reports (my / team / organization) | **KEEP** |
| Export CSV / XLSX | **KEEP** |
| Report access permissions | **KEEP** |
| Scheduled report delivery by email | **OPTIONAL** |
| Diversity reporting | **OPTIONAL** |
| Custom report builder | **OPTIONAL** |
| Time-tracker / project reports | **OPTIONAL** |

---

## 11. Roles and permissions

The most architecturally significant finding. The reference uses a **four-dimensional**
model, richer than our current flat permission strings.

### Dimensions

1. **Role** — General Role (org-wide) or Specific Role (scoped to a department/location),
   plus Specific Role Assignment and a separate Administrator designation
2. **Form / module** — permissions are set per record type
3. **Operation** — View, Edit, Add, Delete
4. **Data scope** — **No Data · My Data · Reportees' Data · Reportees + My Data · All Data**

### Additional layers

| Layer | Classification |
| --- | --- |
| **Record permissions** (role × form × operation → scope) | **KEEP** |
| **Field permissions** (per field: view / edit, per role) | **KEEP** — mandatory for salary, CNIC, bank details |
| **Import and Export permissions** | **KEEP** |
| **Tabular section permissions** | **OPTIONAL** |
| Function-based permissions | **OPTIONAL** |
| Applicability groups | **OPTIONAL** |

### Consequence for our architecture

Phase 1 shipped flat permission strings (`employee.read`). That is **not sufficient** —
a manager must see their reportees but not the whole company, and no manager should see
another employee's bank details.

**Plan:** keep the permission-string registry as the operation layer, and add an orthogonal
**scope** dimension plus a **field-visibility** layer. This extends the existing model
rather than replacing it — `requirePermission()` gains a scope resolver, and list queries
gain a scope-derived `where` clause.

**Scheduled into Phase 2** (scope) and **Phase 8** (field-level), because employee records
are exactly where both first matter.

---

## 12. Cross-cutting features

| Feature | Classification |
| --- | --- |
| Audit trail (Added By / Added time / Modified By / Modified time on every record) | **KEEP** — already built |
| Data Administration console (bulk import/export, data cleanup) | **KEEP** |
| Notifications — in-app bell with unread count | **KEEP** |
| Email notifications | **KEEP** |
| Global search across modules | **KEEP** |
| Quick Actions (global create button) | **OPTIONAL** |
| Dashboards per module | **KEEP** |
| Calendar views | **KEEP** |
| Automation / workflow engine (triggers, scheduled actions, reminders) | **OPTIONAL** |
| Employee self-service portal | **KEEP** — our "My Space" equivalent |
| Delegation (hand duties to a colleague while away) | **OPTIONAL** |
| Multi-language | **EXCLUDE** |
| Mobile app | **EXCLUDE** |
| Social feed / chat / channels | **EXCLUDE** — Slack/Teams already do this |
| Marketplace / third-party integrations | **EXCLUDE** |
| AI assistant | **EXCLUDE** |
| Custom form builder | **EXCLUDE** — see §13 |
| Web forms (public form embedding) | **EXCLUDE** |
| Rebranding / custom domains | **EXCLUDE** |

---

## 13. Where we deliberately diverge

Independent decisions. These are **not** oversights.

**1. One navigation plane, not three.**
The reference repeats a My/Team/Organization scope switch across three separate navigation
levels, so the same data is reachable several ways. We use a single sidebar plus an explicit
scope control inside each screen. Fewer places to look, less to learn.

**2. No custom form builder.**
The reference lets admins add arbitrary fields and forms at runtime. That is a product
requirement for a multi-tenant SaaS; for a single company it buys flexibility at the cost of
a weakly typed schema, unreliable reporting and a permanent migration problem. We use a
typed schema with proper migrations. If genuinely dynamic attributes are needed later, we
add a scoped custom-attributes table — not a whole form engine.

**3. Teams stay, and departments gain a parent.**
The reference has no Team entity, only nested departments. Our `Department → Team` model is
clearer for the common case, so it stays; we add `parentDepartment` for deeper nesting.

**4. Designation becomes a real entity.**
Phase 1 used free-text `jobTitle`. The reference is right here — a lookup table gives clean
reporting and consistent naming. Phase 2 migrates it.

**5. Approvals are core infrastructure from the start.**
The reference bolts a separate approval configuration onto each module. We build one engine
in `core/`, as we did with auditing, so every module inherits it.

**6. No hard delete of HR records.**
Terminate and archive. HR data has legal retention requirements.

**7. Sensitive fields are restricted by default.**
National ID, bank account, passport, visa and salary are readable only with an explicit
grant, and every read of them is audited. The reference makes this possible; we make it
the default.

**8. No social layer.**
Chat, channels and feeds duplicate tools the company already has.

---

## 14. Requirements with no reference source

These are **our own requirements**. The reference cannot inform them, so they need your
specification before they are built:

| Area | What is needed from you |
| --- | --- |
| **Payroll** | Pay cycle, salary components, allowance and deduction types, tax treatment, payslip format |
| **Performance** | Review cycle length, rating scale, goal/KPI model, who reviews whom |
| **Expenses** | Expense categories, claim limits, approval chain, reimbursement process |
| **Leave policy** | Accrual rates, carry-forward caps, probation rules, encashment |
| **Attendance policy** | Grace period, half-day threshold, minimum hours, overtime eligibility |

---

## 15. Open questions

1. **Locations** — the reference has one. Do you need multi-location holiday calendars and
   attendance policies, or is a single location enough for now?
2. **Time Tracker** — project/client time logging is enabled in the reference but appears to
   serve billing. Do you need it, or is attendance sufficient?
3. **Onboarding / Exit** — enabled in the reference. Worth building, or handled outside the
   system?
4. **Cases / HR help desk** — worth building, or is email enough?
5. **Document retention** — how long must records be kept after termination?
