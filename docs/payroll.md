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

## Exceptions

The calculation records what it could not resolve rather than guessing:

| Code | Severity | Meaning |
|---|---|---|
| `MISSING_SALARY` | blocking | no salary on record, or a gap in the period |
| `OVERLAPPING_SALARY` | blocking | two records claim the same day |
| `NON_POSITIVE_NET` | blocking | net is zero or negative |
| `MISSING_PROFILE` | warning | company defaults were used |
| `MISSING_SHIFT` | warning | no shift assigned; eight hours assumed |
| `INVALID_ATTENDANCE` | warning | checked in but never out |
| `UNAPPROVED_OVERTIME` | warning | hours recorded but not paid |
| `INCOMPLETE_EMPLOYEE` | warning | employee number or hire date missing |

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
`employeeScopeFilter`. An employee with an OWN scope sees exactly one payslip,
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
