/**
 * Demonstration payroll data.
 *
 * Creates a period, salaries, a couple of allowances and some attendance, so
 * the payroll screens have something real to show. Everything it writes is
 * prefixed `DEMO ` and `--clean` removes exactly that and nothing else.
 *
 * Not part of the test suites: those build and tear down their own fixtures.
 * This exists so a person opening the screens sees a working payroll rather
 * than eight empty states.
 *
 *   npx dotenv -e .env -- npx tsx scripts/seed-payroll-demo.mjs
 *   npx dotenv -e .env -- npx tsx scripts/seed-payroll-demo.mjs --clean
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CLEAN = process.argv.includes('--clean');

const PERIOD_START = '2025-10-01';
const PERIOD_END = '2025-10-31';
const NOTE = 'DEMO payroll';

async function clean() {
  const runs = await prisma.payrollRun.findMany({
    where: { period: { name: { startsWith: 'DEMO ' } } },
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

  await prisma.payrollPeriod.deleteMany({ where: { name: { startsWith: 'DEMO ' } } });
  await prisma.payrollAdjustment.deleteMany({ where: { reason: { startsWith: 'DEMO ' } } });
  await prisma.employeeSalaryComponent.deleteMany({ where: { note: { startsWith: 'DEMO ' } } });
  await prisma.salaryComponent.deleteMany({ where: { name: { startsWith: 'DEMO ' } } });
  await prisma.employeeSalary.deleteMany({ where: { note: { startsWith: 'DEMO ' } } });
  await prisma.attendanceRecord.deleteMany({ where: { notes: { startsWith: 'DEMO ' } } });
  await prisma.timesheet.deleteMany({ where: { notes: { startsWith: 'DEMO ' } } });
}

try {
  await clean();
  if (CLEAN) {
    console.log('Demo payroll data removed.');
    process.exit(0);
  }

  const company = await prisma.company.findFirstOrThrow({ select: { id: true, currency: true } });
  const employees = await prisma.employee.findMany({
    where: { companyId: company.id, status: 'ACTIVE' },
    orderBy: { employeeNumber: 'asc' },
    select: { id: true, employeeNumber: true, firstName: true },
  });

  console.log(`${employees.length} active employees.`);

  // --- salaries -------------------------------------------------------------
  // A spread of figures so the reports have something to group, and one raise
  // partway through the year so the effective dating is visible on screen.
  let index = 0;
  for (const employee of employees) {
    const base = 60000 + (index % 6) * 20000;
    await prisma.employeeSalary.create({
      data: {
        companyId: company.id,
        employeeId: employee.id,
        salaryType: 'MONTHLY',
        amount: base,
        currency: company.currency,
        effectiveFrom: new Date('2024-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2025-06-30T00:00:00.000Z'),
        note: `${NOTE} initial`,
      },
    });
    await prisma.employeeSalary.create({
      data: {
        companyId: company.id,
        employeeId: employee.id,
        salaryType: 'MONTHLY',
        amount: Math.round(base * 1.1),
        currency: company.currency,
        effectiveFrom: new Date('2025-07-01T00:00:00.000Z'),
        note: `${NOTE} raise`,
      },
    });
    index += 1;
  }
  console.log(`${employees.length * 2} salary records (one raise each, from July 2025).`);

  // --- components -----------------------------------------------------------
  const transport = await prisma.salaryComponent.create({
    data: {
      companyId: company.id,
      name: 'DEMO Transport allowance',
      code: 'TRANSPORT',
      kind: 'EARNING',
      calc: 'FIXED',
      isTaxable: true,
    },
  });
  const housing = await prisma.salaryComponent.create({
    data: {
      companyId: company.id,
      name: 'DEMO Housing allowance',
      code: 'HOUSING',
      kind: 'EARNING',
      calc: 'PERCENT_OF_BASIC',
      isTaxable: true,
    },
  });
  const loan = await prisma.salaryComponent.create({
    data: {
      companyId: company.id,
      name: 'DEMO Loan repayment',
      code: 'LOAN',
      kind: 'DEDUCTION',
      calc: 'FIXED',
      isTaxable: false,
    },
  });

  for (const [position, employee] of employees.entries()) {
    await prisma.employeeSalaryComponent.create({
      data: {
        companyId: company.id,
        employeeId: employee.id,
        componentId: transport.id,
        value: 5000,
        frequency: 'RECURRING',
        effectiveFrom: new Date('2024-01-01T00:00:00.000Z'),
        note: `${NOTE} transport`,
      },
    });
    if (position % 2 === 0) {
      await prisma.employeeSalaryComponent.create({
        data: {
          companyId: company.id,
          employeeId: employee.id,
          componentId: housing.id,
          value: 10,
          frequency: 'RECURRING',
          effectiveFrom: new Date('2024-01-01T00:00:00.000Z'),
          note: `${NOTE} housing`,
        },
      });
    }
    if (position % 5 === 0) {
      await prisma.employeeSalaryComponent.create({
        data: {
          companyId: company.id,
          employeeId: employee.id,
          componentId: loan.id,
          value: 4000,
          frequency: 'RECURRING',
          effectiveFrom: new Date('2024-01-01T00:00:00.000Z'),
          note: `${NOTE} loan`,
        },
      });
    }
  }
  console.log('3 salary components assigned across the workforce.');

  // --- attendance -----------------------------------------------------------
  // Written the way the attendance engine writes it. Payroll reads these rows;
  // it never sees a punch. October 2025 starts on a Wednesday.
  let records = 0;
  for (const [position, employee] of employees.entries()) {
    for (let d = 1; d <= 31; d += 1) {
      const date = new Date(Date.UTC(2025, 9, d));
      const weekday = date.getUTCDay();
      if (weekday === 0 || weekday === 6) continue;

      // A different pattern per employee so the review table is not uniform.
      const absent = d === 7 + (position % 5);
      const late = d === 14 + (position % 3);
      const overtime = d === 21 && position % 4 === 0;
      const iso = date.toISOString().slice(0, 10);

      await prisma.attendanceRecord.create({
        data: {
          companyId: company.id,
          employeeId: employee.id,
          date,
          status: absent ? 'ABSENT' : 'PRESENT',
          source: 'DEVICE',
          notes: `${NOTE} fixture`,
          ...(absent
            ? {}
            : {
                // 09:00-18:00 Karachi is 04:00-13:00 UTC.
                checkInAt: new Date(`${iso}T04:00:00.000Z`),
                checkOutAt: new Date(`${iso}T13:00:00.000Z`),
                workedMinutes: 540,
                lateMinutes: late ? 22 : 0,
                overtimeMinutes: overtime ? 180 : 0,
              }),
        },
      });
      records += 1;
    }
  }
  console.log(`${records} attendance records for October 2025.`);

  // An approved timesheet so the recorded overtime is payable, and the
  // difference between "recorded" and "approved" is visible on the reports.
  for (const [position, employee] of employees.entries()) {
    if (position % 4 !== 0) continue;
    await prisma.timesheet.create({
      data: {
        companyId: company.id,
        employeeId: employee.id,
        periodStart: new Date(`${PERIOD_START}T00:00:00.000Z`),
        periodEnd: new Date(`${PERIOD_END}T00:00:00.000Z`),
        status: 'APPROVED',
        totalMinutes: 0,
        notes: `${NOTE} overtime approval`,
      },
    });
  }

  // --- period ---------------------------------------------------------------
  const period = await prisma.payrollPeriod.create({
    data: {
      companyId: company.id,
      name: 'DEMO October 2025',
      startDate: new Date(`${PERIOD_START}T00:00:00.000Z`),
      endDate: new Date(`${PERIOD_END}T00:00:00.000Z`),
      payDate: new Date('2025-11-05T00:00:00.000Z'),
    },
  });

  console.log(`\nPay period "${period.name}" is ready.`);
  console.log('Open Payroll -> Pay runs, create a run against it and calculate.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
