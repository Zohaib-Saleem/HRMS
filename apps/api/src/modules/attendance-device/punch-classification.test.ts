import { describe, expect, it } from 'vitest';
import { clockBoundary } from '../../core/zoned-time.js';
import {
  checkOutBoundaryOn,
  computeAttendance,
  type AttendancePolicy,
  type ShiftWindow,
} from '../time/attendance-policy.js';
import { pairPunches, resolvePunchRoles } from './attendance-import.service.js';

/**
 * A terminal left in the wrong punch mode, and the day underneath it.
 *
 * The K50 on site has had its punch mode nudged into OverTime In or OverTime
 * Out more than once. Every transaction it records while that is true carries
 * that label, an ordinary six-o'clock departure included - so a day of one
 * arrival and one departure reaches the HRMS as two punches both labelled as
 * arrivals, and the departure disappears into "check out: missing".
 *
 * What follows are the shapes that reach the engine, read under BOTH pairing
 * strategies, because the fix must be the same answer either way and because
 * the strategy is a per-device setting somebody can change by accident just as
 * easily as the punch mode.
 *
 * Two properties are load-bearing and both are asserted repeatedly below:
 *
 *   - An overtime label is NOT a claim about overtime. It is resolved to an
 *     arrival or a departure by where it falls in the day, and whether the day
 *     earned overtime stays the policy's decision from the hours worked.
 *   - Nothing is fabricated. A day with one punch still has no departure, and
 *     the raw punch is never edited - `punchState` goes in and comes out as
 *     whatever the device said.
 */

const DAY = '2026-09-10'; // a Thursday
const ZONE = 'Asia/Karachi';

const at = (hhmm: string, day: string = DAY): Date => {
  const instant = clockBoundary(day, hhmm, ZONE);
  if (!instant) throw new Error(`bad time ${hhmm}`);
  return instant;
};

/** One transaction as the device reported it. */
const punch = (hhmm: string, punchState: string | null, seconds = 0) => ({
  punchedAt: new Date(at(hhmm).getTime() + seconds * 1000),
  punchState,
});

/** Both strategies, so a case states one expected answer rather than two. */
const BOTH = ['DEVICE_STATE', 'FIRST_IN_LAST_OUT'] as const;

const pairedUnder = (
  strategy: (typeof BOTH)[number],
  punches: ReturnType<typeof punch>[],
  duplicateWindowSeconds = 0,
) => pairPunches(punches, strategy, duplicateWindowSeconds);

/** `HH:mm` of a paired time, or null - shorter to read than a Date in a diff. */
const clock = (date: Date | null): string | null =>
  date === null
    ? null
    : new Intl.DateTimeFormat('en-GB', {
        timeZone: ZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);

describe('a punch labelled by the terminal mode is read from where it falls', () => {
  it('1. C/In then C/Out: the ordinary day, unchanged', () => {
    for (const strategy of BOTH) {
      const day = pairedUnder(strategy, [punch('09:00', 'IN'), punch('18:00', 'OUT')]);
      expect([strategy, clock(day.checkInAt), clock(day.checkOutAt)]).toEqual([
        strategy,
        '09:00',
        '18:00',
      ]);
    }
  });

  it('2. C/In then OverTime Out: the evening punch is the departure', () => {
    for (const strategy of BOTH) {
      const day = pairedUnder(strategy, [punch('09:01', 'IN'), punch('18:33', 'OVERTIME_OUT')]);
      expect([strategy, clock(day.checkInAt), clock(day.checkOutAt)]).toEqual([
        strategy,
        '09:01',
        '18:33',
      ]);
    }
  });

  it('3. C/In then OverTime In: still a departure, not a second arrival', () => {
    // The shape that produced the report. Read literally this is two arrivals
    // and no departure, which is exactly how the day went missing.
    for (const strategy of BOTH) {
      const day = pairedUnder(strategy, [punch('09:01', 'IN'), punch('18:23', 'OVERTIME_IN')]);
      expect([strategy, clock(day.checkInAt), clock(day.checkOutAt)]).toEqual([
        strategy,
        '09:01',
        '18:23',
      ]);
    }
  });

  it('4. OverTime In then OverTime Out: a whole day recorded in the wrong mode', () => {
    for (const strategy of BOTH) {
      const day = pairedUnder(strategy, [
        punch('09:00', 'OVERTIME_IN'),
        punch('18:20', 'OVERTIME_OUT'),
      ]);
      expect([strategy, clock(day.checkInAt), clock(day.checkOutAt)]).toEqual([
        strategy,
        '09:00',
        '18:20',
      ]);
    }
  });

  it('5. C/In alone: an arrival, and no departure invented for it', () => {
    for (const strategy of BOTH) {
      const day = pairedUnder(strategy, [punch('09:00', 'IN')]);
      expect([strategy, clock(day.checkInAt), day.checkOutAt]).toEqual([strategy, '09:00', null]);
    }
  });

  it('6. OverTime In alone: the same - one punch is an arrival, nothing more', () => {
    for (const strategy of BOTH) {
      const day = pairedUnder(strategy, [punch('09:00', 'OVERTIME_IN')]);
      expect([strategy, clock(day.checkInAt), day.checkOutAt]).toEqual([strategy, '09:00', null]);
    }
  });

  it('7. a day of many punches: first arrival, last departure', () => {
    for (const strategy of BOTH) {
      const day = pairedUnder(strategy, [
        punch('09:00', 'IN'),
        punch('13:00', 'OUT'),
        punch('14:00', 'IN'),
        punch('18:30', 'OVERTIME_IN'),
      ]);
      expect([strategy, clock(day.checkInAt), clock(day.checkOutAt)]).toEqual([
        strategy,
        '09:00',
        '18:30',
      ]);
    }
  });

  it('8. morning C/In with an evening OverTime In is never "missing check-out"', () => {
    for (const strategy of BOTH) {
      const day = pairedUnder(strategy, [punch('08:57', 'IN'), punch('18:23', 'OVERTIME_IN')]);
      expect(day.checkOutAt).not.toBeNull();
      expect(clock(day.checkOutAt)).toBe('18:23');
    }
  });

  it('9. morning C/In with an evening OverTime Out is never "missing check-out"', () => {
    for (const strategy of BOTH) {
      const day = pairedUnder(strategy, [punch('08:57', 'IN'), punch('18:23', 'OVERTIME_OUT')]);
      expect(day.checkOutAt).not.toBeNull();
      expect(clock(day.checkOutAt)).toBe('18:23');
    }
  });

  it('10. a genuinely missing check-out stays missing', () => {
    // Nobody punched again. Manufacturing a departure here would invent worked
    // hours, which is a worse answer than an open day somebody can correct.
    for (const strategy of BOTH) {
      const day = pairedUnder(strategy, [punch('09:00', 'OVERTIME_IN')]);
      expect(day.checkOutAt).toBeNull();
    }
  });

  it('11. duplicates collapse before anything is read as a direction', () => {
    // One arrival reported three times in half a minute, then a real departure
    // in the wrong mode. Two events, not four.
    for (const strategy of BOTH) {
      const day = pairedUnder(
        strategy,
        [
          punch('09:00', 'OVERTIME_IN'),
          punch('09:00', 'OVERTIME_IN', 12),
          punch('09:00', 'OVERTIME_IN', 27),
          punch('18:40', 'OVERTIME_IN'),
        ],
        60,
      );
      expect([strategy, clock(day.checkInAt), clock(day.checkOutAt)]).toEqual([
        strategy,
        '09:00',
        '18:40',
      ]);
    }
  });

  it('a morning of duplicates in overtime mode does not become a worked day', () => {
    for (const strategy of BOTH) {
      const day = pairedUnder(
        strategy,
        [punch('09:00', 'OVERTIME_IN'), punch('09:00', 'OVERTIME_IN', 20)],
        60,
      );
      expect([strategy, clock(day.checkInAt), day.checkOutAt]).toEqual([strategy, '09:00', null]);
    }
  });

  it('an overtime punch does not open a second interval of its own', () => {
    // Four punches, one pair. A day has one arrival and one departure however
    // many times the terminal was touched in between.
    const day = pairedUnder('DEVICE_STATE', [
      punch('09:00', 'IN'),
      punch('13:00', 'OVERTIME_IN'),
      punch('14:00', 'OVERTIME_OUT'),
      punch('18:30', 'OVERTIME_IN'),
    ]);
    expect([clock(day.checkInAt), clock(day.checkOutAt)]).toEqual(['09:00', '18:30']);
  });
});

describe('what the device said is not edited, only read', () => {
  it('every punch comes back, with its own state untouched', () => {
    const punches = [
      punch('09:01', 'OVERTIME_IN'),
      punch('13:00', 'OUT'),
      punch('18:33', 'OVERTIME_OUT'),
    ];
    const before = punches.map((p) => ({ ...p }));

    const read = resolvePunchRoles(punches);

    expect(read).toHaveLength(punches.length);
    expect(read.map((r) => r.punch.punchState)).toEqual([
      'OVERTIME_IN',
      'OUT',
      'OVERTIME_OUT',
    ]);
    // The inputs themselves are the raw rows; nothing may have been mutated.
    expect(punches).toEqual(before);
  });

  it('says which roles were stated by the device and which were inferred', () => {
    const read = resolvePunchRoles([
      punch('09:01', 'IN'),
      punch('18:23', 'OVERTIME_IN'),
    ]);

    expect(read.map((r) => [r.punch.punchState, r.role, r.inferred])).toEqual([
      ['IN', 'IN', false],
      ['OVERTIME_IN', 'OUT', true],
    ]);
  });

  it('the first punch of a day in overtime mode is read as the arrival', () => {
    const read = resolvePunchRoles([
      punch('09:00', 'OVERTIME_OUT'),
      punch('18:20', 'OVERTIME_OUT'),
    ]);

    expect(read.map((r) => [r.role, r.inferred])).toEqual([
      ['IN', true],
      ['OUT', true],
    ]);
  });

  it('a state with no reading is kept, and not guessed at', () => {
    // Breaks, and spellings from a terminal nobody has met yet. Under
    // DEVICE_STATE they took part in no pairing before and still do not.
    const read = resolvePunchRoles([
      punch('09:00', 'IN'),
      punch('13:00', 'BREAK_OUT'),
      punch('13:30', 'BREAK_IN'),
      punch('18:00', 'OUT'),
    ]);

    expect(read.map((r) => r.role)).toEqual(['IN', null, null, 'OUT']);
    expect(read.map((r) => r.punch.punchState)).toEqual(['IN', 'BREAK_OUT', 'BREAK_IN', 'OUT']);
  });
});

describe('the punches that were there before still pair as they did', () => {
  it('a day with no direction at all is unchanged under FIRST_IN_LAST_OUT', () => {
    const day = pairedUnder('FIRST_IN_LAST_OUT', [punch('09:00', null), punch('18:00', null)]);
    expect([clock(day.checkInAt), clock(day.checkOutAt)]).toEqual(['09:00', '18:00']);
  });

  it('a day with no direction at all yields nothing under DEVICE_STATE', () => {
    // A device told to report direction, reporting none, is a configuration
    // problem. It surfaced as an unresolved day before and still does.
    const day = pairedUnder('DEVICE_STATE', [punch('09:00', null), punch('18:00', null)]);
    expect([day.checkInAt, day.checkOutAt]).toEqual([null, null]);
  });

  it('a lone C/Out is still not an arrival', () => {
    const day = pairedUnder('DEVICE_STATE', [punch('18:00', 'OUT')]);
    expect([day.checkInAt, clock(day.checkOutAt)]).toEqual([null, '18:00']);
  });

  it('no punches at all is no day', () => {
    for (const strategy of BOTH) {
      const day = pairedUnder(strategy, []);
      expect([strategy, day.checkInAt, day.checkOutAt]).toEqual([strategy, null, null]);
    }
  });
});

// --------------------------------------------- the label is not the overtime

/**
 * The company's own rules, deliberately not round numbers, so an answer that
 * came from a hardcoded 480 or 18:00 shows up as wrong rather than as lucky.
 */
const POLICY: AttendancePolicy = {
  timeZone: ZONE,
  weekendDays: ['SATURDAY', 'SUNDAY'],
  graceMinutes: 10,
  halfDayMinutes: 240,
  fullDayMinutes: 480,
  earlyLeaveGraceMinutes: 10,
  overtimeEnabled: true,
  overtimeAfterMinutes: 480,
  overtimeDailyCapMinutes: 240,
  locationRestrictionEnabled: false,
  defaultGeofenceRadiusM: 200,
  ipRestrictionEnabled: false,
  allowedCheckInCidrs: [],
  defaultShiftStart: '09:00',
  defaultShiftEnd: '18:00',
  overtimeFromShiftEnd: true,
  overtimeCountsEarlyArrival: false,
  overtimeReducedByLateArrival: false,
  lateTrackingEnabled: true,
  earlyDepartureTrackingEnabled: true,
  fullDayToleranceMinutes: 30,
  irregularCheckInEnabled: true,
  irregularCheckInCutoff: '11:00',
  breakIncludedInWindow: true,
  overtimeMinimumMinutes: 0,
  overtimeRoundingMinutes: 0,
  overtimeWeeklyCapMinutes: null,
  overtimeMonthlyCapMinutes: null,
  missingCheckOutStatus: 'PRESENT',
  missingCheckInStatus: 'ABSENT',
  irregularCheckInMode: 'ABSOLUTE_TIME',
  irregularAfterShiftStartMinutes: 120,
  defaultBreakMinutes: 0,
  lateThresholdMinutes: 0,
  earlyLeaveThresholdMinutes: 0,
  weekendWorkRule: 'AS_WORKING_DAY',
  holidayWorkRule: 'AS_WORKING_DAY',
  duplicatePunchWindowSeconds: 60,
  maxPlausibleSpanMinutes: 960,
  allowImplausibleSpans: false,
  overnightCheckOutWindowMinutes: 1080,
  overnightCheckOutCutoff: '06:00',
};

/**
 * A day as the import path builds it: resolve the boundary from the shift and
 * the policy, pair the punches against it, then score them. Deliberately the
 * same three steps in the same order as `recalculateFromPunches`, so a test
 * here cannot pass through a path production does not take.
 */
const dayFrom = (
  punches: ReturnType<typeof punch>[],
  strategy: (typeof BOTH)[number] = 'DEVICE_STATE',
  policy: AttendancePolicy = POLICY,
  shift: ShiftWindow | null = null,
) => {
  const paired = pairPunches(
    punches,
    strategy,
    policy.duplicatePunchWindowSeconds,
    checkOutBoundaryOn({ shift, policy, dayKey: DAY }),
  );
  return {
    paired,
    computed: computeAttendance({
      day: DAY,
      checkInAt: paired.checkInAt,
      checkOutAt: paired.checkOutAt,
      shift,
      policy,
    }),
  };
};

describe('an overtime label decides nothing about overtime', () => {
  it('12. the ordinary day still scores exactly as it did', () => {
    const { computed } = dayFrom([punch('09:00', 'IN'), punch('18:00', 'OUT')]);

    expect(computed.status).toBe('PRESENT');
    expect(computed.workedMinutes).toBe(540);
    // Nine hours against an eight-hour threshold, from the shift's end.
    expect(computed.overtimeMinutes).toBe(0);
  });

  it('13. the same day punched in overtime mode scores identically', () => {
    const ordinary = dayFrom([punch('09:00', 'IN'), punch('18:00', 'OUT')]).computed;
    const mislabelled = dayFrom([
      punch('09:00', 'OVERTIME_IN'),
      punch('18:00', 'OVERTIME_OUT'),
    ]).computed;

    expect(mislabelled).toEqual(ordinary);
  });

  it('the policy decides the fifteen minutes, not the device', () => {
    // 09:00 to 18:15 with an OverTime In on the end: a quarter of an hour past
    // the shift, and it is the policy's overtimeFromShiftEnd that says so.
    const { paired, computed } = dayFrom([
      punch('09:00', 'IN'),
      punch('18:15', 'OVERTIME_IN'),
    ]);

    expect(clock(paired.checkOutAt)).toBe('18:15');
    expect(computed.overtimeMinutes).toBe(15);
  });

  it('the same punches earn no overtime when the company does not grant it', () => {
    const { computed } = dayFrom(
      [punch('09:00', 'IN'), punch('18:15', 'OVERTIME_IN')],
      'DEVICE_STATE',
      { ...POLICY, overtimeEnabled: false },
    );

    expect(computed.overtimeMinutes).toBe(0);
  });

  it('a day that was open now closes, and stops being scored as one', () => {
    // Before: the evening punch read as a second arrival, so the day had no
    // departure and fell to the missing-check-out rule. After: a worked day.
    const open = computeAttendance({
      day: DAY,
      checkInAt: at('09:01'),
      checkOutAt: null,
      shift: null,
      policy: POLICY,
    });
    const { computed } = dayFrom([punch('09:01', 'IN'), punch('18:33', 'OVERTIME_IN')]);

    expect(open.integrity).toBe('OPEN');
    expect(computed.integrity).toBe('COMPLETE');
    expect(computed.workedMinutes).toBe(572);
  });
});

// ------------------------------------------- the days that prompted the report

describe('the shapes recorded on site', () => {
  /**
   * Two evenings the terminal spent in an overtime mode. Read literally, the
   * first is an arrival with no departure and the second is two arrivals; read
   * from the day, both are a normal working day with the overtime the policy
   * grants and nothing more.
   */
  const recorded: Array<[string, ReturnType<typeof punch>[], string, string]> = [
    [
      '10 September, 09:01 and 18:33, both in overtime mode',
      [punch('09:01', 'OVERTIME_IN'), punch('18:33', 'OVERTIME_OUT')],
      '09:01',
      '18:33',
    ],
    [
      '11 September, 08:57 in and 18:23 out, both in overtime mode',
      [punch('08:57', 'OVERTIME_IN'), punch('18:23', 'OVERTIME_OUT')],
      '08:57',
      '18:23',
    ],
    [
      '11 September, an ordinary arrival and an OverTime In at the end of it',
      [punch('08:57', 'IN'), punch('18:23', 'OVERTIME_IN')],
      '08:57',
      '18:23',
    ],
  ];

  for (const [label, punches, expectedIn, expectedOut] of recorded) {
    it(label, () => {
      for (const strategy of BOTH) {
        const { paired, computed } = dayFrom(punches, strategy);
        expect([strategy, clock(paired.checkInAt), clock(paired.checkOutAt)]).toEqual([
          strategy,
          expectedIn,
          expectedOut,
        ]);
        expect(computed.status).toBe('PRESENT');
      }
    });
  }
});

// ------------------------------------- the boundary is the employee's own day

/**
 * The rule this file exists for, stated once: a mode label plus a time.
 *
 * `OverTime In` and `OverTime Out` are read as a departure when, and only when,
 * the punch falls at or after the scheduled end of that employee's day. Before
 * it the label is not evidence of direction, because the terminal's mode says
 * nothing about which way somebody walked through the door.
 *
 * Every boundary below comes from `checkOutBoundaryOn`, which reads the
 * employee's shift assignment and falls back to the company's default window.
 * No time of day is asserted here that was not configured somewhere above.
 */
const GENERAL: ShiftWindow = { startTime: '09:00', endTime: '18:00' };
const LATE_SHIFT: ShiftWindow = { startTime: '10:00', endTime: '19:00' };
const OVERNIGHT: ShiftWindow = { startTime: '20:00', endTime: '05:00' };

const boundaryFor = (shift: ShiftWindow | null, policy: AttendancePolicy = POLICY) =>
  checkOutBoundaryOn({ shift, policy, dayKey: DAY });

describe('an overtime label after the scheduled end is a departure', () => {
  it('1. C/In and C/Out: the ordinary day is untouched by the rule', () => {
    for (const strategy of BOTH) {
      const { paired } = dayFrom([punch('09:00', 'IN'), punch('18:00', 'OUT')], strategy);
      expect([strategy, clock(paired.checkInAt), clock(paired.checkOutAt)]).toEqual([
        strategy,
        '09:00',
        '18:00',
      ]);
    }
  });

  it('2. C/In then OverTime In after the shift end: 18:16 is the departure', () => {
    for (const strategy of BOTH) {
      const { paired } = dayFrom([punch('09:05', 'IN'), punch('18:16', 'OVERTIME_IN')], strategy);
      expect([strategy, clock(paired.checkInAt), clock(paired.checkOutAt)]).toEqual([
        strategy,
        '09:05',
        '18:16',
      ]);
    }
  });

  it('3. C/In then OverTime Out after the shift end: 18:23 is the departure', () => {
    for (const strategy of BOTH) {
      const { paired } = dayFrom([punch('09:05', 'IN'), punch('18:23', 'OVERTIME_OUT')], strategy);
      expect([strategy, clock(paired.checkInAt), clock(paired.checkOutAt)]).toEqual([
        strategy,
        '09:05',
        '18:23',
      ]);
    }
  });

  it('4. a whole day in overtime mode: arrival in the morning, departure at 18:16', () => {
    for (const strategy of BOTH) {
      const { paired } = dayFrom(
        [punch('09:05', 'OVERTIME_IN'), punch('18:16', 'OVERTIME_OUT')],
        strategy,
      );
      expect([strategy, clock(paired.checkInAt), clock(paired.checkOutAt)]).toEqual([
        strategy,
        '09:05',
        '18:16',
      ]);
    }
  });

  it('5. a morning overtime label never becomes a departure', () => {
    // The failure this guards against is the opposite of the original bug and
    // considerably worse: a day closed at breakfast, with the hours to match.
    const cases: Array<[string, ReturnType<typeof punch>[]]> = [
      ['08:57, before anyone has arrived', [punch('08:57', 'OVERTIME_IN')]],
      ['09:10, ten minutes after the arrival', [punch('09:00', 'IN'), punch('09:10', 'OVERTIME_IN')]],
      ['10:00, an hour into the day', [punch('09:00', 'IN'), punch('10:00', 'OVERTIME_IN')]],
      ['17:59, one minute short of the end', [punch('09:00', 'IN'), punch('17:59', 'OVERTIME_OUT')]],
    ];

    for (const [label, punches] of cases) {
      const { paired } = dayFrom(punches, 'DEVICE_STATE');
      expect([label, paired.checkOutAt]).toEqual([label, null]);
      // The arrival is still there - nothing was discarded to achieve this.
      expect(paired.checkInAt).not.toBeNull();
    }
  });

  it('5b. the morning punch stays available as the arrival', () => {
    const { paired } = dayFrom([punch('08:57', 'OVERTIME_IN')], 'DEVICE_STATE');
    expect(clock(paired.checkInAt)).toBe('08:57');
  });

  it('5c. the first punch of a day is the arrival even when it is late', () => {
    // A lone evening punch in overtime mode. Reading it as a departure would
    // leave the day with no arrival, and `recalculateFromPunches` writes no
    // record at all for a day with no arrival - so the day would disappear
    // rather than surface as one needing a correction.
    for (const state of ['OVERTIME_IN', 'OVERTIME_OUT']) {
      const { paired } = dayFrom([punch('18:33', state)], 'DEVICE_STATE');
      expect([state, clock(paired.checkInAt), paired.checkOutAt]).toEqual([state, '18:33', null]);
    }
  });

  it('5d. an evening arrival followed by a later overtime label still closes', () => {
    const { paired } = dayFrom(
      [punch('18:10', 'OVERTIME_IN'), punch('20:30', 'OVERTIME_OUT')],
      'DEVICE_STATE',
    );
    expect([clock(paired.checkInAt), clock(paired.checkOutAt)]).toEqual(['18:10', '20:30']);
  });

  it('6. a genuinely single punch still has no departure', () => {
    for (const strategy of BOTH) {
      for (const state of ['IN', 'OVERTIME_IN', 'OVERTIME_OUT']) {
        const { paired } = dayFrom([punch('09:05', state)], strategy);
        expect([strategy, state, paired.checkOutAt]).toEqual([strategy, state, null]);
      }
    }
  });

  it('7. many punches, one pair: the evening overtime label closes the day', () => {
    for (const strategy of BOTH) {
      const { paired } = dayFrom(
        [
          punch('09:00', 'IN'),
          punch('13:00', 'OUT'),
          punch('14:00', 'IN'),
          punch('18:20', 'OVERTIME_IN'),
        ],
        strategy,
      );
      expect([strategy, clock(paired.checkInAt), clock(paired.checkOutAt)]).toEqual([
        strategy,
        '09:00',
        '18:20',
      ]);
    }
  });

  it('8. the boundary is the employee\'s shift, not a time in this file', () => {
    const evening = [punch('10:00', 'IN'), punch('18:30', 'OVERTIME_IN')];

    // 18:30 is past a 09:00-18:00 day, so it is a departure.
    expect(clock(dayFrom(evening, 'DEVICE_STATE', POLICY, GENERAL).paired.checkOutAt)).toBe('18:30');

    // The same punch, for somebody rostered until 19:00, is not.
    expect(dayFrom(evening, 'DEVICE_STATE', POLICY, LATE_SHIFT).paired.checkOutAt).toBeNull();

    // Past *their* end, it is.
    const later = [punch('10:00', 'IN'), punch('19:10', 'OVERTIME_IN')];
    expect(clock(dayFrom(later, 'DEVICE_STATE', POLICY, LATE_SHIFT).paired.checkOutAt)).toBe('19:10');
  });

  it('8b. with no shift assigned the company default window decides', () => {
    expect(boundaryFor(null)).toEqual(boundaryFor(GENERAL));
    // And a company that works to a different default moves the boundary.
    const nineToFive = { ...POLICY, defaultShiftEnd: '17:00' };
    const { paired } = dayFrom(
      [punch('09:00', 'IN'), punch('17:30', 'OVERTIME_IN')],
      'DEVICE_STATE',
      nineToFive,
    );
    expect(clock(paired.checkOutAt)).toBe('17:30');
    // Under the 18:00 default the very same punch is still inside the day.
    expect(dayFrom([punch('09:00', 'IN'), punch('17:30', 'OVERTIME_IN')], 'DEVICE_STATE').paired
      .checkOutAt).toBeNull();
  });
});

describe('the rule changes nothing the policy decides', () => {
  it('9. overtime is still the policy\'s answer, from the hours worked', () => {
    // The same instants, once stated and once in overtime mode. If the label
    // leaked into the figures these two would differ.
    const stated = dayFrom([punch('09:00', 'IN'), punch('18:45', 'OUT')]).computed;
    const mislabelled = dayFrom([punch('09:00', 'OVERTIME_IN'), punch('18:45', 'OVERTIME_OUT')])
      .computed;
    expect(mislabelled).toEqual(stated);
    expect(mislabelled.overtimeMinutes).toBe(45);
  });

  it('9b. a company that grants no overtime still grants none', () => {
    const { computed } = dayFrom(
      [punch('09:00', 'IN'), punch('18:45', 'OVERTIME_IN')],
      'DEVICE_STATE',
      { ...POLICY, overtimeEnabled: false },
    );
    expect(computed.overtimeMinutes).toBe(0);
    // Being read as a departure is not the same as being paid for it.
    expect(computed.status).toBe('PRESENT');
  });

  it('9c. lateness, the day\'s worth and the early-leave figure are unaffected', () => {
    const stated = dayFrom([punch('09:40', 'IN'), punch('17:30', 'OUT')]).computed;
    const mislabelled = dayFrom([punch('09:40', 'OVERTIME_IN'), punch('17:30', 'OUT')]).computed;
    expect(mislabelled).toEqual(stated);
    expect(stated.lateMinutes).toBe(40);
  });

  it('12. a day of stated directions reads the same with or without a boundary', () => {
    const punches = [punch('09:20', 'IN'), punch('13:00', 'OUT'), punch('18:05', 'OUT')];
    const withBoundary = pairPunches(punches, 'DEVICE_STATE', 60, boundaryFor(GENERAL));
    const without = pairPunches(punches, 'DEVICE_STATE', 60);
    expect(withBoundary).toEqual(without);
    expect([clock(withBoundary.checkInAt), clock(withBoundary.checkOutAt)]).toEqual([
      '09:20',
      '18:05',
    ]);
  });
});

describe('the raw punch is read, never rewritten', () => {
  it('10. every device state survives the classification verbatim', () => {
    const punches = [
      punch('09:01', 'OVERTIME_IN'),
      punch('13:00', 'OUT'),
      punch('18:33', 'OVERTIME_OUT'),
    ];
    const before = punches.map((p) => ({ punchedAt: new Date(p.punchedAt), state: p.punchState }));

    const read = resolvePunchRoles(punches, boundaryFor(GENERAL));

    expect(read.map((r) => r.punch.punchState)).toEqual(['OVERTIME_IN', 'OUT', 'OVERTIME_OUT']);
    // The array handed in holds the raw rows themselves; none may be mutated.
    expect(punches.map((p) => ({ punchedAt: p.punchedAt, state: p.punchState }))).toEqual(before);
    // An OverTime Out at 18:33 is a departure, and still says OVERTIME_OUT.
    expect(read.map((r) => r.role)).toEqual(['IN', 'OUT', 'OUT']);
    expect(read.map((r) => r.inferred)).toEqual([true, false, true]);
  });

  it('10b. the normalisation is a reading, so it is recomputed not remembered', () => {
    const punches = [punch('09:01', 'OVERTIME_IN'), punch('18:33', 'OVERTIME_OUT')];
    // The same punches under two shifts give two answers, from one input.
    expect(resolvePunchRoles(punches, boundaryFor(GENERAL)).map((r) => r.role)).toEqual([
      'IN',
      'OUT',
    ]);
    expect(resolvePunchRoles(punches, boundaryFor(LATE_SHIFT)).map((r) => r.role)).toEqual([
      'IN',
      null,
    ]);
  });

  it('11. however many punches, exactly one arrival and one departure', () => {
    const punches = [
      punch('08:58', 'OVERTIME_IN'),
      punch('09:00', 'IN'),
      punch('13:02', 'OUT'),
      punch('13:40', 'IN'),
      punch('18:31', 'OVERTIME_IN'),
      punch('18:44', 'OVERTIME_OUT'),
    ];
    const first = dayFrom(punches, 'DEVICE_STATE').paired;
    const again = dayFrom(punches, 'DEVICE_STATE').paired;

    // One pair, so one attendance row - the upsert above has one key to write.
    expect(Object.keys(first)).toEqual(['checkInAt', 'checkOutAt']);
    expect(clock(first.checkInAt)).toBe('08:58');
    // The LAST departure of the day, not one row per evening punch.
    expect(clock(first.checkOutAt)).toBe('18:44');
    // Reading twice gives the same answer, so re-running writes the same row.
    expect(again).toEqual(first);
  });
});

describe('the boundary itself', () => {
  it('comes from the assigned shift when there is one', () => {
    expect(boundaryFor(LATE_SHIFT)).toEqual(clockBoundary(DAY, '19:00', ZONE));
  });

  it('falls back to the company default window when there is not', () => {
    expect(boundaryFor(null)).toEqual(clockBoundary(DAY, '18:00', ZONE));
  });

  it('is anchored on the attendance day in the company zone, not on UTC', () => {
    // 18:00 in Asia/Karachi is 13:00 UTC. Anchoring on the UTC calendar day
    // would put the boundary five hours out and re-open every evening.
    expect(boundaryFor(GENERAL)?.toISOString()).toBe('2026-09-10T13:00:00.000Z');
  });

  it('declines an overnight shift rather than guessing at it', () => {
    // Documented limitation: the engine does not measure an overnight window
    // against a single attendance day, and this does not invent support for it.
    expect(boundaryFor(OVERNIGHT)).toBeNull();
  });

  it('with no boundary the reading falls back to position, as it did before', () => {
    const punches = [punch('21:00', 'OVERTIME_IN'), punch('23:30', 'OVERTIME_OUT')];
    expect(resolvePunchRoles(punches, boundaryFor(OVERNIGHT)).map((r) => r.role)).toEqual([
      'IN',
      'OUT',
    ]);
  });

  it('declines a window it cannot parse', () => {
    expect(boundaryFor({ startTime: '09:00', endTime: 'not-a-time' })).toBeNull();
  });
});

// ------------------------------------------------- the days that were reported

describe('the production days, read as the import path reads them', () => {
  /**
   * The exact instants on the device, seconds included, asserted by identity
   * against the punch they should have chosen rather than by a formatted
   * string - so a test cannot pass by picking a different punch in the same
   * minute.
   */
  const chose = (
    punches: ReturnType<typeof punch>[],
    strategy: (typeof BOTH)[number],
    inIndex: number | null,
    outIndex: number | null,
  ) => {
    const { paired } = dayFrom(punches, strategy);
    expect(paired.checkInAt?.getTime() ?? null).toBe(
      inIndex === null ? null : punches[inIndex]!.punchedAt.getTime(),
    );
    expect(paired.checkOutAt?.getTime() ?? null).toBe(
      outIndex === null ? null : punches[outIndex]!.punchedAt.getTime(),
    );
  };

  it('2026-09-10: 09:01:59 and 18:33:13, both in overtime mode', () => {
    const punches = [punch('09:01', 'OVERTIME_IN', 59), punch('18:33', 'OVERTIME_OUT', 13)];
    for (const strategy of BOTH) chose(punches, strategy, 0, 1);
  });

  it('2026-09-11: 08:57:21 and 18:23:41, both in overtime mode', () => {
    const punches = [punch('08:57', 'OVERTIME_IN', 21), punch('18:23', 'OVERTIME_OUT', 41)];
    for (const strategy of BOTH) chose(punches, strategy, 0, 1);
  });

  it('2026-09-14: 09:05:32 and 18:16:27, the evening punch labelled C/In', () => {
    // What the device actually recorded that day: two punches both stated IN.
    const punches = [punch('09:05', 'IN', 32), punch('18:16', 'IN', 27)];

    // The configured strategy, and the expected answer: 18:16 is the departure.
    chose(punches, 'FIRST_IN_LAST_OUT', 0, 1);

    // Under DEVICE_STATE it is not, and this rule does not change that: a
    // STATED direction is still taken at its word. A repeated C/In is a
    // different defect from a mis-set overtime mode and is left alone here.
    chose(punches, 'DEVICE_STATE', 0, null);
  });

  it('2026-09-14 read as an overtime mode day would close at 18:16 either way', () => {
    const punches = [punch('09:05', 'IN', 32), punch('18:16', 'OVERTIME_IN', 27)];
    for (const strategy of BOTH) chose(punches, strategy, 0, 1);
  });
});
