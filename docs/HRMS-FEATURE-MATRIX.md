# Feature status matrix

Status values are exactly four:

- **IMPLEMENTED** — built, reachable from the interface, covered by tests.
- **PARTIALLY IMPLEMENTED** — works, but with a named gap.
- **PENDING** — built but not yet exercised against the real world.
- **NOT IMPLEMENTED** — no table, no API, no screen.

Roles are the four seeded ones: Super Admin (SA), HR Admin (HR), Manager (MGR),
Employee (EMP), plus the narrow ones where they are relevant — Team Manager
(TM), Interviewer (INT), IT Asset Manager and Office Boy. A role appears only if
it holds the permission by default.

> **Known coverage gap.** **Cases**, **Lunch**, **Loans** and **Medical** are
> built and running, and have never had a section here. Their behaviour is
> documented in the [admin manual](HRMS-ADMIN-MANUAL.md); it is the line-by-line
> status rows that are missing. Nothing in this document describes them as
> unimplemented — they are simply absent, which is a gap and not a claim.

## Access and identity

| Feature | Status | Roles | Depends on | Notes |
|---|---|---|---|---|
| Sign in / sign out | IMPLEMENTED | all | — | Server-side sessions, 8h default TTL, 10 attempts / 5 min / IP |
| Password reset by email | IMPLEMENTED | all | mail provider | Falls back to logging the link when `MAIL_PROVIDER=console` |
| Change own password | IMPLEMENTED | all | — | `PATCH /me/password` |
| See and revoke own sessions | PARTIALLY IMPLEMENTED | all | — | Can list sessions and sign out everywhere; cannot revoke one named device |
| Invitation acceptance | IMPLEMENTED | — | mail provider | Setting a password through the reset link activates an invited account |
| **Create a login account** | IMPLEMENTED | SA, HR | employees, roles | Invite-based: `user.manage` never generates or sees a password |
| Link a login to an employee | IMPLEMENTED | SA, HR | employees | One account per employee, enforced by a unique index |
| Assign and change roles | IMPLEMENTED | SA, HR | roles | At least one role is always required |
| Suspend an account | IMPLEMENTED | SA, HR | — | Records why, and ends every session |
| Restore an account | IMPLEMENTED | SA, HR | — | Returns it to the status it had before |
| Revoke sessions | IMPLEMENTED | SA, HR | — | Without suspending: they can sign in again |
| Send a password reset link | IMPLEMENTED | SA, HR | mail provider | The link goes to the account holder; no token is ever shown |
| **Set somebody's password** | IMPLEMENTED | SA | — | `user.password.manage`, held by no other default role. Shown once, never stored readably, never in the audit trail. Onboards people when no mail relay exists |
| **Forced change of an issued password** | IMPLEMENTED | all | — | `mustChangePassword` gates the whole application until the holder chooses their own. Set by *Set password* and by the bulk account script |
| Roles and permissions editor | IMPLEMENTED | SA, HR (read) | — | `role.manage` needed to change grants; only Super Admin holds it by default |
| **Create a role** | IMPLEMENTED | SA | — | `role.manage`. Key is derived from the name and permanent; the name is not |
| **Rename or re-scope a role** | IMPLEMENTED | SA | — | System roles included. Super Admin is refused — it always holds everything |
| **Delete a role** | IMPLEMENTED | SA | — | Company roles only, and only when nobody holds it. System roles are refused: the catalogue recreates them |
| Data scopes | IMPLEMENTED | — | — | NONE / OWN / REPORTS / REPORTS_AND_OWN / DEPARTMENT / ALL. The role form offers OWN, REPORTS_AND_OWN, DEPARTMENT and ALL |

## Organisation

| Feature | Status | Roles | Depends on | Notes |
|---|---|---|---|---|
| Company profile | IMPLEMENTED | SA, HR | — | Name, address, timezone, currency, date format, week start |
| Timezone | IMPLEMENTED | SA, HR | — | Drives every attendance day boundary |
| Weekend days | IMPLEMENTED | SA, HR | — | Any combination of weekdays, not just Sat/Sun |
| Departments | IMPLEMENTED | SA, HR | — | Nestable, with an optional head |
| Teams | IMPLEMENTED | SA, HR | departments | One primary team per employee |
| Team managers | IMPLEMENTED | SA, HR | teams | Explicit appointment, 1 to 3 active per team; replace in one action |
| Team manager data scope | IMPLEMENTED | TM, MGR | `team.data.read` | Directory, attendance, leave, timesheets, approvals and assets for teams you manage. Never payroll, loans, medical or restricted fields |
| Approval hierarchy | IMPLEMENTED | SA | approval engine | Stages per request type, ANY_ONE or ALL per stage; HR Manager and CEO named explicitly |
| Designations | IMPLEMENTED | SA, HR | — | Job titles |
| Locations | IMPLEMENTED | SA, HR | — | Optional coordinates and geofence radius |
| Org chart (reporting line) | IMPLEMENTED | SA, HR, MGR | employees | Built from `managerId`; narrowed by data scope |
| Org hierarchy (teams) | IMPLEMENTED | SA, HR, MGR, TM | teams, stage assignees | CEO, HR, teams, managers, members; narrowed to what the caller may see |

## People

| Feature | Status | Roles | Depends on | Notes |
|---|---|---|---|---|
| Add / edit employee | IMPLEMENTED | SA, HR | — | Only first and last name are required |
| Auto employee number | IMPLEMENTED | SA, HR | company prefix | Overridable |
| Restricted fields | IMPLEMENTED | SA, HR | — | National ID, passport, visa, bank account — stripped without `employee.sensitive.read` |
| Work experience sub-records | IMPLEMENTED | SA, HR | — | Prior employment history |
| Terminate employee | IMPLEMENTED | SA, HR | — | Suspends the login and revokes every session |
| Reactivate employee | IMPLEMENTED | SA, HR | — | Restores the login too, but only when the termination is what suspended it |
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
| LAN connector ingest (`/connector`) | IMPLEMENTED | SA, HR | — | Endpoints plus the on-site agent in `apps/connector` |
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

## Assets

| Feature | Status | Roles | Depends on | Notes |
|---|---|---|---|---|
| Asset register | IMPLEMENTED | SA, HR | — | `asset.read.all`. Every filter applied in the database; the tiles are their own query |
| See your own assets | IMPLEMENTED | all | — | `asset.read` alone returns what the caller's data scope reaches, as a WHERE clause. 404, never 403 |
| Add / edit an asset | IMPLEMENTED | SA, HR | categories | Tag and name required; tag and serial unique per company |
| Status and condition as two columns | IMPLEMENTED | SA, HR | — | Eight statuses, five conditions, neither derived from the other |
| Status transition rules | IMPLEMENTED | SA, HR | — | Nothing comes back from Disposed; Retired goes only to Disposed |
| Assign to an employee | IMPLEMENTED | SA, HR | employees | One active assignment per asset, enforced by a unique index and claimed by compare-and-swap |
| Transfer to another employee | IMPLEMENTED | SA, HR | — | Outgoing handover ends as *Transferred on*, and records which row it came from |
| Return | IMPLEMENTED | SA, HR | — | Records the condition it came back in, on the handover; missing accessories derived and stored |
| Accessories on a handover | IMPLEMENTED | SA, HR | — | Label list, suggestions not a closed set |
| Acknowledge a handover | IMPLEMENTED | all | — | `asset.acknowledge`. Reaches only the caller's own handover |
| Report a problem with your asset | IMPLEMENTED | all | — | Raises an incident. Writes nothing about the asset itself |
| Handover notification | IMPLEMENTED | all | — | In-app only, on assign and transfer. Skipped when the holder has no login |
| Repairs | IMPLEMENTED | SA, HR | — | Remembers the status held before, and restores it on completion or cancellation |
| Mark damaged / lost | IMPLEMENTED | SA, HR | — | `asset.update`. Records an incident. Lost can return to Available |
| Retire | IMPLEMENTED | SA, HR | — | Date and reason. Still owned |
| Dispose | IMPLEMENTED | SA, HR | — | Sold / Scrapped / Donated / Recycled / Other, with final value and approver |
| Delete an asset | **NOT IMPLEMENTED** | — | — | Deliberate. No DELETE exists for an asset, handover, repair or incident |
| Asset documents | IMPLEMENTED | SA, HR | object store | 20 per asset, 10 MB each. Reuses the case-attachment path, not a second store |
| Asset timeline | IMPLEMENTED | SA, HR | audit log | Read back from `audit_logs`; there is no separate history table |
| Category catalogue | IMPLEMENTED | SA, HR | — | Two levels, seeded as data. Retired, never deleted |
| Assets tab on an employee | IMPLEMENTED | SA, HR, MGR, EMP | — | Narrowed by data scope: an employee reaches their own id and is refused every other |
| Clearance block | IMPLEMENTED | SA, HR | — | Counts only. Three states. Nothing here marks an asset returned |
| Asset dashboard | IMPLEMENTED | SA, HR | — | `asset.read.all`. One request behind the whole screen |
| Six alerts | IMPLEMENTED | SA, HR | — | Counts exact, row lists capped at 50 and labelled as such |
| Warranty window | IMPLEMENTED | SA, HR | company timezone | 30 / 60 / 90 / 180 days, measured against the company's today. Skips Retired and Disposed |
| Asset report (per asset) | IMPLEMENTED | SA, HR | — | `asset.report`. Totals cover every matching row, not the page |
| Employee asset register (per handover) | IMPLEMENTED | SA, HR | — | Scope: currently held, or every handover ever |
| CSV export of either report | IMPLEMENTED | SA, HR | — | Same filters and columns as the screen; audited as `asset.report.export` |
| Export row ceiling | IMPLEMENTED | SA, HR | — | Over 20,000 rows is refused with a message, never silently truncated |
| Depreciation schedule | **NOT IMPLEMENTED** | — | — | Current value is a number somebody sets. Nothing calculates it |
| Barcode / QR scanning | **NOT IMPLEMENTED** | — | — | The tag is typed or searched for |
| Asset request approval | IMPLEMENTED | all | approval engine | Employee asks; Team Manager → HR → CEO; IT fulfils after approval |
| Asset handover approval | **NOT IMPLEMENTED** | — | — | Assigning outside a request, retiring and disposing are audited, not routed |
| Asset bulk import | **NOT IMPLEMENTED** | — | — | Added one at a time |

## Recruitment

Roles here include the seeded **Interviewer** (INT), which holds `interview.read`
and `interview.evaluate` and nothing else.

| Feature | Status | Roles | Depends on | Notes |
|---|---|---|---|---|
| Job openings | IMPLEMENTED | SA, HR, MGR | — | Five statuses. Only *Open* accepts applications and interviews |
| Draft openings excluded from counts | IMPLEMENTED | SA, HR | — | A draft is not a quiet Open: no pipeline, no applications, counts towards nothing |
| Closing / cancelling needs a reason | IMPLEMENTED | SA, HR | — | Its own endpoint, so the reason cannot be forgotten on a form save |
| Vacancy count (seats) | IMPLEMENTED | SA, HR, MGR | — | Six openings for two people each is twelve seats |
| Salary band and date validation | IMPLEMENTED | SA, HR | — | Top cannot be below bottom; closing cannot precede opening |
| Generated references | IMPLEMENTED | SA, HR | — | `JOB-0007`, `CAN-0042`, per company, from the highest issued rather than a row count |
| Candidates | IMPLEMENTED | SA, HR | — | `candidate.read`, deliberately **not** part of `employee.read` |
| Candidate exists without a vacancy | IMPLEMENTED | SA, HR | — | A CV filed before any opening stays *New* |
| Applications (candidate × opening) | IMPLEMENTED | SA, HR | job openings | **The stage lives here**, not on the person |
| Derived candidate stage | IMPLEMENTED | SA, HR | — | Furthest stage across applications; terminal stages count for nothing unless there is nothing else |
| Nine-stage pipeline | IMPLEMENTED | SA, HR | — | Seven progression stages on the board; Rejected and Withdrawn have no column |
| Stage transition rules | IMPLEMENTED | SA, HR | — | Permissive between live stages; *Hired* only from *Offer*; nothing leaves *Hired* |
| Rejected / Withdrawn kept apart | IMPLEMENTED | SA, HR | — | Who ended it is the question asked when the same CV arrives next year |
| Re-opening a closed candidate | IMPLEMENTED | SA, HR | — | Rejected and Withdrawn are reversible to *Screening* |
| Leaving the pipeline needs a reason | IMPLEMENTED | SA, HR | — | Required on a move to Rejected or Withdrawn |
| Candidate board | IMPLEMENTED | SA, HR | — | Columns are the seven progression stages |
| Restricted candidate block | IMPLEMENTED | SA, HR | — | Current salary, expected salary, HR notes — stripped without `candidate.manage` |
| Candidate timeline | IMPLEMENTED | SA, HR | — | Assembled from the rows themselves; no timeline table, no write path. Carries no restricted value |
| Candidate documents | IMPLEMENTED | SA, HR | object store | 20 per candidate, 10 MB each. Reuses the case-attachment path |
| Interviews | IMPLEMENTED | SA, HR, MGR, INT | candidates | `interview.read` alone returns the interviews you are **on** |
| Day + time + zone booking | IMPLEMENTED | SA, HR | — | Never an instant the browser computed. An unrecognised zone is refused, not treated as UTC |
| Interview calendar | IMPLEMENTED | SA, HR, MGR, INT | — | Scoped the same way as the list |
| Clash detection | IMPLEMENTED | SA, HR | — | Refuses and names who clashes; **overrulable**. Same check behind the form's warning |
| Blocking statuses | IMPLEMENTED | SA, HR | — | Scheduled, Confirmed, Rescheduled, Completed. A cancelled interview frees its slot |
| Six interview statuses | IMPLEMENTED | SA, HR | — | *Rescheduled* is produced by the reschedule endpoint, never picked |
| Reschedule history | IMPLEMENTED | SA, HR | — | The history row and the move are one transaction |
| Panel confirmation | IMPLEMENTED | MGR, INT, all panellists | — | Reaches exactly one row: your own seat. The only write a plain `interview.read` holder has |
| Panel notifications | IMPLEMENTED | — | notification service | In-app on schedule, move and cancel, plus reminders and an evaluation nudge |
| Honest email reporting | IMPLEMENTED | — | mail provider | Reports skipped / delivered / unconfirmed / failed separately. The console provider is always *unconfirmed* |
| Evaluations | IMPLEMENTED | SA, HR, MGR, INT | interviews | `interview.evaluate`, your own seat only. Never merged, never averaged |
| Five optional scores | IMPLEMENTED | — | — | Blank means "not assessed", which a zero cannot say |
| Evaluation gate | IMPLEMENTED | — | — | Only on a Completed or No-show interview |
| Offers | IMPLEMENTED | SA, HR | candidates | `recruitment.offer.manage`, separate from `recruitment.manage` |
| An answered offer is final | IMPLEMENTED | SA, HR | — | Nothing leaves Accepted, Declined or Expired. New terms are a new offer |
| Sending nudges the stage forward only | IMPLEMENTED | SA, HR | — | Never drags somebody back from *Hired* |
| Automatic offer expiry | **NOT IMPLEMENTED** | — | — | *Expired* is a status somebody sets. No scheduled job |
| Offer letter document | **NOT IMPLEMENTED** | — | — | An offer is a record of terms, not a generated PDF |
| Convert to employee | IMPLEMENTED | SA, HR | employees | `recruitment.convert.employee`. The only write to the employees table in the module |
| Conversion preview | IMPLEMENTED | SA, HR | — | Read-only proposal from the offer, then the opening, then the candidate |
| Duplicate detection | IMPLEMENTED | SA, HR | — | By email and by name. Refuses unless acknowledged, and is re-run at write time |
| One candidate, one employee | IMPLEMENTED | SA, HR | — | Unique index on `hiredEmployeeId`; safe under a race |
| Login created on conversion | **NOT IMPLEMENTED** | — | — | Deliberate. A separate step behind `user.manage` |
| Salary written on conversion | **NOT IMPLEMENTED** | — | — | Deliberate. The offer's figure stays on the offer |
| Recruitment dashboard | IMPLEMENTED | SA, HR, MGR | — | Eight figures, computed in the company's timezone and **scoped to the reader** |
| Narrowing by named involvement | IMPLEMENTED | — | — | The data scope is deliberately **not** consulted: a reporting line is not a reason to read a stranger's CV |
| 404 rather than 403 | IMPLEMENTED | — | — | Throughout. A guessed id must not confirm that a candidate is being interviewed |
| Interviewer role | IMPLEMENTED | INT | — | Seeded system role: `interview.read` + `interview.evaluate`. One sidebar row, their own calendar |
| Careers portal / public job board | **NOT IMPLEMENTED** | — | — | An opening is an internal record. Candidates are entered by HR |
| CV parsing | **NOT IMPLEMENTED** | — | — | A CV is a file. Nothing reads it |
| Email to candidates | **NOT IMPLEMENTED** | — | — | Nothing in the module writes to a candidate |
| Scoring / ranking / auto-shortlist | **NOT IMPLEMENTED** | — | — | Evaluations are read, not computed with |
| Recruitment approval workflow | **NOT IMPLEMENTED** | — | — | Opening, offering and converting are audited, not routed |

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
| Onboarding checklists | NOT IMPLEMENTED | |
| Offboarding workflow | PARTIALLY IMPLEMENTED | Termination is thorough and **asset clearance now exists** (see [Assets](#assets)); there is still no checklist or exit-interview flow |
| Expense claims | NOT IMPLEMENTED | |
| Training records | NOT IMPLEMENTED | |
| Multi-company tenancy | NOT IMPLEMENTED | Every table carries `companyId` and every query filters on it, but nothing creates a second company |
| Mobile application | NOT IMPLEMENTED | The web interface is responsive down to 375px |
