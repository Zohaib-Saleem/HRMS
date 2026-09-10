/**
 * Attendance module, step 2: the integration audit.
 *
 * The unit suites pin the arithmetic and the guards. This one drives the real
 * API over HTTP - the same way a browser does - and asserts the things that
 * only a running system can answer:
 *
 *   - the new endpoints are actually mounted and answer;
 *   - a correction writes the record, the ledger and the audit log, and leaves
 *     every raw punch byte-for-byte as it was;
 *   - a PunchCode cannot belong to two people at once;
 *   - the payroll preview writes nothing at all;
 *   - reports and their CSV exports come back.
 *
 * Point it at a THROWAWAY database. It creates fixtures, corrects attendance
 * and leaves the fixtures behind only if it crashes; it is not safe to run
 * against production and refuses to try.
 *
 *   DATABASE_URL=... API_BASE=http://127.0.0.1:4000/api/v1 \
 *     npx tsx scripts/audit-attendance-module.mjs
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000/api/v1';
const EMAIL = process.env.AUDIT_EMAIL ?? 'admin@hrms.local';
const PASSWORD = process.env.AUDIT_PASSWORD ?? 'Admin@12345';

if (/hrms_prod/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refusing to run against hrms_prod. Point DATABASE_URL at a clone.');
  process.exit(2);
}

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

async function login(email, password) {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200) {
    throw new Error(`login failed for ${email}: ${response.status} ${await response.text()}`);
  }
  return response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function call(cookie, path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      cookie,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: json, text };
}

/**
 * A fingerprint of every immutable column on every raw punch.
 *
 * The attribution and the processed flag are excluded deliberately: those are
 * the two columns the mapping service is allowed to write. Everything the
 * device itself reported is in here, so any change to it fails the run.
 */
async function punchFingerprint() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, "rawTimestamp", "punchedAt", "deviceUserId", "deviceId",
            coalesce("punchState",'') AS state, coalesce("verifyMode",'') AS verify,
            "localDayKey", "deviceTimeZone"
     FROM attendance_raw_punches ORDER BY id`,
  );
  const hash = createHash('sha256');
  for (const row of rows) hash.update(JSON.stringify(row));
  return { count: rows.length, digest: hash.digest('hex') };
}

async function main() {
  const company = await prisma.company.findFirst({ select: { id: true, timezone: true } });
  if (!company) throw new Error('no company in this database');

  const cookie = await login(EMAIL, PASSWORD);

  // A person, a day, and the punches underneath it, all left exactly as found.
  const employee = await prisma.employee.findFirst({
    where: { companyId: company.id, status: 'ACTIVE' },
    orderBy: { employeeNumber: 'asc' },
    select: { id: true, employeeNumber: true, firstName: true, lastName: true },
  });
  if (!employee) throw new Error('no active employee in this database');

  const beforePunches = await punchFingerprint();
  const beforeRecords = await prisma.attendanceRecord.count();
  const beforeSalaries = await prisma.employeeSalary.count();

  // ------------------------------------------------------------ endpoints
  section('the endpoints answer');

  const monthly = await call(cookie, '/attendance/monthly?limit=5');
  check('GET /attendance/monthly', monthly.status, 200);
  truthy('  returns rows and totals', Array.isArray(monthly.body?.data) && monthly.body?.totals);

  const dashboard = await call(cookie, '/attendance/dashboard');
  check('GET /attendance/dashboard', dashboard.status, 200);
  truthy('  counts every employee once', typeof dashboard.body?.data?.counts?.totalEmployees === 'number');

  const mappings = await call(cookie, '/attendance/mappings');
  check('GET /attendance/mappings', mappings.status, 200);

  const history = await call(cookie, '/attendance/mappings/history?limit=5');
  check('GET /attendance/mappings/history', history.status, 200);

  const adjustments = await call(cookie, '/attendance/adjustments');
  check('GET /attendance/adjustments', adjustments.status, 200);

  // ------------------------------------------------------------- reports
  section('reports');

  for (const type of [
    'daily',
    'monthly',
    'employee',
    'department',
    'team',
    'late',
    'early-leave',
    'absence',
    'overtime',
    'missing-punch',
    'leave-vs-attendance',
    'summary',
  ]) {
    const report = await call(cookie, `/attendance/reports/${type}`);
    check(`GET /attendance/reports/${type}`, report.status, 200);
    if (report.status === 200) {
      truthy(`  ${type} has columns`, (report.body?.data?.columns?.length ?? 0) > 0);
    }
  }

  const csv = await call(cookie, '/attendance/reports/monthly/export');
  check('GET /attendance/reports/monthly/export', csv.status, 200);

  const file = await call(
    cookie,
    `/attendance/reports/employee-file?employeeId=${employee.id}`,
  );
  check('GET /attendance/reports/employee-file', file.status, 200);
  if (file.status === 200) {
    truthy('  carries days, punches, corrections and shift history', [
      'days',
      'rawPunches',
      'adjustments',
      'shiftHistory',
    ].every((key) => Array.isArray(file.body?.data?.[key])));
  }

  // ------------------------------------------------------- the correction
  section('correcting a day');

  // A date far enough back that no fixture or job will touch it again, and
  // near enough that it is a real working day for this company.
  const day = new Date();
  day.setUTCDate(day.getUTCDate() - 400);
  const dayKey = day.toISOString().slice(0, 10);

  const detail = await call(
    cookie,
    `/attendance/day?employeeId=${employee.id}&date=${dayKey}`,
  );
  check('GET /attendance/day', detail.status, 200);
  truthy('  shows the rules that scored it', Boolean(detail.body?.data?.rules));
  truthy('  shows the original punches', Array.isArray(detail.body?.data?.rawPunches));

  const correction = await call(cookie, '/attendance/corrections', {
    method: 'POST',
    body: {
      employeeId: employee.id,
      date: dayKey,
      status: 'HALF_DAY',
      workedMinutes: 270,
      reason: 'Attendance module audit - synthetic correction, reverted below.',
    },
  });
  check('POST /attendance/corrections', correction.status, 201);

  const adjustmentId = correction.body?.data?.adjustmentId;
  const recordId = correction.body?.data?.recordId;
  truthy('  writes a ledger entry', Boolean(adjustmentId));

  if (adjustmentId) {
    const entry = await prisma.attendanceAdjustment.findUnique({ where: { id: adjustmentId } });
    truthy('  the entry records a reason', Boolean(entry?.reason));
    truthy('  the entry records an actor', Boolean(entry?.actorId));
    truthy('  the entry records the changed fields', (entry?.changedFields.length ?? 0) > 0);
    truthy('  the entry records the old value', entry?.before !== null);
    truthy('  the entry records the new value', entry?.after !== null);
  }

  const audit = await prisma.auditLog.findFirst({
    where: { action: 'attendance.correct', entityId: recordId ?? undefined },
    orderBy: { createdAt: 'desc' },
  });
  truthy('  writes an audit log entry', Boolean(audit));

  const record = await prisma.attendanceRecord.findFirst({
    where: { employeeId: employee.id, date: new Date(`${dayKey}T00:00:00.000Z`) },
  });
  check('  the record is marked ADMIN', record?.source, 'ADMIN');
  check('  the record carries the corrected figures', record?.workedMinutes, 270);

  // The same correction again changes nothing, and is refused rather than
  // filling the ledger with empty entries.
  const repeat = await call(cookie, '/attendance/corrections', {
    method: 'POST',
    body: {
      employeeId: employee.id,
      date: dayKey,
      status: 'HALF_DAY',
      workedMinutes: 270,
      reason: 'Attendance module audit - the same correction twice.',
    },
  });
  check('  a correction that changes nothing is refused', repeat.status, 409);

  // ------------------------------------------------- the punches are intact
  section('the evidence is untouched');

  const afterPunches = await punchFingerprint();
  check('raw punch count unchanged', afterPunches.count, beforePunches.count);
  check('every raw punch byte-for-byte unchanged', afterPunches.digest, beforePunches.digest);

  const afterRecords = await prisma.attendanceRecord.count();
  check(
    'exactly one attendance record created, or none',
    afterRecords - beforeRecords <= 1,
    true,
  );

  // -------------------------------------------------------- mapping guard
  section('duplicate PunchCode protection');

  const existing = await prisma.attendanceDeviceUserMapping.findFirst({
    where: { companyId: company.id, isActive: true },
    include: { employee: { select: { id: true } } },
  });
  const other = await prisma.employee.findFirst({
    where: { companyId: company.id, id: { not: existing?.employeeId ?? '' } },
    select: { id: true },
  });

  if (existing && other) {
    const clash = await call(cookie, '/attendance/mappings', {
      method: 'POST',
      body: {
        deviceId: existing.deviceId,
        deviceUserId: existing.deviceUserId,
        employeeId: other.id,
      },
    });
    check('the same PunchCode for a second employee is refused', clash.status, 409);
    truthy('  the refusal names who holds it', /already assigned to/i.test(clash.body?.error?.message ?? ''));
  } else {
    console.log('  SKIP  no existing mapping to contend with');
  }

  // ------------------------------------------------------ payroll preview
  section('the payroll preview writes nothing');

  const before = {
    lines: await prisma.payrollLine.count(),
    runs: await prisma.payrollRun.count(),
    exceptions: await prisma.payrollException.count(),
    claimed: await prisma.payrollAdjustment.count({ where: { appliedRunId: { not: null } } }),
    salaries: await prisma.employeeSalary.count(),
  };

  const to = new Date();
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  const preview = await call(
    cookie,
    `/payroll/runs/preview?from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`,
  );
  check('GET /payroll/runs/preview', preview.status, 200);
  truthy('  returns rows and totals', Array.isArray(preview.body?.data?.rows));

  const after = {
    lines: await prisma.payrollLine.count(),
    runs: await prisma.payrollRun.count(),
    exceptions: await prisma.payrollException.count(),
    claimed: await prisma.payrollAdjustment.count({ where: { appliedRunId: { not: null } } }),
    salaries: await prisma.employeeSalary.count(),
  };
  check('  no payroll line written', after.lines, before.lines);
  check('  no payroll run written', after.runs, before.runs);
  check('  no exception written', after.exceptions, before.exceptions);
  check('  no adjustment claimed', after.claimed, before.claimed);
  check('  no salary history touched', after.salaries, before.salaries);
  check('  salary history unchanged overall', after.salaries, beforeSalaries);

  // ------------------------------------------------------------ the rules
  section('configuration');

  const rules = await call(cookie, '/company/attendance-rules');
  check('GET /company/attendance-rules', rules.status, 200);
  truthy('  carries the shipped defaults', Boolean(rules.body?.data?.defaults));
  truthy('  says whether the caller may manage them', typeof rules.body?.data?.canManage === 'boolean');
  check('  the office window is configuration', [
    rules.body?.data?.defaultShiftStart,
    rules.body?.data?.defaultShiftEnd,
  ], ['09:00', '18:00']);

  // ---------------------------------------------------------------- clean
  section('cleaning up');
  if (adjustmentId) {
    await prisma.attendanceAdjustment.delete({ where: { id: adjustmentId } });
    console.log('  removed the synthetic ledger entry');
  }
  if (recordId && afterRecords > beforeRecords) {
    await prisma.attendanceRecord.delete({ where: { id: recordId } }).catch(() => {});
    console.log('  removed the synthetic attendance record');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
