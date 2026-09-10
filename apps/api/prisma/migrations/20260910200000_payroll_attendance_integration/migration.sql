-- Payroll reads the attendance engine, and gains the two rules it was missing.
--
-- Every default below reproduces current behaviour exactly: no leave type is
-- deductible, and the short-hours deduction is off. Nothing anybody has already
-- been paid changes because this migration ran.

-- Whether payroll deducts a PAID leave even though it is paid. Off everywhere:
-- approved paid leave is leave the company agreed to pay for.
ALTER TABLE "leave_types"
  ADD COLUMN "isDeductible" BOOLEAN NOT NULL DEFAULT false;

-- How a day attended but worked short of its roster is charged. This is the
-- middle of the day, which the late and early-leave rules cannot see.
CREATE TYPE "PayrollShortHoursMode" AS ENUM ('NONE', 'PER_MINUTE', 'PRO_RATA');

ALTER TABLE "payroll_settings"
  ADD COLUMN "shortHoursDeductionMode" "PayrollShortHoursMode" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "shortHoursDeductionRate" DECIMAL(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN "shortHoursGraceMinutes"  INTEGER NOT NULL DEFAULT 0;

-- Null inherits the company setting, like every other override on this table.
ALTER TABLE "payroll_profiles"
  ADD COLUMN "shortHoursDeductionMode" "PayrollShortHoursMode",
  ADD COLUMN "shortHoursDeductionRate" DECIMAL(14,4),
  ADD COLUMN "shortHoursGraceMinutes"  INTEGER;
