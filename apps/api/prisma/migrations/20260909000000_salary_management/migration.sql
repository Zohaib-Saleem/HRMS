-- Salary management: two more ways to price a component, a place for it on the
-- payslip, an effective date on it, and a configurable proration method.
--
-- Additive throughout. Enum values are appended, never reordered or removed;
-- every new column has a default or is nullable. No existing row is read,
-- written or recalculated.

ALTER TYPE "PayrollComponentCalc" ADD VALUE IF NOT EXISTS 'PER_DAY';
ALTER TYPE "PayrollComponentCalc" ADD VALUE IF NOT EXISTS 'PER_HOUR';

CREATE TYPE "PayrollProrationMethod" AS ENUM ('CALENDAR_DAYS', 'WORKING_DAYS');

ALTER TABLE "salary_components"
  ADD COLUMN "displayOrder"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "effectiveFrom" DATE;

ALTER TABLE "payroll_settings"
  ADD COLUMN "prorationMethod" "PayrollProrationMethod" NOT NULL DEFAULT 'CALENDAR_DAYS',
  ADD COLUMN "payDay"          INTEGER;
