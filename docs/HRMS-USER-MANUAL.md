# HRMS user manual

The system of record for people, time and pay. This document explains what it
does, how the parts connect, and who can do what.

---

## 1. Overview

### What the system does

Six things, in the order they depend on each other:

1. **Organisation** — company profile, locations, departments, teams,
   designations, and who reports to whom.
2. **People** — employee records, with restricted fields protected.
3. **Time** — shifts, attendance, timesheets, and the biometric terminals that
   feed them.
4. **Leave** — leave types, balances, requests and the holiday calendar.
5. **Payroll** — salaries, allowances, deductions, runs and payslips.
6. **Governance** — roles, permissions, data scopes and an audit trail.

### What it deliberately does not do

Performance management, document storage, recruitment, expenses, assets and
tax. Performance and Documents appear in the sidebar as greyed-out "planned"
entries — there is nothing behind them.

### The main workflow

```
Set up the company
      ↓
Departments, designations, locations, holidays
      ↓
Shifts and leave types
      ↓
Employees, each with a department, manager and shift
      ↓
Attendance terminals, with device users mapped to employees
      ↓
Daily: punches → attendance → corrections and leave
      ↓
Monthly: pay period → run → calculate → review → approve → finalize → payslips
```

### How data flows between modules

This is the single most important diagram in this manual. Each arrow is a
one-way dependency; nothing flows back up.

```
Company ──► timezone, weekend days, currency, attendance thresholds
   │
   ├──► Locations ──► Holidays (a holiday may be company-wide or per location)
   │         └──────► Employees (a work location, optionally geofenced)
   │
   ├──► Departments ──► Teams ──► Employees
   │
   └──► Designations ──► Employees

Employees ──► manager / secondary manager ──► the approval chain
     │
     ├──► Shift assignments (effective-dated) ──► expected start and end
     │
     ├──► Device user mappings ──► raw punches become that person's attendance
     │
     ├──► Leave requests ──► approved leave overrides the attendance status
     │
     └──► Salaries and components (effective-dated) ──► payroll

Raw punches ──► pairing ──► Attendance records ──► the attendance engine
                                     │
                                     ├──► Team attendance and reports
                                     ├──► Timesheets (a draft can be filled from it)
                                     └──► Payroll (day counts, worked minutes, overtime)

Timesheets (APPROVED) ──► which overtime is payable

Payroll run ──► Payroll lines ──► Payslips
                     └──► Reports
```

### Which modules depend on which

| Module | Cannot work without | Degrades without |
|---|---|---|
| Attendance | Company timezone, an attendance policy | A shift (no shift → no lateness, no early leave; payroll assumes 8h) |
| Leave | Leave types, a reporting manager or department head | Holidays (leave would consume days the company does not work) |
| Approvals | A manager, secondary manager, **or** department head | — |
| Timesheets | — | Attendance (the "fill from attendance" button does nothing without it) |
| Devices | — | Device user mappings (punches are stored but belong to nobody) |
| Payroll | An effective-dated salary per employee, attendance for the period | Timesheets (unapproved overtime is not paid), payroll profiles (company defaults are used) |
| Payslips | A **finalized** payroll run | — |

---

## 2. Login and user roles

### Signing in

Email and password. Sessions are held server-side and last **8 hours** by
default (`SESSION_TTL_HOURS`). Sign-in is rate limited to **10 attempts per 5
minutes per IP address**; password reset requests to 5 per 15 minutes.

Forgotten passwords are reset by emailed link, valid for **60 minutes**
(`PASSWORD_RESET_TTL_MINUTES`). When `MAIL_PROVIDER=console` — the development
default — the link is written to the server log instead of being sent.

> **There is no way to create a login through the application.** See
> [Known limitations](HRMS-ADMIN-MANUAL.md#12-known-limitations).

### How permission actually works

Two independent things, and confusing them is the most common source of
"why can they see that?":

- A **permission** says *what kind of thing* you may do — read attendance,
  manage payroll, approve a request.
- A **data scope** says *whose records* that applies to.

A manager and an HR administrator can both hold `employee.read`. The manager's
scope narrows it to their reporting line; the administrator's does not. The
permission is the same; the answer is different.

The six data scopes:

| Scope | Sees |
|---|---|
| `NONE` | nothing |
| `OWN` | only their own employee record |
| `REPORTS` | people who report to them |
| `REPORTS_AND_OWN` | both |
| `DEPARTMENT` | everyone in their department, plus themselves |
| `ALL` | the whole company |

Where a user holds several roles, **the widest scope wins**.

### The four seeded roles

There is no separate "Company Admin" role. **HR Admin is the company
administrator**; Super Admin is the unrestricted technical role.

#### Super Admin — scope ALL

Holds **every** permission, including `role.manage`. This is the only role that
can change what other roles may do. Protected from editing.

#### HR Admin — scope ALL

The day-to-day administrator.

- **Can see:** everyone, including restricted fields (national ID, passport,
  visa, bank account) and every salary.
- **Can create:** employees, departments, teams, designations, locations,
  shifts, leave types, holidays, attendance policies, devices, salaries,
  salary components, pay periods and payroll runs.
- **Can edit:** all of the above; company profile and attendance thresholds.
- **Can approve:** any approval request (`approval.manage`), and payroll
  (`payroll.approve`).
- **Cannot access:** changing role permissions (`role.manage` is Super Admin
  only).

#### Manager — scope REPORTS_AND_OWN

- **Can see:** themselves and their direct reports — attendance, leave,
  timesheets, shifts, the org chart, company profile, departments, teams,
  designations, locations, holidays.
- **Can create:** their own leave requests, their own timesheets, their own
  attendance corrections and shift-change requests.
- **Can edit:** their own profile.
- **Can approve:** requests where they are the assigned approver
  (`approval.act`) — leave, timesheets, attendance corrections, shift changes.
- **Cannot access:** payroll and payslips **at all**. No payroll permission is
  granted to managers by default, so the Payroll section does not appear in
  their sidebar. Seeing a report's attendance is not the same as seeing their
  salary.
- **Restricted data:** no `employee.sensitive.read`, so national ID, passport,
  visa and bank account are stripped from every response.

#### Employee — scope OWN

- **Can see:** their own profile, attendance, leave balance and history,
  timesheets, payslips; the company holiday calendar; department, team,
  designation and location lists.
- **Can create:** leave requests, timesheets, attendance corrections,
  shift-change requests; their own check-in and check-out.
- **Can edit:** parts of their own profile, and their password.
- **Can approve:** nothing.
- **Cannot access:** anyone else's record. Requesting another employee's
  payslip by changing the id in the URL returns **403**, not the payslip.

### Permission catalogue

Grouped as the Roles screen groups them.

| Group | Permissions |
|---|---|
| Organisation | `company.read`, `company.manage`, `department.read/manage`, `team.read/manage`, `designation.read/manage`, `location.read/manage` |
| People | `employee.read`, `employee.manage`, `employee.sensitive.read`, `employee.import`, `employee.export` |
| Access control | `user.read`, `user.manage`, `role.read`, `role.manage` |
| Approvals | `approval.read`, `approval.act`, `approval.manage` |
| Payroll | `payroll.read`, `payroll.manage`, `payroll.approve`, `payslip.read` |
| Time | `attendance.read/manage`, `shift.read/manage`, `timesheet.read/manage`, `device.read/manage` |
| Leave | `leave.read`, `leave.request`, `leave.manage`, `holiday.read/manage` |
| Governance | `audit.read`, `settings.manage` |

Two of these are **grantable but do nothing**: `user.read` and `user.manage`
have no endpoint behind them, and `employee.import` has no import endpoint.

---

## 3. Company and organisation setup

Order matters — later steps reference earlier ones.

### Step 1: Company profile

**Settings → Company.** Name, legal name, contact details and address are
descriptive. Four fields are not:

- **Timezone** — the single most consequential setting in the system. Every
  attendance day boundary, every shift start comparison and every payroll
  period is interpreted in it. Set it before recording any attendance.
- **Currency** — stamped onto salary records and payroll runs when they are
  created. Changing it later does not restate history.
- **Week starts on** — affects how calendars are drawn.
- **Weekend days** — any combination of weekdays. A Sunday-to-Thursday week is
  configuration, not a code change. Days marked as weekend are never scheduled
  days and are never scored as absence.

### Step 2: Locations

**Organisation → Locations.** A location may carry latitude, longitude and a
geofence radius. Those are only consulted if check-in location restriction is
switched on. Locations also scope the holiday calendar.

### Step 3: Departments

**Organisation → Departments.** Departments nest, and each may have a head.
The head matters operationally: when an employee has no manager, the approval
chain falls back to their department head. Without either, **leave requests
cannot be raised at all**.

### Step 4: Designations

**Organisation → Designations.** Job titles. Purely descriptive; nothing
calculates from them.

### Step 5: Teams

**Organisation → Teams.** A grouping within a department, with an optional
lead. Used for filtering and for scoping attendance policies.

### Step 6: Reporting lines

Set on the employee record: **manager** and optionally **secondary manager**.
These build the org chart and determine who approves that person's requests.

### Step 7: Holidays

**Holidays.** A date, a name, and optionally a location. No location means
company-wide. Employees inherit the calendar of the location they are assigned
to, plus every company-wide holiday.

### Step 8: Attendance thresholds

**Settings → Attendance policy.** The company baseline — grace period, half-day
and full-day minutes, early-leave grace, overtime rules, and the optional IP
and geofence restrictions. See the [attendance guide](HRMS-ATTENDANCE-GUIDE.md).

**Settings → Policy overrides** creates named policies scoped to a department,
team or individual, with effective dates. Most specific wins:
employee → team → department → company.

---

## 4. The rest of this manual

| Subject | Document |
|---|---|
| Employees, settings, audit, security, offboarding | [Admin manual](HRMS-ADMIN-MANUAL.md) |
| Shifts, attendance, corrections, timezone rules | [Attendance guide](HRMS-ATTENDANCE-GUIDE.md) |
| Devices, pull, ADMS push, raw punches | [Device guide](HRMS-DEVICE-GUIDE.md) |
| Leave, holidays, approvals, payroll | [Payroll guide](HRMS-PAYROLL-GUIDE.md) |
| What each person does day to day | [Employee](HRMS-EMPLOYEE-GUIDE.md) · [Manager](HRMS-MANAGER-GUIDE.md) |
| When something is wrong | [Troubleshooting](HRMS-TROUBLESHOOTING.md) |
