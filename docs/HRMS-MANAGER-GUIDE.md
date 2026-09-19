# Manager guide

For managers and heads of department. You can do everything in the
[employee guide](HRMS-EMPLOYEE-GUIDE.md) for yourself, plus what follows for
your team.

---

## What "your team" means

Your default data scope is **reports and own** — you and the people whose
`managerId` or `secondaryManagerId` points at you. Every screen narrows itself
to that set automatically.

If someone is missing from your team views, they are not assigned to you. Ask
HR to set their reporting manager.

A **head of department** picks up requests from anyone in the department who has
no manager set. That is a fallback in the approval chain, not a wider data
scope: it does not by itself let you see the whole department. If you need
that, ask an administrator for a `DEPARTMENT` scope.

---

## Daily manager workflow

### 1. Sign in and check the bell

The header notification bell shows anything waiting on you.

### 2. Team attendance

**Attendance → Team attendance.** Default view is today.

Scan for:

- **Absent** — nobody recorded on a working day
- **Late** — arrivals past the grace period
- **Incomplete** — checked in, never checked out. Worked minutes are blank
  because the system will not guess. These need a correction

Filter by date range, department, team, or search for a person. Click through to
one employee's calendar, history and the attendance policy in force for them.

### 3. Approvals

**Approvals.** Everything waiting on your decision, filterable by type:

| Type | What approving does |
|---|---|
| Leave | The leave is approved and starts overriding attendance for those days |
| Timesheet | The timesheet is approved, and its overtime becomes payable in payroll |
| Attendance correction | The attendance record is rewritten and protected from future device syncs |
| Shift change | The new shift assignment is created |

Open a request to see the detail, the requester and the history, then approve or
reject. A rejection should carry a reason — it is shown to the requester.

Once a request reaches a terminal state it cannot be changed. Re-approving
returns an error.

**Separation of duties:** in a two-step chain, whoever decided step 1 cannot
also decide step 2. And you can never approve your own request.

### 4. Leave

**Leave requests** shows your team's requests. Before approving, check:

- The dates do not clash with someone else already off
- The balance covers it — the request shows the days deducted, already
  excluding weekends and holidays

### 5. Timesheets

**Timesheets** shows your team's. Check the hours are plausible against
attendance before approving, because **approving a timesheet is what makes that
period's overtime payable**.

---

## Weekly

- Review the week's team attendance for a pattern of lateness or absence.
- Clear any correction requests still sitting.
- Check the shift assignments are right for the coming week.

## Monthly

- Before payroll runs, make sure every timesheet with overtime on it is
  approved. Unapproved overtime is recorded and reported but **not paid**.
- Clear the approval queue. A pending leave request holds days against the
  employee's balance.

---

## Your team's assets

Open somebody's profile and the **Assets** tab shows the equipment they are
holding, with the date each item was issued.

You see this for the people your data scope reaches, and nothing more. You do
**not** see the asset register — the company's stock, what anything cost, or the
laptops sitting in a cupboard. Those are not your team's; they are the company's,
and HR runs them.

You cannot assign, return, transfer or repair anything. What you *can* do, for
your own equipment, is acknowledge a handover and report a problem with it, the
same as anyone else — see the [employee guide](HRMS-EMPLOYEE-GUIDE.md#your-assets).

Useful when somebody leaves: their outstanding items are what HR will be chasing
on the clearance list, and the conversation is easier before the last day than
after it. The full picture is in the [asset guide](HRMS-ASSET-GUIDE.md).

---

## Hiring and interviews

What you see here is narrowed by **who you are named on**, not by your reporting
line — a deliberate difference from the rest of the system. Your data scope says
whose employee records you may read; it is not a reason to read the CVs of
people who do not work here.

### Your vacancies

**Recruitment** and **Job openings** show the openings you are named on, as
hiring manager or as recruiter. Not the company's — yours. The dashboard is
scoped the same way, so "open positions: 2" means your own two.

You can read them and their pipelines. Creating, editing, closing and cancelling
an opening is HR's.

### Your interviews

**Interviews** shows the ones you are **on**, as a list and a calendar. An
interview you were not invited to is not hidden from you — it is not returned at
all, and a guessed link answers "not found".

**Confirm your seat** when you are booked. It reaches exactly your own seat;
there is no way to confirm on a colleague's behalf.

You cannot schedule, move or cancel an interview. Ask whoever is coordinating —
they get a clash warning naming you if they try to double-book you.

### Your evaluation

After an interview is marked **Completed** (or **No show**), file your
evaluation: a recommendation — strong yes, yes, maybe, no — and up to five
scores out of ten.

Two things worth knowing:

- **Leave a score blank if you did not assess it.** A blank says "not assessed";
  a zero says "assessed, and terrible". They are not the same thing about a
  person.
- **Yours is yours.** Nothing averages the panel's scores, ranks candidates by
  them, or moves anybody's stage because of one. Three interviewers produce
  three opinions and a person reads them. You cannot see or overwrite anybody
  else's before filing your own.

### What you will not see

You do not hold `candidate.read`. You reach a candidate's **name** through the
interview, which carries it, and you do not reach the candidate list, their CV
shelf, their salary expectation or HR's notes at all.

The full picture is in the [recruitment guide](HRMS-RECRUITMENT-GUIDE.md).

---

## What you cannot do

- **See any payroll information.** No payroll permission is granted to managers
  by default, so the Payroll section does not appear in your sidebar at all,
  and the API refuses payroll requests with 403. Seeing a report's attendance is
  not the same as seeing their salary.
- **See restricted fields.** National ID, passport, visa and bank account are
  stripped from every response for you.
- **Edit an employee record.** Department, manager, designation and salary are
  HR's to change.
- **Correct attendance directly.** There is no "correct this row" action on the
  team attendance screen. You approve a correction the employee raised, or you
  ask HR to write one.
- **Create a login** for a new team member.
- **Assign a shift directly.** You approve a shift-change request; HR assigns.
- **Issue or take back a company asset.** You can see what your team is holding; HR records every handover.
- **Open, close or edit a job opening**, or schedule an interview. You read the vacancies you are named on and sit on the panels you are booked for.
- **Open a candidate's record.** You see the name of the person you are interviewing, and nothing else about them.

---

## When something is wrong

| Symptom | What to do |
|---|---|
| Someone missing from your team views | They are not assigned to you — ask HR |
| A request cannot be raised: "no approver could be determined" | The employee has no manager and their department has no head — ask HR |
| An employee shows absent but was at work | Check whether the terminal synced. Ask them to raise a correction |
| Overtime recorded but not paid | Their timesheet for that period is not approved. Approve it, then ask payroll to recalculate |
| Attendance shows nothing after a device outage | Punches import once the device reconnects; the sync looks back far enough to catch up |

More in [troubleshooting](HRMS-TROUBLESHOOTING.md).
