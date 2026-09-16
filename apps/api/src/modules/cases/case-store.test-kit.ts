import { vi } from 'vitest';

/**
 * A small in-memory stand-in for the slice of Prisma the cases module uses.
 *
 * Written rather than reached for because of what the cases tests are actually
 * for. The interesting claims in this module are all claims about a WHERE
 * clause - that an employee's list is narrowed to their own rows, that a
 * guessed case id finds nothing, that a filter filters - and a mock that
 * returns a fixed array no matter what it was asked proves none of them. It
 * would pass just as happily against a route that dropped the requester id
 * altogether, which is the exact bug these tests exist to catch.
 *
 * So this evaluates the query instead: the same rows go in, the route's real
 * `where` is applied to them, and what comes back is what the database would
 * have returned. It supports precisely the shapes the cases routes build -
 * `AND`, `OR`, scalar equality, `contains`, `startsWith`, `gte`, `lte` - and
 * nothing else, deliberately: a general-purpose Prisma emulator is a second
 * database to maintain, and a clause this does not understand should fail
 * loudly in a test rather than be silently ignored.
 *
 * Note that it is not a test double for the DATABASE. Uniqueness, foreign keys
 * and referential actions are the schema's job and are asserted by the
 * migration, not here; what this holds is query semantics.
 */

type Row = Record<string, unknown>;

/** Applied for `mode: 'insensitive'`, which is what every text filter uses. */
const lower = (value: unknown): string => String(value ?? '').toLowerCase();

function compare(actual: unknown, operand: unknown): number {
  const a = actual instanceof Date ? actual.getTime() : Number(actual);
  const b = operand instanceof Date ? operand.getTime() : Number(operand);
  return a - b;
}

/** True when `row` satisfies `where`. Throws on a clause it does not model. */
export function matches(row: Row, where: unknown): boolean {
  if (where === undefined || where === null) return true;
  if (typeof where !== 'object') return true;

  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (value === undefined) continue;

    if (key === 'AND') {
      if (!(value as unknown[]).every((clause) => matches(row, clause))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!(value as unknown[]).some((clause) => matches(row, clause))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matches(row, value)) return false;
      continue;
    }

    const actual = row[key];

    if (value === null || typeof value !== 'object' || value instanceof Date) {
      const same =
        actual instanceof Date && value instanceof Date
          ? actual.getTime() === value.getTime()
          : actual === value;
      if (!same) return false;
      continue;
    }

    for (const [operator, operand] of Object.entries(value as Record<string, unknown>)) {
      switch (operator) {
        // Carried by every text filter and consumed by `lower` below, so it
        // needs no branch of its own - but it must not fall to `default`.
        case 'mode':
          break;
        case 'equals':
          if (actual !== operand) return false;
          break;
        case 'contains':
          if (!lower(actual).includes(lower(operand))) return false;
          break;
        case 'startsWith':
          if (!lower(actual).startsWith(lower(operand))) return false;
          break;
        case 'in':
          if (!(operand as unknown[]).includes(actual)) return false;
          break;
        case 'gte':
          if (compare(actual, operand) < 0) return false;
          break;
        case 'lte':
          if (compare(actual, operand) > 0) return false;
          break;
        case 'gt':
          if (compare(actual, operand) <= 0) return false;
          break;
        case 'lt':
          if (compare(actual, operand) >= 0) return false;
          break;
        default:
          throw new Error(
            `case-store.test-kit does not model the Prisma operator ${JSON.stringify(operator)}. ` +
              'Add it deliberately rather than letting the clause be ignored.',
          );
      }
    }
  }

  return true;
}

/** Applies a single `orderBy` object, or an array of them, in order. */
export function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const clauses = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<
    Record<string, 'asc' | 'desc'>
  >;
  if (clauses.length === 0) return rows;

  return [...rows].sort((left, right) => {
    for (const clause of clauses) {
      for (const [field, direction] of Object.entries(clause)) {
        const a = left[field];
        const b = right[field];
        const delta =
          a instanceof Date || b instanceof Date
            ? compare(a, b)
            : String(a ?? '').localeCompare(String(b ?? ''));
        if (delta !== 0) return direction === 'desc' ? -delta : delta;
      }
    }
    return 0;
  });
}

export interface TableArgs {
  where?: unknown;
  orderBy?: unknown;
  skip?: number;
  take?: number;
  data?: Row;
}

/**
 * One table: an array of rows plus the handful of Prisma methods the module
 * calls on it. Every method is a `vi.fn`, so a test can still assert how it was
 * called when the call itself is the thing under test.
 */
export function table(initial: Row[] = []) {
  const rows: Row[] = [...initial];

  const find = (args: TableArgs = {}) => {
    const filtered = rows.filter((row) => matches(row, args.where));
    const sorted = sortRows(filtered, args.orderBy);
    const from = args.skip ?? 0;
    return args.take === undefined ? sorted.slice(from) : sorted.slice(from, from + args.take);
  };

  return {
    rows,
    findFirst: vi.fn((args: TableArgs = {}) => Promise.resolve(find(args)[0] ?? null)),
    findMany: vi.fn((args: TableArgs = {}) => Promise.resolve(find(args))),
    count: vi.fn((args: TableArgs = {}) =>
      Promise.resolve(rows.filter((row) => matches(row, args.where)).length),
    ),
    create: vi.fn((args: { data: Row }) => {
      const row = { id: `row-${rows.length + 1}`, createdAt: new Date(), ...args.data };
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: vi.fn((args: { where: Row; data: Row }) => {
      const row = rows.find((candidate) => matches(candidate, args.where));
      if (!row) throw new Error('testkit: update matched no row');
      Object.assign(row, args.data, { updatedAt: new Date() });
      return Promise.resolve(row);
    }),
    groupBy: vi.fn((args: { by: string[]; where?: unknown }) => {
      const buckets = new Map<string, number>();
      for (const row of rows.filter((candidate) => matches(candidate, args.where))) {
        const key = args.by.map((field) => String(row[field])).join('|');
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      return Promise.resolve(
        [...buckets].map(([key, total]) => {
          const record: Row = { _count: { _all: total } };
          key.split('|').forEach((value, index) => {
            record[args.by[index] as string] = value;
          });
          return record;
        }),
      );
    }),
  };
}

export type Table = ReturnType<typeof table>;
