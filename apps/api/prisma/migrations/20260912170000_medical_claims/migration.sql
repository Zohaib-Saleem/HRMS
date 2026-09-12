-- Medical claims: the submission, decision and payment of a claim against the
-- medical policy foundation.
--
-- ADDITIVE ONLY, with one widening. One new table, one new enum type, six new
-- nullable-or-empty columns on `medical_claims`, and one NOT NULL that is
-- dropped. Nothing is deleted and no existing value is rewritten.
--
-- Explicitly NOT touched by this migration - no column added, no row read for
-- writing, no row updated or deleted:
--   employees, employee_salaries, employee_loans, employee_loan_installments,
--   loan_policies, attendance_records, attendance_raw_punches,
--   attendance_device_user_mappings, attendance_regularization_requests,
--   leave_requests, leave_balances, payroll_runs, payroll_run_lines, payslips,
--   companies, users, permissions, role_permissions,
--   medical_policies, medical_policy_categories, medical_dependents.
--
-- On the two statements that need justifying:
--
--   ADD COLUMN "claimNumber" TEXT NOT NULL
--     Adding a NOT NULL column with no default fails against a table that has
--     rows. `medical_claims` has none and can have none: it was created by
--     20260912160000_medical_policy_foundation with no writer anywhere in the
--     product, and this release is the first code that inserts into it. The
--     preceding migration and this one are the whole life of the table.
--
--   ALTER COLUMN "treatmentDate" DROP NOT NULL
--     A widening, so no existing value can violate it. It is here because
--     `requireTreatmentDate` is a policy switch: a column that cannot be empty
--     would make switching it off unimplementable, which is exactly the
--     hardcoded-company-rule failure this module exists to avoid.
--
-- No row is inserted. Claim numbers are generated per company at submission,
-- and the unique index below is what actually guarantees they do not collide.
--
-- Reversible with:
--   DROP TABLE "medical_claim_documents";
--   DROP TYPE "MedicalClaimDocumentType";
--   DROP INDEX "medical_claims_companyId_claimNumber_key";
--   ALTER TABLE "medical_claims"
--     DROP COLUMN "claimNumber", DROP COLUMN "notes", DROP COLUMN "decisionNote",
--     DROP COLUMN "cancelledByUserId", DROP COLUMN "paidByUserId",
--     DROP COLUMN "paymentReference",
--     ALTER COLUMN "treatmentDate" SET NOT NULL;

-- CreateEnum
CREATE TYPE "MedicalClaimDocumentType" AS ENUM ('RECEIPT', 'PRESCRIPTION', 'DIAGNOSIS', 'OTHER');

-- AlterTable
ALTER TABLE "medical_claims" ADD COLUMN     "cancelledByUserId" TEXT,
ADD COLUMN     "claimNumber" TEXT NOT NULL,
ADD COLUMN     "decisionNote" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "paidByUserId" TEXT,
ADD COLUMN     "paymentReference" TEXT,
ALTER COLUMN "treatmentDate" DROP NOT NULL;

-- CreateTable
CREATE TABLE "medical_claim_documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "type" "MedicalClaimDocumentType" NOT NULL,
    "reference" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medical_claim_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "medical_claim_documents_claimId_idx" ON "medical_claim_documents"("claimId");

-- CreateIndex
CREATE INDEX "medical_claim_documents_companyId_type_idx" ON "medical_claim_documents"("companyId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "medical_claims_companyId_claimNumber_key" ON "medical_claims"("companyId", "claimNumber");

-- AddForeignKey
ALTER TABLE "medical_claim_documents" ADD CONSTRAINT "medical_claim_documents_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "medical_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

