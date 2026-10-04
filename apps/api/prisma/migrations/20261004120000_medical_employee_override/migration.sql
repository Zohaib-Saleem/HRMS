-- Per-employee medical override: HR's eligibility decision and an individual
-- annual limit. Additive and nullable; every existing employee keeps following
-- the policy.
CREATE TYPE "MedicalEligibilityOverride" AS ENUM ('ELIGIBLE', 'NOT_ELIGIBLE');

ALTER TABLE "employees"
  ADD COLUMN "medicalEligibilityOverride" "MedicalEligibilityOverride",
  ADD COLUMN "medicalAnnualLimitOverride" DECIMAL(14,2),
  ADD COLUMN "medicalOverrideNote" TEXT;
