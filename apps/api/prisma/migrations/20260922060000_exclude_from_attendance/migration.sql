-- Somebody who never punches is outside the attendance question, rather than
-- absent every working day. Additive and defaulted, so every existing employee
-- keeps being counted exactly as before.
ALTER TABLE "employees" ADD COLUMN "excludedFromAttendance" BOOLEAN NOT NULL DEFAULT false;

-- The nightly absence job and every attendance screen filter on this column
-- together with the employment window, so it is read on the same paths.
CREATE INDEX "employees_companyId_excludedFromAttendance_idx"
  ON "employees"("companyId", "excludedFromAttendance");
