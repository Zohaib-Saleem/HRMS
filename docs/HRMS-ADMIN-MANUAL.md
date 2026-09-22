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
| Department, team, location | no | Two separate fields: the **team** drives the Team Manager stage, the department only the fallback |
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

Lists the seeded roles and lets `role.manage` holders change what each may do.
Super Admin is protected from editing. A company can also **create** its own
roles here.

| Role | Scope | What it is for |
|---|---|---|
| **Super Admin** | ALL | Everything. Protected — its grants cannot be edited away, so nobody can lock the company out |
| **HR Admin** | ALL | People, organisation structure, attendance, leave, payroll, recruitment and the asset register |
| **Manager** | REPORTS_AND_OWN | Their own reporting line: their reports' records, attendance, leave and approvals |
| **Employee** | OWN | Baseline self-service for every member of staff |
| **Office Boy** | OWN | The daily lunch round and nothing else. No HR, payroll or employee-record access |
| **Interviewer** | OWN | The interviews they are sitting on, and their own feedback. Nothing of the pipeline |
| **IT Asset Manager** | OWN | The company's equipment register, plus ordinary employee self-service. **No HR access** — see [below](#the-it-asset-manager-role) |

The last three are **jobs rather than ranks**. They are handed out by name,
beside Employee, to somebody who has been given that job — and each is seeded
rather than left for a company to assemble, because a role introduced by a
release would otherwise exist on new installations and on no existing one.

A seeded role a company is missing is created at API start-up, so a role
introduced by a later release arrives on an existing installation rather than
only on new ones. An existing role is never touched by that: not renamed, not
re-scoped, not re-granted.

Changing a role's grants takes effect on the affected users' **next request** —
sessions are resolved per request.

#### Scope is not a permission, and it is the half people forget

A permission answers *"may you read attendance?"*. A **data scope** answers
*"whose?"*. They are orthogonal, and two rules about scope cause almost every
surprise in this area:

1. **Scopes union across a user's roles, and the widest wins.** Somebody holding
   Employee (OWN) and a custom role scoped ALL runs the *whole session* at ALL.
2. **A scope granted for one module applies to every module.** `attendance.read`
   is held by every member of staff, for their own record — so a custom role
   given an ALL scope because *its own* module is company-wide will also be
   served the whole company's attendance, leave and timesheets, without holding
   a single HR permission.

Since the release that added the IT Asset Manager role, one rule limits the
blast radius of (2) for attendance specifically: **a caller who does not hold
`employee.read` is narrowed to their own record on every attendance screen,
however wide their data scope is.** `employee.read` is already what the sidebar
gates Team attendance and Attendance reports on, so this makes the data agree
with the signposts. Super Admin, HR Admin and Manager all hold it, so nothing
about them changed.

The rule covers `/attendance`, `/attendance/team`, `/attendance/team-summary`,
`/attendance/monthly`, `/attendance/analytics`, `/attendance/reports/*`,
`/attendance/pay-period`, `/attendance/regularizations`, `/timesheets`,
`/shifts/assignments` and `/shifts/change-requests`. It is a narrowing and only
ever a narrowing: a scope of NONE still means no rows.

#### The IT Asset Manager role

For the person who looks after the company's laptops, phones and desks. Give it
to them **beside** the Employee role, not instead of it.

**What they get:** the whole asset register — add, correct, assign, transfer,
return, send for repair, retire, maintain the category catalogue, and run the
two asset reports — plus everything an ordinary member of staff holds for
themselves: their own attendance, leave, corrections, approvals, timesheets,
payslips, lunch, cases, loans and medical.

**What they do not get, deliberately:**

| Not held | Consequence |
|---|---|
| `employee.read` | No People screen, no Team attendance, no Attendance reports, no Employee Master Report, and no company-wide dashboard figures |
| `asset.dispose` | They can *retire* an asset — out of service, still owned — but writing one off for good stays with HR Admin and Super Admin |
| `attendance.manage` | No Correction centre. They raise their own correction requests like anybody else |
| `payroll.*` | No payroll, no salaries, no payslips but their own |
| `loan.manage`, `medical.manage` | Their own loans and their own medical benefit, and nobody else's |
| `device.read` | No device list and no raw punches |

Their sidebar is an employee's sidebar plus exactly three rows: **Asset
dashboard**, **Assets** and **Asset reports**.

**Their scope is OWN, and it costs the register nothing.** `asset.read.all` is
checked before the data scope is consulted, so this role sees every asset the
company owns from the narrowest scope in the system. Picking an employee to
hand equipment to goes through a six-field lookup rather than the employee
directory — see the [asset guide](HRMS-ASSET-GUIDE.md#picking-the-person-to-hand-it-to).

> **Replacing a hand-made asset role?** Remove the old one rather than adding
> this beside it. Scopes union and the widest wins, so leaving an ALL-scoped
> role attached keeps the holder at ALL and undoes the point of the change.
> The swap is **Settings → Users → [person] → Roles**, and it is recorded in the
> audit trail as `user.roles.update` with the roles before and after.

### Settings → Audit log

Every recorded action, newest first, with filters by action, entity type and
actor.

### Payroll → Settings

See the [payroll guide](HRMS-PAYROLL-GUIDE.md#2-payroll-settings).

---

## 3. Dashboard

**There are two dashboards, and which one you land on is decided by one
permission and one scope.**

| You hold | You get |
|---|---|
| `employee.read` **and** an ALL data scope | The **company dashboard** — headcount, present/absent/late today, the attendance trend, and attendance by department and by team |
| anything else | The **personal dashboard** — your own day, your own month, your own leave, and the self-service cards you hold grants for |

Both halves of the test matter, and the second was added because the first was
not enough on its own. A company built a role for the person who looks after
its laptops and gave it an ALL data scope, because the asset register *is*
company-wide. That role holds no HR permission at all — and it landed on the
company dashboard, where half the page refused to load and the other half
rendered the whole company's attendance. Scope alone could not tell an HR
administrator from an asset manager; `employee.read` can.

The server enforces the same thing independently, so this is not a matter of
which screen is drawn: `GET /company/stats` refuses a caller without
`employee.read` or without a full scope, and every attendance endpoint narrows
to the caller's own record without `employee.read`. See
[Scope is not a permission](#scope-is-not-a-permission-and-it-is-the-half-people-forget).

### The company dashboard

Its figures come from two places. The **KPI cards** come from
`GET /company/stats`; every **attendance** figure on the page — today's counts,
the trend, the department and team breakdowns, the exception lists — is folded
in the browser from `GET /attendance/team`, which returns one classified day per
employee per date. Nothing on the page is estimated or sampled: a figure that
cannot be derived is shown as a dash, because zero is a claim.

| Card | Exactly what it counts |
|---|---|
| Total employees | **Every** employee record in the company, including terminated ones |
| Departments | Active departments |
| On leave | Employees whose **status field** is `ON_LEAVE` |
| Active accounts | User accounts with status `ACTIVE` |

Two of those labels do not mean what they say, and both are worth stating:

1. **"On leave" does not mean "on leave today".** It counts employees whose
   *employment status* is set to `ON_LEAVE` — a long-term status like a
   sabbatical or extended absence, set by hand on the employee record. It has
   nothing to do with approved leave requests, and somebody on annual leave this
   week will **not** appear in it.

2. **"Total employees" includes leavers.** It is an unfiltered count. The
   endpoint also returns an `activeEmployees` figure, but the card does not use
   it.

There is no date filter on the KPI cards — those figures are "as of now". Below
them: recent activity from the audit log, and a setup checklist that links to
whatever is not yet configured.

### The personal dashboard

The landing page for everybody else, including every role built for a job. It
shows the holder's own day — check-in and check-out, today's status, the month
as bars and its totals — their own leave balance, their upcoming holidays, and
one card per self-service module they hold a grant for: lunch, cases, loans,
medical, and the assets issued to them.

Each card renders itself away when the grant behind it is absent, so a narrow
role gets a shorter page rather than a page of empty boxes. **No figure on it is
about anybody else**, and the endpoints behind it take no employee id — the
subject is resolved from the session, so there is no parameter to change.

One strip is added for whoever holds `asset.read.all`: **Asset register** —
total assets, assigned, available and under repair, with a link through to the
asset dashboard. It is the only company-wide figure on the page, and it is about
equipment. An asset count is a fact about things the company owns; an attendance
count is a fact about people, and in a small company "absent today: 1" beside a
visibly empty desk names a colleague. That distinction is the whole reason the
two dashboards are separate.

---

## 4. Approvals

Six things route through the generic approval engine:

| Subject | Raised by | Default chain | Applied on approval |
|---|---|---|---|
| `LEAVE_REQUEST` | the employee | Team Manager → HR Manager → CEO | the leave is marked approved and starts affecting attendance |
| `ASSET_REQUEST` | the employee | Team Manager → HR Manager → CEO | the request becomes APPROVED, and IT may then issue against it |
| `TIMESHEET` | the owner | reporting line | the timesheet is marked approved; its overtime becomes payable |
| `ATTENDANCE_REGULARIZATION` | the employee or their manager | reporting line | the attendance record is written with `source: ADMIN` |
| `SHIFT_CHANGE` | the employee or their manager | reporting line | the shift assignment is created |
| `LOAN_REQUEST` | the employee | reporting line | the loan is agreed; releasing it is a separate act |

**Payroll approval is not part of this engine.** It has its own status machine
and its own permission (`payroll.approve`).

### Who approves

A chain is a sequence of **stages**, and a stage is a job rather than a person.
It is resolved when the request is raised, and written down as it was resolved.

| Stage | Filled from |
|---|---|
| Team Manager | the active managers of the requester's own team, from the team roster |
| HR Manager | the people named for that stage in Settings → Approval hierarchy |
| CEO | the people named for that stage |
| Reporting manager | the requester's manager and second manager, falling back to their department head |

Nothing is inferred from a job title, a designation, a department name or a
role name.

A stage may have several approvers — a team has one to three managers — and
carries a mode: **any one** (the default: the first decision carries the stage)
or **every approver**. Four rules apply to every stage: the requester is never
on their own chain, nobody who has left is ever asked, nobody appears twice in
one chain, and a stage that resolves to nobody is **skipped with the skip
recorded on the request**.

If no stage can be filled at all the chain falls back to the reporting line,
and if that is empty too the request is **refused at creation**, before
anything is written, naming the fix.

### The flow

```
REQUEST ──► PENDING ──► stage 1 decides ──► stage 2 ──► stage 3 ──► APPROVED
                             └────────────────────────────────────► REJECTED
   requester may CANCEL while PENDING ──────────────────────────► CANCELLED
```

A multi-stage chain exists so several different people sign off. Separation of
duties is enforced: someone who decided an earlier stage cannot also decide a
later one, whatever they hold.

`approval.act` lets you decide the stages **you are named on**.
`approval.manage` is an administrative override — see and decide any request in
the company, recorded as an override.

Terminal states are immutable: re-approving returns 409, and so does approving
a stage a colleague has already carried.

The full picture — the team roster, the stage assignees, the configuration
screen and what happens on upgrade — is in the
[organisation hierarchy guide](HRMS-ORG-HIERARCHY-GUIDE.md).

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

See the [device guide](HRMS-DEVICE-GUIDE.md#6-security). In short: `/iclock` is
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
    Onboarding on a server with no relay goes through **Setting a password**
    instead, which needs no email at all.

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
| **Invited** | Created, but has never set a password. **Cannot sign in yet**. Setting a password for them activates the account |
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

> **Inviting creates no password.** The account is created as *Invited* with a
> stored value no password can ever match, and the person sets their own through
> the ordinary reset link. Nobody holding *Manage users* ever learns anybody's
> password. If the invitation does not arrive, send it again from the account's
> detail panel — a fresh link supersedes the old one.
>
> **There is one exception, and it is a separate permission.** *Set passwords*
> (`user.password.manage`) lets its holder set a temporary password and read it
> once, so somebody can be given it face to face. It exists because this server
> delivers no email, and an invitation nobody receives onboards nobody. See
> **Setting a password** below. No default role carries it except Super Admin.

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

### Setting a password

**Settings → Users → the account → Set password.** Needs *Set passwords*
(`user.password.manage`), which only **Super Admin** holds by default. Holders
of *Manage users* see **Send reset link** and not this.

This is the only place in the system where a password is shown to anybody but
its owner, and it exists for one reason: with no mail relay, a reset link
reaches nobody, so there would otherwise be no way to onboard a new joiner at
all.

**What you do.** Choose **Generate one** — four words and a number, built to be
read out loud and hard to guess — or type one you have agreed on the spot. Tick
the acknowledgement, and the password appears once, with a copy button.

**What happens to the account.**

- The password is stored, hashed, and marked as one the holder must replace.
- Any lockout is cleared, so the password you just issued actually works.
- **Every session ends.** Anyone signed in as them, anywhere, is signed out.
- Every unused reset link and invitation stops working.
- An *Invited* account becomes **Active**, because only an Active account can
  sign in — the screen tells you when this happened.

**What happens to them.** The first time they sign in, they are stopped at
**Choose your own password** and cannot reach any part of the application until
they set one. They are asked for the password you gave them as well as the new
one, so an unlocked browser is not enough to take the account.

> **The password you read out stops working the moment they use it.** That is
> what makes handing one over survivable, and it is not optional or a setting —
> the flag is written with the password, in the same operation.

**It is shown exactly once.** It is not stored anywhere you can read it back, no
screen or API returns it, and the audit trail records that a password was set,
by whom, for which account, and how many sessions ended — never the password
itself. If you lose it before handing it over, set another one; it costs
nothing and leaves its own audit line.

**Refused:** your own account, and any **suspended** account — restore that
first, deliberately, rather than as a side effect of issuing a password.

### Managing roles

**Settings → Roles.** Needs *Manage roles* (`role.manage`), held by **Super
Admin** by default.

A role answers two separate questions, and both matter:

| | |
|---|---|
| **Permissions** | What the holder may *do* — the tick-boxes under **Permissions** |
| **Data scope** | How much of the company they may *see*, whatever the permissions allow |

They are independent, and the second is the one people forget. A role holding
*View assets* at **Own record only** scope can open the asset register and find
almost nothing in it. Set the scope to match the job:

| Scope | Who it suits |
|---|---|
| **Own record only** | Employees, and desk roles that act on what is brought to them |
| **Direct reports and own record** | Team leads and line managers |
| **Whole department** | A head of department |
| **Entire organisation** | HR, IT and anyone running a company-wide function |

**Creating one.** **New role**, give it a name, a line of description and a
scope. The name is yours to change later; the identifier derived from it — `IT
Manager` becomes `IT_MANAGER` — is permanent, shown under the name field before
you commit, and is what any future seed or script would refer to. Then open
**Permissions** and tick what the role may do; a new role starts with none.

**Editing one.** **Details** renames, re-describes and re-scopes.
**Permissions** changes what it may do. A **system** role — the ones the
software seeds — can be renamed and re-scoped but never deleted, because the
catalogue recreates it on the next start. **Super Admin** is protected outright:
it always holds every permission and sees the whole company, which is what stops
a company locking itself out of its own settings.

**Deleting one.** Only a role the company created, and only when **nobody holds
it**. An account with no role at all is refused elsewhere in this system, so the
role is not taken out from under its last holder — move people first, then
delete. The refusal names how many accounts are in the way.

> **A scope change takes effect immediately**, including for whoever made it.
> Narrowing the scope of a role you hold yourself will narrow what you can see
> on the very next screen.

### Actions refused on your own account

Suspending yourself, revoking your own sessions, stripping your own roles and
setting your own password are all refused from this screen. They are ways to
lock the last administrator out — setting your own password here would end the
very session making the request and then demand you change it again. Sign out
from the header; change your password from your profile.

### Onboarding: the normal sequence

```
1  People → Add employee           department, manager, hire date
2  Shifts → Assignments            effective from their start date
3  Payroll → Profiles              a salary, effective-dated
4  Settings → Users → Invite user  choose the employee, pick roles
5  They accept the invitation      set a password → account becomes Active
6  Devices → Device users          map their terminal PIN, if used
```

**With no mail relay, step 5 cannot happen** — the invitation is an email and
nothing delivers it. Replace it with:

```
5  Settings → Users → the account → Set password
   Generate one, read it to them, and they choose their own at first sign-in
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

### 3. ~~The dashboard is not scope-narrowed~~ — *resolved*

`GET /company/stats` used to count the whole company for anyone holding
`company.read`, which every member of staff holds. It now requires
**`employee.read` and a full data scope**, and refuses everybody else — so a
manager no longer sees "Total employees: 250" on a twelve-person team, and an
employee is served their own dashboard instead.

A second half of the same problem was found later and is also closed: the
attendance figures on that page come from `/attendance/team`, which was narrowed
by the data scope alone. A role given a wide scope for an unrelated module was
therefore served the company's attendance while holding no HR permission.
Attendance now additionally requires `employee.read` to reach anybody but
yourself. See [Dashboard](#3-dashboard) and
[Scope is not a permission](#scope-is-not-a-permission-and-it-is-the-half-people-forget).

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

---

## 17. Assets

The company's equipment, who is holding it, and what happened to it. This is the
operator's walkthrough; the [asset guide](HRMS-ASSET-GUIDE.md) is the complete
reference, including every status transition and every endpoint.

### Three screens

**Asset dashboard** — what needs attention today. **Assets** — the register.
**Asset reports** — the register as a sheet, and everything anybody is holding.
Plus **Settings → Asset management** for the category catalogue.

### The two things to understand first

**Status and condition are different questions.** Status says where the thing is
in the company's custody; condition says what state the thing is in. A laptop can
be *Assigned* and *Damaged* at the same time, and that is how it usually happens.
They are two columns on the form and neither follows from the other.

**Who has it is a history.** There is no "current holder" field. The holder is
the one open handover, and every handover before it is still on the record. That
is why you cannot type *Assigned* into the edit form — an asset becomes assigned
by being assigned to somebody, which writes the row that says whose desk it is
on. The form will refuse *Assigned* and *Returned* with a message saying so.

### Adding one

**Assets → Add asset.** Only the **tag** and the **name** are required, though an
asset with no category is an asset that falls into the *Uncategorised* bucket on
every breakdown. The tag is unique per company; so is the serial number when you
give one.

A new asset cannot start *Assigned*. Add it, then assign it.

### The round trip

**Assign** records who, when, the condition it went out in, and what went with
it — charger, bag, SIM. The condition is **required**: a handover with no
recorded condition is one nobody can argue about later, which in practice means
the employee loses the argument. The holder gets an in-app notification asking
them to confirm.

**Return** records the condition it came **back** in, which is stored on the
handover rather than only on the asset. Accessories missing on the day are
worked out for you — issued minus returned — and stored, so the record survives
somebody later editing the issued list.

**Transfer** moves it straight to the next person without it coming back. The
outgoing handover ends as *Transferred on*, not *Returned*, because it was not.

> **Returned is not Available.** An asset that has just come back has not been
> checked yet. Somebody moves it to *Available* on purpose, after looking in the
> bag. That step is the whole reason the status exists.

### Repairs, damage and loss

**Send for repair** remembers the status the asset had before and restores it
when the repair completes or is cancelled — so a laptop that was assigned goes
back to being assigned, not to the bottom of the stock pile.

**Damaged** and **Lost** each record an incident: what happened, when, and who
reported it. Marking something lost does not end the claim on it; *Lost* can go
back to *Available*, because things turn up.

### Retiring and disposing

**Retire** takes an asset out of service while you still have it. **Dispose**
writes it off — sold, scrapped, donated, recycled or other — with the date, the
reason, the final value and who approved it.

Retired goes only to Disposed, and **nothing comes back from Disposed.** Both are
irreversible by design; an asset that was scrapped and is then marked available
again is either a second asset or a mistake, and both deserve attention rather
than a silent edit.

Nothing in this module deletes anything. A written-off laptop is a status, not a
missing row.

### What employees can do

Two things, and only to their own handover: **acknowledge** it, and **report a
problem** with it. Reporting a problem raises an incident for you; it does not
mark the asset damaged. That decision is yours.

They cannot see the register, what anything cost, who had their laptop before
them, or any asset sitting in a cupboard. A manager sees their reporting line's
assets by data scope, and still not the unheld stock.

### Clearance

Somebody who has **resigned** or been **terminated** and is still holding
something shows up on the dashboard and on their own employee record, as
*Cleared*, *Partially cleared* or *Pending*.

**It counts; it never acts.** Nothing on a clearance screen marks an asset
returned — that would be a screen saying the laptop came back when it did not.
Record the real return through **Return** and the clearance follows.

### The dashboard, in one paragraph

One request behind the whole screen, so every figure describes the same rows at
the same instant. Six alerts: warranty expiring, under repair, damaged, lost, not
returned, pending clearance. The middle three link straight to the register with
that filter applied; the other three carry their own lists, because no status
filter can reach them. Counts are exact and the lists are capped at fifty, and
the page tells you when it is showing fifty of four hundred. The warranty window
is 30, 60, 90 or 180 days and is measured against **the company's today**.

### The two reports

They have different **grains**, which is why there are two. The **asset report**
is one row per asset — what do we own and what is it worth. The **employee
register** is one row per handover — what is this person holding, which is the
question asked at an audit, a transfer and a resignation.

Both total **every row the filters match**, not the page on screen. Both export
to CSV with the same filters and columns as the screen, and every export is
recorded in the audit log with who, when, and how many rows left the building.
An export of more than 20,000 rows is refused with a message rather than quietly
shortened.

> **One trap worth knowing.** On the register, the *department* filter means the
> department the **asset** is booked to. On the two reports it means the
> **holder's** department — that is the column those reports print, and *team*
> beside it could only ever mean the person. So narrowing a report by department
> excludes assets nobody is holding.

### The category catalogue

**Settings → Asset management.** Two levels: a group that means something in a
report, and a type underneath it that somebody picks on the form. An asset may be
filed against either.

You start with a seeded catalogue — IT Equipment, Office Equipment, Vehicles,
Other — and from that moment it is yours to rename, reorder and retire. Nothing
in the system matches on those names.

Categories are **retired, never deleted**: a retired category stops being offered
on the form while every asset already filed against it keeps its category and
every past report still adds up.

### What is not here

No approval step on assigning or disposing — they are audited, not routed. No
depreciation: current value is a number you set. No barcode scanning, no bulk
import, and no email — the two handover notifications are in-app only. And
nothing reaches payroll: issuing somebody a laptop creates no deduction of any
kind.

---

## 18. Recruitment

Vacancies, candidates, interviews, offers, and the one bridge onto the payroll
roster. This is the operator's walkthrough; the
[recruitment guide](HRMS-RECRUITMENT-GUIDE.md) is the complete reference,
including every status transition and every endpoint.

### The one thing to understand first

**A candidate is not an employee.** They have no employee number, no department,
no contract, no attendance and no login, and they are a separate record for a
reason: modelling applicants as employees would mean every headcount, payroll
run and org chart in this product quietly counting people who have never worked
here.

There is exactly one bridge — **Convert to Employee** — and you perform it
deliberately, review the mapping, and confirm it.

### Four screens

**Recruitment** (the dashboard), **Job openings**, **Candidates**,
**Interviews**. Each carries the grant its own endpoints need, so an interviewer
sees one row and a hiring manager sees two.

### Openings

**Draft** is not a quiet **Open**. A draft takes no applications, appears on no
pipeline, and counts towards nothing — because the difference between "we are
hiring" and "somebody started typing" is a number you report upwards. Only
**Open** accepts new candidates and new interviews; **On hold** keeps the
vacancy alive but stops activity against it.

**Closing or cancelling asks you for a reason, and insists.** That is why status
lives behind its own action rather than on the edit form: a reason that can be
skipped is a reason nobody writes, and "Closed" with nothing beside it is
useless six months later when the same headcount comes back round.

*Vacancies* is a count of **seats**. Six openings for two people each is twelve.

### Candidates and the board

**The stage lives on the application, not on the person.** Somebody can be
shortlisted for Design and rejected by Development on the same afternoon, and
that is a normal Tuesday. The stage shown next to their name in the list is a
**summary** — the furthest stage across their applications — and it is never
what a decision is made against. Open the candidate and act on the application.

The board's columns are the seven progression stages. **Rejected** and
**Withdrawn** have no column on purpose: they are states people leave the
pipeline into, and giving them columns turns a board that shows a process into a
board that mostly shows people who are no longer in it.

Moving backwards is allowed and expected — shortlisted on Monday, back to
screening on Tuesday when somebody actually reads the CV. Two moves are refused:
**Hired only from Offer**, and **nothing comes back from Hired**.

Rejecting or withdrawing somebody **asks why**. Both are reversible back to
*Screening*, so re-opening a candidate does not mean creating a second record.

> Keep Rejected and Withdrawn apart. "We said no" and "they said no" are the
> same outcome and completely different information when the same CV arrives
> again next year.

### What an interviewer cannot see

`candidate.read` is **not** part of `employee.read`, and managers do not hold it.
Somebody interviewing a person is shown that person through the interview, which
carries their name; they do not get to browse what everybody who ever applied is
earning.

Even with `candidate.read`, the **restricted block** — current salary, expected
salary, your notes — is stripped without `candidate.manage`. So is anything in
the candidate timeline that would reveal it.

### Interviews

Book a **day, two times and a timezone**. Not an instant: the interview is at ten
o'clock in Karachi whoever is looking at it, and the server does the arithmetic.

**Clashes refuse the booking and name who clashes**, and you can overrule them —
sometimes the person really is double-booked and it is fine. The warning the form
shows before you commit is the same check, so it cannot disagree with the
refusal. A cancelled interview frees its slot; a completed one still occupied it.

**Rescheduling is not editing the time.** It writes a history row saying where
the interview moved from, in the same transaction as the move, and sets the
status to *Rescheduled* — which nobody can pick by hand.

Nothing comes back from **Cancelled**. An interview that is happening after all
is a new booking, which keeps the cancellation visible rather than erasing it.
*Completed* can still go to *No show*, because "marked complete by mistake" is an
ordinary Tuesday.

**The panel is notified in the app** when an interview is booked, moved or
cancelled. The interface tells you honestly what happened to the email half —
and on this installation mail is the console provider, so **no email is actually
delivered**. A panellist with no login is skipped silently rather than failing
the booking.

**Candidates are never notified by the system.** Contacting them is your job,
outside it.

### Evaluations

One per panellist per interview, **never merged and never averaged**. Nothing
ranks candidates by score or moves a stage because of one. Three interviewers
produce three opinions and a person reads them.

Scores are **optional on purpose**: an HR interviewer has no business scoring
technical skill, and a blank says "not assessed" where a zero would say
"assessed, and terrible".

They can only be filed once the interview is **Completed** or **No show**.
Removing somebody from a panel removes their evaluation with it.

### Offers

`recruitment.offer.manage` is a separate grant from `recruitment.manage`,
because an offer is a commitment about money and the person who arranges
interviews need not be the person who makes one.

**An answered offer is finished.** Nothing leaves Accepted, Declined or Expired —
changing the terms afterwards is a **new offer**, which keeps the first one and
what it promised on the record.

Marking an offer *Sent* nudges the candidate forward to *Offer*, and only
forward: marking an old offer expired can never drag somebody back from *Hired*.

**Nothing expires on its own.** *Expired* is a status you set when the answer
never came.

### Convert to Employee

Two steps, and the first one writes nothing.

**Preview** assembles a proposal — from the accepted offer, then the opening,
then the candidate — and shows you any existing employee who looks like this
person, matched by email and by name.

**Convert** creates the employee record from **what you confirmed on the form**,
not from what the candidate record said. The name split is a guess (everything
before the last space, then the rest), which is exactly why it lands on a form
you edit.

Four things it will not do:

- **Create a second employee for the same candidate.** Ever, even under a race.
- **Proceed silently past a look-alike.** It refuses until you acknowledge them,
  and re-checks at the moment of writing rather than trusting a preview taken
  ten minutes ago. Two people really do share a name, so it is overrulable — but
  never silent.
- **Create a login.** Do that afterwards, deliberately, under Users.
- **Write any salary, payroll profile or contract.** The offer's figure stays on
  the offer. Set their pay in payroll, on purpose.

Employment status defaults to **Probation**.

Conversion does not require the candidate to be at *Hired* first. It is a
deliberate action by somebody holding the grant, and your review is the control.

### Who sees what, and why it is not the data scope

Recruitment is narrowed by **named involvement**, not by data scope, and that is
a deliberate departure from the rest of the product.

A data scope says whose **employee records** somebody may read. A reporting line
is a good reason to read your own people's records; it is not a reason to read
what the company is paying a stranger to replace them with. So:

- `recruitment.read` alone returns the openings you are **named on** — as hiring
  manager or recruiter.
- `interview.read` alone returns the interviews you are **on**.
- `candidate.read` returns candidates with the restricted block stripped.

The dashboard is scoped the same way: a hiring manager's "open positions: 2" is
their own two. And throughout the module a guessed id answers **404**, never
403 — telling somebody "that exists but is not yours" confirms that a particular
candidate is being interviewed, which is exactly what an unauthorised caller was
probing for.

A login that is not linked to an employee record has no anchor, so the narrow
grants return nothing for it.

### The Interviewer role

A seeded system role holding `interview.read` and `interview.evaluate` and
nothing else. The whole module for them is one sidebar row leading to their own
calendar, with the interviews they are actually sitting on. Give it to people
who join panels and should reach nothing else.

### What is not here

No careers portal and no public job board — openings are internal records and
candidates are entered by you. No CV parsing. No email to candidates. No offer
letter PDF. No automatic offer expiry. No scoring, ranking or automatic
shortlisting. No approval workflow on opening a vacancy, making an offer or
converting somebody. And nothing reaches payroll.
