# HRMS documentation

Everything here describes what the system **actually does today**, verified
against the source: the Prisma schema, the API routes, the permission
catalogue, the React pages and the audit suites. Where the interface and the
backend disagree, the disagreement is written down rather than smoothed over.

Nothing in these documents describes a feature that is not implemented. Where
something is missing, it says so.

## Start here

| Document | Read it if you are |
|---|---|
| [Quick start](HRMS-QUICK-START.md) | setting the system up for the first time |
| [User manual](HRMS-USER-MANUAL.md) | looking for the overview and how modules fit together |
| [Feature matrix](HRMS-FEATURE-MATRIX.md) | asking "is X implemented?" |

## By role

| Document | Audience |
|---|---|
| [Employee guide](HRMS-EMPLOYEE-GUIDE.md) | every member of staff |
| [Manager guide](HRMS-MANAGER-GUIDE.md) | managers and heads of department |
| [Admin manual](HRMS-ADMIN-MANUAL.md) | HR administrators and system administrators |
| [Payroll guide](HRMS-PAYROLL-GUIDE.md) | whoever runs payroll |

## By subject

| Document | Covers |
|---|---|
| [Attendance guide](HRMS-ATTENDANCE-GUIDE.md) | the full attendance lifecycle and every calculation rule |
| [Device guide](HRMS-DEVICE-GUIDE.md) | ZKTeco K50 integration, pull and ADMS push |
| [Troubleshooting](HRMS-TROUBLESHOOTING.md) | when something is wrong |

## Technical references

These predate this manual and are written for developers rather than operators.

| Document | Covers |
|---|---|
| [Attendance devices](attendance-devices.md) | the device protocols, in implementation terms |
| [Payroll](payroll.md) | the payroll engine, in implementation terms |
| [Architecture](architecture.md) | how the codebase is laid out |
| [Roadmap](roadmap.md) | what was built in each phase, and what was deliberately not |
| [Feature map](feature-map.md) | the original scoping decisions |

## Three things to know before you read anything else

**The physical ZKTeco K50 has never been connected.** Both the pull and the
push integrations are implemented and tested against a simulator that speaks
the real protocol over a real socket. That is evidence the implementation is
internally consistent, not evidence it matches your hardware. See the
[device guide](HRMS-DEVICE-GUIDE.md).

**There is no way to create a login through the application.** The permissions
`user.read` and `user.manage` exist and can be granted, but no user-management
API or screen was ever built. Accounts exist only because the seed script
created them. This is the single biggest gap for a real deployment — see
[Known limitations](HRMS-ADMIN-MANUAL.md#12-known-limitations).

**Performance and Documents do not exist.** They appear in the sidebar as
greyed-out "planned" entries. There is no database table, no API and no screen
behind either.
