-- Attendance rules: the shift window a day is measured against, and how the
-- time either side of it is scored.
--
-- Additive only. Every column has a default that reproduces the behaviour
-- already in force, so existing rows are complete the moment the column exists
-- and no attendance figure changes as a result of this migration.
ALTER TABLE "companies"
  ADD COLUMN "defaultShiftStart"             TEXT    NOT NULL DEFAULT '09:00',
  ADD COLUMN "defaultShiftEnd"               TEXT    NOT NULL DEFAULT '18:00',
  ADD COLUMN "overtimeFromShiftEnd"          BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "overtimeCountsEarlyArrival"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "overtimeReducedByLateArrival"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lateTrackingEnabled"           BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "earlyDepartureTrackingEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "irregularCheckInEnabled"       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "irregularCheckInCutoff"        TEXT    NOT NULL DEFAULT '11:00';
