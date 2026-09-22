import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clockBoundary } from '../../core/zoned-time.js';
import type { OvernightSettings } from './overnight-attribution.js';

/**
 * Re-attributing a window of history.
 *
 * The backfill is the dangerous half of this feature: it rewrites days that
 * have already been reported on. Three promises are asserted, because each one
 * is a way a backfill goes wrong in a way nobody notices until payroll:
 *
 *   1. It returns ONLY the days where a punch actually changed sides. Re-deriving
 *      a whole range re-reads untouched days under today's policy and restates
 *      history that was correct.
 *   2. A dry run writes nothing - the punch table has no `updateMany` reachable
 *      from it - and reports exactly what the real run would do, chains included.
 *      A preview that under-reports is worse than no preview.
 *   3. A day outside the requested range still gets its punches, because the day
 *      being closed is by definition the day BEFORE the one that was scanned.
 */

const db = vi.hoisted(() => ({
  attendanceRawPunch: { groupBy: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { reattributeDateRange } = await import('./overnight-attribution.js');

const ZONE = 'Asia/Karachi';
const COMPANY = 'co-1';
const EMP = 'emp-1';

const SETTINGS: OvernightSettings = {
  windowMinutes: 1080,
  cutoff: '06:00',
  timeZone: ZONE,
  pairing: 'FIRST_IN_LAST_OUT',
  duplicateWindowSeconds: 60,
};

interface Row {
  id: string;
  employeeId: string;
  localDayKey: string;
  punchedAt: Date;
  punchState: string | null;
}

/** The punch table, as rows the mock serves and the code under test mutates. */
let table: Row[] = [];

const at = (dayKey: string, hhmm: string): Date => {
  const instant = clockBoundary(dayKey, hhmm, ZONE);
  if (!instant) throw new Error(`bad time ${hhmm}`);
  return instant;
};

const row = (id: string, dayKey: string, hhmm: string): Row => ({
  id,
  employeeId: EMP,
  localDayKey: dayKey,
  punchedAt: at(dayKey, hhmm),
  punchState: null,
});

beforeEach(() => {
  vi.clearAllMocks();

  db.attendanceRawPunch.groupBy.mockImplementation(async ({ where }: any) => {
    const { gte, lte } = where.localDayKey;
    const seen = new Set<string>();
    for (const r of table) {
      if (r.localDayKey >= gte && r.localDayKey <= lte) seen.add(`${r.employeeId}:${r.localDayKey}`);
    }
    return [...seen].map((key) => {
      const [employeeId, localDayKey] = key.split(':');
      return { employeeId, localDayKey };
    });
  });

  db.attendanceRawPunch.findMany.mockImplementation(async ({ where }: any) =>
    table
      .filter((r) => r.employeeId === where.employeeId && r.localDayKey === where.localDayKey)
      .sort((a, b) => a.punchedAt.getTime() - b.punchedAt.getTime())
      .map((r) => ({ id: r.id, punchedAt: r.punchedAt, punchState: r.punchState })),
  );

  db.attendanceRawPunch.updateMany.mockImplementation(async ({ where, data }: any) => {
    let count = 0;
    for (const r of table) {
      if (where.id.in.includes(r.id)) {
        r.localDayKey = data.localDayKey;
        count += 1;
      }
    }
    return { count };
  });
});

const run = (over: Partial<Parameters<typeof reattributeDateRange>[0]> = {}) =>
  reattributeDateRange({
    companyId: COMPANY,
    from: '2026-08-01',
    to: '2026-08-31',
    dryRun: false,
    settingsFor: async () => SETTINGS,
    ...over,
  });

describe('only the days that actually moved come back', () => {
  beforeEach(() => {
    table = [
      // A late night: in on the 10th, out at 00:29 on the 11th.
      row('a-in', '2026-08-10', '08:55'),
      row('a-out', '2026-08-11', '00:29'),
      row('a-next', '2026-08-11', '09:27'),
      // An ordinary day, which must be left completely alone.
      row('b-in', '2026-08-12', '09:02'),
      row('b-out', '2026-08-12', '18:05'),
    ];
  });

  it('reports the one move and not the ordinary days', async () => {
    const result = await run();

    expect(result.moved).toEqual([
      { employeeId: EMP, fromDayKey: '2026-08-11', toDayKey: '2026-08-10', punchesMoved: 1 },
    ]);
  });

  it('scanned more days than it moved, which is the point', async () => {
    const result = await run();

    expect(result.daysScanned).toBe(3);
    expect(result.moved).toHaveLength(1);
    expect(result.employeesScanned).toBe(1);
  });

  it('writes the punch onto the day it closes and leaves the arrival alone', async () => {
    await run();

    expect(table.find((r) => r.id === 'a-out')!.localDayKey).toBe('2026-08-10');
    expect(table.find((r) => r.id === 'a-next')!.localDayKey).toBe('2026-08-11');
    expect(table.find((r) => r.id === 'b-in')!.localDayKey).toBe('2026-08-12');
  });
});

describe('a dry run', () => {
  beforeEach(() => {
    table = [
      row('a-in', '2026-08-10', '08:55'),
      row('a-out', '2026-08-11', '00:29'),
      row('a-next', '2026-08-11', '09:27'),
    ];
  });

  it('writes nothing at all', async () => {
    await run({ dryRun: true });

    expect(db.attendanceRawPunch.updateMany).not.toHaveBeenCalled();
    expect(table.find((r) => r.id === 'a-out')!.localDayKey).toBe('2026-08-11');
  });

  it('reports exactly what the real run then does', async () => {
    const preview = await run({ dryRun: true });
    const real = await run();

    expect(preview.moved).toEqual(real.moved);
  });
});

describe('a chain of late nights', () => {
  beforeEach(() => {
    // Three consecutive nights, each closed after midnight on the next date.
    table = [
      row('d1-in', '2026-08-10', '09:00'),
      row('d1-out', '2026-08-11', '00:20'),
      row('d2-in', '2026-08-11', '09:00'),
      row('d2-out', '2026-08-12', '00:25'),
      row('d3-in', '2026-08-12', '09:00'),
      row('d3-out', '2026-08-13', '00:30'),
    ];
  });

  it('resolves every link in one pass', async () => {
    const result = await run();

    expect(result.moved.map((m) => `${m.fromDayKey}->${m.toDayKey}`)).toEqual([
      '2026-08-11->2026-08-10',
      '2026-08-12->2026-08-11',
      '2026-08-13->2026-08-12',
    ]);
  });

  it('previews the whole chain, not just its first link', async () => {
    const preview = await run({ dryRun: true });

    // Without modelling the moves it has not written, a dry run would read the
    // 11th as already closed and stop after one.
    expect(preview.moved).toHaveLength(3);
  });
});

describe('the edges of the range', () => {
  it('closes a day before the range, which is where the punches belong', async () => {
    table = [
      row('prev-in', '2026-07-31', '09:00'),
      row('moves', '2026-08-01', '00:45'),
    ];

    const result = await run();

    expect(result.moved).toEqual([
      { employeeId: EMP, fromDayKey: '2026-08-01', toDayKey: '2026-07-31', punchesMoved: 1 },
    ]);
    expect(table.find((r) => r.id === 'moves')!.localDayKey).toBe('2026-07-31');
  });

  it('moves nothing for an employee whose policy will not resolve', async () => {
    table = [row('in', '2026-08-10', '08:55'), row('out', '2026-08-11', '00:29')];

    const result = await run({ settingsFor: async () => null });

    expect(result.moved).toEqual([]);
    expect(db.attendanceRawPunch.updateMany).not.toHaveBeenCalled();
  });

  it('moves nothing when the rule is switched off', async () => {
    table = [row('in', '2026-08-10', '08:55'), row('out', '2026-08-11', '00:29')];

    const result = await run({ settingsFor: async () => ({ ...SETTINGS, windowMinutes: 0 }) });

    expect(result.moved).toEqual([]);
  });
});
