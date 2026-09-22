# Organisation hierarchy and multi-level approvals

How the company is shaped, who runs each team, and the chain a request climbs
before it is approved.

Everything here is verified against the source: `team_managers`,
`approval_workflows`, `approval_stage_assignees`, `approval_step_approvers`,
`hierarchy.service.ts`, `approval.service.ts` and `scope.ts`.

---

## 1. The shape

```
                    CEO
                     │
                HR Manager
                     │
        ┌────────────┼────────────┐
     Team Alpha                Team Beta         (teams)
     ┌────┴────┐               ┌──┴──┐
  Manager A  Manager B      Manager C            (1 to 3 per team)
     │                         │
  Employee 1..3            Employee 4..5         (one primary team each)
```

### Departments and teams are two separate dimensions

**A team is not a sub-department.** The company is divided two ways at once,
and a person sits in one of each:

```
COMPANY
├── Departments                └── Teams
│   ├── Development                ├── Team Alpha
│   ├── Designing                  ├── Team Beta
│   ├── HR                         └── Team Gamma
│   └── ...
```

| | Department | Team |
|---|---|---|
| Set on | the employee record's **Department** field | the employee record's **Team** field |
| Decides approvals | no (except the optional Department Head stage) | **yes** — the Team Manager stage |
| Has managers | a single optional head | 1 to 3 appointed managers |
| Contains the other | **no** | **no** |

So Muhammad Ahmed is in **Development** *and* on **Team Alpha**, and Team Alpha
may hold people from Development, Designing and QA at once. The two fields are
edited separately and neither narrows the other: choosing a department on the
employee form does not shorten the team list, and the People filters combine as
*Department = Development AND Team = Team Alpha*.

Teams used to be children of departments — the New Team form required one — and
the two departments named `T-A` and `Team Clan` exist only because somebody
needed a team the old form could not place. They are ordinary departments now
and can be renamed or retired like any other; see §8.

Two of those rows are **rosters you maintain**, and one is derived:

| Row | Where it lives | Who maintains it |
|---|---|---|
| CEO | Settings → Approval hierarchy | Super Admin |
| HR Manager | Settings → Approval hierarchy | Super Admin |
| Teams | Organisation → Teams | HR (`team.manage`) |
| Team managers | Organisation → Teams → Managers | HR (`team.manage`) |
| Employees on a team | the employee record's Team field | HR |

An employee has **one primary team** — the `teamId` on their record. That is
the first implementation and it is what the approval chain reads: the Team
Manager stage resolves to the managers of that one team. It resolves from the
**team** and never from the department: a person's department has no say in who
approves their leave.

---

## 2. Team managers

A team manager is **a stored appointment**, never an inference. Nothing in this
system decides that somebody runs a team because of their job title, their
designation, the department they head, the name of their role, or where their
name sorts. There is a row in `team_managers` saying so, and an administrator
put it there.

### The rules, all enforced by the server

| Rule | What happens if you try |
|---|---|
| At most **3** active managers per team | The fourth is refused: *"Development already has 3 managers, which is the maximum. Replace one of them instead."* |
| A manager must be an **ACTIVE** employee | Appointing somebody TERMINATED or RESIGNED is refused |
| An appointment **ends**, it is never deleted | Removing shows the person under *Previously*, with the date and reason |
| Replacing is **one action** | Ends one appointment and starts the successor's in a single transaction |

The **floor of one is advisory**. You can remove a team's last manager, on
purpose: a team whose only manager resigned this morning must be allowed to
exist for the hour it takes to name a successor, and refusing the removal would
leave the leaver approving that team's leave in the meantime. What the team
loses is the Team Manager stage — requests from it skip that rung, and the
request history says so on every one.

### Replacing a manager who has left

Organisation → Teams → the Managers button → the ⇄ icon beside their name.
Choose the successor, write the reason, Replace. This works on a team that is
already at three managers, which a remove-then-add would not.

### The gap to watch for

An appointment and a role are **two separate facts**:

- the appointment says *whose requests you decide*;
- the role says *what you can see*.

Somebody made a manager of Development decides Development's requests
immediately. They see nothing of Development until a role they hold carries
**See your team as a manager** (`team.data.read`). The roster warns about
exactly this, per person:

> They can decide this team's requests, but no role they hold lets them SEE the
> team. Give them the Team Manager role, or any role with "See your team as a
> manager".

---

## 3. What a team manager can see

The **Team Manager** system role, plus an active appointment, reaches the
people on the teams they manage across these screens:

- the employee directory, and one team member's record
- attendance, and the team attendance screen
- leave requests
- timesheets
- attendance corrections
- approvals raised by their people
- the equipment their people are holding, and the requests they have raised

and **nothing else**. Specifically NOT, whatever the appointment says:

| Not visible | Why not |
|---|---|
| Other teams | The filter is the teams with an active appointment, and no others |
| Payroll, salary, payslips | Those screens read the plain data scope, which this role holds at OWN |
| Loans | Same |
| Medical information and claims | Same, and medical additionally requires `medical.manage` |
| National ID, passport, visa, bank account | `employee.sensitive.read`, which this role does not hold |
| The helpdesk queue | Cases are deliberately not widened by any scope — see the admin manual |

### Why it is a permission and not a data scope

Data scopes union across a user's roles and **the widest wins**. A `TEAM` scope
added to the enum would have been handed to anybody holding a team-manager role
beside the ordinary Employee role, and every module that consults the scope
would have widened with it — including `payslip.read` and `loan.read`, which
every member of staff holds for their own pay. A manager would have opened
their team's payslips as a side effect of an enum value.

So the widening is a grant (`team.data.read`) read by **one function**,
`teamScopeFilter`, which the people-facing modules call and payroll, loans,
contracts and medical do not. The narrowing is structural rather than
conventional: those modules call `employeeScopeFilter`, which cannot widen.

---

## 4. The approval chain

### The default

```
Employee raises a request
        │
        ▼
  Team Manager      ← any ONE of the team's 1–3 managers
        │
        ▼
   HR Manager       ← whoever is named for that stage
        │
        ▼
      CEO           ← whoever is named for that stage
        │
        ▼
    APPROVED
```

Sequential. A rejection at **any** rung ends the request as REJECTED — a
rejection is a decision about the request, not a vote about the stage.

This chain is the default for **leave requests** and **equipment requests**.
Attendance corrections, shift changes, timesheets and loan applications keep
the reporting-line chain they have always had (your manager, and your second
manager if you have one, falling back to your department head). That is
deliberate: a forgotten check-out is corrected by the person who can say
whether you were at your desk, and sending eleven of those a week to the CEO
would empty the meaning out of the CEO's queue inside a month. A company that
wants otherwise configures it.

### Any one, or all

Each stage carries a mode:

| Mode | Meaning |
|---|---|
| **Any one approver** (default) | The first decision carries the stage. Manager A approves → the stage is complete, and B and C see a finished stage rather than a second button |
| **Every approver** | All of them must approve before the request moves on. One rejection still ends it |

Once an "any one" stage is decided, the other approvers' seats are **closed**,
so the request leaves their inbox and stops counting towards their pending
badge. The server refuses a second decision on a decided stage; the screen is a
signpost, not the gate.

### How a stage is filled

| Stage | Resolved from |
|---|---|
| Team Manager | the active managers of the requester's own team (`team_managers`) |
| HR Manager | the people named for that stage in Settings → Approval hierarchy |
| CEO | the people named for that stage |
| Reporting manager | the requester's `managerId` and `secondaryManagerId`, falling back to their department head |
| Department head | the head of the requester's department |

Four rules apply to every stage, at the moment the request is raised:

1. **The requester is never on their own chain.** A team manager raising leave
   does not get handed their own first rung.
2. **Nobody who has left is ever asked**, whatever the roster says. Status must
   be ACTIVE.
3. **Nobody appears twice in one chain.** If the person named as HR Manager
   also manages the requester's team, they fill the earlier rung and are struck
   from the later one — otherwise the request would stick at a stage its only
   approver is forbidden to decide.
4. **A stage that resolves to nobody is skipped**, and the skip is written into
   the request's history: *"CEO stage skipped: nobody is named as CEO."*

If no configured stage can be filled at all, the chain falls back to the
reporting line. If that is empty too the request is **refused at creation**,
before anything is written, naming the fix.

### What is recorded

Every decision writes an `approval_events` row that survives forever:

- who decided (the user), and which stage they were filling
- the transition, from status to status
- the comment or reason
- the timestamp

plus the seat itself — which of the three managers actually signed, and what
the other two's seats became. The audit log carries the same decision a second
time, under `approval.approve` / `approval.reject`, with `.override` appended
when an administrator stood in for an absent approver.

### Separation of duties

Nobody decides two stages of the same request, whatever they hold.
`approval.manage` is an administrative override for an approver who has left —
it is not a way for one person to carry a request through every rung of a chain
that exists so several people sign it.

---

## 5. Configuring it

**Settings → Approval hierarchy** (`approval.workflow.read` to see it,
`approval.workflow.manage` — Super Admin only by default — to change it).

Two halves:

- **Who fills each stage.** Name one or more people as HR Manager and as CEO.
  Several is fine: two HR managers, an acting CEO. The Team Manager stage is
  *not* here, because who manages a team lives on the Teams screen and a second
  answer would be a second source of truth.
- **The chains.** For each kind of request: the stages in order, and each
  stage's mode. Add a stage, remove one, change a mode, Save. *Reset to
  default* deletes the company's override and goes back to the built-in chain.

The page warns you about anything that would silently skip:

> No active employee is named as CEO, so that stage is being skipped on every
> request.
>
> 3 team(s) have no active manager. Requests from those teams skip the Team
> Manager stage.

### On upgrade

Nothing is configured on the morning of this release and everything keeps
working:

- every existing **team lead** was copied into the team-manager roster as an
  active appointment, so teams that had a lead already have a manager;
- every **approval step already in flight** was copied into the new approver
  table, so requests mid-chain keep their approver and their inbox;
- with no HR Manager or CEO named, leave requests resolve to the Team Manager
  stage alone, or fall back to the reporting line — the behaviour from before.

Name a CEO and an HR Manager to switch the full three-rung chain on.

---

## 6. Equipment requests

The second thing routed through the hierarchy, and the one that shows why
approving and doing are different acts.

```
Employee asks for a laptop, a monitor and a headset
        │
   Team Manager → HR Manager → CEO
        │
   APPROVED  ← the company has agreed
        │
   IT / Asset Manager picks a machine and hands it over
        │
   FULFILLED ← the person has it
```

- **My work → Equipment requests → Request equipment.** Pick what you need and
  how many, say why (compulsory: three people are going to read it), send.
- The request tells you who it is going to, by name, before you send it.
- **Approving happens under Approvals**, by the people the chain resolved. The
  equipment screen has no approve button anywhere on it.
- **Fulfilling happens on the request**, by whoever holds
  `asset.request.fulfil` *and* `asset.assign` — the IT Asset Manager role. They
  choose an available asset of the right category and issue it; the handover is
  an ordinary asset assignment, linked back to the request line, and the
  employee is asked to acknowledge it exactly as with any other handover.
- A line the company cannot supply is **declined with a reason** — *"No spare
  monitors until April"* — which is an answer. Leaving it open is not.
- The request becomes FULFILLED when every line is issued in full or declined.

**The IT person is not an approver.** The role holds no `approval.act`, the
fulfilment endpoint refuses anything that is not already APPROVED —
*"That request has not finished the approval chain yet. Issuing equipment is not
an approval."* — and there is no approve endpoint in the module to hold
wrongly.

---

## 7. Permissions introduced

| Permission | Holder by default | Reaches |
|---|---|---|
| `team.data.read` | Team Manager, Manager | The people on teams you actively manage, on the people-facing screens only |
| `approval.workflow.read` | HR Admin, Manager, Team Manager | Seeing the chain and who fills it |
| `approval.workflow.manage` | Super Admin | Changing the chain and naming HR/CEO |
| `asset.request.create` | everybody | Raising and withdrawing your own equipment request |
| `asset.request.read` | everybody | Your own requests; your team's if you manage one |
| `asset.request.read.all` | HR Admin, IT Asset Manager | Every request — the fulfilment queue |
| `asset.request.fulfil` | HR Admin, IT Asset Manager | Issuing against an approved request, declining a line |

And one system role: **Team Manager**. Everything an ordinary member of staff
holds, plus the employee directory, `team.data.read` and `approval.act`. Its
data scope is **OWN** and that is deliberate — see §3.

---

## 8. What is not here

- **No parallel branches.** A chain is a sequence of stages; a stage can have
  several approvers, but there is no "either HR or Finance, whichever answers".
- **No conditional routing.** A chain does not change because a request is for
  fourteen days rather than two, or for a laptop rather than a headset.
- **No delegation.** An approver who is on holiday does not hand their seat to
  somebody else; an administrator with `approval.manage` overrides the stage,
  and the override is recorded as one.
- **No escalation or reminder.** A request sitting on a stage for a fortnight
  is not chased. The approver's inbox and the pending badge are what show it.
- **No second team.** An employee has one primary team. The schema would take
  more, the resolver reads one.
- **No department on a team.** A team has a name, a description and a status,
  and that is all. `teams.departmentId` still exists in the database, nullable,
  holding whatever it held before the two were separated, so that release can
  be rolled back without losing it — but nothing reads it: not the API, not the
  forms, not the lookups. The departments `T-A` and `Team Clan` are left as
  they are rather than guessed at; whoever knows which department those two
  people really belong to should set it on their employee records and then
  retire the placeholder departments.
- **No approval on hiring, on assigning an asset outside a request, or on
  payroll.** Payroll has its own approval with its own permission.
