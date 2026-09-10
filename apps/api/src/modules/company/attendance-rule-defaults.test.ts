import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_RULE_DEFAULTS,
  ATTENDANCE_RULE_SECTIONS,
  type AttendanceRuleKey,
} from '@hrms/shared';

/**
 * The rule catalogue, checked against the two things it claims to describe.
 *
 * `ATTENDANCE_RULE_DEFAULTS` is offered on the settings screen as "the
 * default" and used for its reset control. If it drifts from the Prisma
 * schema, that control writes a value a new company would never have had, and
 * nothing anywhere would notice - the types are identical either way.
 *
 * `ATTENDANCE_RULE_SECTIONS` is the screen, as data. A rule with no entry in
 * it is a rule Super Admin cannot see, which is the same as a rule Super Admin
 * cannot fix. Both are asserted here rather than trusted.
 */

const SCHEMA = readFileSync(
  fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url)),
  'utf8',
);

/** The `model Company { ... }` block, where every company-wide rule lives. */
function companyBlock(): string {
  const start = SCHEMA.indexOf('model Company {');
  expect(start).toBeGreaterThan(-1);
  const end = SCHEMA.indexOf('\nmodel ', start + 1);
  return SCHEMA.slice(start, end === -1 ? undefined : end);
}

/**
 * The `@default(...)` a column carries, as the literal text.
 *
 * Deliberately textual. Parsing the schema properly would mean shipping a
 * parser to check a dozen constants; reading the default off the line the
 * developer actually edits is both simpler and closer to what would go wrong.
 */
function schemaDefault(field: string): string | null {
  const block = companyBlock();
  const line = block
    .split('\n')
    .find((row) => new RegExp(`^\\s*${field}\\s`).test(row));
  if (!line) return null;
  const match = /@default\(([^)]*)\)/.exec(line);
  return match ? match[1]!.trim() : null;
}

/** How a shipped default is written in the schema. */
const asSchemaLiteral = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
};

/**
 * Rules whose shipped default is deliberately not the schema's.
 *
 * There is exactly one class of these: a column that is nullable and means
 * "no limit", which the schema expresses by having no default at all.
 */
const NO_SCHEMA_DEFAULT: AttendanceRuleKey[] = [
  'overtimeWeeklyCapMinutes',
  'overtimeMonthlyCapMinutes',
];

describe('the shipped defaults', () => {
  it('match what a new company would actually be given', () => {
    const mismatches: string[] = [];

    for (const [key, value] of Object.entries(ATTENDANCE_RULE_DEFAULTS)) {
      if (NO_SCHEMA_DEFAULT.includes(key as AttendanceRuleKey)) continue;

      const declared = schemaDefault(key);
      if (declared === null) {
        mismatches.push(`${key}: no @default in schema.prisma`);
        continue;
      }
      const expected = asSchemaLiteral(value);
      // The schema writes an enum bare and a string quoted; accept either
      // spelling of the same value rather than demanding one.
      if (declared !== expected && declared !== String(value)) {
        mismatches.push(`${key}: schema says ${declared}, defaults say ${expected}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('leaves the two "no limit" caps null, which is what no default means', () => {
    for (const key of NO_SCHEMA_DEFAULT) {
      expect(ATTENDANCE_RULE_DEFAULTS[key], key).toBeNull();
      expect(schemaDefault(key), key).toBeNull();
    }
  });
});

describe('the rule catalogue', () => {
  const described = new Set(
    ATTENDANCE_RULE_SECTIONS.flatMap((section) => section.fields.map((field) => field.key)),
  );

  it('describes every rule the screen can edit', () => {
    const missing = (Object.keys(ATTENDANCE_RULE_DEFAULTS) as AttendanceRuleKey[]).filter(
      (key) => !described.has(key),
    );
    // A stored rule with no label, description and default is a hidden rule.
    expect(missing).toEqual([]);
  });

  it('invents no rule that does not exist', () => {
    const known = new Set(Object.keys(ATTENDANCE_RULE_DEFAULTS));
    for (const key of described) {
      expect(known.has(key), `${key} is described but is not a rule`).toBe(true);
    }
  });

  it('gives every field a label and a description somebody could act on', () => {
    for (const section of ATTENDANCE_RULE_SECTIONS) {
      expect(section.title.length, section.key).toBeGreaterThan(0);
      for (const field of section.fields) {
        expect(field.label.length, field.key).toBeGreaterThan(0);
        // Not a restatement of the label: a description that says nothing is
        // worse than none, because it looks like help.
        expect(field.description.length, field.key).toBeGreaterThan(field.label.length);
      }
    }
  });

  it('puts each rule in exactly one section', () => {
    const seen = new Map<string, number>();
    for (const section of ATTENDANCE_RULE_SECTIONS) {
      for (const field of section.fields) {
        seen.set(field.key, (seen.get(field.key) ?? 0) + 1);
      }
    }
    expect([...seen.entries()].filter(([, count]) => count > 1)).toEqual([]);
  });
});
