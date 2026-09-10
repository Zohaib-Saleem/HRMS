-- Salary management step 2: a payroll-level ceiling on paid overtime, the
-- minutes a line actually priced, and an exception code that says when the
-- ceiling trimmed something.
--
-- Additive throughout: one nullable column, one column with a default, one
-- enum value appended. No existing row is read, written or recalculated, and a
-- null cap reproduces exactly what every finalized run already paid.

ALTER TABLE "payroll_settings"
  ADD COLUMN "overtimeCapMinutes" INTEGER;

ALTER TABLE "payroll_lines"
  ADD COLUMN "paidOvertimeMinutes" INTEGER NOT NULL DEFAULT 0;

-- Earnings already carried a rate; the units it was multiplied by were only
-- on deductions. Overtime hours on a payslip need both.
ALTER TABLE "payroll_earnings"
  ADD COLUMN "units" DECIMAL(10,2);

ALTER TYPE "PayrollExceptionCode" ADD VALUE IF NOT EXISTS 'OVERTIME_CAPPED';
