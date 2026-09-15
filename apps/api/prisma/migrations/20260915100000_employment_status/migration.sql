-- Employment status: one canonical field, promoted out of free text.
--
-- `employees.confirmationStatus` already held this fact. It arrived with the
-- payroll roster import as free text - "Probation" / "Permanent" as supplied -
-- and both the loan and the medical eligibility engines were already reading it
-- by lowercasing the string and comparing. This migration turns that column
-- into an enum and renames it to say what it is. It does NOT add a second
-- field: the column is renamed in place, so every existing value is carried
-- over and no row loses its history.
--
-- The backfill is an explicit CASE with no ELSE default. Anything the mapping
-- does not recognise becomes NULL rather than being guessed at, and NULL means
-- "nobody has classified this record", which the eligibility engines already
-- treat as saying nothing either way. Silently calling an unknown row PERMANENT
-- would hand out a loan the policy never approved.

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('PROBATION', 'PERMANENT', 'INTERNEE');

-- Rename in place: same column, same data, better name.
ALTER TABLE "employees" RENAME COLUMN "confirmationStatus" TO "employmentStatus";

-- Retype, mapping the wordings the roster actually used. Case- and
-- whitespace-insensitive, because an import is not a controlled vocabulary.
-- 'INTERN'/'INTERNEE' are accepted even though the current data holds none:
-- the mapping should not have to be revisited the first time one appears.
ALTER TABLE "employees"
  ALTER COLUMN "employmentStatus" TYPE "EmploymentStatus"
  USING (
    CASE lower(btrim("employmentStatus"))
      WHEN 'probation' THEN 'PROBATION'
      WHEN 'probationary' THEN 'PROBATION'
      WHEN 'on probation' THEN 'PROBATION'
      WHEN 'permanent' THEN 'PERMANENT'
      WHEN 'confirmed' THEN 'PERMANENT'
      WHEN 'intern' THEN 'INTERNEE'
      WHEN 'internee' THEN 'INTERNEE'
      WHEN 'internship' THEN 'INTERNEE'
      ELSE NULL
    END::"EmploymentStatus"
  );

-- CreateIndex: People and the Employee Master Report both filter on this.
CREATE INDEX "employees_companyId_employmentStatus_idx"
  ON "employees"("companyId", "employmentStatus");

-- Eligible employment statuses, one switch per value, on both benefit policies.
--
-- Defaults preserve today's behaviour exactly. Loans and medical each already
-- refused probation by default and allowed everyone else; `allowPermanent` on
-- loans and `allowInternee` on both are new columns whose defaults reproduce
-- the rule that was previously implicit. No existing policy version changes
-- meaning, which matters because those versions are what past applications were
-- judged against.
ALTER TABLE "loan_policies"
  ADD COLUMN "allowPermanent" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "allowInternee"  BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "medical_policies"
  ADD COLUMN "allowInternee" BOOLEAN NOT NULL DEFAULT false;
