-- The policy that history was scored under, kept in force for history.
--
-- From this release the day status (PRESENT / HALF_DAY / ABSENT) is derived
-- from the stored punches under the policy in force for that date, exactly as
-- the hours, lateness and overtime already were, instead of being read back
-- from the row as the import wrote it. The company baseline changed on 8 and
-- 12 September 2026 (full day 480 -> 540, tolerance 30 -> 0, irregular cutoff
-- 11:00 -> 09:15), so without this every day imported before that would be
-- re-graded under the new thresholds on the next read: roughly 2,200 of them,
-- almost all from PRESENT to HALF_DAY.
--
-- A company-scope policy assignment effective to 11 September 2026 is the
-- mechanism that already exists for exactly this - "rescoring a day in March
-- has to use the policy that was in force in March". It carries only the three
-- thresholds that decide the verdict, at the values then configured. The
-- non-nullable columns are copied from the company row rather than left at
-- their schema defaults, so lateness and overtime for history do not move.
-- Everything nullable inherits the baseline.
--
-- Idempotent: nothing is inserted where the policy already exists. One row per
-- company, for every company on the installation.

INSERT INTO "attendance_policies" (
  "id", "companyId", "name", "description",
  "graceMinutes", "halfDayMinutes", "fullDayMinutes", "earlyLeaveGraceMinutes",
  "overtimeEnabled", "overtimeAfterMinutes", "overtimeDailyCapMinutes",
  "fullDayToleranceMinutes", "irregularCheckInCutoff",
  "isActive", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  'History to 11 Sep 2026 (thresholds then in force)',
  'Keeps days up to 11 Sep 2026 scored under the full-day threshold (480), tolerance (30) and irregular cutoff (11:00) that were configured when they were imported. Every other rule inherits the company baseline. Added with the release that made the day status follow the active policy.',
  c."graceMinutes", c."halfDayMinutes", 480, c."earlyLeaveGraceMinutes",
  c."overtimeEnabled", c."overtimeAfterMinutes", c."overtimeDailyCapMinutes",
  30, '11:00',
  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "attendance_policies" p
  WHERE p."companyId" = c."id" AND p."name" = 'History to 11 Sep 2026 (thresholds then in force)'
);

INSERT INTO "attendance_policy_assignments" (
  "id", "companyId", "policyId", "scope", "targetId", "effectiveFrom", "effectiveTo", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text, p."companyId", p."id", 'COMPANY', NULL,
  DATE '2025-01-01', DATE '2026-09-11', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "attendance_policies" p
WHERE p."name" = 'History to 11 Sep 2026 (thresholds then in force)'
  AND NOT EXISTS (
    SELECT 1 FROM "attendance_policy_assignments" a WHERE a."policyId" = p."id"
  );

-- On the audit log like any other policy change, so the settings screen's
-- history explains where the row came from.
INSERT INTO "audit_logs" ("id", "companyId", "actorId", "action", "entityType", "entityId", "summary", "after", "createdAt")
SELECT
  gen_random_uuid()::text, p."companyId", NULL, 'attendance.policy.create', 'AttendancePolicy', p."id",
  'Created attendance policy "History to 11 Sep 2026 (thresholds then in force)" at company scope, 2025-01-01 to 2026-09-11 (applied by migration 20260924120000)',
  jsonb_build_object('fullDayMinutes', 480, 'fullDayToleranceMinutes', 30, 'irregularCheckInCutoff', '11:00', 'scope', 'COMPANY', 'effectiveFrom', '2025-01-01', 'effectiveTo', '2026-09-11'),
  CURRENT_TIMESTAMP
FROM "attendance_policies" p
WHERE p."name" = 'History to 11 Sep 2026 (thresholds then in force)'
  AND NOT EXISTS (
    SELECT 1 FROM "audit_logs" l WHERE l."entityType" = 'AttendancePolicy' AND l."entityId" = p."id"
  );
