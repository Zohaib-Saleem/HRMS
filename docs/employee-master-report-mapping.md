# Employee Master Report — field mapping

Date: 2026-09-11. Read-only feature; no migration, no data change.

## 0. Who can open it

`GET /reports/employee-master`, `/export.csv` and `/export.xlsx` all require
**`employee_master_report.read` AND `employee.read`**, enforced on the API
module, so an unauthorised caller gets a 403 from every one of them - the
sidebar row and the route are hidden with the same grant, but the API is the
gate. By default only **Super Admin** and **HR Admin** hold the report grant;
Manager, Team Manager, Employee and IT Asset Manager do not. Inside a row, each
block (pay, leave, loans, attendance, punch codes, restricted fields) is still
gated by the module that owns it.

## 1. Master Sheet → HRMS → Report

The import script (`scripts/import-employee-master.mjs`) is the authority for the
left column. Where the roster and HRMS already agree on a field, the report reads the
HRMS field — no column was added because a spreadsheet had one.

| Master Sheet column | HRMS field / service | Report column |
|---|---|---|
| Employee ID | `employees.employeeNumber` | Employee Code |
| Name | `employees.firstName` + `lastName` / `displayName` | Employee, First Name, Last Name |
| Official Email | `employees.workEmail` | Email |
| Mobile Number | `employees.phone` | Phone |
| CNIC | `employees.nationalId` *(sensitive)* | CNIC |
| Date of Birth | `employees.dateOfBirth` | Date of Birth |
| Gender | `employees.gender` | Gender |
| Address | `employees.presentAddress` | Address |
| Joining Date | `employees.hireDate` | Joining Date |
| Probation End Date | `employees.confirmationDate` | Confirmation Date |
| Role | `employees.jobTitle` | Job Title |
| — (org structure) | `departments.name` via `departmentId` | Department |
| — | `teams.name` via `teamId` | Team |
| — | `designations.name` via `designationId` | Designation |
| — | `locations.name` via `locationId` | Location |
| — | `employees.managerId` → manager's name | Reports To |
| Employment Type | `employees.employmentType` | Employment Type |
| Next Increment Due Date | `employees.nextIncrementDueDate` | Next Increment Due |
| Previous Experience | `employees.priorExperienceMonths` | Prior Experience |
| Matric/Inter/Bachelors/Masters … | `employee_education` rows | Education |
| Yearly salary columns | `employee_salaries` (in force on the reference day) | Current Salary, Salary Effective, Revisions |
| — | `salary_revisions` (latest) | Last Revision, Last Revision Amount |
| Punch Code *(optional column)* | `attendance_device_user_mappings.deviceUserId` | **PunchCode** |
| — | `leave.service.balancesForEmployee`, folded by `foldPaidBalances` | Leave Entitlement / Used / Remaining / Pending / by Type |
| — | `leave_requests` counts | Leave Requests, Pending, Approved, Rejected/Cancelled |
| — | `loans.service.loanTotals` over `employee_loan_installments` | Loan Amount / Paid / Outstanding / Monthly / Installments Left / Next Due |
| — | `attendance.service.deriveRangeForEmployees` + `tallyDerived` | Present, Absent, Late, Half Days, Leave Days, Holidays, Weekend/Off, Hours Worked, Overtime, Attendance % |
| — | `employee_contracts` (ACTIVE) | Contract |

### EmployeeCode ≠ PunchCode

These are separate columns from separate tables and the report never derives one from
the other. **30 of 80 employees punch under a PIN that differs from their employee
number**, and the HR roster has been observed carrying a PIN in its Employee ID column
for two people — one of which is a live employee number belonging to somebody else.
`Employee Code` reads `employees.employeeNumber`; `PunchCode` reads
`attendance_device_user_mappings`, gated on `device.read`.

The import script reads a **`Punch Code`** column if the roster has one, and
reads it as nothing else: the Employee ID column is never taken for a PIN, nor
the PIN for an employee number. It is **fill-only** — a mapping is created only
where the employee has no active one and nobody else holds the code. A code that
disagrees with what HRMS holds, or that belongs to somebody else, is printed as
a conflict for a person to settle; no existing mapping is ever edited or closed,
and the only punches it touches are ones attributed to nobody at all. With no
device configured, or more than one, the column is reported as unresolved rather
than guessed at — a PIN belongs to a terminal.

## 2. Master Sheet columns with no HRMS equivalent

Present in the roster, not represented in the report, because HRMS has nowhere to put
them or the field is not reporting-grade:

| Master Sheet column | Why not |
|---|---|
| Reporting Manager (free text) | HRMS holds `managerId`, a real relation. The sheet's value is free text and sometimes multi-valued ("Amir / Kaleem / Abdul Rehman"), so it is not importable and not reportable. The report shows the HRMS relation instead. |
| Bank Name, Account Number | Columns exist (`bankName`, `bankAccountNumber`) but are deliberately **not** in the report. Payment details on a bulk-exportable screen is a different risk decision from payment details on one profile; add them only on an explicit request. |
| Father's Name | `employees.fatherName` exists; omitted from the default registry as it is not a reporting dimension. Available to add. |
| Comments / free-text notes | No structured HRMS field. |

Fields HRMS holds that the roster does not, and the report surfaces anyway: contract,
leave balances, loans, attendance, salary revisions.

## 3. Reused services — nothing recalculated

| Dimension | Service reused | Owner module |
|---|---|---|
| Attendance, overtime, attendance % | `deriveRangeForEmployees` + `tallyDerived` | `modules/time/attendance.service.ts` |
| Leave entitlement / used / remaining | `balancesForEmployee` + `foldPaidBalances` | `modules/leave/leave.service.ts` |
| Loan paid / outstanding | `loanTotals` | `modules/loans/loans.service.ts` |
| Salary in force | `employee_salaries`, same "started and not ended" test as the salary screens | `modules/payroll` |
| Scope | `employeeScopeFilter` | `auth/scope.ts` |

Verified figure-by-figure against `employeeProfileSummary` (the Employee 360 header)
for sampled employees: salary, leave used, leave available, loan outstanding, present
days, overtime hours, attendance % and PunchCodes all matched exactly.

## 4. Order of operations

1. Narrow in SQL on real columns (department, team, status, dates).
2. Enrich the survivors through the owning services.
3. Narrow again on computed figures — salary band, leave remaining, loan outstanding,
   attendance %, overtime. None of these is a column, so none can be a `WHERE` clause.
4. Total, sort, paginate.

Summary cards are computed from the same enriched, filtered set the table pages
through, so they cannot drift from it.

A row with no block for a filtered dimension **fails** that filter rather than passing
it: "outstanding over 50,000" must not include somebody whose loans the caller cannot
see, because the honest answer there is unknown, and unknown is not a match.

## 5. Paid types only

`Leave Entitlement`, `Leave Used`, `Leave Pending` and `Leave Remaining` fold **paid
leave types only**. An unpaid type carries an entitlement so a request against it can
be bounded and approved, but it is not leave anybody has: folding Unpaid Leave's 30
days in reported 45 days remaining against a 15-day policy, and the person reading that
number is asking what they can take without losing pay.

The fold is `foldPaidBalances` in `modules/leave/leave.service.ts`, shared by this
report and the Employee 360 header card so the two cannot disagree. `Leave by Type`
still lists every type, paid or not — the breakdown is where an unpaid balance stays
legible without being added to a total.

### Three ways to read what somebody has taken

The 2026 workbook import recorded prior leave as a **balance adjustment**
(`leave_balances.adjustmentDays`), because the sheet carries no dates, types or
statuses and so cannot produce `leave_requests` rows. That leaves three distinct
questions, and the report answers each with its own column rather than conflating them:

| Column | Field | Means |
|---|---|---|
| Leave Used | `usedDays` | Approved leave **requests**. Reads 0 for the 74 imported employees, honestly - nothing was booked through HRMS. |
| Adjusted Days | `adjustedDays` | Days an administrator **debited** from the balance, i.e. the imported history. Only the negative side of an adjustment counts: a credit is a grant, not consumption. |
| **Days Consumed** | `consumedDays` | `usedDays + adjustedDays` - everything spent, however it was recorded. This is the default column. |

The identity `entitlement - consumed = remaining` holds for every row, which is what
makes the three legible side by side.
