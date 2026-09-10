# Payroll

Payroll sits at the end of a pipeline that already existed. It does not read a
punch, re-score a day, or decide whether somebody was late.

```
device punches ──► attendance engine ──► attendance records
                                    └──► timesheets (overtime approval)
                                                  │
                                                  ▼
                                             PAYROLL
                                                  │
                                                  ▼
                                    payroll lines ──► payslips
```

The join is `deriveRangeForEmployees()` — the same function the attendance
screens are built from. Every day count on a payslip can be traced to a day an
administrator can open and look at. There is one attendance engine, and payroll
is a consumer of it.

## What is reused

| Need | Existing model |
|---|---|
| Day status, worked/late/early/overtime minutes | `AttendanceRecord` via the attendance engine |
| Paid vs unpaid leave | `LeaveType.isPaid` |
| Overtime approval | `Timesheet.status = APPROVED` |
| Weekends, holidays | `Company.weekendDays`, `Holiday` (location-aware) |
| Rostered hours, overnight shifts | `Shift`, `EmployeeShiftAssignment` |
| Audit trail | `AuditLog`, with `payroll.*` actions |
| Authorization | `requirePermission` + `employeeScopeFilter` |

There is no separate payroll audit table. `AuditLog` already records actor,
timestamp, action, entity and a before/after diff; a second table would split
the trail so that reconstructing who did what meant looking in two places.

## Salary is effective-dated

A salary record has `effectiveFrom` and an optional `effectiveTo`. Overlapping
records are refused at write time, because two salaries claiming the same day
are two contradictory answers to "what is this person paid" and payroll should
not pick one.

```
Jan–Jun   100,000
Jul on    120,000     ← July payroll uses 120,000; June is untouched
```

A change mid-period splits the period into segments and prorates:
a raise on the 16th of a 30-day month pays `100,000 × 15/30 + 120,000 × 15/30`.

## Salary types

| Type | Basic pay | Absence |
|---|---|---|
| `MONTHLY` | the salary, prorated only for partial coverage | deducted at the daily rate |
| `DAILY` | rate × days actually paid for | never deducted — the day simply is not paid |
| `HOURLY` | rate × (worked hours + paid-leave hours) | never deducted |

Deducting an absence from daily or hourly pay would charge for the same day
twice, so it is not done.

## The configurable numbers

Nothing about what a day is worth is hard-coded.

**Basis** — what a monthly salary is divided by to reach a daily rate:
`CALENDAR_DAYS` (days in the period), `FIXED_DAYS` (a configured figure,
usually 30 or 26), or `WORKING_DAYS` (the period less weekends and holidays).
A company paying by calendar days and one paying by a fixed thirty produce
different figures from the same salary and the same attendance, and both are
right for their own contracts.

```
daily_rate        = monthly_salary / basis_days
absence_deduction = daily_rate × unpaid_days
```

**Overtime** — `NONE`, `MULTIPLIER` (hourly rate × factor) or `FIXED_RATE`
(a flat amount per hour). With `requireApprovedOvertime` on, which is the
default, only hours covered by an APPROVED timesheet are paid; the rest are
counted, reported as an exception, and not paid.

```
500/hr × 1.5 × 4 approved hours = 3,000
```

Overtime minutes come from the attendance engine as recorded - payroll never
re-derives them from punches. The attendance policy's daily, weekly and
monthly caps have already been applied by the time payroll reads a day.
`overtimeCapMinutes` on payroll settings is a ceiling on top of that: the most
overtime paid to one person in one period, or null for no ceiling. When it
trims something the run carries an `OVERTIME_CAPPED` warning saying how much,
and the line records `paidOvertimeMinutes` alongside the recorded and approved
figures so the payslip can show all three.

`standardHoursPerDay` turns a daily rate into an hourly one (9 hours = 540
minutes); `fallbackScheduledMinutes` is the length assumed for a working day
with no shift assignment behind it. Both are settings, both are shown on
Payroll → Settings, and neither is a constant in the engine.

**Deductions** — unpaid absence and unpaid leave each have their own on/off
switch. Lateness and early leaving can be charged `PER_MINUTE` or
`PER_OCCURRENCE`, with a payroll grace period on top of whatever the attendance
policy already forgave.

Every one of these can be overridden per employee on their `PayrollProfile`;
null there means "inherit the company setting", so a company that changes its
mind changes one row rather than four hundred.

## The run

```
DRAFT ──► CALCULATING ──► REVIEW ──► APPROVED ──► FINALIZED
   └──────────────────────────┴───────────┴──────► CANCELLED
```

`REVIEW → APPROVED` can be sent back for another look. `FINALIZED` and
`CANCELLED` are terminal.

**A finalized run never changes.** Every figure the calculation used — the
salary amount, the basis, the multiplier, the day counts — is copied onto the
line rather than referenced. That redundancy is the point: a later raise, an
attendance correction, a leave approval or a change of company policy has
nothing to reach back into. The period is closed and cannot be run again.

Corrections after finalization are raised as a `PayrollAdjustment`, which is
applied in a later run. The original line and the correction both stay visible.

## The preview

**Payroll → Preview** answers "what would this pay?" before anybody commits to
it. `GET /payroll/runs/preview` accepts a run, a period, or a bare date range —
so a period with no run yet can be previewed too.

It runs `computePayroll()`, which is *the same function a run runs*. A run then
persists what it returns; the preview shows it and throws it away. That shared
path is the point: the preview and the payslip that follows it cannot disagree
about a period except about facts that changed in between.

**The preview writes nothing.** No line, no exception, no run status, and no
adjustment is claimed — it passes `runId: null`, so it sees only adjustments
still unspoken for and marks none of them as spent.

Columns, per employee: basic salary, paid days, absent days, unpaid leave,
allowances, overtime hours and amount, deductions, gross and net. Each row
opens to show every earning and deduction line with its rate and units, plus
the rates the whole calculation was derived from. Exceptions are hung on the
employee they belong to rather than heaped at the bottom.

Employees a **blocking** exception stopped short of a line still appear, marked
— because a preview that quietly omitted the three people with no salary on
record is exactly how a payroll gets finalized without them.

## Exceptions

The calculation records what it could not resolve rather than guessing:

| Code | Severity | Meaning |
|---|---|---|
| `MISSING_SALARY` | blocking | no salary on record, or a gap in the period |
| `OVERLAPPING_SALARY` | blocking | two records claim the same day |
| `NON_POSITIVE_NET` | blocking | net is zero or negative |
| `MISSING_PROFILE` | warning | company defaults were used |
| `MISSING_SHIFT` | warning | no shift assigned; eight hours assumed |
| `INVALID_ATTENDANCE` | warning | checked in but never out, or no attendance at all for the whole period |
| `UNAPPROVED_OVERTIME` | warning | hours recorded but not paid |
| `INCOMPLETE_EMPLOYEE` | warning | employee number or hire date missing |
| `OVERTIME_CAPPED` | warning | overtime above the payroll ceiling, recorded and not paid |

A run carrying a blocking exception cannot be approved or finalized. That is
the mechanism behind "do not silently produce questionable payroll".

## Authorization

Two rules, and they are not the same rule. A **permission** says what kind of
thing you may do; a **data scope** says whose.

| Permission | Default holders |
|---|---|
| `payroll.read` | Super Admin, HR Admin |
| `payroll.manage` | Super Admin, HR Admin |
| `payroll.approve` | Super Admin, HR Admin |
| `payslip.read` | Super Admin, HR Admin, **every employee** (scope OWN) |

Managers hold no payroll permission by default: seeing a report's attendance is
not the same as seeing their salary.

Every read of a line, payslip, salary or adjustment is filtered through
`employeeScopeFilter`. A payslip exists from the moment a run is finalized,
but is released to its owner only when the run's payslips are published; until
then anyone without `payroll.read` gets a 404 for it and does not see it
listed. An employee with an OWN scope sees exactly one payslip,
and changing the id in the URL returns 403 — not somebody else's pay. That is
asserted directly in the test suite, and the assertion was verified to fail
when the guard is removed.

`payroll.approve` is separate from `payroll.manage` so a company can insist
that whoever prepares the payroll is not the person who signs it off. HR Admin
holds both by default, because a company with one administrator should not be
locked out of its own payroll; revoking `payroll.approve` splits the duty.

## Timezones

Payroll inherits the company timezone rather than reasoning about it. A punch at
01:00 Karachi was assigned to its local day when it was imported — that is
20:00 UTC the previous day — and payroll counts the day the attendance engine
recorded. Repeating the decision here is exactly how a late shift ends up
counted twice or not at all.

## The screens

| Route | What it is | Permission |
|---|---|---|
| `/payroll` | Dashboard: period, status, gross/deductions/net, overtime cost, pending approvals, exceptions | `payroll.read` |
| `/payroll/runs` | Pay runs, with the workflow actions | `payroll.read` |
| `/payroll/runs/:id` | Review: exceptions above, one row per employee, click for the calculation | `payroll.read` |
| `/payroll/profiles` | Salary history and assigned components, per employee | `payroll.read` |
| `/payroll/components` | The allowance and deduction catalogue | `payroll.read` |
| `/payroll/reports` | Eight reports with filters and CSV export | `payroll.read` |
| `/payroll/preview` | What a run or period would pay, written nowhere | `payroll.read` |
| `/payroll/settings` | Frequency, basis, overtime, deductions, rounding, tax | `payroll.manage` |
| `/payslips` | Payslips, narrowed by data scope | `payslip.read` |
| `/payslips/:id` | The payslip document, printable | `payslip.read` |

Managers hold no payroll permission by default, so Payroll does not appear in
their sidebar at all. Every member of staff holds `payslip.read` with an OWN
scope, so Payslips does — and shows exactly one row.

The action buttons on a run follow its status rather than being shown and
disabled: a six-state workflow with every button always visible is harder to
read than one offering the two things actually possible. The server enforces
the same transitions regardless — hiding a button is a courtesy, not a control.

### Printing

The payslip uses the browser's own print. No PDF library: the browser produces
a better PDF than a hand-rolled one, every platform has the button, and it is
one `print:hidden` class rather than a second rendering path that can drift
from the screen.

## Testing

```bash
npx tsx scripts/verify-payroll-calc.mjs
```

Drives the calculation as pure functions against figures worked out by hand.
No server, no database, no fixtures.

```bash
npx dotenv -e .env -- npx tsx scripts/audit-payroll.mjs
```

Drives the real API end to end: the workflow, immutability, exceptions,
adjustments and employee isolation.


## A worked example

Pinned in `calculation.test.ts` under **the worked example**, so the arithmetic
below is asserted rather than described.

**Given.** Salary 120,000 monthly. A 30-day period: 20 days present, 2 days of
paid leave, 3 days of unpaid absence, 5 weekend days. Two hours of *approved*
overtime and a fixed allowance of 10,000. Company settings: `FIXED_DAYS` basis
of 30, 8 standard hours a day, overtime at 1.5x, absence deducted, approval
required.

**The rates.**

```
daily rate    120,000 / 30 basis days     =   4,000.00
hourly rate     4,000 / 8 standard hours  =     500.00
```

**Earnings.**

```
basic         one salary, whole period    = 120,000.00
overtime      2 h × 500 × 1.5             =   1,500.00
allowance     fixed                       =  10,000.00
                                            -----------
GROSS                                        131,500.00
```

**Deductions.**

```
unpaid absence   3 days × 4,000           =  12,000.00
paid leave       2 days, paid             =       0.00
                                            -----------
DEDUCTIONS                                    12,000.00
```

**Net.**

```
NET           131,500 − 12,000            = 119,500.00
```

**Day counts.** Scheduled days are 20 + 2 + 3 = **25**; the 5 weekend days are
nobody's expectation and are not in the count. Payable days are 25 − 3 = **22**
— present, plus paid leave, minus what is not paid for.

**Why paid leave costs nothing.** It is a scheduled day the employee is paid
for. It never becomes a deduction line at all, so it cannot be charged twice by
being both "not present" and "on leave".

**If the overtime were not approved**, with `requireApprovedOvertime` on: gross
falls to exactly 130,000 and net to 118,000. Nothing else moves — the overtime
line simply is not priced, and the hours are still counted and reported as an
`UNAPPROVED_OVERTIME` exception.
