# Quick start — for a new HR administrator

What must be configured before the first employee can use the system, in the
order it has to happen.

> ## Read this before you start
>
> Recording an employee does **not** give them a way in. An employee record and
> a login account are separate things, and not everybody needs both.
>
> Logins are created by invitation from **Settings → Users**: you choose the
> employee and the roles, they receive a link and set their own password. No
> password is ever generated or shared, so nobody but the account holder ever
> knows it.
>
> The three seeded accounts (`admin@`, `manager@`, `employee@hrms.local`) exist
> for development. Change their passwords or replace them before going live.

---

## Before you touch the interface

Confirm with whoever runs the server:

- [ ] `DATABASE_URL` points at the right database
- [ ] `SESSION_SECRET` is a real 32+ character secret, not the development one
- [ ] `MAIL_PROVIDER=smtp` with real SMTP settings, if you want password-reset
      emails to actually send. On `console` the link is written to the server log
- [ ] `APP_URL` is the address staff will use, so reset links point somewhere real
- [ ] For a pushing attendance terminal: `DEVICE_PUSH_ORIGIN` set to a LAN
      address, and `API_HOST=0.0.0.0`

---

## Step 1 — Company profile

**Settings → Company.**

- [ ] Name and legal name
- [ ] **Timezone** — set this first and do not change it later. Every attendance
      day, every shift comparison and every payroll period is interpreted in it
- [ ] Currency — stamped onto salaries and payroll runs when they are created
- [ ] Week starts on
- [ ] **Weekend days** — any combination, not only Saturday and Sunday
- [ ] Employee number prefix

## Step 2 — Organisation structure

- [ ] **Locations** — every site. Add coordinates now if you intend to geofence
      check-in later
- [ ] **Departments** — set a **head** for each. This is the fallback approver
      and prevents leave requests being refused outright
- [ ] **Designations** — job titles
- [ ] **Teams** — optional, within departments

## Step 3 — Time rules

- [ ] **Settings → Attendance policy** — grace, half-day and full-day
      thresholds, early-leave grace, overtime rules. Leave IP and location
      restrictions **off** until everything else works
- [ ] **Shifts** — at least one, with start, end and break minutes
- [ ] **Holidays** — the year's calendar. Company-wide, or per location

## Step 4 — Leave rules

- [ ] **Leave types** — for each: annual entitlement, monthly accrual,
      carry-forward and cap, and crucially whether it is **paid**. Unpaid leave
      is deducted by payroll

## Step 5 — People

For each employee (**People → Add employee**):

- [ ] First and last name — the only required fields
- [ ] Employee number, or let it generate
- [ ] Department, designation, location
- [ ] **Manager** — without a manager and without a department head, this person
      cannot raise a leave request at all
- [ ] **Hire date** — payroll clamps the period to it, and warns if missing
- [ ] Employment type

Then:

- [ ] **Shifts → Assignments** — assign a shift, effective from their start date

## Step 6 — Payroll configuration

- [ ] **Payroll → Settings**:
  - Frequency (reporting only — periods carry their own dates)
  - **Basis** — calendar days, a fixed figure, or working days. This decides
    what a day is worth and there is no universally right answer
  - Standard hours per day
  - Overtime mode and multiplier, and whether approval is required
  - Which absences are deducted
  - Rounding and payslip prefix
- [ ] **Payroll → Salary components** — allowances, bonuses, recurring
      deductions
- [ ] **Payroll → Profiles** — for each employee, a **salary** effective from
      their start date, and any components they receive

Payroll will refuse to finalize without a salary for everyone in the run.

## Step 7 — Attendance terminals (optional)

- [ ] **Attendance → Devices → Add device** — see the
      [device guide](HRMS-DEVICE-GUIDE.md)
- [ ] **Test connection** (pull devices) and record the serial
- [ ] **Device users** — map every device PIN to an employee. Unmapped punches
      are kept but belong to nobody

## Step 8 — Access

- [ ] **Settings → Roles and permissions** — review what each of the four roles
      can do before anyone signs in
- [ ] **Settings → Users** — invite a login for everyone who needs one, with
      the right roles. Start with one administrator other than the seeded
      account

---

## First-day setup checklist

```
[ ] Company profile, timezone, currency, weekend days
[ ] Locations
[ ] Departments, each with a head
[ ] Designations
[ ] Teams (optional)
[ ] Attendance policy thresholds
[ ] Shifts
[ ] Holiday calendar for the year
[ ] Leave types, with paid/unpaid set correctly
[ ] Employees, each with department, manager and hire date
[ ] Shift assignment for every employee
[ ] Payroll settings: basis, overtime, deductions, rounding
[ ] Salary components
[ ] A salary for every employee, effective-dated
[ ] Attendance device registered (if used)
[ ] Device user mapping for every employee (if used)
[ ] Roles reviewed
[ ] Logins invited, with roles
[ ] Attendance test  (below)
[ ] Payroll test     (below)
```

### Attendance test

1. Have one employee check in and out, or let a terminal deliver a punch.
2. **Attendance → Team attendance** — confirm the day appears with the right
   status, and that late minutes match what you expect from the shift and grace.
3. If a device is in use: **Devices → Sync history** should show the run, and
   **Device punches** the raw reading with the right local day.

### Payroll test

Run a **throwaway period** before you trust the real one:

1. **Payroll → Pay runs → New period** for a month that already has attendance.
2. **New pay run** against it, then **Calculate**.
3. Read the **exceptions** first, not the totals.
4. Open one employee and check the calculation drawer line by line against a
   figure you have worked out by hand.
5. **Cancel** the run. Do not finalize a test — finalizing closes the period
   permanently and issues payslips.

---

## Monthly HR checklist

```
Through the month
[ ] Clear the approvals queue — pending leave holds days against balances
[ ] Watch for incomplete days (checked in, never out) and chase corrections
[ ] Add new joiners with department, manager, hire date, shift and salary
[ ] Terminate leavers — this also suspends their login and ends their sessions

Before payroll
[ ] Every timesheet carrying overtime is approved, or that overtime is not paid
[ ] Every employee in the period has a salary covering it
[ ] Attendance corrections for the period are approved and applied
[ ] The holiday calendar for the period is right
[ ] Leave for the period is decided, not left pending

Payroll
[ ] Create the pay period
[ ] Create the run and calculate
[ ] Read every exception. Blocking ones must be resolved and the run recalculated
[ ] Review the employee table; spot-check a few calculation drawers
[ ] Approve
[ ] Finalize  ← irreversible; issues payslips and closes the period
[ ] Publish payslips when you are ready for staff to see them

After payroll
[ ] Export the reports you file
[ ] Raise adjustments for anything found afterwards — never edit a finalized run

Year end
[ ] Carry forward leave balances
[ ] Create next year's holiday calendar
```
