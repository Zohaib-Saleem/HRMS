-- Attendance module, step 1: the rule layer, shift-level overrides,
-- effective-dated PunchCode mappings, and an adjustment ledger.
--
-- Additive throughout. Every new column either carries a default that
-- reproduces the behaviour already in force, or is nullable and means
-- "inherit". No raw punch, attendance record, mapping, shift or assignment is
-- read, rewritten or recalculated by this migration. The one dropped object is
-- a unique index, replaced by a plain one so a PIN can carry its history.

-- What time worked on a weekend or holiday is worth.
CREATE TYPE "NonWorkingDayWorkRule" AS ENUM ('AS_WORKING_DAY', 'ALL_OVERTIME', 'IGNORE');

-- Why an adjustment was written.
CREATE TYPE "AttendanceAdjustmentKind" AS ENUM ('CORRECTION', 'MAPPING_CHANGE');

-- Reported properties of a day, alongside its status.
CREATE TYPE "AttendanceFlag" AS ENUM ('LATE', 'EARLY_LEAVE', 'OVERTIME', 'MISSING_PUNCH', 'IRREGULAR', 'MANUAL');

-- Company rule layer.
ALTER TABLE "companies"
  ADD COLUMN "defaultBreakMinutes"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lateThresholdMinutes"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "earlyLeaveThresholdMinutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "weekendWorkRule" "NonWorkingDayWorkRule" NOT NULL DEFAULT 'AS_WORKING_DAY',
  ADD COLUMN "holidayWorkRule" "NonWorkingDayWorkRule" NOT NULL DEFAULT 'AS_WORKING_DAY';

-- The engine records whether a day fitted its shift. Existing rows read false,
-- which is exactly what they were reported as.
ALTER TABLE "attendance_records"
  ADD COLUMN "irregular" BOOLEAN NOT NULL DEFAULT false;

-- Shift-level rules. Null inherits the company value.
ALTER TABLE "shifts"
  ADD COLUMN "description"                   TEXT,
  ADD COLUMN "workingDays"                   "WeekDay"[] DEFAULT ARRAY[]::"WeekDay"[],
  ADD COLUMN "expectedMinutes"               INTEGER,
  ADD COLUMN "graceMinutes"                  INTEGER,
  ADD COLUMN "earlyLeaveGraceMinutes"        INTEGER,
  ADD COLUMN "lateTrackingEnabled"           BOOLEAN,
  ADD COLUMN "earlyDepartureTrackingEnabled" BOOLEAN,
  ADD COLUMN "overtimeEnabled"               BOOLEAN,
  ADD COLUMN "overtimeDailyCapMinutes"       INTEGER,
  ADD COLUMN "overtimeMinimumMinutes"        INTEGER,
  ADD COLUMN "effectiveFrom"                 DATE;

-- Effective-dated mappings. Existing rows get null dates, which means "since
-- the beginning, still in force" - precisely what they meant before.
ALTER TABLE "attendance_device_user_mappings"
  ADD COLUMN "effectiveFrom" DATE,
  ADD COLUMN "effectiveTo"   DATE,
  ADD COLUMN "notes"         TEXT;

DROP INDEX IF EXISTS "attendance_device_user_mappings_deviceId_deviceUserId_key";
CREATE INDEX "attendance_device_user_mappings_deviceId_deviceUserId_idx"
  ON "attendance_device_user_mappings"("deviceId", "deviceUserId");

-- The adjustment ledger.
CREATE TABLE "attendance_adjustments" (
  "id"            TEXT NOT NULL,
  "companyId"     TEXT NOT NULL,
  "employeeId"    TEXT NOT NULL,
  "date"          DATE NOT NULL,
  "recordId"      TEXT,
  "kind"          "AttendanceAdjustmentKind" NOT NULL DEFAULT 'CORRECTION',
  "changedFields" TEXT[],
  "before"        JSONB NOT NULL,
  "after"         JSONB NOT NULL,
  "reason"        TEXT NOT NULL,
  "actorId"       TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "attendance_adjustments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "attendance_adjustments_employeeId_date_idx" ON "attendance_adjustments"("employeeId", "date");
CREATE INDEX "attendance_adjustments_companyId_createdAt_idx" ON "attendance_adjustments"("companyId", "createdAt");

ALTER TABLE "attendance_adjustments"
  ADD CONSTRAINT "attendance_adjustments_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_adjustments_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_adjustments_recordId_fkey"
    FOREIGN KEY ("recordId") REFERENCES "attendance_records"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_adjustments_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A dedicated permission for changing attendance rules, so HR Admin can be
-- granted it explicitly without being handed settings.manage. The seed is not
-- run on deploy, so the catalogue row is written here; SUPER_ADMIN holds every
-- permission and receives it immediately.
INSERT INTO "permissions" ("id", "key", "name", "description", "groupKey", "createdAt")
VALUES (
  'perm_attendance_rules_manage',
  'attendance.rules.manage',
  'Manage attendance rules',
  'Change the company attendance rules that decide what a day is worth.',
  'time',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" = 'attendance.rules.manage'
WHERE r."key" = 'SUPER_ADMIN'
ON CONFLICT DO NOTHING;
