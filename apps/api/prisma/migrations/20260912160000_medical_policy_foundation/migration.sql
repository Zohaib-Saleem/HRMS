-- Medical policy foundation: the configurable medical benefit, the dependents
-- it can extend to, and the claim table the benefit totals are summed from.
--
-- ADDITIVE ONLY. Four new tables and four new enum types. Nothing existing is
-- created, altered or dropped - there is not one ALTER TABLE below against a
-- table that already exists, and not one DROP of any kind.
--
-- Explicitly NOT touched by this migration - no column added, no row read for
-- writing, no row updated or deleted:
--   employees, employee_salaries, employee_loans, employee_loan_installments,
--   loan_policies, attendance_records, attendance_raw_punches,
--   attendance_device_user_mappings, attendance_regularization_requests,
--   leave_requests, leave_balances, payroll_runs, payroll_run_lines, payslips,
--   companies, users, permissions, role_permissions.
--
-- The four new FOREIGN KEY constraints point FROM the new tables TO companies,
-- employees and each other. A foreign key is declared on the referencing table,
-- so companies and employees are read for validation and are never written.
-- Existing loans keep their principal, their schedule, their installments and
-- their status; the loan policy is not read, referenced or altered here.
--
-- No row is inserted either. The first medical policy version is created on
-- first read, from the defaults in packages/shared/src/dto/medical-policy.ts,
-- so the values a company starts with are the ones the code and the tests
-- agree on rather than a copy of them that can drift.
--
-- Reversible with:
--   DROP TABLE "medical_claims";
--   DROP TABLE "medical_dependents";
--   DROP TABLE "medical_policy_categories";
--   DROP TABLE "medical_policies";
--   DROP TYPE "MedicalClaimStatus";
--   DROP TYPE "MedicalDependentStatus";
--   DROP TYPE "MedicalDependentRelationship";
--   DROP TYPE "MedicalCategory";

-- CreateEnum
CREATE TYPE "MedicalCategory" AS ENUM ('OPD', 'HOSPITALIZATION', 'MEDICINES', 'DIAGNOSTICS', 'DENTAL', 'OPTICAL', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "MedicalDependentRelationship" AS ENUM ('SPOUSE', 'CHILD', 'PARENT');

-- CreateEnum
CREATE TYPE "MedicalDependentStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MedicalClaimStatus" AS ENUM ('PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'CANCELLED', 'PAID');

-- CreateTable
CREATE TABLE "medical_policies" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "policyName" TEXT NOT NULL DEFAULT 'Company Medical Benefit',
    "description" TEXT NOT NULL DEFAULT '',
    "minEmploymentMonths" INTEGER NOT NULL DEFAULT 3,
    "allowProbation" BOOLEAN NOT NULL DEFAULT false,
    "allowPermanent" BOOLEAN NOT NULL DEFAULT true,
    "blockResigned" BOOLEAN NOT NULL DEFAULT true,
    "blockTerminated" BOOLEAN NOT NULL DEFAULT true,
    "annualLimitPerEmployee" DECIMAL(14,2) NOT NULL DEFAULT 100000,
    "spouseCovered" BOOLEAN NOT NULL DEFAULT true,
    "childrenCovered" BOOLEAN NOT NULL DEFAULT true,
    "maxChildren" INTEGER NOT NULL DEFAULT 4,
    "parentsCovered" BOOLEAN NOT NULL DEFAULT false,
    "maxParents" INTEGER NOT NULL DEFAULT 2,
    "dependentsShareEmployeeLimit" BOOLEAN NOT NULL DEFAULT true,
    "dependentAnnualLimit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "requireReceipt" BOOLEAN NOT NULL DEFAULT true,
    "requirePrescription" BOOLEAN NOT NULL DEFAULT false,
    "requireDiagnosis" BOOLEAN NOT NULL DEFAULT false,
    "requireHospitalName" BOOLEAN NOT NULL DEFAULT true,
    "requireTreatmentDate" BOOLEAN NOT NULL DEFAULT true,
    "claimSubmissionDeadlineDays" INTEGER NOT NULL DEFAULT 30,
    "allowBackdatedClaims" BOOLEAN NOT NULL DEFAULT true,
    "maxBackdatedDays" INTEGER NOT NULL DEFAULT 30,
    "requireHrApproval" BOOLEAN NOT NULL DEFAULT true,
    "allowPartialApproval" BOOLEAN NOT NULL DEFAULT true,
    "allowEmployeeCancelPending" BOOLEAN NOT NULL DEFAULT true,
    "allowHrOverride" BOOLEAN NOT NULL DEFAULT true,
    "requireOverrideReason" BOOLEAN NOT NULL DEFAULT true,
    "allowCarryForward" BOOLEAN NOT NULL DEFAULT false,
    "maxCarryForwardAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "medical_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_policy_categories" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "category" "MedicalCategory" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "annualLimit" DECIMAL(14,2),
    "maxClaimAmount" DECIMAL(14,2),
    "companyContributionPercent" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "employeeContributionPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,

    CONSTRAINT "medical_policy_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_dependents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" "MedicalDependentRelationship" NOT NULL,
    "dateOfBirth" DATE,
    "gender" "Gender",
    "status" "MedicalDependentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medical_dependents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_claims" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "dependentId" TEXT,
    "category" "MedicalCategory" NOT NULL,
    "treatmentDate" DATE NOT NULL,
    "providerName" TEXT,
    "requestedAmount" DECIMAL(14,2) NOT NULL,
    "approvedAmount" DECIMAL(14,2),
    "companyAmount" DECIMAL(14,2),
    "employeeAmount" DECIMAL(14,2),
    "status" "MedicalClaimStatus" NOT NULL DEFAULT 'PENDING',
    "policyId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "rejectionReason" TEXT,
    "overrideReason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medical_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "medical_policies_companyId_effectiveFrom_idx" ON "medical_policies"("companyId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "medical_policies_companyId_effectiveFrom_key" ON "medical_policies"("companyId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "medical_policy_categories_policyId_idx" ON "medical_policy_categories"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "medical_policy_categories_policyId_category_key" ON "medical_policy_categories"("policyId", "category");

-- CreateIndex
CREATE INDEX "medical_dependents_companyId_employeeId_idx" ON "medical_dependents"("companyId", "employeeId");

-- CreateIndex
CREATE INDEX "medical_dependents_employeeId_relationship_createdAt_idx" ON "medical_dependents"("employeeId", "relationship", "createdAt");

-- CreateIndex
CREATE INDEX "medical_claims_companyId_status_idx" ON "medical_claims"("companyId", "status");

-- CreateIndex
CREATE INDEX "medical_claims_employeeId_status_treatmentDate_idx" ON "medical_claims"("employeeId", "status", "treatmentDate");

-- CreateIndex
CREATE INDEX "medical_claims_policyId_idx" ON "medical_claims"("policyId");

-- AddForeignKey
ALTER TABLE "medical_policies" ADD CONSTRAINT "medical_policies_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_policy_categories" ADD CONSTRAINT "medical_policy_categories_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "medical_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_dependents" ADD CONSTRAINT "medical_dependents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_dependents" ADD CONSTRAINT "medical_dependents_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_claims" ADD CONSTRAINT "medical_claims_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_claims" ADD CONSTRAINT "medical_claims_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_claims" ADD CONSTRAINT "medical_claims_dependentId_fkey" FOREIGN KEY ("dependentId") REFERENCES "medical_dependents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_claims" ADD CONSTRAINT "medical_claims_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "medical_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

