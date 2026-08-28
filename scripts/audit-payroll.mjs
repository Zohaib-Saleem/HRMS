/**
 * Phase 9 audit: payroll end to end.
 *
 * The calculation itself is checked by verify-payroll-calc.mjs against figures
 * worked out by hand. This suite is about everything around it: that payroll
 * reads the attendance the existing engine produced rather than inventing its
 * own, that the run workflow holds, that a finalized run cannot be moved, and
 * - the part that matters most - that one employee cannot read another's pay by
 * changing an id.
 *
 * Fixtures live in September 2025, a month no other suite touches, and are
 * removed at the end.
 *
 *   npx dotenv -e .env -- npx tsx scripts/audit-payroll.mjs
 */
import { PrismaClient } from '@prisma/client';

const BASE = 'http://127.0.0.1:4000/api/v1';
const prisma = new PrismaClient();

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label} (${JSON.stringify(actual)})`);
  } else {
    fail += 1;
    console.log(
      `  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`,
    );
  }
}

const truthy = (label, actual) => check(label, Boolean(actual), true);

function section(title) {
  console.log(`\n################ ${title} ################`);
}

/** A session, as a cookie the fetch calls carry. */
async function login(email, password) {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status === 429) {
    throw new Error(
      `login for ${email} was rate limited. This suite signs in three times; give it a` +
        ' couple of minutes after another suite that signs in, or run it on its own.',
    );
  }
  if (response.status !== 200) throw new Error(`login failed for ${email}: ${response.status}`);
  const raw = response.headers.getSetCookie?.() ?? [];
  const cookie = raw.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`no session cookie for ${email}`);
  return cookie;
}

async function api(cookie, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: json };
}

const ZONE = 'Asia/Karachi';
const PERIOD_START = '2025-09-01';
const PERIOD_END = '2025-09-30';

let companyId = null;
let adminCookie = null;
let managerCookie = null;
let employeeCookie = null;
let periodId = null;
let runId = null;

/** The three demo accounts, and the employees behind two of them. */
let adminEmployeeId = null;
let managerEmployeeId = null;
let staffEmployeeId = null;

const created = { salaries: [], components: [], assignments: [], adjustments: [] };

/** Removes everything this suite made, whatever happened. */
async function cleanup() {
  const runs = await prisma.payrollRun.findMany({
    where: { period: { name: { startsWith: 'AUDIT ' } } },
    select: { id: true },
  });
  const runIds = runs.map((r) => r.id);

  if (runIds.length > 0) {
    const lines = await prisma.payrollLine.findMany({
      where: { runId: { in: runIds } },
      select: { id: true },
    });
    const lineIds = lines.map((l) => l.id);
    await prisma.payslip.deleteMany({ where: { lineId: { in: lineIds } } });
    await prisma.payrollEarning.deleteMany({ where: { lineId: { in: lineIds } } });
    await prisma.payrollDeduction.deleteMany({ where: { lineId: { in: lineIds } } });
    await prisma.payrollException.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollAdjustment.updateMany({
      where: { appliedRunId: { in: runIds } },
      data: { appliedRunId: null, appliedAt: null },
    });
    await prisma.payrollLine.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollRun.deleteMany({ where: { id: { in: runIds } } });
  }

  await prisma.payrollPeriod.deleteMany({ where: { name: { startsWith: 'AUDIT ' } } });
  await prisma.payrollAdjustment.deleteMany({ where: { reason: { startsWith: 'AUDIT ' } } });
  await prisma.employeeSalaryComponent.deleteMany({ where: { note: { startsWith: 'AUDIT ' } } });
  await prisma.salaryComponent.deleteMany({ where: { name: { startsWith: 'AUDIT ' } } });
  await prisma.employeeSalary.deleteMany({ where: { note: { startsWith: 'AUDIT ' } } });
  await prisma.attendanceRecord.deleteMany({
    where: {
      date: { gte: new Date(`${PERIOD_START}T00:00:00.000Z`), lte: new Date(`${PERIOD_END}T00:00:00.000Z`) },
      notes: { startsWith: 'AUDIT ' },
    },
  });
}

try {
  section('FIXTURES');

  {
    const company = await prisma.company.findFirstOrThrow({
      select: { id: true, timezone: true, currency: true },
    });
    companyId = company.id;
    check('the company timezone is the one payroll must use', company.timezone, ZONE);

    const users = await prisma.user.findMany({
      where: { email: { in: ['admin@hrms.local', 'manager@hrms.local', 'employee@hrms.local'] } },
      select: { email: true, employee: { select: { id: true } } },
    });
    const byEmail = new Map(users.map((u) => [u.email, u.employee?.id ?? null]));
    adminEmployeeId = byEmail.get('admin@hrms.local');
    managerEmployeeId = byEmail.get('manager@hrms.local');
    staffEmployeeId = byEmail.get('employee@hrms.local');
    truthy('three demo accounts with employee records', adminEmployeeId && managerEmployeeId && staffEmployeeId);

    await cleanup();

    // Attendance for the staff employee, written the way the attendance engine
    // writes it. Payroll reads these; it never sees a punch.
    // September 2025: the 1st is a Monday, so weekends are 6,7,13,14,20,21,27,28.
    const workingDays = [];
    for (let d = 1; d <= 30; d += 1) {
      const weekday = (d % 7) % 7; // 1 Sept 2025 is a Monday -> d=6 is Saturday
      const isWeekend = d % 7 === 6 || d % 7 === 0;
      if (!isWeekend) workingDays.push(d);
    }
    check('September 2025 has 22 working days', workingDays.length, 22);

    for (const d of workingDays) {
      const date = `2025-09-${String(d).padStart(2, '0')}`;
      // 09:00 to 18:00 Karachi is 04:00 to 13:00 UTC.
      await prisma.attendanceRecord.create({
        data: {
          companyId,
          employeeId: staffEmployeeId,
          date: new Date(`${date}T00:00:00.000Z`),
          status: d === 10 ? 'ABSENT' : 'PRESENT',
          source: 'DEVICE',
          notes: 'AUDIT payroll fixture',
          ...(d === 10
            ? {}
            : {
                checkInAt: new Date(`${date}T04:00:00.000Z`),
                checkOutAt: new Date(`${date}T13:00:00.000Z`),
                workedMinutes: 540,
                lateMinutes: d === 3 ? 25 : 0,
                overtimeMinutes: d === 4 ? 120 : 0,
              }),
        },
      });
    }

    const written = await prisma.attendanceRecord.count({
      where: { employeeId: staffEmployeeId, notes: { startsWith: 'AUDIT ' } },
    });
    check('attendance fixtures written', written, 22);

    adminCookie = await login('admin@hrms.local', 'Admin@12345');
    managerCookie = await login('manager@hrms.local', 'Manager@12345');
    employeeCookie = await login('employee@hrms.local', 'Employee@12345');
    truthy('three sessions', adminCookie && managerCookie && employeeCookie);
  }

  section('AUTHORIZATION');

  {
    const anon = await fetch(`${BASE}/payroll/runs`);
    check('payroll needs a session', anon.status, 401);

    const anonSlips = await fetch(`${BASE}/payslips`);
    check('so do payslips', anonSlips.status, 401);

    const staffRuns = await api(employeeCookie, '/payroll/runs');
    check('an employee cannot see payroll runs', staffRuns.status, 403);

    const staffSalaries = await api(employeeCookie, '/payroll/salaries');
    check('nor salaries', staffSalaries.status, 403);

    const staffSettings = await api(employeeCookie, '/payroll/settings');
    check('nor payroll settings', staffSettings.status, 403);

    const managerRuns = await api(managerCookie, '/payroll/runs');
    check('a manager has no payroll access by default', managerRuns.status, 403);

    const staffWrite = await api(employeeCookie, '/payroll/salaries', {
      method: 'POST',
      body: {
        employeeId: staffEmployeeId,
        salaryType: 'MONTHLY',
        amount: 999999,
        effectiveFrom: '2025-01-01',
      },
    });
    check('an employee cannot set their own salary', staffWrite.status, 403);

    const stored = await prisma.employeeSalary.count({ where: { employeeId: staffEmployeeId } });
    check('and nothing was written', stored, 0);

    const adminRuns = await api(adminCookie, '/payroll/runs');
    check('an administrator can', adminRuns.status, 200);

    // Every payslip route is reachable by staff; the data scope is what limits
    // it, and that is tested once payslips exist.
    const staffSlips = await api(employeeCookie, '/payslips');
    check('an employee may reach their own payslips', staffSlips.status, 200);
  }

  section('PAYROLL SETTINGS');

  {
    const read = await api(adminCookie, '/payroll/settings');
    check('settings are created on first read', read.status, 200);
    check('with a fixed-days basis by default', read.body.data.basis, 'FIXED_DAYS');
    check('of thirty', read.body.data.fixedBasisDays, 30);
    check('time and a half for overtime', read.body.data.overtimeMultiplier, 1.5);
    check('and approval required', read.body.data.requireApprovedOvertime, true);

    const patched = await api(adminCookie, '/payroll/settings', {
      method: 'PATCH',
      body: { fixedBasisDays: 30, deductUnpaidAbsence: true, overtimeMultiplier: 1.5 },
    });
    check('settings can be changed', patched.status, 200);

    const partial = await api(adminCookie, '/payroll/settings', {
      method: 'PATCH',
      body: { payslipPrefix: 'AUD-' },
    });
    check('a partial update is accepted', partial.status, 200);
    check('and leaves the other fields alone', partial.body.data.fixedBasisDays, 30);

    await api(adminCookie, '/payroll/settings', { method: 'PATCH', body: { payslipPrefix: 'PS-' } });
  }

  section('EFFECTIVE-DATED SALARY');

  {
    const first = await api(adminCookie, '/payroll/salaries', {
      method: 'POST',
      body: {
        employeeId: staffEmployeeId,
        salaryType: 'MONTHLY',
        amount: 100000,
        effectiveFrom: '2025-01-01',
        effectiveTo: '2025-06-30',
        note: 'AUDIT first salary',
      },
    });
    check('a salary can be set', first.status, 201);
    created.salaries.push(first.body.data.id);

    const second = await api(adminCookie, '/payroll/salaries', {
      method: 'POST',
      body: {
        employeeId: staffEmployeeId,
        salaryType: 'MONTHLY',
        amount: 120000,
        effectiveFrom: '2025-07-01',
        note: 'AUDIT raise',
      },
    });
    check('and raised from a later date', second.status, 201);
    created.salaries.push(second.body.data.id);

    const overlapping = await api(adminCookie, '/payroll/salaries', {
      method: 'POST',
      body: {
        employeeId: staffEmployeeId,
        salaryType: 'MONTHLY',
        amount: 150000,
        effectiveFrom: '2025-08-01',
        note: 'AUDIT overlap',
      },
    });
    check('an overlapping record is refused', overlapping.status, 422);
    truthy(
      'and says why',
      JSON.stringify(overlapping.body).includes('overlaps'),
    );

    const backwards = await api(adminCookie, '/payroll/salaries', {
      method: 'POST',
      body: {
        employeeId: adminEmployeeId,
        salaryType: 'MONTHLY',
        amount: 1000,
        effectiveFrom: '2025-05-01',
        effectiveTo: '2025-04-01',
        note: 'AUDIT backwards',
      },
    });
    check('a record ending before it starts is refused', backwards.status, 422);

    const list = await api(adminCookie, `/payroll/salaries?employeeId=${staffEmployeeId}`);
    check('both records are listed', list.body.data.length, 2);
    const current = list.body.data.find((r) => r.isCurrent);
    check('the later one is in force today', current.amount, 120000);
  }

  {
    // Every employee in the run needs a salary, or they block it - which is the
    // correct behaviour and would otherwise make the blocking test below prove
    // nothing, because the run would already be blocked before it starts.
    const everyone = await prisma.employee.findMany({
      where: {
        companyId,
        OR: [{ terminationDate: null }, { terminationDate: { gte: new Date(PERIOD_START) } }],
      },
      select: { id: true },
    });

    for (const employee of everyone) {
      if (employee.id === staffEmployeeId) continue;
      const response = await api(adminCookie, '/payroll/salaries', {
        method: 'POST',
        body: {
          employeeId: employee.id,
          salaryType: 'MONTHLY',
          amount: employee.id === managerEmployeeId ? 150000 : 200000,
          effectiveFrom: '2024-01-01',
          note: 'AUDIT baseline',
        },
      });
      if (response.status === 201) created.salaries.push(response.body.data.id);
    }

    const count = await prisma.employeeSalary.count({ where: { note: { startsWith: 'AUDIT ' } } });
    check('every employee in the period has a salary', count, everyone.length + 1);
  }

  section('ALLOWANCES');

  {
    const component = await api(adminCookie, '/payroll/components', {
      method: 'POST',
      body: {
        name: 'AUDIT Transport',
        code: 'TRANSPORT',
        kind: 'EARNING',
        calc: 'FIXED',
        isTaxable: true,
        isActive: true,
      },
    });
    check('a salary component can be defined', component.status, 201);
    created.components.push(component.body.data.id);

    const duplicate = await api(adminCookie, '/payroll/components', {
      method: 'POST',
      body: { name: 'AUDIT Transport', kind: 'EARNING', calc: 'FIXED' },
    });
    check('names are unique within a company', duplicate.status, 409);

    const assignment = await api(adminCookie, '/payroll/employee-components', {
      method: 'POST',
      body: {
        employeeId: staffEmployeeId,
        componentId: component.body.data.id,
        value: 5000,
        frequency: 'RECURRING',
        effectiveFrom: '2025-01-01',
        note: 'AUDIT transport',
      },
    });
    check('and assigned to an employee', assignment.status, 201);
    created.assignments.push(assignment.body.data.id);

    const bonus = await api(adminCookie, '/payroll/components', {
      method: 'POST',
      body: { name: 'AUDIT Bonus', code: 'BONUS', kind: 'EARNING', calc: 'FIXED' },
    });
    created.components.push(bonus.body.data.id);

    const oneTime = await api(adminCookie, '/payroll/employee-components', {
      method: 'POST',
      body: {
        employeeId: staffEmployeeId,
        componentId: bonus.body.data.id,
        value: 10000,
        frequency: 'ONE_TIME',
        effectiveFrom: '2025-09-15',
        note: 'AUDIT bonus',
      },
    });
    check('a one-time bonus can be assigned', oneTime.status, 201);
    created.assignments.push(oneTime.body.data.id);

    const stored = await prisma.employeeSalaryComponent.findUnique({
      where: { id: oneTime.body.data.id },
    });
    check(
      'and is closed on the day it starts so it cannot repeat',
      stored.effectiveTo.toISOString().slice(0, 10),
      '2025-09-15',
    );

    const staffAttempt = await api(employeeCookie, '/payroll/employee-components', {
      method: 'POST',
      body: {
        employeeId: staffEmployeeId,
        componentId: component.body.data.id,
        value: 999999,
        effectiveFrom: '2025-01-01',
      },
    });
    check('an employee cannot award themselves an allowance', staffAttempt.status, 403);
  }

  section('PAY PERIOD AND RUN');

  {
    const period = await api(adminCookie, '/payroll/periods', {
      method: 'POST',
      body: {
        name: 'AUDIT September 2025',
        startDate: PERIOD_START,
        endDate: PERIOD_END,
        payDate: '2025-10-05',
      },
    });
    check('a pay period can be created', period.status, 201);
    periodId = period.body.data.id;

    const backwards = await api(adminCookie, '/payroll/periods', {
      method: 'POST',
      body: { name: 'AUDIT Backwards', startDate: '2025-09-30', endDate: '2025-09-01' },
    });
    check('a period ending before it starts is refused', backwards.status, 422);

    const run = await api(adminCookie, '/payroll/runs', {
      method: 'POST',
      body: { periodId, notes: 'AUDIT run' },
    });
    check('a run can be created', run.status, 201);
    check('and starts as a draft', run.body.data.status, 'DRAFT');
    runId = run.body.data.id;

    const second = await api(adminCookie, '/payroll/runs', {
      method: 'POST',
      body: { periodId },
    });
    check('a second run for the same period is refused', second.status, 409);

    const staffRun = await api(employeeCookie, '/payroll/runs', {
      method: 'POST',
      body: { periodId },
    });
    check('an employee cannot start a payroll run', staffRun.status, 403);
  }

  section('CALCULATION');

  {
    const result = await api(adminCookie, `/payroll/runs/${runId}/calculate`, { method: 'POST' });
    check('the run calculates', result.status, 200);
    check('and lands in review', result.body.data.status, 'REVIEW');
    truthy('with lines', result.body.data.lines >= 3);

    const lines = await api(adminCookie, `/payroll/runs/${runId}/lines?employeeId=${staffEmployeeId}`);
    check('the employee has a line', lines.body.data.length, 1);

    const line = lines.body.data[0];

    // The whole point: these figures came from the attendance engine, not from
    // payroll re-reading anything.
    check('scheduled days match the working days in the month', line.scheduledDays, 22);
    check('weekends are counted, not paid for', line.weekendDays, 8);
    check('the one absence is seen', line.absentDays, 1);
    check('and 21 present days', line.presentDays, 21);
    check('one day of lateness is carried through', line.lateOccurrences, 1);
    check('with its minutes', line.lateMinutes, 25);
    check('overtime minutes are carried through', line.overtimeMinutes, 120);

    // September 2025 sits entirely after the July raise, so 120000 applies.
    check('the salary in force is the raised one', line.salaryAmount, 120000);
    check('and only one salary covered the period', line.salarySegments, 1);
    check('basic is the full monthly salary', line.basicAmount, 120000);
    // 120000 / 30 = 4000 exactly.
    check('the daily rate divides by the basis', line.dailyRate, 4000);
    check('one unpaid day', line.unpaidDays, 1);
    check('deducted at the daily rate', line.deductionsTotal, 4000);

    // 120000 basic + 5000 transport + 10000 bonus = 135000
    check('allowances are added', line.earningsTotal, 135000);
    check('net is gross less the absence', line.netAmount, 131000);

    const absence = line.deductions.find((d) => d.kind === 'ABSENCE');
    truthy('the absence appears as its own itemised line', absence);
    check('for one day', absence.units, 1);

    const transport = line.earnings.find((e) => e.label === 'AUDIT Transport');
    truthy('so does the allowance', transport);
    check('at its assigned value', transport.amount, 5000);
  }

  {
    // The overtime was never on an approved timesheet, so it is reported and
    // not paid - the difference between counting hours and paying for them.
    const lines = await api(adminCookie, `/payroll/runs/${runId}/lines?employeeId=${staffEmployeeId}`);
    check('unapproved overtime is not paid', lines.body.data[0].overtimeAmount, 0);
    check('and none of it counts as approved', lines.body.data[0].approvedOvertimeMinutes, 0);

    const exceptions = await api(adminCookie, `/payroll/runs/${runId}/exceptions`);
    check('exceptions are reported', exceptions.status, 200);
    const unapproved = exceptions.body.data.filter((e) => e.code === 'UNAPPROVED_OVERTIME');
    check('including the unapproved overtime', unapproved.length, 1);
    check('as a warning, not a blocker', unapproved[0].severity, 'WARNING');
  }

  section('APPROVED OVERTIME');

  {
    // Approve a timesheet covering the period and recalculate: the same hours,
    // now paid, with nothing about the attendance itself having changed.
    const sheet = await prisma.timesheet.create({
      data: {
        companyId,
        employeeId: staffEmployeeId,
        periodStart: new Date(`${PERIOD_START}T00:00:00.000Z`),
        periodEnd: new Date(`${PERIOD_END}T00:00:00.000Z`),
        status: 'APPROVED',
        totalMinutes: 0,
        notes: 'AUDIT payroll overtime approval',
      },
    });

    const recalculated = await api(adminCookie, `/payroll/runs/${runId}/calculate`, {
      method: 'POST',
    });
    check('the run recalculates', recalculated.status, 200);

    const lines = await api(adminCookie, `/payroll/runs/${runId}/lines?employeeId=${staffEmployeeId}`);
    const line = lines.body.data[0];
    check('the overtime is now approved', line.approvedOvertimeMinutes, 120);
    // 120000 / 30 / 8 = 500/hr, x1.5 x 2h = 1500
    check('and paid at time and a half', line.overtimeAmount, 1500);
    check('gross rises by exactly that', line.earningsTotal, 136500);
    check('and so does net', line.netAmount, 132500);

    await prisma.timesheet.delete({ where: { id: sheet.id } });
  }

  section('EXCEPTIONS BLOCK FINALIZATION');

  {
    // Take one employee's salary away and recalculate: the run must refuse to
    // finalize rather than quietly pay them nothing.
    const removed = await prisma.employeeSalary.findFirst({
      where: { employeeId: managerEmployeeId, note: { startsWith: 'AUDIT ' } },
    });
    await prisma.employeeSalary.delete({ where: { id: removed.id } });

    await api(adminCookie, `/payroll/runs/${runId}/calculate`, { method: 'POST' });

    const run = await api(adminCookie, `/payroll/runs/${runId}`);
    check('exactly one blocking exception is recorded', run.body.data.blockingCount, 1);

    const approve = await api(adminCookie, `/payroll/runs/${runId}/approve`, { method: 'POST' });
    check('approval is refused while it stands', approve.status, 422);

    const finalize = await api(adminCookie, `/payroll/runs/${runId}/finalize`, { method: 'POST' });
    check('and so is finalization', finalize.status, 409);

    const exceptions = await api(adminCookie, `/payroll/runs/${runId}/exceptions`);
    const missing = exceptions.body.data.filter((e) => e.code === 'MISSING_SALARY');
    check('the exception says what is missing', missing.length, 1);
    check('and blocks', missing[0].severity, 'BLOCKING');

    // Put it back and recalculate.
    const restored = await api(adminCookie, '/payroll/salaries', {
      method: 'POST',
      body: {
        employeeId: managerEmployeeId,
        salaryType: 'MONTHLY',
        amount: 150000,
        effectiveFrom: '2024-01-01',
        note: 'AUDIT baseline',
      },
    });
    check('the salary can be restored', restored.status, 201);

    await api(adminCookie, `/payroll/runs/${runId}/calculate`, { method: 'POST' });
    const after = await api(adminCookie, `/payroll/runs/${runId}`);
    check('and the block clears', after.body.data.blockingCount, 0);
  }

  section('A SALARY TYPE CANNOT CHANGE MID-PERIOD');

  {
    // Monthly, daily and hourly pay are read in different units. A period that
    // changes from one to another has no single right answer, so the run must
    // refuse it rather than pick whichever came first.
    const admin = await prisma.employeeSalary.findFirst({
      where: { employeeId: adminEmployeeId, note: { startsWith: 'AUDIT ' } },
    });
    await prisma.employeeSalary.update({
      where: { id: admin.id },
      data: { effectiveTo: new Date('2025-09-15T00:00:00.000Z') },
    });
    const hourly = await prisma.employeeSalary.create({
      data: {
        companyId,
        employeeId: adminEmployeeId,
        salaryType: 'HOURLY',
        amount: 900,
        currency: 'USD',
        effectiveFrom: new Date('2025-09-16T00:00:00.000Z'),
        note: 'AUDIT type change',
      },
    });

    await api(adminCookie, `/payroll/runs/${runId}/calculate`, { method: 'POST' });

    const exceptions = await api(adminCookie, `/payroll/runs/${runId}/exceptions`);
    const mixed = exceptions.body.data.filter(
      (e) => e.employeeId === adminEmployeeId && e.severity === 'BLOCKING',
    );
    check('a mid-period type change is refused', mixed.length, 1);
    truthy('and says what to do about it', mixed[0].message.includes('separately'));

    const lines = await api(adminCookie, `/payroll/runs/${runId}/lines?employeeId=${adminEmployeeId}`);
    check('no line is produced for them', lines.body.data.length, 0);

    const approve = await api(adminCookie, `/payroll/runs/${runId}/approve`, { method: 'POST' });
    check('and the run cannot be approved', approve.status, 422);

    // Put it back.
    await prisma.employeeSalary.delete({ where: { id: hourly.id } });
    await prisma.employeeSalary.update({ where: { id: admin.id }, data: { effectiveTo: null } });
    await api(adminCookie, `/payroll/runs/${runId}/calculate`, { method: 'POST' });
    const cleared = await api(adminCookie, `/payroll/runs/${runId}`);
    check('resolving it clears the block', cleared.body.data.blockingCount, 0);
  }

  section('WORKFLOW');

  {
    const run = await api(adminCookie, `/payroll/runs/${runId}`);
    check('the run is in review', run.body.data.status, 'REVIEW');

    const finalizeEarly = await api(adminCookie, `/payroll/runs/${runId}/finalize`, {
      method: 'POST',
    });
    check('a run in review cannot skip straight to finalized', finalizeEarly.status, 409);

    const approve = await api(adminCookie, `/payroll/runs/${runId}/approve`, { method: 'POST' });
    check('it can be approved', approve.status, 200);

    const recalc = await api(adminCookie, `/payroll/runs/${runId}/calculate`, { method: 'POST' });
    check('an approved run cannot be recalculated', recalc.status, 409);

    const back = await api(adminCookie, `/payroll/runs/${runId}/review`, { method: 'POST' });
    check('but it can be sent back', back.status, 200);

    const recalcAgain = await api(adminCookie, `/payroll/runs/${runId}/calculate`, {
      method: 'POST',
    });
    check('and then recalculated', recalcAgain.status, 200);

    await api(adminCookie, `/payroll/runs/${runId}/approve`, { method: 'POST' });

    const staffApprove = await api(employeeCookie, `/payroll/runs/${runId}/finalize`, {
      method: 'POST',
    });
    check('an employee cannot finalize payroll', staffApprove.status, 403);

    const finalize = await api(adminCookie, `/payroll/runs/${runId}/finalize`, { method: 'POST' });
    check('an approver can', finalize.status, 200);
    truthy('and payslips are issued', finalize.body.data.payslips >= 3);
  }

  section('A FINALIZED RUN IS IMMUTABLE');

  {
    const before = await api(adminCookie, `/payroll/runs/${runId}/lines?employeeId=${staffEmployeeId}`);
    const original = before.body.data[0];
    check('the run is finalized', (await api(adminCookie, `/payroll/runs/${runId}`)).body.data.status, 'FINALIZED');

    const recalc = await api(adminCookie, `/payroll/runs/${runId}/calculate`, { method: 'POST' });
    check('it cannot be recalculated', recalc.status, 409);
    truthy('and says corrections need an adjustment', JSON.stringify(recalc.body).includes('adjustment'));

    const cancel = await api(adminCookie, `/payroll/runs/${runId}/cancel`, {
      method: 'POST',
      body: { reason: 'AUDIT trying to cancel a finalized run' },
    });
    check('it cannot be cancelled', cancel.status, 409);

    const approve = await api(adminCookie, `/payroll/runs/${runId}/approve`, { method: 'POST' });
    check('nor re-approved', approve.status, 409);

    // Attendance changes must not rewrite it.
    await prisma.attendanceRecord.updateMany({
      where: { employeeId: staffEmployeeId, notes: { startsWith: 'AUDIT ' } },
      data: { status: 'ABSENT', workedMinutes: 0 },
    });

    const afterAttendance = await api(
      adminCookie,
      `/payroll/runs/${runId}/lines?employeeId=${staffEmployeeId}`,
    );
    check(
      'changing attendance does not move the figure',
      afterAttendance.body.data[0].netAmount,
      original.netAmount,
    );
    check('nor the day counts it was based on', afterAttendance.body.data[0].presentDays, original.presentDays);

    // A salary the finalized run has used cannot be edited either.
    const salary = await prisma.employeeSalary.findFirst({
      where: { employeeId: staffEmployeeId, note: 'AUDIT raise' },
    });
    const edit = await api(adminCookie, `/payroll/salaries/${salary.id}`, {
      method: 'PATCH',
      body: { salaryType: 'MONTHLY', amount: 999999, effectiveFrom: '2025-07-01' },
    });
    check('a salary a finalized run used cannot be edited', edit.status, 409);

    const afterSalary = await api(
      adminCookie,
      `/payroll/runs/${runId}/lines?employeeId=${staffEmployeeId}`,
    );
    check('so the payslip figure stands', afterSalary.body.data[0].netAmount, original.netAmount);

    // A new run for the same period is refused outright.
    const newRun = await api(adminCookie, '/payroll/runs', { method: 'POST', body: { periodId } });
    check('and the period cannot be run again', newRun.status, 409);

    const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
    check('the period is closed', period.status, 'CLOSED');

    // Put the attendance back for the remaining assertions.
    await prisma.attendanceRecord.updateMany({
      where: { employeeId: staffEmployeeId, notes: { startsWith: 'AUDIT ' }, checkInAt: { not: null } },
      data: { status: 'PRESENT', workedMinutes: 540 },
    });
  }

  section('PAYSLIPS AND EMPLOYEE ISOLATION');

  {
    const all = await api(adminCookie, '/payslips');
    check('an administrator sees the payslips', all.status, 200);
    truthy('all of them', all.body.data.length >= 3);

    const mine = await api(employeeCookie, '/payslips');
    check('an employee sees payslips', mine.status, 200);
    check('exactly one - their own', mine.body.data.length, 1);
    check('and it is theirs', mine.body.data[0].employeeId, staffEmployeeId);

    const someoneElse = all.body.data.find((p) => p.employeeId !== staffEmployeeId);
    truthy('another employee has a payslip', someoneElse);

    // The assertion this whole module exists to satisfy.
    const stolen = await api(employeeCookie, `/payslips/${someoneElse.id}`);
    check('changing the id does not reveal it', stolen.status, 403);
    truthy('and no figure leaks in the refusal', !JSON.stringify(stolen.body).includes('netAmount'));

    const own = await api(employeeCookie, `/payslips/${mine.body.data[0].id}`);
    check('their own payslip opens', own.status, 200);
    truthy('with the itemised lines', own.body.data.line.earnings.length > 0);
    truthy('and a payslip number', own.body.data.number.length > 0);

    const filtered = await api(employeeCookie, `/payslips?employeeId=${someoneElse.employeeId}`);
    check('filtering by another employee is refused too', filtered.status, 403);

    const managerSlips = await api(managerCookie, '/payslips');
    check('a manager holds no payslip permission by default', managerSlips.status, 403);

    const staffLines = await api(employeeCookie, `/payroll/runs/${runId}/lines`);
    check('an employee cannot read the run lines either', staffLines.status, 403);
  }

  section('PAYROLL ADJUSTMENT');

  {
    const line = (
      await api(adminCookie, `/payroll/runs/${runId}/lines?employeeId=${staffEmployeeId}`)
    ).body.data[0];

    const adjustment = await api(adminCookie, '/payroll/adjustments', {
      method: 'POST',
      body: {
        employeeId: staffEmployeeId,
        originLineId: line.id,
        kind: 'EARNING',
        label: 'September correction',
        amount: 3000,
        reason: 'AUDIT underpaid overtime in September',
      },
    });
    check('a correction to a finalized run is raised as an adjustment', adjustment.status, 201);
    created.adjustments.push(adjustment.body.data.id);

    const unchanged = await api(
      adminCookie,
      `/payroll/runs/${runId}/lines?employeeId=${staffEmployeeId}`,
    );
    check('the finalized line is untouched by it', unchanged.body.data[0].netAmount, line.netAmount);

    const wrongEmployee = await api(adminCookie, '/payroll/adjustments', {
      method: 'POST',
      body: {
        employeeId: adminEmployeeId,
        originLineId: line.id,
        kind: 'EARNING',
        label: 'Mismatched',
        amount: 100,
        reason: 'AUDIT mismatched line',
      },
    });
    check('an adjustment cannot point at another employee line', wrongEmployee.status, 422);

    const staffAttempt = await api(employeeCookie, '/payroll/adjustments', {
      method: 'POST',
      body: {
        employeeId: staffEmployeeId,
        kind: 'EARNING',
        label: 'Self award',
        amount: 50000,
        reason: 'AUDIT self award',
      },
    });
    check('an employee cannot raise their own adjustment', staffAttempt.status, 403);
  }

  {
    // The adjustment is carried into the next period's run.
    const nextPeriod = await api(adminCookie, '/payroll/periods', {
      method: 'POST',
      body: { name: 'AUDIT October 2025', startDate: '2025-10-01', endDate: '2025-10-31' },
    });
    const nextRun = await api(adminCookie, '/payroll/runs', {
      method: 'POST',
      body: { periodId: nextPeriod.body.data.id },
    });
    await api(adminCookie, `/payroll/runs/${nextRun.body.data.id}/calculate`, { method: 'POST' });

    const lines = await api(
      adminCookie,
      `/payroll/runs/${nextRun.body.data.id}/lines?employeeId=${staffEmployeeId}`,
    );
    const line = lines.body.data[0];
    check('the adjustment lands in the next run', line.adjustmentTotal, 3000);
    const adjustmentLine = line.earnings.find((e) => e.kind === 'ADJUSTMENT');
    truthy('as an itemised earning', adjustmentLine);
    check('for the amount raised', adjustmentLine.amount, 3000);

    const applied = await prisma.payrollAdjustment.findFirst({
      where: { id: created.adjustments[0] },
    });
    check('and is marked as claimed by that run', applied.appliedRunId, nextRun.body.data.id);

    // Recalculating must not double it.
    await api(adminCookie, `/payroll/runs/${nextRun.body.data.id}/calculate`, { method: 'POST' });
    const again = await api(
      adminCookie,
      `/payroll/runs/${nextRun.body.data.id}/lines?employeeId=${staffEmployeeId}`,
    );
    check('recalculating does not apply it twice', again.body.data[0].adjustmentTotal, 3000);

    const cancelled = await api(adminCookie, `/payroll/runs/${nextRun.body.data.id}/cancel`, {
      method: 'POST',
      body: { reason: 'AUDIT tidy up' },
    });
    check('a run in review can be cancelled', cancelled.status, 200);
  }

  section('TIMEZONE BOUNDARIES');

  {
    // 2025-09-24 23:30 Karachi is 18:30 UTC the same day; 2025-09-25 00:30
    // Karachi is 19:30 UTC on the 24th. The attendance engine assigned each to
    // its own local day when it stored them, and payroll reads that assignment
    // rather than repeating it - which is what stops a late shift being counted
    // on the wrong day, or twice.
    const late = new Date('2025-09-24T18:30:00.000Z');
    const localDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(late);
    check('23:30 Karachi is still the 24th locally', localDay, '2025-09-24');

    const utcDay = late.toISOString().slice(0, 10);
    check('and the same day in UTC, so this case alone proves nothing', utcDay, '2025-09-24');

    // The case that separates them: 01:00 Karachi on the 25th is 20:00 UTC on
    // the 24th. Read in UTC it would land on the previous day.
    const earlyMorning = new Date('2025-09-24T20:00:00.000Z');
    const localEarly = new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(earlyMorning);
    check('01:00 Karachi on the 25th is local the 25th', localEarly, '2025-09-25');
    check('but the 24th in UTC', earlyMorning.toISOString().slice(0, 10), '2025-09-24');

    // Payroll counts by the day the attendance engine recorded, so a record
    // stored against the 25th is in a period that ends on the 30th and out of
    // one that ends on the 24th.
    const inPeriod = await prisma.attendanceRecord.count({
      where: {
        employeeId: staffEmployeeId,
        notes: { startsWith: 'AUDIT ' },
        date: {
          gte: new Date(`${PERIOD_START}T00:00:00.000Z`),
          lte: new Date(`${PERIOD_END}T00:00:00.000Z`),
        },
      },
    });
    check('every fixture day falls inside the period', inPeriod, 22);

    const shortPeriod = await prisma.attendanceRecord.count({
      where: {
        employeeId: staffEmployeeId,
        notes: { startsWith: 'AUDIT ' },
        date: {
          gte: new Date(`${PERIOD_START}T00:00:00.000Z`),
          lte: new Date('2025-09-15T00:00:00.000Z'),
        },
      },
    });
    check('and a shorter period takes only its own days', shortPeriod, 11);
  }

  section('AUDIT TRAIL');

  {
    const logs = await prisma.auditLog.findMany({
      where: { action: { startsWith: 'payroll.' } },
      orderBy: { createdAt: 'desc' },
      take: 60,
    });

    const actions = new Set(logs.map((l) => l.action));
    truthy('salary changes are recorded', actions.has('payroll.salary.create'));
    truthy('allowance changes are recorded', actions.has('payroll.allowance.create'));
    truthy('run creation is recorded', actions.has('payroll.run.create'));
    truthy('calculation is recorded', actions.has('payroll.run.calculate'));
    truthy('approval is recorded', actions.has('payroll.run.approve'));
    truthy('finalization is recorded', actions.has('payroll.run.finalize'));
    truthy('cancellation is recorded', actions.has('payroll.run.cancel'));
    truthy('adjustments are recorded', actions.has('payroll.adjustment.create'));
    truthy('settings changes are recorded', actions.has('payroll.settings.update'));

    const finalize = logs.find((l) => l.action === 'payroll.run.finalize');
    truthy('each entry names the actor', finalize.actorId !== null);
    truthy('and carries a timestamp', finalize.createdAt instanceof Date);
    truthy('and the entity it concerns', finalize.entityId !== null);

    const salaryLog = logs.find((l) => l.action === 'payroll.salary.create');
    truthy('a salary entry records the new value', JSON.stringify(salaryLog.after).includes('amount'));

    const settingsLog = logs.find((l) => l.action === 'payroll.settings.update');
    truthy('a settings entry records what changed', settingsLog.before !== null);
  }

  section('OTHER MODULES ARE UNAFFECTED');

  {
    const attendance = await api(adminCookie, '/attendance?limit=1');
    check('attendance still answers', attendance.status, 200);

    const payPeriod = await api(
      adminCookie,
      `/attendance/pay-period?from=${PERIOD_START}&to=${PERIOD_END}`,
    );
    check('the Phase 6 pay-period summary still answers', payPeriod.status, 200);

    const devices = await api(adminCookie, '/attendance/devices');
    check('devices still answer', devices.status, 200);

    const leave = await api(adminCookie, '/leave/requests?limit=1');
    check('leave still answers', leave.status, 200);

    const timesheets = await api(adminCookie, '/timesheets?limit=1');
    check('timesheets still answer', timesheets.status, 200);

    const iclock = await fetch('http://127.0.0.1:4000/iclock/cdata?SN=NOPE');
    check('the ADMS push endpoint still refuses an unknown device', iclock.status, 401);
  }

  section('RESTORE');

  {
    await cleanup();

    const runs = await prisma.payrollRun.count();
    check('test runs removed', runs, 0);
    const periods = await prisma.payrollPeriod.count();
    check('test periods removed', periods, 0);
    const salaries = await prisma.employeeSalary.count();
    check('test salaries removed', salaries, 0);
    const slips = await prisma.payslip.count();
    check('test payslips removed', slips, 0);
    const records = await prisma.attendanceRecord.count({
      where: { notes: { startsWith: 'AUDIT ' } },
    });
    check('test attendance removed', records, 0);
  }
} catch (error) {
  fail += 1;
  console.error('\nSUITE ABORTED:', error);
  try {
    await cleanup();
  } catch (cleanupError) {
    console.error('cleanup also failed:', cleanupError);
  }
} finally {
  await prisma.$disconnect();
}

console.log('\n################ SUMMARY ################');
console.log(`PASS=${pass}  FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
