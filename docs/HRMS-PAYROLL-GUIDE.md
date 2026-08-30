# Payroll guide

Every rule below is taken from the implementation. Where something is not
implemented, it says so in those words.

> **Tax is NOT IMPLEMENTED.** No income tax, no EOBI, no PESSI, no SESSI, no
> statutory deduction of any kind. Salary components carry an `isTaxable` flag
> and payroll settings carry a `taxEnabled` switch, but **nothing computes
> tax**. No rate is stored anywhere, deliberately: a rate that is wrong for a
> jurisdiction is worse than no rate at all.

---

## 1. Where payroll gets its numbers

```
Employee
   ↓
Salary (effective-dated)  +  Payroll profile (overrides)  +  Payroll settings
   ↓
Attendance engine ─────► day counts, worked minutes, late, early, overtime
   ↓                     (payroll never reads a punch or re-scores a day)
Timesheets (APPROVED) ─► which overtime is payable
   ↓
Salary components ─────► allowances and recurring deductions
   ↓
Adjustments ───────────► corrections carried from a finalized run
   ↓
CALCULATION
   ↓
Payroll line  +  Exceptions
   ↓
Review → Approve → Finalize
   ↓
Payslips  +  Reports
```

The join to attendance is the same function the attendance screens are built
from. Every day count on a payslip can be traced to a day an administrator can
open and look at.

---

## 2. Payroll settings

**Payroll → Settings** (`payroll.manage`). Every one of these can be overridden
per employee on their payroll profile, where `null` means "inherit".

### Pay cycle and basis

| Setting | Default | Effect |
|---|---|---|
| Payroll frequency | Monthly | **Reporting only.** The calculation reads each period's own dates. Monthly, every two weeks, weekly |
| Payroll basis | A fixed number of days | What a monthly salary is divided by to reach a daily rate |
| Days per month | 30 | Only when the basis is "fixed" |
| Standard hours per day | 8 | Turns a daily rate into an hourly one |

The three bases:

| Basis | Divisor |
|---|---|
| `CALENDAR_DAYS` | days in the pay period |
| `FIXED_DAYS` | the configured figure — usually 30 or 26 |
| `WORKING_DAYS` | the period less weekends and holidays |

> This is the single most consequential number in payroll. A company paying by
> calendar days and one paying by a fixed thirty produce **different figures**
> from the same salary and the same attendance, and both are correct for their
> own contracts. It is configuration, never a constant.

### Overtime

| Setting | Default | Effect |
|---|---|---|
| How overtime is paid | Multiplier | `NONE`, `MULTIPLIER`, or `FIXED_RATE` |
| Multiplier | 1.5 | Time and a half |
| Rate per hour | 0 | Only when the mode is a flat rate |
| Only pay approved overtime | on | Requires an APPROVED timesheet covering the date |

### Attendance deductions

| Setting | Default | Effect |
|---|---|---|
| Deduct for unpaid absence | on | |
| Deduct for unpaid leave | on | Leave on a type where `isPaid` is false |
| Late arrival | No deduction | `NONE`, `PER_MINUTE`, `PER_OCCURRENCE` |
| Late rate / grace | 0 / 0 | Grace is **on top of** the attendance policy's grace |
| Early leaving | No deduction | Same three modes |

### Rounding, payslips, tax

| Setting | Default | Effect |
|---|---|---|
| Decimal places | 2 | |
| Payslip prefix | `PS-` | Numbers run sequentially after it |
| Tax module enabled | off | **Stores a flag. Computes nothing.** |

---

## 3. Salary — effective-dated, always

**Payroll → Profiles and salaries → open an employee → New salary.**

| Field | Notes |
|---|---|
| Salary type | Monthly, Daily, or Hourly |
| Amount | The monthly, daily or hourly figure according to the type |
| Effective from | Required |
| Effective to | Blank means "still in force" |
| Note | Free text — "annual review", "promotion" |

**Two records may never cover the same day.** An overlap is refused at write
time, because two salaries claiming one day are two contradictory answers to
"what is this person paid" and payroll will not pick one.

To give a raise: open a new record from its date. Close the previous one first
if it is open-ended.

```
Jan–Jun   100,000
Jul on    120,000     →  July pays 120,000. June is untouched.
```

A change **mid-period** splits the period into segments and prorates by
coverage:

```
raise on the 16th of a 30-day month
= 100,000 × 15/30 + 120,000 × 15/30
= 110,000
```

> **A salary a finalized payroll has already used cannot be edited.** The
> attempt returns 409 and tells you to add a new effective-dated record instead.
> Editing it would make the payslip and the record disagree, and the payslip is
> the one somebody was actually paid.

### Changing salary type mid-period is refused

Monthly, daily and hourly pay are read in different units, and one reading is
applied to the whole period. A period that changes from one to another has no
single right answer, so it raises a **blocking** exception naming both types
and telling you to split the period.

---

## 4. Salary types — what "basic pay" means

| Type | Basic pay | Absence |
|---|---|---|
| `MONTHLY` | the salary, prorated only for partial coverage | **deducted** at the daily rate |
| `DAILY` | rate × days actually paid for | never deducted |
| `HOURLY` | rate × (worked hours + paid-leave hours) | never deducted |

Daily and hourly staff get **no** absence deduction. They were never credited
for the day, so deducting would charge them twice for one absence. This is not
an oversight; it is the rule.

---

## 5. The calculation, in order

The order is deliberate: basic first, because percentage components read
against it; then overtime; then components; then the deductions that price time
already accounted for; then adjustments last, because a correction should be
able to answer for everything above it.

### 5.1 Day counting

Weekends and holidays are **not** scheduled days — nobody was expected, so
nobody is short. Everything else in the period is a scheduled day.

```
presentDays      full days present, plus 0.5 per half day
paidLeaveDays    leave on a paid type   (0.5 for a half-day leave)
unpaidLeaveDays  leave on an unpaid type
absentDays       scheduled days with nothing recorded, or too few minutes
```

A leave type with **no** paid flag is treated as unpaid rather than guessed at:
paying for leave nobody configured as paid is the more expensive mistake.

### 5.2 Rates

```
MONTHLY   dailyRate  = salary / basisDays
DAILY     dailyRate  = salary
HOURLY    dailyRate  = salary × standardHoursPerDay

hourlyRate = the profile override, if set
           = the salary, for HOURLY staff
           = dailyRate / standardHoursPerDay otherwise
```

### 5.3 Payable and unpaid days

```
unpaidAbsenceDays = deductUnpaidAbsence ? absentDays + halfDays × 0.5 : 0
unpaidLeaveCharged = deductUnpaidLeave ? unpaidLeaveDays : 0
unpaidDays  = unpaidAbsenceDays + unpaidLeaveCharged
payableDays = scheduledDays − unpaidDays
```

A half day worked is half a day *not* worked, so it follows the same switch as
an absence.

### 5.4 Basic pay

```
MONTHLY   Σ over salary segments of  amount × (segment days / period days)
DAILY     Σ  amount × (presentDays + paidLeaveDays)  per segment
HOURLY    Σ  amount × (workedMinutes + paidLeaveMinutes) / 60  per segment
```

Paid leave for hourly staff is paid at the rostered hours — there are no worked
minutes on a day nobody worked.

Note the monthly formula prorates by **coverage**, not by basis. Dividing and
re-multiplying by 30 would introduce an error the contract never had.

### 5.5 Overtime

```
minutes = requireApprovedOvertime ? approvedOvertimeMinutes : overtimeMinutes

NONE         0
MULTIPLIER   hourlyRate × multiplier × (minutes / 60)
FIXED_RATE   fixedRate × (minutes / 60)
```

Worked example from the specification:

```
hourly rate 500, multiplier 1.5, 4 approved hours  →  3,000
```

### 5.6 Components

Fixed and percent-of-basic are computed first; percent-of-gross then reads
against the total above it. Without a fixed order, two percentage components
could each be computed on a total that included the other and the result would
depend on iteration order.

```
FIXED              value
PERCENT_OF_BASIC   basic × value / 100
PERCENT_OF_GROSS   (everything above it) × value / 100
```

### 5.7 Deductions

```
ABSENCE        dailyRate × unpaidAbsenceDays      (MONTHLY only)
UNPAID_LEAVE   dailyRate × unpaidLeaveCharged     (MONTHLY only)
LATE           rate × (chargeable minutes | occurrences)
EARLY_LEAVE    rate × (chargeable minutes | occurrences)
COMPONENT      as configured
ADJUSTMENT     as raised
```

The specification's formula, exactly as implemented:

```
daily_rate        = monthly_salary / configured_basis
absence_deduction = daily_rate × unpaid_days
```

### 5.8 Totals and rounding

```
gross = sum of every earning line
net   = gross − sum of every deduction line
```

**Each line is rounded once, where it is shown, and the totals are the sum of
the rounded lines.** A payslip therefore adds up exactly as printed. Rounding is
half-away-from-zero, with the scaled value normalised first — `2.675 × 100` is
`267.49999999999997` in binary floating point, and naive rounding would lose a
cent from somebody's pay every time the fraction landed badly.

Intermediate rates (`dailyRate`, `hourlyRate`) are used **unrounded** inside the
calculation and rounded only for display.

---

## 6. Worked example

Real figures from a verified run. Monthly salary 66,000; basis fixed 30;
standard hours 8; multiplier 1.5; October, 23 scheduled days, 1 absence, 3
approved overtime hours; transport allowance 5,000 fixed; housing 10% of basic.

```
daily rate     66,000 ÷ 30              = 2,200.00
hourly rate    2,200 ÷ 8                =   275.00

EARNINGS
Basic salary                              66,000.00
Overtime         3h × 275 × 1.5         =  1,237.50
Transport allowance                        5,000.00
Housing (10% of basic)                     6,600.00
                                        ------------
Gross                                     78,837.50

DEDUCTIONS
Unpaid absence   1 × 2,200               =  2,200.00
Loan repayment                              4,000.00
                                        ------------
Total deductions                            6,200.00

NET                                        72,637.50
```

---

## 7. The run workflow

```
DRAFT ──► CALCULATING ──► REVIEW ──► APPROVED ──► FINALIZED
   └──────────────────────────┴───────────┴──────► CANCELLED
```

`APPROVED → REVIEW` sends it back for another look. `FINALIZED` and `CANCELLED`
are terminal.

| Step | Screen | Permission |
|---|---|---|
| Create a pay period | Payroll → Pay runs → New period | `payroll.manage` |
| Create a run | Payroll → Pay runs → New pay run | `payroll.manage` |
| Calculate | Calculate | `payroll.manage` |
| Review | Payroll → Pay runs → open the run | `payroll.read` |
| Approve | Approve | **`payroll.approve`** |
| Finalize | Finalize | **`payroll.approve`** |
| Cancel | Cancel | `payroll.manage` |

`payroll.approve` is separate so a company can insist that whoever prepares
payroll is not the person who signs it off. HR Admin holds both by default,
because a company with one administrator should not be locked out of its own
payroll. Revoking `payroll.approve` from HR Admin splits the duty.

Rules the server enforces regardless of what the interface shows:

- A period that already has a **finalized** run cannot be run again.
- A period cannot have two runs in progress.
- A run being calculated refuses a second calculation. A calculation that died
  more than 10 minutes ago is treated as dead, not running.
- An **approved** run cannot be recalculated — send it back to review first.
- A run with a **blocking** exception cannot be approved or finalized.

---

## 8. Payroll exceptions

Recorded rather than guessed at. A payroll that quietly pays zero because a
salary was missing is worse than one that refuses and says so.

| Code | Severity | Meaning |
|---|---|---|
| `MISSING_SALARY` | **blocking** | No salary on record, or a gap in the period |
| `OVERLAPPING_SALARY` | **blocking** | Two records claim the same day, or the salary type changes mid-period |
| `NON_POSITIVE_NET` | **blocking** | Net is zero or negative |
| `MISSING_PROFILE` | warning | Company defaults were used |
| `MISSING_SHIFT` | warning | No shift assigned; 8 hours assumed |
| `INVALID_ATTENDANCE` | warning | Checked in but never out, **or no attendance at all for the whole period** |
| `UNAPPROVED_OVERTIME` | warning | Hours recorded but not paid |
| `INCOMPLETE_EMPLOYEE` | warning | Employee number or hire date missing |

Blocking exceptions produce **no payroll line** for that employee — there is
nothing to pay them until it is resolved. Warnings produce a line and a note.

Exceptions appear above the employee table on the run screen, never behind a
tab: a run with an unresolved blocking exception is not ready to be read as
payroll.

---

## 9. Finalization and locking

Finalizing issues payslips and closes the period. After that:

- Recalculating returns **409**
- Approving again returns **409**
- Cancelling returns **409**
- Editing a salary the run used returns **409**
- Creating another run for the period returns **409**
- Changing attendance, leave, or company policy **does not move any figure**

Every number the calculation used — the salary amount, the basis, the
multiplier, the day counts — is **copied onto the payroll line** rather than
referenced. That redundancy is the whole mechanism: a later raise or an
attendance correction has nothing to reach back into.

### Corrections after finalization

**Payroll → Adjustments.** An adjustment names an employee, a kind (payment or
recovery), an amount and a reason, and optionally points at the finalized line
it corrects.

- It never edits the original line.
- It is picked up by the **next** run for that employee and appears there as an
  itemised earning or deduction.
- Recalculating that run does not apply it twice.
- Once paid, it cannot be deleted — raise a further adjustment.

---

## 10. Payslips

Issued on finalization, numbered sequentially with the configured prefix
(`PS-000001`). One per payroll line.

**Contents:** company, employee, employee ID, department, pay period, period
dates, payment date; working days, present, paid leave, unpaid leave, absence,
overtime hours; itemised earnings; itemised deductions; gross, total deductions
and net.

**Access:** `payslip.read`, narrowed by data scope. Every employee holds it with
an OWN scope and sees exactly their own. Requesting another employee's by
changing the id returns **403** with no figures in the response.

**Printing:** the browser's own print dialogue, which also produces a PDF on
every platform. Server-side PDF generation is NOT IMPLEMENTED, deliberately —
the browser produces a better one and it avoids a second rendering path that
could drift from the screen.

**Publishing:** `POST /payslips/publish` with a run id (`payroll.approve`)
releases a finalized run's payslips. This lets a finalized run be checked before
anyone sees their own figure.

---

## 11. Reports

**Payroll → Reports.** All eight share filters for pay period, department,
location, and an "include draft runs" switch. By default only **approved and
finalized** runs are included — a draft calculation is working material and
reporting on it as payroll would be misleading.

| Report | Purpose | Key columns |
|---|---|---|
| Payroll summary | One row per run | period, status, employees, basic, allowances, overtime, gross, deductions, net |
| Department payroll | The same grouped by department | department, employees, gross, allowances, overtime, deductions, net |
| Employee payroll | Every line, split out | employee, ID, department, designation, period, salary type, basic, allowances, overtime, gross, deductions, net |
| Overtime cost | Recorded against approved | employee, department, recorded hours, approved hours, hourly rate, cost |
| Allowance report | Every allowance and bonus | employee, component, basis, rate, amount |
| Deduction report | Every deduction | employee, deduction, type, units, amount |
| **Attendance vs payroll** | Why a salary changed | scheduled, present, paid leave, unpaid leave, absent, payable days, unpaid days, daily rate, absence deduction, net |
| Payslip report | Payslips issued | employee, ID, department, period, gross, deductions, net, run status |

**Export:** every report exports to CSV, generated by the server so the export
and the screen cannot disagree. A UTF-8 BOM is included so Excel opens names
correctly. Exports are audited.

**Access:** `payroll.read`, and every report is narrowed by data scope **before**
anything is totalled — so an aggregate cannot be used to infer a salary the
caller could not read directly.

---

## 12. Payroll dashboard

**Payroll → Overview.** Filters: pay period, department, location.

| Card | Where the number comes from |
|---|---|
| Current pay period | The chosen period, or the latest run's period |
| Payroll status | That run's status |
| Total employees | Non-terminated employees in scope, after filters |
| Employees processed | Payroll lines in that run, after the same filters |
| Gross payroll | Sum of line gross |
| Total deductions | Sum of line deductions |
| Net payroll | Sum of line net |
| Overtime cost | Sum of line overtime, with approved hours as a hint |
| Pending approvals | Runs company-wide in REVIEW or APPROVED |
| Payroll exceptions | That run's exception count, with blocking called out |

Figures come from **one run** — the latest for the chosen period. Summing
several runs for one month would double-count a recalculated one.

---

## 13. What is not implemented

| | Status |
|---|---|
| Income tax, EOBI, PESSI, SESSI, any statutory deduction | **NOT IMPLEMENTED** |
| Tax slabs, exemptions, year-to-date tax | **NOT IMPLEMENTED** |
| Loan balances, schedules, amortisation | **NOT IMPLEMENTED** — a loan can be modelled as a recurring deduction component, but the system tracks no outstanding balance and will not stop when it is repaid |
| Advances against salary | **NOT IMPLEMENTED** — same workaround, same caveat |
| Bank transfer file export | **NOT IMPLEMENTED** |
| Server-side payslip PDF | **NOT IMPLEMENTED** — browser print is used |
| Emailing payslips | **NOT IMPLEMENTED** |
| Multi-currency within one run | **NOT IMPLEMENTED** — a run carries one currency |
| Retrospective bulk recalculation | **NOT IMPLEMENTED** — a finalized run is immutable by design |
