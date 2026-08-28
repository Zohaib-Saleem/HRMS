/**
 * Unit checks for the zone helpers that attendance now depends on.
 *
 * These are pure functions, so they are exercised directly rather than through
 * the API. Everything the attendance engine does with a wall clock - deciding
 * which day a punch belongs to, and where a shift boundary falls - comes from
 * here, so an error at this level is an error in every calculation above it.
 *
 *   npx tsx scripts/verify-timezone.mjs
 */
import {
  clockBoundary,
  dayBoundsInZone,
  dayKeyInZone,
  instantInZone,
  isValidTimeZone,
  zoneOffsetMinutes,
} from '../apps/api/src/core/zoned-time.ts';

let pass = 0;
let fail = 0;

const check = (label, expected, actual) => {
  const e = String(expected);
  const a = String(actual);
  if (e === a) {
    console.log(`  PASS  ${label} (${a})`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label} - expected ${e}, got ${a}`);
    fail += 1;
  }
};

const KHI = 'Asia/Karachi';

console.log('################ A. PAKISTAN (UTC+5, no daylight saving) ################');
check('offset is +300 minutes', 300, zoneOffsetMinutes(new Date('2026-08-28T00:00:00Z'), KHI));
check('offset is the same in January', 300, zoneOffsetMinutes(new Date('2026-01-15T00:00:00Z'), KHI));
check(
  '08:56 local is 03:56 UTC',
  '2026-08-28T03:56:00.000Z',
  instantInZone('2026-08-28', 8, 56, KHI).toISOString(),
);
check(
  'a 09:00 shift starts at 04:00 UTC',
  '2026-08-28T04:00:00.000Z',
  clockBoundary('2026-08-28', '09:00', KHI)?.toISOString(),
);

console.log();
console.log('################ B. THE DAY A PUNCH BELONGS TO ################');
// This is the bug the old code had: it asked what UTC day it was.
check(
  'a 03:56 UTC punch is 28 Aug in Karachi',
  '2026-08-28',
  dayKeyInZone(new Date('2026-08-28T03:56:00Z'), KHI),
);
check(
  'a 20:00 UTC punch is already 29 Aug in Karachi',
  '2026-08-29',
  dayKeyInZone(new Date('2026-08-28T20:00:00Z'), KHI),
);
check(
  'and the same instant is still 28 Aug in UTC',
  '2026-08-28',
  dayKeyInZone(new Date('2026-08-28T20:00:00Z'), 'UTC'),
);
check(
  'a 02:00 local punch belongs to that local day, not the UTC one before it',
  '2026-08-28',
  dayKeyInZone(new Date('2026-08-27T21:00:00Z'), KHI),
);

console.log();
console.log('################ C. MIDNIGHT BOUNDARIES ################');
const bounds = dayBoundsInZone('2026-08-28', KHI);
check('local midnight is 19:00 UTC the day before', '2026-08-27T19:00:00.000Z', bounds.from.toISOString());
check('the day ends at 19:00 UTC on the 28th', '2026-08-28T19:00:00.000Z', bounds.to.toISOString());
check('the local day is exactly 24 hours', 1440, (bounds.to - bounds.from) / 60000);
check(
  '23:59 local is inside the day',
  true,
  instantInZone('2026-08-28', 23, 59, KHI) < bounds.to,
);
check(
  '00:00 local is the start of the day',
  true,
  instantInZone('2026-08-28', 0, 0, KHI).getTime() === bounds.from.getTime(),
);

console.log();
console.log('################ D. LATENESS ACROSS THE OLD UTC BUG ################');
// Device sends 08:56 local. Shift starts 09:00 local. The employee is early.
const punch = instantInZone('2026-08-28', 8, 56, KHI);
const shiftStart = clockBoundary('2026-08-28', '09:00', KHI);
check('08:56 against a 09:00 shift is 4 minutes early', -4, Math.round((punch - shiftStart) / 60000));
// What the old UTC-anchored code would have concluded.
const utcShiftStart = new Date(Date.UTC(2026, 7, 28, 9, 0));
check(
  'the old UTC anchoring would have called it 304 minutes early',
  -304,
  Math.round((punch - utcShiftStart) / 60000),
);

console.log();
console.log('################ E. DAYLIGHT SAVING (a zone that has it) ################');
const LON = 'Europe/London';
check('London is UTC+0 in January', 0, zoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), LON));
check('London is UTC+1 in July', 60, zoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), LON));
check(
  '09:00 London in July is 08:00 UTC',
  '2026-07-15T08:00:00.000Z',
  clockBoundary('2026-07-15', '09:00', LON)?.toISOString(),
);
check(
  '09:00 London in January is 09:00 UTC',
  '2026-01-15T09:00:00.000Z',
  clockBoundary('2026-01-15', '09:00', LON)?.toISOString(),
);
// The clocks go forward at 01:00 UTC on 29 March 2026.
const springDay = dayBoundsInZone('2026-03-29', LON);
check('a spring-forward day is 23 hours long', 1380, (springDay.to - springDay.from) / 60000);
const autumnDay = dayBoundsInZone('2026-10-25', LON);
check('an autumn-back day is 25 hours long', 1500, (autumnDay.to - autumnDay.from) / 60000);

console.log();
console.log('################ F. GUARDS ################');
check('a real zone validates', true, isValidTimeZone(KHI));
check('a nonsense zone does not', false, isValidTimeZone('Mars/Olympus_Mons'));
check('an unparseable clock yields null', null, clockBoundary('2026-08-28', 'not-a-time', KHI));
check('25:00 is rejected', null, clockBoundary('2026-08-28', '25:00', KHI));

console.log();
console.log('################ SUMMARY ################');
console.log(`PASS=${pass}  FAIL=${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
