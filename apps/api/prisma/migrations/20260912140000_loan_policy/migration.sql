-- Loan policy: the configurable eligibility rules a loan application is
-- measured against.
--
-- ADDITIVE ONLY. One new table. Nothing else is created, altered or dropped.
--
-- Explicitly NOT touched by this migration - no column added, no row read for
-- writing, no row updated or deleted:
--   employees, employee_salaries, employee_loans, employee_loan_installments,
--   attendance_records, attendance_raw_punches,
--   attendance_device_user_mappings, attendance_regularization_requests,
--   leave_requests, leave_balances, payroll_runs, payroll_run_lines,
--   permissions, role_permissions.
--
-- Existing loans keep their principal, their schedule, their installments and
-- their status. The policy sits in FRONT of the application flow and decides
-- whether a NEW application may be made; it never revisits one already made.
--
-- No row is inserted here either. The first policy version is created on first
-- read, from the defaults in packages/shared/src/dto/loan-policy.ts, so the
-- values a company starts with are the ones the code and the tests agree on.
--
-- Reversible with:
--   DROP TABLE "loan_policies";

-- CreateTable
CREATE TABLE "loan_policies" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "maxSalaryMultiplier" DECIMAL(6,2) NOT NULL DEFAULT 1,
    "minEmploymentMonths" INTEGER NOT NULL DEFAULT 3,
    "allowProbation" BOOLEAN NOT NULL DEFAULT false,
    "minSalary" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "minAttendancePercent" DECIMAL(5,2) NOT NULL DEFAULT 90,
    "maxUnapprovedAbsences" INTEGER NOT NULL DEFAULT 3,
    "maxLateDays" INTEGER NOT NULL DEFAULT 10,
    "maxMissingPunches" INTEGER NOT NULL DEFAULT 3,
    "evaluationMonths" INTEGER NOT NULL DEFAULT 3,
    "maxMonthlyDeductionPercent" DECIMAL(5,2) NOT NULL DEFAULT 30,
    "maxTenureMonths" INTEGER NOT NULL DEFAULT 12,
    "maxInstallments" INTEGER NOT NULL DEFAULT 12,
    "oneActiveLoan" BOOLEAN NOT NULL DEFAULT true,
    "onePendingLoan" BOOLEAN NOT NULL DEFAULT true,
    "blockTerminated" BOOLEAN NOT NULL DEFAULT true,
    "blockResigned" BOOLEAN NOT NULL DEFAULT true,
    "allowHrOverride" BOOLEAN NOT NULL DEFAULT true,
    "requireOverrideReason" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "loan_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loan_policies_companyId_effectiveFrom_idx" ON "loan_policies"("companyId", "effectiveFrom");

-- CreateIndex
-- One version per instant per company: two administrators saving at the same
-- moment cannot leave "the current policy" a matter of row ordering.
CREATE UNIQUE INDEX "loan_policies_companyId_effectiveFrom_key" ON "loan_policies"("companyId", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "loan_policies" ADD CONSTRAINT "loan_policies_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
