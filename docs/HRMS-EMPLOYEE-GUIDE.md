# Employee guide

Everything you can do yourself. If something here is missing from your sidebar,
your administrator has not granted that permission.

---

## Signing in

Your administrator gives you an email address and a password. Sessions last
**8 hours**, after which you sign in again.

Forgot your password? **Forgot password** on the sign-in screen emails you a
link valid for **60 minutes**.

Change your password under **Profile → Password**. You can also see your active
sessions and sign out everywhere — useful if you have signed in on a device you
no longer have.

---

## Your profile

**Profile.** Your own record: contact details, job information, department,
manager and location.

You can edit your own contact details. Job information — department,
designation, manager, salary — is set by HR and is read-only to you.

Some fields you may not see at all. National ID, passport, visa and bank
account details are restricted and are not returned to accounts without the
specific permission.

---

## Attendance

### Checking in and out

**Attendance → Check in**, and **Check out** when you leave.

- One check-in and one check-out per day.
- Checking in twice is refused.
- Checking out before checking in is refused.
- You cannot check in on a weekend, a public holiday, or a day you are on
  approved leave — there is nothing to check in to.

Your company may restrict check-in **by network** or **by location**. If either
is on and you are outside it, check-in is refused. If your work location has no
coordinates recorded, a location-restricted check-in is also refused — ask HR
to set it.

If your company uses a biometric terminal, you may not need to check in at all:
your punches arrive from the device.

### What the statuses mean

| Status | Meaning |
|---|---|
| Present | You worked at least the full-day threshold, or you checked in and have not yet checked out |
| Half day | You worked at least the half-day threshold but less than a full day |
| Absent | Nothing recorded, or you worked less than the half-day threshold |
| On leave | Approved leave covers the day |
| Weekend | A non-working day for your company |
| Holiday | A public holiday for your location |

**Late** counts from your shift start, after a grace period. Note that grace is
a threshold, not a discount: with 10 minutes of grace, arriving 11 minutes late
records 11 minutes, not 1.

**Overtime** is worked time beyond a threshold, capped daily. It is a labelled
part of your worked time, not extra hours added on.

If you forget to check out, the day stays **Present** but your worked minutes
are blank — the system will not guess how long you worked. Raise a correction.

### Correcting your attendance

**Attendance → Request a correction.** Give the date, the times that should
have been recorded, and a reason. It goes to your manager. Once approved, the
day is updated and no device sync will overwrite it again.

---

## Leave

### Your balance

**My leave.** Per leave type:

```
available = opening + accrued + adjustment − used − pending
```

- **Opening** — carried forward from last year
- **Accrued** — earned so far this year, capped at the annual entitlement
- **Adjustment** — a manual correction by HR, up or down
- **Used** — approved leave
- **Pending** — requested but not yet decided; held against your balance

### Requesting leave

**My leave → Request leave.** Choose the type, the dates and a reason. For a
single day you can request a **first half** or **second half** instead of a
full day.

The days deducted exclude weekends and holidays, and that figure is frozen when
the request is decided — a later change to the holiday calendar will not move
it.

Your request goes to your reporting manager. If you have no manager, it goes to
your department head. **If you have neither, the request is refused** — ask HR
to set your manager.

### Cancelling

You can cancel your own request while it is still pending.

### After approval

Approved leave overrides your attendance for those days — they show as **On
leave** and you cannot check in. Whether they are paid depends on the leave
type; unpaid leave is deducted by payroll.

---

## Timesheets

**Timesheets.** A record of hours for a period, separate from attendance.

1. **New timesheet** for a period.
2. **From attendance** fills it from your recorded attendance. Lines you typed
   yourself are kept. Days with no check-out are skipped.
3. Add or edit lines by hand as needed.
4. **Submit** — it goes to your manager and can no longer be edited.

Statuses: Draft → Submitted → Approved or Rejected.

A timesheet does not add hours to your pay. Its effect on payroll is that an
**approved** timesheet covering a date makes that day's overtime payable —
without one, overtime is recorded but generally not paid.

---

## Shifts

**Shifts** shows the shift you are assigned and when it took effect.

To change it, **Request a change**: choose the shift, the date it should start,
and a reason. Your manager approves, and the assignment is created
automatically.

---

## Payslips

**Payslips.** One per finalized payroll run. You see **only your own** — the
system enforces this on the server, not by hiding buttons.

Open one to see:

- Your details and the pay period
- Attendance: working days, present, paid leave, unpaid leave, absence,
  overtime hours
- Earnings, itemised: basic salary, allowances, bonuses, overtime
- Deductions, itemised: absence, unpaid leave, loan repayments, anything else
- Gross, total deductions and net

**Print or save as PDF** uses your browser's print dialogue, which produces a
PDF on every platform.

Every amount is rounded once where it is shown, so the columns add up exactly
as printed.

If a figure looks wrong, do not guess — ask HR to open the **attendance versus
payroll** view for you, which shows the attendance beside what it cost.

---

## Approvals and notifications

**Approvals** shows requests you raised and their status. The bell in the header
shows notifications when a request of yours is approved, rejected or cancelled.

If you manage people, it also shows requests waiting on you — see the
[manager guide](HRMS-MANAGER-GUIDE.md).

---

## What you cannot do

- See another employee's record, attendance, leave or payslip
- See salary information, including your own salary structure — you see the
  payslip, not the configuration behind it
- Create a login for anyone
- Change your own department, manager, shift or salary
- Edit a raw device punch
- Approve anything, unless you manage people

---

## Not available

**Performance** and **Documents** appear in the sidebar but are greyed out.
Neither is built — there is no goal, review, rating, or document upload feature
in this system.
