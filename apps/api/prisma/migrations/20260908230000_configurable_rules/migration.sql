-- Company attendance and payroll rules that were still assumptions in code.
--
-- Additive throughout. Every new column either carries a default reproducing
-- the behaviour already in force, or is nullable and means "inherit". No
-- existing value is read, written or recalculated by this migration.

-- What a day with a punch missing on one end is worth.
CREATE TYPE "AttendanceMissingPunchRule" AS ENUM ('PRESENT', 'ABSENT', 'THRESHOLD');

-- Company baseline.
ALTER TABLE "companies"
  ADD COLUMN "breakIncludedInWindow"     BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "overtimeMinimumMinutes"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "overtimeRoundingMinutes"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "overtimeWeeklyCapMinutes"  INTEGER,
  ADD COLUMN "overtimeMonthlyCapMinutes" INTEGER,
  ADD COLUMN "missingCheckOutStatus" "AttendanceMissingPunchRule" NOT NULL DEFAULT 'PRESENT',
  ADD COLUMN "missingCheckInStatus"  "AttendanceMissingPunchRule" NOT NULL DEFAULT 'ABSENT';

-- The effective-dated override table gains the same rules, all nullable so an
-- override states only what it changes and inherits the rest.
ALTER TABLE "attendance_policies"
  ADD COLUMN "defaultShiftStart"             TEXT,
  ADD COLUMN "defaultShiftEnd"               TEXT,
  ADD COLUMN "overtimeFromShiftEnd"          BOOLEAN,
  ADD COLUMN "overtimeCountsEarlyArrival"    BOOLEAN,
  ADD COLUMN "overtimeReducedByLateArrival"  BOOLEAN,
  ADD COLUMN "fullDayToleranceMinutes"       INTEGER,
  ADD COLUMN "overtimeMinimumMinutes"        INTEGER,
  ADD COLUMN "overtimeRoundingMinutes"       INTEGER,
  ADD COLUMN "overtimeWeeklyCapMinutes"      INTEGER,
  ADD COLUMN "overtimeMonthlyCapMinutes"     INTEGER,
  ADD COLUMN "breakIncludedInWindow"         BOOLEAN,
  ADD COLUMN "irregularCheckInEnabled"       BOOLEAN,
  ADD COLUMN "irregularCheckInCutoff"        TEXT,
  ADD COLUMN "lateTrackingEnabled"           BOOLEAN,
  ADD COLUMN "earlyDepartureTrackingEnabled" BOOLEAN;

-- Pay-side rules. The fallback replaces ASSUMED_SHIFT_MINUTES, which was the
-- last business-rule constant left in the calculation code.
ALTER TABLE "payroll_settings"
  ADD COLUMN "overtimeWeekendMultiplier" DECIMAL(6,3),
  ADD COLUMN "overtimeHolidayMultiplier" DECIMAL(6,3),
  ADD COLUMN "fallbackScheduledMinutes"  INTEGER NOT NULL DEFAULT 480;

-- An absolute cutoff marks every night-shift worker irregular, which is exactly
-- the "everyone works 09:00-18:00" assumption this configuration exists to
-- remove. ABSOLUTE_TIME stays the default, so behaviour is unchanged until a
-- company chooses otherwise.
CREATE TYPE "IrregularCutoffMode" AS ENUM ('ABSOLUTE_TIME', 'AFTER_SHIFT_START');

ALTER TABLE "companies"
  ADD COLUMN "irregularCheckInMode" "IrregularCutoffMode" NOT NULL DEFAULT 'ABSOLUTE_TIME',
  ADD COLUMN "irregularAfterShiftStartMinutes" INTEGER NOT NULL DEFAULT 120;

ALTER TABLE "attendance_policies"
  ADD COLUMN "irregularCheckInMode" "IrregularCutoffMode",
  ADD COLUMN "irregularAfterShiftStartMinutes" INTEGER;
