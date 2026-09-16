# Administrator manual

For HR administrators and system administrators. Assumes you have read the
[user manual](HRMS-USER-MANUAL.md) overview.

---

## 1. Employee management

### Adding an employee

**People → Add employee.**

Only **two fields are required**: first name and last name. Everything else is
optional — which is convenient and also a trap. An employee saved with nothing
else set will:

- have **no approver**, so their leave requests are refused outright
- have **no shift**, so lateness and early leave are never calculated
- trigger `INCOMPLETE_EMPLOYEE` and `MISSING_SHIFT` warnings in payroll
- have **no salary**, which is a *blocking* payroll exception

Fill in at least: employee number (or let it generate), department, manager,
designation, location, hire date, and employment type.

| Field | Required | Notes |
|---|---|---|
| First name, last name | **yes** | The only required fields |
| Employee number | no | Auto-generated from the company prefix (`EMP-0007`) if blank. Unique per company |
| Display name | no | Overrides "first last" everywhere |
| Work email, personal email | no | Validated if present. **Not** a login |
| Phone, personal phone | no | |
| Job title | no | Free text, kept as a fallback for imports |
| Designation | no | The structured job title |
| Department, team, location | no | Department drives the approval fallback |
| Manager, secondary manager | no | **Drives the approval chain** |
| Employment type | defaulted | Full time, part time, contract, intern, temporary |
| Status | defaulted | Active, On leave, Suspended, Terminated |
| Employment status | no | Probation, Permanent, Internee — or unset. **Loans and medical read it** — see below |
| Hire date | no | Payroll clamps the period to it. Missing → warning |
| Confirmation date, termination date | no | Confirmation date is required to make somebody Permanent |
| Source of hire, LinkedIn, prior experience | no | Descriptive |
| Date of birth, gender, marital status, nationality, blood group | no | |
| Present/permanent address, emergency contact | no | |
| **National ID, passport, visa, bank account** | no | **Restricted** — see below |
| Notes | no | |

### Restricted fields

National ID, passport number and expiry, visa number and expiry, and bank
account number are stripped from **every** response for a caller without
`employee.sensitive.read`. Not hidden in the interface — absent from the
payload. A manager cannot retrieve them by any route.

Only Super Admin and HR Admin hold that permission by default. Grant it
sparingly.

### Editing

**People → open an employee → Edit.** Same fields. Changes are audited with a
field-level before/after diff.

### Employment status

**People → open an employee → Edit → Employment status.** How far through the
employment arrangement somebody is:

| Value | Meaning |
|---|---|
| **Probation** | Serving an initial period; not yet confirmed |
| **Permanent** | Confirmed in post, on the confirmation date held with the record |
| **Internee** | On an internship |
| *Not set* | Nobody has classified this record |

This is the third of three questions an employee record answers, and none of
them can stand in for another:

| | The question | Values |
|---|---|---|
| **Status** | Are they employed at all? | Active, On leave, Suspended, Terminated |
| **Employment type** | On what terms? | Full time, part time, contract, intern, temporary |
| **Employment status** | How far through the arrangement? | Probation, Permanent, Internee |

**Internee is not the Intern employment type.** The type is the contract; the
status is the stage. A record can hold either without the other.

**Confirming somebody needs a date.** Moving a record to *Permanent* is refused
unless a confirmation date is set — in the same edit or in an earlier one.
Clearing the confirmation date on a Permanent record is refused for the same
reason. Changing the status writes nothing else: not the Active/Inactive
status, not the employment type, not the punch code, not the salary, and no
loan or medical record. The move is audited as
`employee.employment-status.update` with the old and new value.

**Who can change it.** `employee.manage` — Super Admin and HR Admin by default.
A manager holds `employee.read` and so can *see* a report's employment status
and cannot move it. An employee sees their own on their dashboard and has no
route by which to change it.

**Where it shows.** People carries it as a column and as a filter, and so does
the Employee Master Report — filter, column and export alike, spelled
*Probation* rather than `PROBATION`. An unclassified record reads *Not set* on
the employee's detail panel and as a dash in the lists. Filtering People by a
status narrows to that status; asking for none returns everybody, unclassified
records included.

**What reads it.** The loan policy and the medical policy each carry three
switches — one per value — under **Eligible employment statuses**. Neither
benefit keeps an employment-status field of its own, which is what stops the
two disagreeing about the same person. Nothing is ineligible in code: an
internship is refused a loan because that switch is off, not because anything
says so. A record with *no* status set is not refused by these switches — an
unfilled field says nothing either way, and the other rules (service length,
salary, attendance) still apply to those people in full.

### Profile photo

**People → open an employee → click the avatar** (the camera badge on the
circle). Upload a photo, replace the one on file, or remove it. Removing it
returns the avatar to the employee's initials — which is what every screen
showed before photos existed, so nothing breaks by having none.

JPG, PNG or WebP, up to 5 MB. The browser scales the image down before it is
sent and the server checks the format by reading the file's own header, so a
file renamed `photo.jpg` is refused whatever it claims to be.

Who can do it:

- **Super Admin** and **HR Admin** — anyone within their data scope, through
  `employee.manage`. This is the same grant that governs every other edit to an
  employee record; there is no separate photo permission to hand out.
- **Any employee** — their own record, and only their own. The same
  self-service principle as changing their own name or password.
- **Managers** can *see* a report's photo (they hold `employee.read`) and
  cannot change it.

Uploads, replacements and removals are audited as `employee.photo.upload`,
`employee.photo.change` and `employee.photo.remove`. The image itself is never
written to the audit log — only its format and size.

The photo appears wherever the person does: People, the profile header, the org
chart, direct reports, and the account menu for their own login.

The files are kept on the server's own disk, not in the database and not with
any outside service. They are served through the API behind the same permission
as the record, so a photo URL is not something that can be shared with somebody
who could not already open the profile.

### Work experience

Prior employment before joining. Add and remove entries on the employee's
record (`employee.manage`).

### Employee login

An employee record and a login account are **separate things**, deliberately.
Recording somebody does not give them a way in, and not everybody needs one.

To give an employee a login: **Settings → Users → Invite user**, and choose them
from the employee list. See [User management](#13-user-management).

### Termination

**People → open an employee → Terminate.** Requires a termination date and
optionally a reason. What it does:

1. Sets the employee status to `TERMINATED` and records the date.
2. **Suspends the linked login account**, recording the reason as
   *employment terminated* so a later reactivation can tell it apart from a
   suspension imposed for its own reasons.
3. **Revokes every active session**, so they are signed out immediately. The
   session they are holding right now stops working on their next request.
4. Writes an audit entry naming how many sessions were ended.

A terminated employee is excluded from new payroll runs from the day after
their termination date, but a run covering a period they worked will still pay
them — a final salary is still owed.

### Reactivation

**People → open a terminated employee → Reactivate.** Restores their status to
`ACTIVE` and clears the termination date.

It also **restores their login** — but only if the termination is what suspended
it. An account an administrator suspended separately, for a reason of its own,
stays suspended and the audit entry says so. Reactivating an employee is not a
decision about a security concern somebody raised deliberately.

### Deletion

`DELETE /employees/:id` exists but is guarded: an employee who has recorded
anything cannot be deleted. Terminate instead — the attendance evidence they
produced must be preserved.

---

## 2. Settings

### Settings → Company

| Setting | Affects |
|---|---|
| Name, legal name, contact, address | Payslip header, general display |
| **Timezone** | **Every attendance day boundary, every shift comparison, every payroll period.** Set it before recording anything |
| Currency | Stamped onto salaries and payroll runs at creation. Changing it does not restate history |
| Date format | Display only |
| Week starts on | Calendar rendering |
| **Weekend days** | Which days are never scheduled and never scored as absence |
| Employee number prefix | Auto-generated employee numbers |

### Settings → Attendance policy

The company baseline. See the
[attendance guide](HRMS-ATTENDANCE-GUIDE.md#3-the-attendance-policy) for every
field and what it does.

### Settings → Policy overrides

Named attendance policies assigned to a department, team or individual, with
effective dates. Most specific wins: employee → team → department → company.

Effective dates are what keep history honest — rescoring a day in March has to
use the policy that was in force in March.

### Settings → Case categories

The routing catalogue for the helpdesk: which of the company's departments have
queues, what the categories and subcategories under them are called, and which
are retired. Gated on **`case.category.manage`**, which HR Admin holds.

The departments here are the company's own — there is no separate helpdesk
department list, and one cannot be added from this screen. A department with no
queues shows as an empty group and cannot receive cases until it is given one.

| Action | What happens |
|---|---|
| Add a category | A new top-level queue under that department |
| Subcategory | A second level under that category. It takes the parent's department; the tree is only ever two deep |
| Retire | Disappears from the raise-a-case form. Existing cases keep it, and retiring a category retires its subcategories with it |
| Restore | Puts it back on the form |
| Delete | Offered **only** where no case has ever been filed. Anything else must be retired — deleting would orphan the history of why a case was routed somewhere |

Names must be unique within a department at each level, case-insensitively.

### Settings → Roles and permissions

Lists the five seeded roles — Super Admin, HR Admin, Manager, Employee and
Office Boy — and lets `role.manage` holders change what each may do. Super Admin
is protected from editing.

A seeded role a company is missing is created at API start-up, so a role
introduced by a later release arrives on an existing installation rather than
only on new ones. An existing role is never touched by that: not renamed, not
re-scoped, not re-granted.

Changing a role's grants takes effect on the affected users' **next request** —
sessions are resolved per request.

### Settings → Audit log

Every recorded action, newest first, with filters by action, entity type and
actor.

### Payroll → Settings

See the [payroll guide](HRMS-PAYROLL-GUIDE.md#2-payroll-settings).

---

## 3. Dashboard

**Dashboard** — the landing page for every role. All four cards come from a
single endpoint, `GET /company/stats`, gated on **`company.read`**.

| Card | Exactly what it counts |
|---|---|
| Total employees | **Every** employee record in the company, including terminated ones |
| Departments | Active departments |
| On leave | Employees whose **status field** is `ON_LEAVE` |
| Active accounts | User accounts with status `ACTIVE` |

Three things about this are worth stating plainly, because none of them is what
the labels suggest:

1. **The figures are company-wide and are *not* narrowed by data scope.** Every
   role that holds `company.read` — which includes **Manager** by default — sees
   the whole company's totals here, not their own reporting line. No individual
   record is exposed, but the counts are not scoped the way every other screen
   in the system is.

2. **"On leave" does not mean "on leave today".** It counts employees whose
   *employment status* is set to `ON_LEAVE` — a long-term status like a
   sabbatical or extended absence, set by hand on the employee record. It has
   nothing to do with approved leave requests, and somebody on annual leave this
   week will **not** appear in it.

3. **"Total employees" includes leavers.** It is an unfiltered count. The
   endpoint also returns an `activeEmployees` figure, but the card does not use
   it.

There is no date filter — the figures are "as of now".

Below the cards: recent activity from the audit log, and a setup checklist that
links to whatever is not yet configured.

> Recorded as a discrepancy rather than corrected: this phase is documentation
> only. See [contradictions](#14-contradictions-between-interface-and-backend).

---

## 4. Approvals

Four things route through the generic approval engine:

| Subject | Raised by | Applied on approval |
|---|---|---|
| `LEAVE_REQUEST` | the employee | the leave is marked approved and starts affecting attendance |
| `TIMESHEET` | the owner | the timesheet is marked approved; its overtime becomes payable |
| `ATTENDANCE_REGULARIZATION` | the employee or their manager | the attendance record is written with `source: ADMIN` |
| `SHIFT_CHANGE` | the employee or their manager | the shift assignment is created |

**Payroll approval is not part of this engine.** It has its own status machine
and its own permission (`payroll.approve`).

### Who approves

The chain is resolved when the request is raised:

1. The requester's **primary manager**
2. Then their **secondary manager**, if set
3. If neither exists, the **head of their department**

Never the requester themselves. If none of the three exists the request is
**refused at creation** with *"No approver could be determined... Assign a
reporting manager or a department head first."*

### The flow

```
REQUEST ──► PENDING ──► step 1 decides ──► (step 2 decides) ──► APPROVED
                             └──────────────────────────────► REJECTED
   requester may CANCEL while PENDING ─────────────────────► CANCELLED
```

A multi-step chain exists so several different people sign off. Separation of
duties is enforced: someone who decided step 1 cannot also decide step 2.

`approval.act` lets you decide requests **assigned to you**. `approval.manage`
is an administrative override — see and decide any request in the company.

Terminal states are immutable: re-approving returns 409.

---

## 5. Leave administration

### Leave types

**Leave types** (`leave.manage`). Everything about a leave policy is data:

| Field | Meaning |
|---|---|
| Name | Unique per company |
| Annual entitlement days | Accrual is capped at this |
| Monthly accrual days | Usually entitlement ÷ 12, kept separate so a policy can accrue faster or slower |
| Carry-forward enabled | |
| Carry-forward cap | Days that survive a year boundary. Null means uncapped |
| **Is paid** | **Unpaid leave still consumes balance but is deducted by payroll** |
| Is active | |

### Balances

Balances are **derived, not stored**, so a stored total can never drift:

```
accrued   = min(monthlyAccrualDays × completed months, annualEntitlementDays)
available = opening + accrued + adjustment − used − pending
```

Only two things are stored: the opening balance carried in from last year, and
any manual adjustment. `used` and `pending` come from the request rows.

### Adjustments and carry-forward

- **Adjust** (`leave.manage`) — positive or negative, with a note. Audited.
- **Carry forward** (`leave.manage`) — moves the remaining balance into the next
  year, capped per type.

### How leave affects everything else

- **Attendance** — an approved leave day derives as `ON_LEAVE`, below weekend
  and holiday in precedence. Check-in on such a day is refused.
- **Payroll** — a paid leave day is payable; an unpaid one is a deduction if
  `deductUnpaidLeave` is on. Half-day leave counts as 0.5.

---

## 6. Holidays

**Holidays** (`holiday.manage`). A date, a name, and optionally a location.
No location means company-wide. Employees inherit their location's calendar plus
every company-wide holiday.

Effects: a holiday is never a scheduled day, never scored as absence, and beats
leave in precedence — booking leave across a public holiday does not report the
holiday as leave.

Postgres treats nulls as distinct, so the uniqueness constraint only stops
duplicates for a named location. The company-wide case is enforced in the
service layer.

---

## 7. Audit and security

### Audit trail

Every mutating action writes an `AuditLog` row: actor, timestamp, action
(a dotted verb like `employee.terminate`, `payroll.run.finalize`), entity type
and id, a human summary, and a **field-level before/after diff**.

Secrets are redacted before they reach the log. Comm keys, push tokens and
passwords never appear.

There is **one** audit trail. Payroll actions (`payroll.*`) go into the same
log, deliberately — a second table would split the history so that
reconstructing who did what meant looking in two places.

### Authentication

- Server-side sessions. The token is opaque; only a SHA-256 hash is stored.
- 8-hour default TTL. Expired sessions are pruned at boot and daily.
- Passwords hashed with Argon2id.
- Rate limits: 300 requests/minute globally (per user when signed in, per IP
  otherwise); sign-in 10 per 5 minutes per IP; password reset 5 per 15 minutes.
- Sign-out-everywhere revokes every session for the account.

### Authorization

Enforced **server-side on every route**. The interface hides controls a user
cannot use, but that is a courtesy — the same request made directly returns 403.
This is verified by the audit suites, which assert the status codes rather than
the absence of buttons.

### Payroll protection

- Salary figures require `payroll.read`; managers do not hold it.
- Payslips are scope-narrowed; changing an id returns 403 with no figures in
  the body.
- A finalized run rejects every mutation with 409.
- Reports are scope-narrowed **before** totalling, so an aggregate cannot leak
  a salary the caller could not read directly.

### Device security

See the [device guide](HRMS-DEVICE-GUIDE.md#5-security). In short: `/iclock` is
the only unauthenticated surface, gated on a registered serial plus an optional
encrypted path token plus an optional network allow-list; the token is redacted
from logs; and no route there can read data back out or command a device.

### Data integrity

- All 12 migrations are **purely additive**. No `DROP TABLE`, `DROP COLUMN`,
  `TRUNCATE` or `DELETE FROM` appears in any of them.
- Raw punches are never edited or deleted — including for age.
- Attendance marked `source: ADMIN` is never overwritten by a device sync.
- Employees who have recorded data cannot be deleted, only terminated.
- Finalized payroll is immutable.

---

## 8. Employee lifecycle

```
1  Recruit                  outside the system — NOT IMPLEMENTED
2  Add employee             People → Add employee
3  Assign department        on the employee record
4  Assign manager           on the employee record — without this, no approvals
5  Assign shift             Shifts → Assignments, effective-dated
6  Configure salary         Payroll → Profiles → New salary, effective-dated
7  Map to a device user     Devices → Device users
8  Employee starts          they need a login — SEE LIMITATIONS
9  Attendance               punches, or self check-in
10 Leave                    requests, approvals, balances
11 Payroll                  monthly run → payslip
12 Performance              NOT IMPLEMENTED
13 Documents                NOT IMPLEMENTED
14 Exit                     People → Terminate
```

### Offboarding

There is **no offboarding module** — no checklist, no clearance workflow, no
exit interview, no asset return, no final-settlement calculation.

What exists is the **Terminate** action, which is thorough as far as it goes:
sets the status and date, suspends the login, revokes every session, and audits
it. Everything else about an exit is a manual process outside the system.

---

## 9. Report catalogue

Payroll's eight reports are documented in the
[payroll guide](HRMS-PAYROLL-GUIDE.md#11-reports). Everything else that produces
a list or an export:

| Report | Where | Purpose | Filters | Access | Export |
|---|---|---|---|---|---|
| Attendance records | Attendance | Every recorded day | date range, status, employee | `attendance.read`, scope-narrowed | no |
| Attendance summary | Attendance | Totals for a range: worked, overtime, present, absent, leave | date range, employee | `attendance.read`, scope-narrowed | no |
| Team attendance | Attendance → Team | Day-by-day for a team | date range, department, team, search | `attendance.read`, scope wider than OWN | no |
| **Pay-period summary** | Attendance → `/pay-period` | The clean input payroll consumes: worked and overtime minutes, day counts, late and early minutes, incomplete and administrator-adjusted days | date range, employee | `attendance.read`, scope-narrowed | no |
| Device sync history | Devices | One row per sync run with per-record failures | device | `device.read` | no |
| Device punches | Device punches | Raw readings | device, employee, unmapped only, date range | `device.read` | no |
| Leave balances | My leave / Leave requests | Per type: opening, accrued, adjustment, used, pending, available | employee, year | `leave.read`, scope-narrowed | no |
| Leave requests | Leave requests | Requests and their status | status, type, employee, date | `leave.read`, scope-narrowed | no |
| Timesheets | Timesheets | Periods, hours and status | status, search | `timesheet.read`, scope-narrowed | no |
| Employee list | People | The workforce | department, team, designation, location, status, search | `employee.read`, scope-narrowed | **CSV** (`employee.export`) |
| Org chart | People → Org chart | Reporting structure | — | `employee.read`, scope-narrowed | no |
| Audit log | Settings → Audit | Every recorded action | action, entity type, actor, date | `audit.read` | no |

**Only two things export:** the employee list and the eight payroll reports,
both as CSV with a UTF-8 BOM so Excel opens names correctly. Payroll exports are
audited; the employee export is audited too. There is no PDF or Excel export
anywhere, and no scheduled or emailed report.

Every report is narrowed by data scope **before** anything is totalled, so an
aggregate cannot be used to infer a record the caller could not read directly.

---

## 10. HR workflow

### Daily

1. **Approvals** — clear anything assigned to you. `approval.manage` lets you
   decide any request in the company, not only those routed to you.
2. **Team attendance**, whole company — look for absent, late and *incomplete*
   days (checked in, never out). Chase corrections for the incomplete ones.
3. **Devices → Sync history** if terminals are in use. A failed run retries on
   the next tick, but a device failing all day needs looking at.
4. **Device punches → unmapped only** — a new joiner enrolled on the terminal
   but not yet mapped shows up here.
5. New joiners and leavers as they happen (see
   [common operations](#11-common-daily-operations)).

### Weekly

1. Review the week's attendance for patterns.
2. Check pending leave — a pending request holds days against the employee's
   balance and blocks their planning.
3. Confirm shift assignments for the coming week.
4. Check every new employee has a department, manager, hire date, shift and
   salary. Any of those missing surfaces as a payroll exception later.

### Monthly

See the [monthly HR checklist](HRMS-QUICK-START.md#monthly-hr-checklist).

### Yearly

1. **Leave → Carry forward** — moves remaining balances into the new year,
   capped per type.
2. Create the new year's **holiday** calendar.
3. Review leave-type entitlements and accrual rates.

---

## 11. Common daily operations

### Add an employee

People → **Add employee** → first and last name (all that is required) →
department, designation, location, **manager**, hire date, employment type →
Save. Then assign a shift and a salary.

### Change someone's department

People → open → **Edit** → Department → Save. History is not rewritten. If the
department changes their approver, set the manager too.

### Change someone's manager

People → open → **Edit** → Manager → Save. Affects **future** requests; anything
already pending keeps the approver it was routed to.

### Assign a shift

Shifts → **Assignments** → New assignment → employee, shift, effective from.
The previous assignment stays; the one in force is the latest that has begun.

### Approve leave

Approvals → open the request → **Approve**. Or Leave requests → the row. Once
approved it overrides attendance for those days.

### Correct attendance

Either approve the correction the employee raised (Approvals), or with
`attendance.manage` write the record directly (`POST /attendance`). Both mark
it `source: ADMIN` so no device sync overwrites it.

### Run payroll

Payroll → Pay runs → **New period** → **New pay run** → **Calculate** → read the
exceptions → **Approve** → **Finalize**. Full detail in the
[payroll guide](HRMS-PAYROLL-GUIDE.md#7-the-run-workflow).

### Generate a payslip

Payslips are issued automatically when a run is **finalized**. To let staff see
them, publish the run's payslips.

### Generate reports

Payroll → **Reports** → choose one of the eight → filter → **Export CSV**.

### Add a holiday

Holidays → **Add holiday** → date, name, and a location for a site-specific one.
Leave the location blank for company-wide.

### Add a leave type

Leave types → **New type** → name, annual entitlement, monthly accrual,
carry-forward and cap, and whether it is **paid**. Unpaid leave is deducted by
payroll.

### Add a device

Attendance → Devices → **Add device**. See the
[device guide](HRMS-DEVICE-GUIDE.md#2-registering-a-device).

### Terminate an employee

People → open → **Terminate** → date and reason. Suspends their login and
revokes every session.

---

## 12. Known limitations

Collected from the implementation and from the development record. Nothing here
is hidden.

### Blocking for a real deployment

1. ~~No user-management module.~~ **Resolved.** See
   [User management](#13-user-management). Accounts are created by invitation,
   linked to employees, given roles, suspended, restored and signed out from
   **Settings → Users**.

2. ~~Reactivation does not restore a login.~~ **Resolved.** Termination records
   *why* it suspended the account, and reactivation restores it — unless an
   administrator had suspended it separately, in which case it stays suspended
   and the audit says so.

3. **The physical ZKTeco K50 has never been connected.** Everything is verified
   against a protocol simulator. See the
   [device guide](HRMS-DEVICE-GUIDE.md).

### Functional gaps

4. **Early leave is not evaluated for overnight shifts.** The shift end falls on
   the next calendar day; rather than guess which, the calculation returns
   `null`. Lateness and worked minutes still work.

5. **Absence marking is tied to process uptime**, not a clock time. It runs at
   boot and every 24 hours after. Restarting the API moves the daily run.

6. **Self-service check-in supports one in/out pair per day.** Devices can
   deliver many punches; the self-service path cannot.

7. **No retrospective recalculation.** Changing a shift or an attendance policy
   does not rescore past days.

8. **No employee import**, despite `employee.import` being grantable.

9. **Attendance corrections have no manager-side entry point.** A manager
   approves a correction the employee raised; there is no "correct this row"
   action on the team attendance screen.

10. **Tax is not implemented**, and neither are loan balances or advances. A
    loan can be modelled as a recurring deduction, but nothing tracks an
    outstanding balance or stops when it is repaid.

11. **Email covers password reset only.** Approval notifications are in-app.
    And it only leaves the server once an SMTP relay is configured: with none,
    reset links and invitations are created but never delivered, and the screen
    says so rather than claiming a send. See **Sending a password reset**.

12. **Single company.** Every table carries `companyId` and every query filters
    on it, but nothing creates a second company.

### Testing gaps

13. **Two audit suites are calendar-dependent.** `audit-phase5` and
    `audit-phase5-policy` skip their live check-in blocks when the day the
    suite runs on is a weekend, covering 17 fewer assertions. Not a defect, but
    a weekend run is a weaker run.

14. **No automated UI tests.** The interface is verified by scripted browser
    walkthroughs during development, not by a persistent test suite.


---

## 13. User management

**Settings → Users.** Requires `user.read` to see, `user.manage` to change.
Managers and employees hold neither, and the API refuses them with 403
regardless of what the interface shows.

### Three statuses that are not the same thing

The screen keeps these apart on purpose, because an administrator looking at a
locked-out person needs to know which one they are looking at:

| | What it means | Where it lives |
|---|---|---|
| **Status** | Whether they work here | The employee record |
| **Account status** | Whether the login can sign in | The user record |
| **Sessions** | Whether they are signed in *right now* | Session rows |

Not to be confused with **Employment status** (Probation / Permanent /
Internee), which is a fourth thing again and says nothing about signing in —
see **Employment status** in *Employee management*.

They move independently. Somebody can be employed with no account, have an
account with no sessions, or be signed out everywhere while their account stays
perfectly usable.

### Account statuses

| Status | Meaning |
|---|---|
| **Invited** | Created, but has never set a password. **Cannot sign in yet** |
| **Active** | Can sign in |
| **Suspended** | Cannot sign in. Every session stops working immediately |

### Creating a user

**Settings → Users → Invite user.**

1. Choose the **employee** this login belongs to. Only employees who do not
   already have one appear, and terminated employees never do. Choosing one
   fills in the name and work email.
2. Confirm the **email** — it is both where the invitation goes and the sign-in
   name.
3. Choose at least one **role**. An account with no role can sign in and see
   nothing, so it is refused.
4. **Send invitation.**

> **No password is created, generated, displayed or transmitted.** The account
> is created as *Invited* with a stored value no password can ever match, and
> the person sets their own through the ordinary reset link. That is what makes
> "an administrator never knows anybody's password" true rather than merely
> intended. If the invitation does not arrive, send it again from the account's
> detail panel — a fresh link supersedes the old one.

The account becomes **Active** the moment they set a password.

### Linking to an employee

One account per employee, enforced by a unique index rather than by hope.
Attempts to give one employee a second account, or to move an account onto an
employee who already has one, are refused with an explanation.

An account **can** exist with no employee linked — an external auditor or a
contractor who needs to see the system but has no attendance, leave or payslips
of their own. Such an account has no data scope anchor, so a narrow scope shows
it nothing.

Link, unlink and relink from the account's detail panel.

### Roles

Change them from the detail panel. A user must always keep **at least one**.

The last active account that can administer roles cannot have that ability
removed, and cannot be suspended: a company with nobody holding `role.manage`
cannot grant it back to anybody, because granting it is the thing that requires
it. That is unrecoverable without database access, so it is refused.

### Suspending and restoring

**Suspend** asks for a reason, which goes into the audit trail. It:

- sets the account to *Suspended*,
- records **why** — administrative, as opposed to a termination,
- remembers what the status was before, and
- **ends every session immediately**.

A suspended account cannot sign in, cannot be sent a reset link, and cannot
redeem a reset link issued before the suspension.

**Restore** returns it to the status it had before — an account that was only
ever *Invited* goes back to *Invited*, not to a working login it never had. It
also clears any lockout.

An administrator restoring from this screen is acting deliberately, so an
administrative suspension is theirs to override. What they cannot override is
the employee still being terminated: that would produce a working login for
somebody who has left. Reactivate the employee first.

### Revoking sessions

Signs the person out of every device without touching the account. They can
sign in again immediately. Use it when a laptop is lost or somebody stayed
signed in somewhere they should not have.

Different from suspension: revoking ends sessions, suspending ends sessions
**and** stops them coming back.

### Changing a sign-in email

**Settings → Users → open the account → Sign-in email → Change.** Requires
`user.email.manage`, which only Super Admin holds by default. HR Admin does
not receive it unless a Super Admin grants it deliberately from Settings →
Roles; `user.manage` does not imply it. Nobody can change their own sign-in
email from this screen, and the API refuses the attempt as well.

The detail panel keeps two addresses apart on purpose:

| | What it is | Where it lives |
|---|---|---|
| **Sign-in email** | The address the person types to sign in | The login account |
| **Employee work email** | The address on the HR record | The employee record |

They are usually the same and occasionally, deliberately, not. The dialog asks
for the new sign-in email, shows the current work email beside it, and offers
**Also update employee work email** — ticked in advance only when the two
currently agree. When it is ticked, both change in one transaction; when it is
not, only the sign-in email changes. The change cannot be submitted until
**I understand that the old sign-in email will stop working** is ticked.

What the change does:

- The old address stops working and the new one starts. The new address must
  not belong to any other account, compared without regard to case.
- **Every session ends.** They sign in again with the new address and their
  existing password.
- Every unused password-reset or invitation link is retired. An *Invited*
  account has its invitation re-sent to the new address; an *Active* account
  is sent nothing; a *Suspended* account is sent nothing and stays suspended.
- The audit trail records who made the change, whose account it was, the
  linked employee, both addresses, whether the work email moved with it, and
  how many sessions and links were retired.

What it never does: change or reset the password, change the role or the
account status, or touch any part of the employee record other than the work
email when asked — the employee number, punch code, attendance, salary,
leave, loans and medical records are keyed on the employee, not on the
address.

### Sending a password reset

Sends the ordinary reset link to the account holder's own address — the
**sign-in email**, never the employee work email, so a changed login takes
future reset links with it and the old address receives nothing. The
administrator never sees the token, it is never returned by the API, never
written to the log, and never recorded in the audit trail — the audit records
only that a link was issued and what became of the email.

**What the confirmation actually tells you.** A reset link is two things: a
token in the database and an email carrying it. Only the first is guaranteed,
so the screen reports them separately rather than assuming one from the other.

| Message | What happened | What to do |
| --- | --- | --- |
| *Password reset link sent.* | A mail transport accepted the message for delivery. | Nothing. Ask them to check spam if it does not arrive. |
| *Password reset request created, but email delivery could not be confirmed.* | The token exists; the server has no mail transport that delivers. This is what a server still on the development mail provider reports. | The link cannot be sent at all until a relay is configured — see below. Nothing the administrator does on this screen will change it. |
| *The reset link was created, but the email could not be sent (CODE).* | A real relay was tried and refused or could not be reached. `EAUTH` is a credential problem, `ECONNECTION` / `ETIMEDOUT` a reachability one. | Pass the code to whoever runs the server. No credential, host or relay message is shown, by design. |

**If delivery is never confirmed,** the server has no mail relay. The API logs
an error saying so on every start. Configuring one is a server-side change:
`deploy/configure-smtp.sh` sets `MAIL_PROVIDER=smtp` with the `SMTP_*` values
and restarts the API, after which the boot log reads `SMTP transport ready`.
Until then, an invited person cannot be onboarded by email — the invitation is
an ordinary reset link and travels the same path.

### Actions refused on your own account

Suspending yourself, revoking your own sessions and stripping your own roles are
all refused from this screen. They are ways to lock the last administrator out.
Sign out from the header; change your password from your profile.

### Onboarding: the normal sequence

```
1  People → Add employee           department, manager, hire date
2  Shifts → Assignments            effective from their start date
3  Payroll → Profiles              a salary, effective-dated
4  Settings → Users → Invite user  choose the employee, pick roles
5  They accept the invitation      set a password → account becomes Active
6  Devices → Device users          map their terminal PIN, if used
```

Step 4 can happen at any point after step 1. The invitation is the only step
that involves the employee themselves.

### Offboarding

**People → Terminate** does the account half for you: suspends the login,
records the reason as *employment terminated*, and ends every session. There is
nothing to do on the users screen.

If they return, **People → Reactivate** brings the login back.

---

## 14. Contradictions between interface and backend

Found while writing this manual by reading the source against the screens.
**None of these has been changed** — this phase was documentation only. Each is
recorded so a decision can be made deliberately.

### 1. Permissions that are grantable but do nothing — *partly resolved*

`user.read` and `user.manage` now do what their descriptions say. See
[User management](#13-user-management).

`employee.import` **still does nothing**: grantable, described as *"Bulk-create
employees from a file"*, with no import endpoint behind it. Left as it was —
building import was explicitly out of scope for the user-management work.

### 2. ~~Reactivation does not undo termination~~ — *resolved*

Terminating now records that *the termination* is what suspended the account.
Reactivating restores it, unless an administrator had suspended it separately
for a reason of its own — in which case it stays suspended, and both the refusal
and the reason appear in the audit trail and on the account's detail panel.

### 3. The dashboard is not scope-narrowed

Every other screen in the system narrows what it returns by the caller's data
scope. `GET /company/stats` does not — it counts the whole company for anyone
holding `company.read`, which includes Manager by default.

The exposure is aggregate counts, not individual records. But it is inconsistent
with the rule the rest of the system follows, and a manager seeing "Total
employees: 250" on a 12-person team is at best confusing.

### 4. Dashboard labels do not match what is counted

- **"On leave"** counts the employee *status field*, not approved leave. Someone
  on annual leave today does not appear.
- **"Total employees"** includes terminated employees, though the same endpoint
  returns an `activeEmployees` figure the card ignores.

### 5. Sidebar entries with nothing behind them

**Performance** and **Documents** render as disabled "planned" rows. That is
honest as far as it goes — they are visibly not available — but they set an
expectation that something is coming, and no table, API or screen exists for
either. The Documents route registration is present but commented out.

### 6. Managers cannot act on what they can see

The team attendance screen shows a manager exactly which days are wrong —
absences, late arrivals, days with no check-out — and offers **no action on
any of them**. A manager can only approve a correction the employee thought to
raise. There is no "correct this" affordance for the person looking at the
problem.

Not a defect; the permission model is deliberate. But it is a workflow gap
somebody will hit on the first day.

---

## 15. Cases (the helpdesk)

Two screens over one module, and they are deliberately not the same screen with
a switch.

**Cases** (`case.read.own`) is every employee's own list — the cases they
raised, and nothing else. No data scope widens it: a manager opening this finds
their own cases and no trace of their team's, because a reporting line is not a
reason to read what somebody asked HR about.

**Case queue** (`case.read.department` or `case.read.all`) is the desk. It shows
the cases filed to the queues the caller may work, whoever raised them.

### Who sees which queue

| Grant | Sees |
|---|---|
| `case.read.department` | Every case routed to the department on **their own employee record**. An IT case is worked by IT |
| `case.read.all` | Every case in the company. For whoever runs the whole desk rather than one queue of it |

An agent whose employee record has no department sees an empty queue — that is
the first thing to check when somebody reports the queue is blank. Somebody who
works two queues is given `case.read.all`; there is no per-person desk roster.

### The rest of the desk's grants

| Grant | Lets somebody |
|---|---|
| `case.assign` | Take a case, hand it to somebody else, or put it back. A case can only be assigned to an account that holds a read grant — assigning into a hole would look handled and would not be |
| `case.update` | Change status and priority, and re-route a misfiled case |
| `case.respond` | Reply to the requester. They see it and are notified |
| `case.note.internal` | Write a staff-only note. The requester never sees it, is never notified about it, and it is absent from their view of the case rather than hidden in it |

HR Admin holds these four, `case.read.department` and `case.category.manage` by
default — the HR queue, and the catalogue everybody's queues are drawn from.
Nobody holds `case.read.all` except Super Admin; give it through a custom role.

### The workflow

`OPEN → IN_PROGRESS → PENDING / ON_HOLD → RESOLVED → CLOSED`, with `REOPENED`
coming back from either settled state. Two of these are easy to confuse and mean
opposite things about whose move it is:

- **Pending** — waiting on the **requester**. Nothing happens until they answer.
- **On hold** — waiting on anything else: a part, a vendor, a change window.

The server refuses any transition the workflow does not allow, whoever asks. A
requester's one move is reopening their own settled case; everything else is the
desk's.

Every status change writes an event into the conversation, and the optional note
that goes with it reaches the requester unless it is marked internal.
Re-routing a case moves it to the new queue with the whole conversation and
unassigns it, so the receiving desk sees it as unclaimed.

### Attachments

JPEG, PNG, WebP, PDF, TXT or CSV, 10 MB each and 20 per case. What a file *is*
is read from its own leading bytes, not from what the browser called it, and
anything else is refused. Files on internal notes are internal too. Downloads go
through an endpoint that re-checks the case against the caller, so a file is
exactly as private as the case it belongs to.

---

## 16. Lunch (the daily order and its cash)

An operational process, not a finance module. An employee orders lunch, the
office boy brings it, the employee pays the office boy, and the office boy marks
the order paid. That is the whole of it.

**Nothing here touches payroll.** There is no salary deduction, no payroll
integration, no finance approval, no reconciliation step, no company subsidy, no
payment gateway and no online payment. None of those is a gap to be filled
later: lunch is cash settled on the day, and a deduction would put a month
between ordering a biryani and accounting for it. If somebody asks for lunch to
come out of salaries, that is a change to what this module *is*, not a feature
request against it.

### Three screens

**Lunch** (`lunch.order.read.own`) is every employee's own — what they ordered
today, what it comes to, and whether they have paid. No data scope widens it.

**Lunch collection** (`lunch.collection.read`) is the office boy's screen: the
day's orders and the six figures that settle it.

**Settings → Lunch menu** (`lunch.menu.manage`) is what may be ordered and what
it costs.

### The grants

| Grant | Lets somebody |
|---|---|
| `lunch.order.create` | Order lunch for themselves. The request carries ids and quantities only — the server prices it |
| `lunch.order.read.own` | See their own orders and payment status |
| `lunch.order.cancel.own` | Call off their own order **while it is unpaid and the kitchen has not started it** |
| `lunch.order.fulfil` | Move an order along the round: preparing, ready, delivered |
| `lunch.order.cancel.any` | Cancel **anybody's** order with a written reason, and decide what happens to money already paid. Not available once an order is delivered |
| `lunch.collection.read` | See a day's orders and totals. Oversight, not money: an administrator may hold this alone |
| `lunch.payment.mark` | Record that somebody handed the money over |
| `lunch.payment.correct` | Undo or amend a payment already recorded. Needs a written reason, and is audited |
| `lunch.menu.manage` | Add, re-price and retire menu items |

Every system role holds the first three — everybody eats. HR Admin also holds
`lunch.menu.manage` and `lunch.collection.read`.

The rest belong to the **Office Boy** role, which is seeded in every company
alongside Super Admin, HR Admin, Manager and Employee. It holds the three
ordering grants plus `lunch.collection.read`, `lunch.payment.mark`,
`lunch.order.fulfil` and `lunch.order.cancel.any` — and **nothing outside
lunch**. No employee record, no attendance, no payslip, no leave, no company
settings: not narrowed by a data scope, absent. Assign it to whoever runs the
round; it needs no configuring first.

**`lunch.payment.correct` is deliberately not in it.** Undoing a payment is kept
away from the person who records them, so the one who can take money is not also
the one who can unmake having taken it. Give it to whoever supervises the round
— through a custom role, or by adding it to Office Boy on the Roles screen if
there is genuinely nobody else. The same thinking applies to `lunch.menu.manage`,
which stays with HR Admin: a price is what an employee will be charged.

### The lunch round

`ORDERED → PREPARING → READY → DELIVERED`, forwards only, moved along by
somebody holding `lunch.order.fulfil`. The server refuses a skipped step and
refuses to walk an order backwards — which is also what stops the delivered rule
below being stepped around by moving an order back to READY first.

An order can be paid at any point along it. Paying on delivery is the ordinary
case.

### Cancelling an order

| Who | When |
|---|---|
| The employee, their own | While it is **ORDERED and unpaid**. Once the kitchen has started it, or once it is paid for, it is no longer theirs to call off |
| The operator, anybody's | **ORDERED, PREPARING or READY**, paid or not, with a compulsory reason |

**A delivered order cannot be cancelled by anybody.** The food has been eaten,
so "cancel" has stopped describing anything that could happen — cancelling one
would take a plate the kitchen actually made out of the day's count and money
that was actually owed out of the day's collection. A delivered order that needs
putting right is a **payment correction** instead, which says what it is and is
audited as what it is.

The reason is compulsory because **the employee reads it**. That is the point of
collecting it: somebody's lunch disappeared and they are owed a sentence about
why, not a status change. The operator's separate note about the money is *not*
shown to them.

**An order is never deleted.** It keeps its number, its lines, its payment and
its cancellation, and it stays on the day's report — in the cancelled figures,
apart from the active ones.

### Cancelling an order somebody has already paid for

The payment is **never** silently erased and `paymentStatus` is never rolled
back to UNPAID. Cash changed hands, and a system that forgets that has lost the
only thing it was keeping. So the operator is made to choose:

| Choice | What is recorded | What it means for the box |
|---|---|---|
| **Cancel + Refund** | `refundStatus = REFUNDED`, plus when and who | The money went back. It leaves the day's cash |
| **Cancel + Payment retained** | `refundStatus = RETAINED` | The money stayed with you. It is still in the box |

Both keep `paymentStatus = PAID`, and both record `cancelledAt`,
`cancelledByUserId` and the cancellation reason. A cancelled paid order with no
decision recorded counts as **retained** — the money is in the box until
somebody says it went back, and assuming a refund that never happened is how a
report tells an office boy he is short when he is not.

### What an employee cannot do

Not by a check, but by there being no endpoint: they cannot mark an order paid,
cannot change what it costs, cannot change how it was paid, and cannot alter an
order once it is paid for. The order total is computed from the menu prices on
the server; nothing a browser sends contributes a figure.

**Nobody marks their own lunch paid**, whatever they hold. The office boy eats
too, and without that rule the one person able to record himself as having paid
would be the person collecting.

### Today's collection

Two groups of figures, and the line between them is the whole design.

**The active day** — lunches that are actually happening:

| Figure | Means |
|---|---|
| Orders | Live orders for the day. Cancelled ones are not counted |
| Paid / Unpaid | How many of those have been settled |
| Expected | What the live orders come to |
| Collected | What the paid ones came to |
| Remaining | Expected minus collected — what is still owed to whoever is collecting |

**Cancelled, reported beside it and never inside it:**

| Figure | Means |
|---|---|
| Cancelled unpaid | Called off before anybody paid. No money was ever involved |
| Cancelled paid | Called off after being paid for |
| Refunded | Of that, what went back. It has left the box |
| Retained | And what stayed. It is still in the box, and is **not** in Collected |
| Cash in hand | Collected plus retained — what should actually be in the box |

**Cancelled orders are excluded from Expected, Collected and Remaining
entirely**, not just from Expected. An order nobody will eat is not a debt, and
a Remaining that included one would send somebody looking for money nobody owes
at the end of every day. They are not thrown away either: they come back in
their own figures, split by what happened to the money, because a refund and a
retained payment mean opposite things when a box is counted.

### Food to make

The collection screen also shows plates per item for the day. **Cancelled orders
contribute nothing to it**, whatever happened to the money: keeping the cash on a
cancelled order is a decision about the box, not an instruction to cook a lunch
nobody is coming for.

The figures are for the whole day and are fetched separately from the list
underneath them, which is one page of it. The day is the **company's** day, in
the company timezone, so a laptop that has travelled still opens the right
collection.

### Corrections

A payment recorded against the wrong person is put right from the collection
screen by somebody holding `lunch.payment.correct`. It needs a reason, it writes
the before and the after into the audit log, and it moves the day's Collected
figure — which is exactly why the reason is compulsory.

An order corrected back to unpaid becomes the employee's again: if it is still
ORDERED they can cancel it themselves, and otherwise the operator can.

Correcting a payment and cancelling an order are different acts and different
grants. A correction says *this payment was recorded wrongly*; a cancellation
says *this lunch is not happening*. On a delivered order only the first is
available.

**A cancelled order cannot be corrected here at all**, in either direction. Its
money was decided when it was cancelled and is recorded on the order; a
correction to PAID would record money taken for food nobody brought, and a
correction to UNPAID would erase the record of cash that really did change
hands. One state, one mechanism.

*Known gap:* there is currently no way to change a refund decision after the
fact — if an order was cancelled with the payment retained and it should have
been refunded, the money moves outside the system and the audit entry stands as
written. That would want its own endpoint and its own audit rather than a reuse
of the correction.

### The audit trail

Every operator cancellation writes one entry (`lunch.order.cancel.operator`)
carrying the order id, the employee, the previous status and the new one, the
payment status, the refund status where there is one, the amount, the
cancellation reason, who cancelled it and when. Marking an order paid, moving it
along the round and correcting a payment each write their own.

That entry is what somebody reads a month later when a cash box did not balance:
`PAID, RETAINED, 290` is the whole answer on one line.

### Prices and history

Menu items are **retired, never deleted**, and order lines carry the name and
price they were placed at. Putting the karahi up by fifty rupees changes new
orders only; it cannot rewrite what was collected last Tuesday.
