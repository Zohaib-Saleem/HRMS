-- Teams stop being children of departments.
--
-- Department and Team are two INDEPENDENT dimensions of the organisation: an
-- employee is in a department AND on a team, and the team is not a sub-unit of
-- the department. Until now `teams.departmentId` was NOT NULL, so every team
-- had to name a department, and a team that did not belong under one could
-- only be created by inventing a department to hold it.
--
-- THIS MIGRATION IS ADDITIVE AND LOSSLESS.
--   * No team row is deleted, renamed or re-pointed.
--   * No employee's departmentId or teamId is touched. Those two columns were
--     already separate and already held the right answers.
--   * `teams.departmentId` KEEPS whatever it holds. It only stops being
--     required, and nothing in the application reads it any more. A rollback
--     that restores NOT NULL therefore still finds every old value in place.

-- 1. The requirement itself.
ALTER TABLE "teams" ALTER COLUMN "departmentId" DROP NOT NULL;

-- 2. Deleting a department must no longer delete the teams that pointed at it.
--    Under the old model that cascade was correct - a child dies with its
--    parent. Under this one it would destroy independent teams as collateral,
--    so the reference is cleared instead.
ALTER TABLE "teams" DROP CONSTRAINT "teams_departmentId_fkey";
ALTER TABLE "teams"
  ADD CONSTRAINT "teams_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Team names were unique PER DEPARTMENT. With the department gone from a
--    team's identity that index enforces nothing useful - and worse, Postgres
--    treats NULLs as distinct, so every department-less team could repeat any
--    name freely. Uniqueness moves to the company, which is the scope a team
--    name now lives in.
--
--    Safe to create: at the time of writing every team name in this database
--    is already distinct within its company. Should a future database hold a
--    collision, this statement fails and the migration stops WITHOUT having
--    changed anything in step 4 - nothing is lost, the duplicate is renamed by
--    hand and the migration is re-run.
DROP INDEX "teams_departmentId_name_key";
CREATE UNIQUE INDEX "teams_companyId_name_key" ON "teams"("companyId", "name");

-- 4. The old unique index was also the only index on departmentId, and the FK
--    still needs one for the ON DELETE SET NULL above to be cheap.
CREATE INDEX "teams_departmentId_idx" ON "teams"("departmentId");
