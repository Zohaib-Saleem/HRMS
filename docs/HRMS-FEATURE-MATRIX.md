# Feature status matrix

Status values are exactly four:

- **IMPLEMENTED** — built, reachable from the interface, covered by tests.
- **PARTIALLY IMPLEMENTED** — works, but with a named gap.
- **PENDING** — built but not yet exercised against the real world.
- **NOT IMPLEMENTED** — no table, no API, no screen.

Roles are the four seeded ones: Super Admin (SA), HR Admin (HR), Manager (MGR),
Employee (EMP). A role appears only if it holds the permission by default.

## Access and identity

| Feature | Status | Roles | Depends on | Notes |
|---|---|---|---|---|
| Sign in / sign out | IMPLEMENTED | all | — | Server-side sessions, 8h default TTL, 10 attempts / 5 min / IP |
| Password reset by email | IMPLEMENTED | all | mail provider | Falls back to logging the link when `MAIL_PROVIDER=console` |
| Change own password | IMPLEMENTED | all | — | `PATCH /me/password` |
| See and revoke own sessions | PARTIALLY IMPLEMENTED | all | — | Can list sessions and sign out everywhere; cannot revoke one named device |
| **Create a login account** | **NOT IMPLEMENTED** | — | — | `user.read`/`user.manage` exist and are grantable, but no API or screen. See limitations |
| Roles and permissions editor | IMPLEMENTED | SA, HR (read) | — | `role.manage` needed to change grants; only Super Admin holds it by default |
| Data scopes | IMPLEMENTED | — | — | NONE / OWN / REPORTS / REPORTS_AND_OWN / DEPARTMENT / ALL |

## Organisation

| Feature | Status | Roles | Depends on | Notes |
|---|---|---|---|---|
| Company profile | IMPLEMENTED | SA, HR | — | Name, address, timezone, currency, date format, week start |
| Timezone | IMPLEMENTED | SA, HR | — | Drives every attendance day boundary |
| Weekend days | IMPLEMENTED | SA, HR | — | Any combination of weekdays, not just Sat/Sun |
| Departments | IMPLEMENTED | SA, HR | — | Nestable, with an optional head |
| Teams | IMPLEMENTED | SA, HR | departments | |
| Designations | IMPLEMENTED | SA, HR | — | Job titles |
| Locations | IMPLEMENTED | SA, HR | — | Optional coordinates and geofence radius |
| Org chart | IMPLEMENTED | SA, HR, MGR | employees | Built from `managerId`; narrowed by data scope |

## People

| Feature | Status | Roles | Depends on | Notes |
|---|---|---|---|---|
| Add / edit employee | IMPLEMENTED | SA, HR | — | Only first and last name are required |
| Auto employee number | IMPLEMENTED | SA, HR | company prefix | Overridable |
| Restricted fields | IMPLEMENTED | SA, HR | — | National ID, passport, visa, bank account — stripped without `employee.sensitive.read` |
| Work experience sub-records | IMPLEMENTED | SA, HR | — | Prior employment history |
| Terminate employee | IMPLEMENTED | SA, HR | — | Suspends the login and revokes every session |
| Reactivate employee | PARTIALLY IMPLEMENTED | SA, HR | — | Restores the employee but **not** the login. See limitations |
| Employee CSV export | IMPLEMENTED | SA, HR | — | `employee.export` |
| Employee import | NOT IMPLEMENTED | — | — | `employee.import` is grantable but no endpoint exists |
| **Employee documents** | **NOT IMPLEMENTED** | — | — | No storage, no table, no screen |

## Time

| Feature | Status | Roles | Depends on | Notes |
|---|---|---|---|---|
| Shifts | IMPLEMENTED | SA, HR | — | Start, end, break minutes |
| Shift assignment | IMPLEMENTED | SA, HR | shifts, employees | Effective-dated |
| Shift change request | IMPLEMENTED | all | approval engine | Applied automatically on approval |
| Self check-in / check-out | IMPLEMENTED | all | shifts, policy | One pair per day |
| IP restriction on check-in | IMPLEMENTED | SA, HR configure | — | Off by default; fails closed when on |
| Geofence on check-in | IMPLEMENTED | SA, HR configure | locations with coordinates | Off by default; fails closed when on |
| Attendance calculation | IMPLEMENTED | — | shifts, policy | Late, early leave, overtime, half day |
| Automatic absence marking | PARTIALLY IMPLEMENTED | — | policy | Runs at boot then every 24h from boot, not at a fixed clock time |
| Attendance policies (scoped) | IMPLEMENTED | SA, HR | — | Company / department / team / employee, effective-dated |
| Manual attendance entry | IMPLEMENTED | SA, HR | — | `attendance.manage`; marked `source: ADMIN` and never overwritten by a sync |
| Attendance correction request | IMPLEMENTED | all | approval engine | Applied automatically on approval |
| Team attendance | IMPLEMENTED | SA, HR, MGR | data scope | With per-employee drill-through |
| Pay-period summary | IMPLEMENTED | SA, HR, MGR | attendance | Figures only, no money |
| Timesheets | IMPLEMENTED | all | — | Draft, submit, approve; fillable from attendance |
| Overnight shifts | PARTIALLY IMPLEMENTED | — | — | Length and lateness handled; **early leave is not evaluated** |

## Leave and holidays

| Feature | Status | Roles | Depends on | Notes |
|---|---|---|---|---|
| Leave types | IMPLEMENTED | SA, HR | — | Entitlement, accrual, carry-forward, paid/unpaid |
| Leave balance | IMPLEMENTED | all (own) | leave types | Derived, not stored: `opening + accrued + adjustment − used − pending` |
| Leave request | IMPLEMENTED | all | approval engine | Half-day supported for single-day requests |
| Leave cancellation | IMPLEMENTED | all (own) | — | |
| Balance adjustment | IMPLEMENTED | SA, HR | — | `leave.manage`, positive or negative, with a note |
| Carry-forward | IMPLEMENTED | SA, HR | leave types | Capped per type |
| Holidays | IMPLEMENTED | SA, HR | — | Company-wide or per location |

## Devices

| Feature | Status | Roles | Depends on | Notes |
|---|---|---|---|---|
| Device registry | IMPLEMENTED | SA, HR | — | `device.manage` to change |
| ZKTeco pull (TCP 4370) | IMPLEMENTED | SA, HR | — | Tested against a protocol simulator |
| ADMS push (`/iclock`) | IMPLEMENTED | SA, HR | — | Tested against synthetic posts |
| **Physical K50 connection** | **PENDING** | — | hardware | Never connected. No claim of hardware verification is made anywhere |
| Device user mapping | IMPLEMENTED | SA, HR | employees | Unmapped punches are stored and reported, never discarded |
| Sync history and diagnostics | IMPLEMENTED | SA, HR | — | Per-run counts and per-record failure reasons |
| Duplicate protection | IMPLEMENTED | — | — | Unique fingerprint per device |
| Raw punch browser | IMPLEMENTED | SA, HR | — | Read-only |
| Reprocess punches | IMPLEMENTED | SA, HR | — | After a mapping is added |
| Push token and network allow-list | IMPLEMENTED | SA, HR | — | Token encrypted at rest, redacted from logs |
| Remote device commands | NOT IMPLEMENTED | — | — | Deliberate: `getrequest` always answers "nothing to do" |
| Biometric template management | NOT IMPLEMENTED | — | — | Enrolment stays on the device |

## Payroll

| Feature | Status | Roles | Depends on | Notes |
|---|---|---|---|---|
| Payroll settings | IMPLEMENTED | SA, HR | — | Basis, overtime, deductions, rounding, frequency |
| Payroll profiles | IMPLEMENTED | SA, HR | employees | Per-employee overrides; null means inherit |
| Effective-dated salary | IMPLEMENTED | SA, HR | — | Overlaps refused at write time |
| Salary components | IMPLEMENTED | SA, HR | — | Fixed, % of basic, % of gross; earning or deduction |
| Pay periods | IMPLEMENTED | SA, HR | — | Arbitrary start and end dates |
| Payroll run workflow | IMPLEMENTED | SA, HR | attendance | DRAFT → CALCULATING → REVIEW → APPROVED → FINALIZED / CANCELLED |
| Calculation engine | IMPLEMENTED | — | attendance engine | Monthly, daily, hourly |
| Overtime pay | IMPLEMENTED | — | timesheets | Multiplier or flat rate; approval required by default |
| Absence / unpaid-leave deduction | IMPLEMENTED | — | attendance, leave | Configurable, monthly salaries only |
| Late / early-leave deduction | IMPLEMENTED | — | attendance | Per minute or per occurrence; off by default |
| Payroll exceptions | IMPLEMENTED | SA, HR | — | Eight codes, three blocking |
| Finalization lock | IMPLEMENTED | SA, HR | — | Every mutation on a finalized run returns 409 |
| Payroll adjustments | IMPLEMENTED | SA, HR | — | The only way to correct a finalized run |
| Payslips | IMPLEMENTED | all (own) | finalized run | Printable; browser print, no PDF library |
| Payslip publishing | IMPLEMENTED | SA, HR | — | `payroll.approve`; withholds until released |
| Reports (8) | IMPLEMENTED | SA, HR | payroll runs | With CSV export |
| Attendance-vs-payroll reconciliation | IMPLEMENTED | SA, HR | payroll runs | |
| **Tax / statutory deductions** | **NOT IMPLEMENTED** | — | — | A taxable flag is stored; nothing computes tax. No EOBI, PESSI, SESSI or income tax rules exist |
| **Loans and advances** | **PARTIALLY IMPLEMENTED** | SA, HR | components | Can be modelled as a recurring deduction; there is no loan balance, schedule or amortisation |
| Bank transfer file | NOT IMPLEMENTED | — | — | |
| Payslip PDF generation server-side | NOT IMPLEMENTED | — | — | The browser's own print is used instead |

## Governance

| Feature | Status | Roles | Depends on | Notes |
|---|---|---|---|---|
| Audit log | IMPLEMENTED | SA, HR | — | Actor, timestamp, action, entity, before/after diff |
| Audit log viewer | IMPLEMENTED | SA, HR | — | With filters |
| In-app notifications | IMPLEMENTED | all | approval engine | Approval raised / approved / rejected / cancelled |
| Email notifications | PARTIALLY IMPLEMENTED | all | SMTP | Password reset only; approvals are in-app |

## Not built at all

| Feature | Status | Notes |
|---|---|---|
| Performance module | NOT IMPLEMENTED | Sidebar shows a disabled "planned" entry. No table, no API, no screen |
| Documents module | NOT IMPLEMENTED | Same. The route registration is commented out in `modules/index.ts` |
| Recruitment / applicant tracking | NOT IMPLEMENTED | |
| Onboarding checklists | NOT IMPLEMENTED | |
| Offboarding workflow | PARTIALLY IMPLEMENTED | Termination exists and is thorough; there is no checklist, clearance or exit-interview flow |
| Asset management | NOT IMPLEMENTED | |
| Expense claims | NOT IMPLEMENTED | |
| Training records | NOT IMPLEMENTED | |
| Multi-company tenancy | NOT IMPLEMENTED | Every table carries `companyId` and every query filters on it, but nothing creates a second company |
| Mobile application | NOT IMPLEMENTED | The web interface is responsive down to 375px |
