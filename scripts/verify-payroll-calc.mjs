/**
 * Phase 9 audit: the payroll calculation itself.
 *
 * Drives the pure functions directly. No server, no database, no fixtures -
 * which is the point of having made them pure: the arithmetic that decides what
 * somebody is paid can be checked against figures worked out by hand, and a
 * disagreement is a disagreement about the rule, not about the test setup.
 *
 * Every expected value below was computed independently of the code.
 *
 *   npx tsx scripts/verify-payroll-calc.mjs
 */
import {
  calculate,
  roundTo,
  tallyDays,
} from '../apps/api/src/modules/payroll/calculation.ts';
import {
  overlappingSalaries,
  salaryOn,
  segmentBySalary,
  shiftLengthMinutes,
} from '../apps/api/src/modules/payroll/payroll.service.ts';

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

function section(title) {
  console.log(`\n################ ${title} ################`);
}

/** Company settings as the defaults ship them. */
const BASE_CONFIG = {
  basis: 'FIXED_DAYS',
  fixedBasisDays: 30,
  standardHoursPerDay: 8,
  overtimeMode: 'MULTIPLIER',
  overtimeMultiplier: 1.5,
  overtimeFixedRate: 0,
  requireApprovedOvertime: true,
  deductUnpaidAbsence: true,
  deductUnpaidLeave: true,
  lateDeductionMode: 'NONE',
  lateDeductionRate: 0,
  lateGraceMinutes: 0,
  earlyLeaveDeductionMode: 'NONE',
  earlyLeaveDeductionRate: 0,
  earlyLeaveGraceMinutes: 0,
  hourlyRateOverride: null,
  roundingDecimals: 2,
};

const config = (overrides = {}) => ({ ...BASE_CONFIG, ...overrides });

function day(date, status, extra = {}) {
  return {
    date,
    status,
    leaveIsPaid: null,
    leaveDayPart: null,
    workedMinutes: status === 'PRESENT' ? 480 : status === 'HALF_DAY' ? 240 : null,
    lateMinutes: null,
    earlyLeaveMinutes: null,
    overtimeMinutes: null,
    overtimeApproved: false,
    scheduledMinutes: 480,
    hasShift: true,
    ...extra,
  };
}

/**
 * April 2026: 30 days, starting on a Wednesday.
 *
 * Built by hand rather than by calling the code under test, so the day pattern
 * is an independent fact the calculation is checked against.
 */
function april2026(pattern = {}) {
  const days = [];
  for (let d = 1; d <= 30; d += 1) {
    const date = `2026-04-${String(d).padStart(2, '0')}`;
    // 1 April 2026 is a Wednesday, so Saturdays fall on 4, 11, 18, 25.
    const weekday = (2 + d) % 7; // 0 = Sunday
    const override = pattern[date];
    if (override) {
      days.push(day(date, override.status, override));
      continue;
    }
    if (weekday === 0 || weekday === 6) days.push(day(date, 'WEEKEND'));
    else days.push(day(date, 'PRESENT'));
  }
  return days;
}

const monthly = (amount, days, currency = 'PKR') => [
  { salaryType: 'MONTHLY', amount, currency, days },
];

try {
  section('ROUNDING');

  check('two decimals, half up', roundTo(3333.335, 2), 3333.34);
  check('binary representation error does not lose a cent', roundTo(2.675, 2), 2.68);
  check('negatives round away from zero', roundTo(-2.675, 2), -2.68);
  check('zero decimals', roundTo(1234.56, 0), 1235);
  check('a non-finite input is zero, not NaN', roundTo(1 / 0, 2), 0);

  section('DAY COUNTING');

  {
    const days = april2026();
    const tally = tallyDays(days, config());
    // April 2026 has 8 weekend days: 4, 5, 11, 12, 18, 19, 25, 26.
    check('weekends are not scheduled days', tally.weekendDays, 8);
    check('the rest are', tally.scheduledDays, 22);
    check('all present', tally.presentDays, 22);
    check('no absences', tally.absentDays, 0);
    check('scheduled minutes follow the shift', tally.scheduledMinutes, 22 * 480);
  }

  {
    const days = april2026({
      '2026-04-06': { status: 'HOLIDAY' },
      '2026-04-07': { status: 'ABSENT' },
      '2026-04-08': { status: 'ON_LEAVE', leaveIsPaid: true, leaveDayPart: 'FULL_DAY' },
      '2026-04-09': { status: 'ON_LEAVE', leaveIsPaid: false, leaveDayPart: 'FULL_DAY' },
      '2026-04-10': { status: 'HALF_DAY' },
    });
    const tally = tallyDays(days, config());

    check('a holiday is not a scheduled day', tally.holidayDays, 1);
    check('and comes out of the scheduled count', tally.scheduledDays, 21);
    check('absence is counted', tally.absentDays, 1);
    check('paid leave is counted apart from unpaid', tally.paidLeaveDays, 1);
    check('unpaid leave is counted apart from paid', tally.unpaidLeaveDays, 1);
    check('a half day is half a day present', tally.presentDays, 17.5);
    check('and is also counted as a half day', tally.halfDays, 1);
  }

  {
    // Half-day leave: half the day is leave, the other half was worked.
    const days = [
      day('2026-04-01', 'ON_LEAVE', { leaveIsPaid: true, leaveDayPart: 'FIRST_HALF' }),
    ];
    const tally = tallyDays(days, config());
    check('half-day leave consumes half a day', tally.paidLeaveDays, 0.5);
    check('and the other half counts as present', tally.presentDays, 0.5);
  }

  section('MONTHLY SALARY');

  {
    const result = calculate({
      segments: monthly(100000, april2026()),
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 30,
    });

    check('a full month pays the salary exactly', result.basicAmount, 100000);
    // 100000 / 30 = 3333.333...
    check('the daily rate divides by the configured basis', result.dailyRate, 3333.33);
    check('nothing is deducted', result.deductionsTotal, 0);
    check('net is the salary', result.netAmount, 100000);
    check('every scheduled day is payable', result.payableDays, 22);
    check('and none is unpaid', result.unpaidDays, 0);
  }

  {
    // Two absences. 100000 / 30 x 2 = 6666.666... -> 6666.67
    const result = calculate({
      segments: monthly(
        100000,
        april2026({ '2026-04-06': { status: 'ABSENT' }, '2026-04-07': { status: 'ABSENT' } }),
      ),
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 30,
    });

    check('basic is still the full salary', result.basicAmount, 100000);
    check('two days are unpaid', result.unpaidDays, 2);
    check('the absence deduction is daily rate x unpaid days', result.deductionsTotal, 6666.67);
    check('net is salary less the deduction', result.netAmount, 93333.33);
    check('and it appears as its own line', result.deductions[0].code, 'ABSENCE');
    check('with the units it was charged for', result.deductions[0].units, 2);
  }

  {
    // Absence deduction switched off: the days are still absent, but free.
    const result = calculate({
      segments: monthly(
        100000,
        april2026({ '2026-04-06': { status: 'ABSENT' }, '2026-04-07': { status: 'ABSENT' } }),
      ),
      config: config({ deductUnpaidAbsence: false }),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('absence costs nothing when the policy says so', result.deductionsTotal, 0);
    check('and no day is unpaid', result.unpaidDays, 0);
    check('net is untouched', result.netAmount, 100000);
  }

  {
    const result = calculate({
      segments: monthly(
        100000,
        april2026({
          '2026-04-06': { status: 'ON_LEAVE', leaveIsPaid: true, leaveDayPart: 'FULL_DAY' },
          '2026-04-07': { status: 'ON_LEAVE', leaveIsPaid: true, leaveDayPart: 'FULL_DAY' },
        }),
      ),
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('paid leave is paid', result.deductionsTotal, 0);
    check('and stays payable', result.payableDays, 22);
  }

  {
    // Three days of unpaid leave: 100000 / 30 x 3 = 9999.999... -> 10000
    const result = calculate({
      segments: monthly(
        100000,
        april2026({
          '2026-04-06': { status: 'ON_LEAVE', leaveIsPaid: false, leaveDayPart: 'FULL_DAY' },
          '2026-04-07': { status: 'ON_LEAVE', leaveIsPaid: false, leaveDayPart: 'FULL_DAY' },
          '2026-04-08': { status: 'ON_LEAVE', leaveIsPaid: false, leaveDayPart: 'FULL_DAY' },
        }),
      ),
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('unpaid leave is deducted', result.deductionsTotal, 10000);
    check('as its own line', result.deductions[0].code, 'UNPAID_LEAVE');
    check('net drops by exactly that', result.netAmount, 90000);
  }

  {
    // A half day is half a day not worked: 3333.333 x 0.5 = 1666.67
    const result = calculate({
      segments: monthly(100000, april2026({ '2026-04-06': { status: 'HALF_DAY' } })),
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('half a day is deducted for a half day', result.deductionsTotal, 1666.67);
    check('and half a day is unpaid', result.unpaidDays, 0.5);
  }

  section('PAYROLL BASIS');

  {
    const days = april2026();
    const calendar = calculate({
      segments: monthly(100000, days),
      config: config({ basis: 'CALENDAR_DAYS' }),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('calendar basis divides by the days in the period', calendar.basisDays, 30);
    check('which in April is the same as a fixed thirty', calendar.dailyRate, 3333.33);

    const working = calculate({
      segments: monthly(100000, days),
      config: config({ basis: 'WORKING_DAYS' }),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('working-day basis divides by scheduled days', working.basisDays, 22);
    // 100000 / 22 = 4545.4545...
    check('which is a materially different daily rate', working.dailyRate, 4545.45);

    const fixed26 = calculate({
      segments: monthly(100000, days),
      config: config({ fixedBasisDays: 26 }),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('a fixed 26-day basis is honoured', fixed26.basisDays, 26);
    // 100000 / 26 = 3846.1538...
    check('and changes the daily rate', fixed26.dailyRate, 3846.15);
    check('but not the basic figure', fixed26.basicAmount, 100000);
  }

  section('DAILY SALARY');

  {
    const days = april2026({
      '2026-04-06': { status: 'ABSENT' },
      '2026-04-07': { status: 'ABSENT' },
      '2026-04-08': { status: 'ON_LEAVE', leaveIsPaid: true, leaveDayPart: 'FULL_DAY' },
    });
    const result = calculate({
      segments: [{ salaryType: 'DAILY', amount: 2000, currency: 'PKR', days }],
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 30,
    });

    // 19 present + 1 paid leave = 20 paid days at 2000.
    check('daily pay is per day actually worked', result.basicAmount, 40000);
    check('and paid leave is paid', result.payableDays, 20);
    check('an absence is simply not paid, never deducted twice', result.deductionsTotal, 0);
    check('the daily rate is the salary itself', result.dailyRate, 2000);
  }

  section('HOURLY SALARY');

  {
    const days = [
      day('2026-04-01', 'PRESENT', { workedMinutes: 480 }),
      day('2026-04-02', 'PRESENT', { workedMinutes: 450 }),
      day('2026-04-03', 'ABSENT'),
    ];
    const result = calculate({
      segments: [{ salaryType: 'HOURLY', amount: 500, currency: 'PKR', days }],
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 3,
    });

    // (480 + 450) / 60 = 15.5 hours at 500.
    check('hourly pay follows worked minutes', result.basicAmount, 7750);
    check('the hourly rate is the salary itself', result.hourlyRate, 500);
    check('an unworked day costs nothing extra', result.deductionsTotal, 0);
  }

  section('OVERTIME');

  {
    // The example from the specification: 500/hr x 1.5 x 4 hours = 3000.
    const days = april2026({
      '2026-04-06': {
        status: 'PRESENT',
        overtimeMinutes: 240,
        overtimeApproved: true,
      },
    });
    const result = calculate({
      segments: [{ salaryType: 'HOURLY', amount: 500, currency: 'PKR', days }],
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 30,
    });

    check('approved overtime pays rate x multiplier x hours', result.overtimeAmount, 3000);
    const line = result.earnings.find((e) => e.code === 'OVERTIME');
    check('it appears as its own earning', line.units, 4);
    check('showing the rate it was paid at', line.rate, 750);
  }

  {
    const days = april2026({
      '2026-04-06': { status: 'PRESENT', overtimeMinutes: 240, overtimeApproved: false },
    });
    const withApproval = calculate({
      segments: [{ salaryType: 'HOURLY', amount: 500, currency: 'PKR', days }],
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('unapproved overtime is not paid', withApproval.overtimeAmount, 0);
    check('but it is still counted', withApproval.tally.overtimeMinutes, 240);
    check('and reported as unapproved', withApproval.tally.approvedOvertimeMinutes, 0);

    const withoutApproval = calculate({
      segments: [{ salaryType: 'HOURLY', amount: 500, currency: 'PKR', days }],
      config: config({ requireApprovedOvertime: false }),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('a company that does not require approval pays it', withoutApproval.overtimeAmount, 3000);
  }

  {
    const days = april2026({
      '2026-04-06': { status: 'PRESENT', overtimeMinutes: 120, overtimeApproved: true },
    });
    const flat = calculate({
      segments: monthly(100000, days),
      config: config({ overtimeMode: 'FIXED_RATE', overtimeFixedRate: 900 }),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('a flat overtime rate ignores the salary', flat.overtimeAmount, 1800);

    const none = calculate({
      segments: monthly(100000, days),
      config: config({ overtimeMode: 'NONE' }),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('overtime can be switched off entirely', none.overtimeAmount, 0);
    check('while the hours are still recorded', none.tally.overtimeMinutes, 120);
  }

  {
    // Monthly staff: hourly rate derived from the daily rate and standard hours.
    // 100000 / 30 / 8 = 416.666... x 1.5 x 2 = 1250.00
    const days = april2026({
      '2026-04-06': { status: 'PRESENT', overtimeMinutes: 120, overtimeApproved: true },
    });
    const result = calculate({
      segments: monthly(100000, days),
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('a monthly salary yields an hourly rate', result.hourlyRate, 416.67);
    check('and overtime is priced from it', result.overtimeAmount, 1250);

    const override = calculate({
      segments: monthly(100000, days),
      config: config({ hourlyRateOverride: 600 }),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('an explicit hourly rate overrides the derivation', override.overtimeAmount, 1800);
  }

  section('LATE AND EARLY LEAVING');

  {
    const days = april2026({
      '2026-04-06': { status: 'PRESENT', lateMinutes: 20 },
      '2026-04-07': { status: 'PRESENT', lateMinutes: 10 },
      '2026-04-08': { status: 'PRESENT', lateMinutes: 30 },
    });

    const perMinute = calculate({
      segments: monthly(100000, days),
      config: config({ lateDeductionMode: 'PER_MINUTE', lateDeductionRate: 50 }),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('three late days are three occurrences', perMinute.tally.lateOccurrences, 3);
    check('sixty late minutes in total', perMinute.tally.lateMinutes, 60);
    check('charged per minute', perMinute.deductionsTotal, 3000);

    const perOccurrence = calculate({
      segments: monthly(100000, days),
      config: config({ lateDeductionMode: 'PER_OCCURRENCE', lateDeductionRate: 500 }),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('or charged per occurrence', perOccurrence.deductionsTotal, 1500);

    const withGrace = calculate({
      segments: monthly(100000, days),
      config: config({
        lateDeductionMode: 'PER_MINUTE',
        lateDeductionRate: 50,
        lateGraceMinutes: 15,
      }),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    // 20 and 30 survive a 15-minute grace as 5 and 15; the 10 disappears.
    check('a payroll grace forgives the smallest', withGrace.tally.lateOccurrences, 2);
    check('and shortens the rest', withGrace.tally.lateMinutes, 20);
    check('charging only what is left', withGrace.deductionsTotal, 1000);

    const off = calculate({
      segments: monthly(100000, days),
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('lateness costs nothing by default', off.deductionsTotal, 0);
  }

  {
    const days = april2026({
      '2026-04-06': { status: 'PRESENT', earlyLeaveMinutes: 45 },
      '2026-04-07': { status: 'PRESENT', earlyLeaveMinutes: 15 },
    });
    const result = calculate({
      segments: monthly(100000, days),
      config: config({
        earlyLeaveDeductionMode: 'PER_OCCURRENCE',
        earlyLeaveDeductionRate: 250,
      }),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    check('early leaving is counted', result.tally.earlyLeaveOccurrences, 2);
    check('and charged', result.deductionsTotal, 500);
    check('as its own line', result.deductions[0].code, 'EARLY_LEAVE');
  }

  section('ALLOWANCES, BONUSES AND COMPONENT DEDUCTIONS');

  {
    const result = calculate({
      segments: monthly(100000, april2026()),
      config: config(),
      components: [
        {
          componentId: 'c1',
          code: 'TRANSPORT',
          label: 'Transport allowance',
          kind: 'EARNING',
          calc: 'FIXED',
          value: 5000,
          isTaxable: true,
        },
        {
          componentId: 'c2',
          code: 'HOUSING',
          label: 'Housing allowance',
          kind: 'EARNING',
          calc: 'PERCENT_OF_BASIC',
          value: 10,
          isTaxable: true,
        },
        {
          componentId: 'c3',
          code: 'BONUS',
          label: 'Performance bonus',
          kind: 'EARNING',
          calc: 'FIXED',
          value: 25000,
          isTaxable: true,
        },
        {
          componentId: 'c4',
          code: 'LOAN',
          label: 'Loan repayment',
          kind: 'DEDUCTION',
          calc: 'FIXED',
          value: 8000,
          isTaxable: false,
        },
      ],
      adjustments: [],
      periodDays: 30,
    });

    // 100000 basic + 5000 transport + 10000 housing + 25000 bonus = 140000
    check('a fixed allowance is added', result.earningsTotal, 140000);
    check('gross is the earnings total', result.grossAmount, 140000);
    check('a fixed deduction is subtracted', result.deductionsTotal, 8000);
    check('net is gross less deductions', result.netAmount, 132000);
    check('the percentage is read against basic', result.earnings[2].amount, 10000);
  }

  {
    // Percent-of-gross is read against everything above it: 100000 + 5000.
    const result = calculate({
      segments: monthly(100000, april2026()),
      config: config(),
      components: [
        {
          componentId: 'c1',
          code: 'TRANSPORT',
          label: 'Transport',
          kind: 'EARNING',
          calc: 'FIXED',
          value: 5000,
          isTaxable: true,
        },
        {
          componentId: 'c2',
          code: 'SHARE',
          label: 'Profit share',
          kind: 'EARNING',
          calc: 'PERCENT_OF_GROSS',
          value: 5,
          isTaxable: true,
        },
      ],
      adjustments: [],
      periodDays: 30,
    });
    check('percent-of-gross reads the total above it', result.earnings[2].amount, 5250);
    check('and the gross includes it', result.grossAmount, 110250);
  }

  section('SALARY CHANGE DURING A PERIOD');

  {
    // The specification's example: 100000 to June, 120000 from July. July pays
    // the new figure and nothing prorates, because one salary covers the month.
    const july = [];
    for (let d = 1; d <= 31; d += 1) {
      july.push(day(`2026-07-${String(d).padStart(2, '0')}`, 'PRESENT'));
    }
    const rows = [
      {
        id: 'old',
        salaryType: 'MONTHLY',
        amount: 100000,
        currency: 'PKR',
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: new Date('2026-06-30'),
      },
      {
        id: 'new',
        salaryType: 'MONTHLY',
        amount: 120000,
        currency: 'PKR',
        effectiveFrom: new Date('2026-07-01'),
        effectiveTo: null,
      },
    ];

    check('June resolves to the old salary', salaryOn(rows, '2026-06-15').amount, 100000);
    check('July resolves to the new one', salaryOn(rows, '2026-07-01').amount, 120000);
    check('and so does August', salaryOn(rows, '2026-08-20').amount, 120000);

    const { segments, uncovered } = segmentBySalary(july, rows);
    check('July is one segment', segments.length, 1);
    check('with nothing uncovered', uncovered.length, 0);

    const result = calculate({
      segments,
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 31,
    });
    check('July pays the new salary', result.basicAmount, 120000);
  }

  {
    // A raise halfway through April: 15 days at each figure.
    const rows = [
      {
        id: 'old',
        salaryType: 'MONTHLY',
        amount: 100000,
        currency: 'PKR',
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: new Date('2026-04-15'),
      },
      {
        id: 'new',
        salaryType: 'MONTHLY',
        amount: 120000,
        currency: 'PKR',
        effectiveFrom: new Date('2026-04-16'),
        effectiveTo: null,
      },
    ];
    const { segments } = segmentBySalary(april2026(), rows);
    check('the period splits in two', segments.length, 2);
    check('fifteen days on the old salary', segments[0].days.length, 15);
    check('fifteen on the new', segments[1].days.length, 15);

    const result = calculate({
      segments,
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    // 100000 x 15/30 + 120000 x 15/30 = 50000 + 60000
    check('basic is prorated across both', result.basicAmount, 110000);
    check('and the line records that it was split', segments.length, 2);
  }

  {
    const rows = [
      {
        id: 'a',
        salaryType: 'MONTHLY',
        amount: 100000,
        currency: 'PKR',
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: null,
      },
      {
        id: 'b',
        salaryType: 'MONTHLY',
        amount: 120000,
        currency: 'PKR',
        effectiveFrom: new Date('2026-04-01'),
        effectiveTo: null,
      },
    ];
    check('two open-ended salaries are an overlap', overlappingSalaries(rows).length, 1);

    const clean = [
      { ...rows[0], effectiveTo: new Date('2026-03-31') },
      rows[1],
    ];
    check('closing the first resolves it', overlappingSalaries(clean).length, 0);
  }

  {
    // A period starting before any salary exists must not be guessed at.
    const rows = [
      {
        id: 'a',
        salaryType: 'MONTHLY',
        amount: 100000,
        currency: 'PKR',
        effectiveFrom: new Date('2026-04-10'),
        effectiveTo: null,
      },
    ];
    const { segments, uncovered } = segmentBySalary(april2026(), rows);
    check('days before the salary begins are uncovered', uncovered.length, 9);
    check('and the rest still segment', segments[0].days.length, 21);
  }

  section('ADJUSTMENTS');

  {
    const result = calculate({
      segments: monthly(100000, april2026()),
      config: config(),
      components: [],
      adjustments: [
        { id: 'a1', kind: 'EARNING', label: 'Underpaid March', amount: 4000 },
        { id: 'a2', kind: 'DEDUCTION', label: 'Overpaid February', amount: 1500 },
      ],
      periodDays: 30,
    });

    check('an earning adjustment is added', result.earningsTotal, 104000);
    check('a deduction adjustment is subtracted', result.deductionsTotal, 1500);
    check('the net reflects both', result.netAmount, 102500);
    check('and the signed total is recorded', result.adjustmentTotal, 2500);
  }

  section('OVERNIGHT SHIFTS');

  {
    check('an ordinary shift is its span less the break', shiftLengthMinutes('09:00', '18:00', 60), 480);
    check('a shift crossing midnight does not go negative', shiftLengthMinutes('22:00', '06:00', 60), 420);
    check('exactly eight hours overnight', shiftLengthMinutes('22:00', '06:00', 0), 480);
    check('a same-hour shift wraps a full day', shiftLengthMinutes('08:00', '08:00', 0), 1440);
    check('an unreadable time falls back to eight hours', shiftLengthMinutes('nonsense', '18:00', 0), 480);
    check('a break longer than the shift cannot go below zero', shiftLengthMinutes('09:00', '10:00', 300), 0);
  }

  {
    // An overnight worker: the attendance engine already assigned the punches
    // to one day, so payroll sees one day with a night's work on it.
    const days = [
      day('2026-04-01', 'PRESENT', { workedMinutes: 420, scheduledMinutes: 420 }),
      day('2026-04-02', 'PRESENT', { workedMinutes: 420, scheduledMinutes: 420 }),
    ];
    const result = calculate({
      segments: [{ salaryType: 'HOURLY', amount: 400, currency: 'PKR', days }],
      config: config(),
      components: [],
      adjustments: [],
      periodDays: 2,
    });
    // 840 minutes = 14 hours at 400.
    check('an overnight shift pays its hours', result.basicAmount, 5600);
    check('and counts as two scheduled days', result.tally.scheduledDays, 2);
  }

  section('EXCEPTIONS THE FIGURES REVEAL');

  {
    const days = [
      day('2026-04-01', 'PRESENT', { hasShift: false }),
      day('2026-04-02', 'PRESENT', { workedMinutes: null }),
    ];
    const tally = tallyDays(days, config());
    check('a day with no shift is counted', tally.daysWithoutShift, 1);
    check('a day checked in but never out is counted', tally.incompleteDays, 1);
  }

  {
    // Deductions larger than the pay: the figure is produced, and the run is
    // the thing that refuses to finalize on it.
    const result = calculate({
      segments: monthly(10000, april2026()),
      config: config(),
      components: [
        {
          componentId: 'c1',
          code: 'LOAN',
          label: 'Loan',
          kind: 'DEDUCTION',
          calc: 'FIXED',
          value: 15000,
          isTaxable: false,
        },
      ],
      adjustments: [],
      periodDays: 30,
    });
    check('a negative net is calculated, not hidden', result.netAmount, -5000);
  }

  section('DETERMINISM');

  {
    const inputs = {
      segments: monthly(
        100000,
        april2026({ '2026-04-06': { status: 'ABSENT' }, '2026-04-08': { status: 'HALF_DAY' } }),
      ),
      config: config({ lateDeductionMode: 'PER_MINUTE', lateDeductionRate: 12.5 }),
      components: [
        {
          componentId: 'c1',
          code: 'H',
          label: 'Housing',
          kind: 'EARNING',
          calc: 'PERCENT_OF_BASIC',
          value: 12.5,
          isTaxable: true,
        },
      ],
      adjustments: [],
      periodDays: 30,
    };
    const first = calculate(inputs);
    const second = calculate(inputs);
    check('the same facts produce the same money', first.netAmount, second.netAmount);
    check('down to every line', JSON.stringify(first.deductions), JSON.stringify(second.deductions));
  }
} catch (error) {
  fail += 1;
  console.error('\nSUITE ABORTED:', error);
}

console.log('\n################ SUMMARY ################');
console.log(`PASS=${pass}  FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
