-- Loan ledger, case routing rules and premises check-out. Additive only: new
-- enum values, new tables and nullable / defaulted columns. No existing row is
-- read, rewritten or deleted - every flag added here defaults to the
-- behaviour the system had before it existed.
--
--   employee_loan_transactions   append-only ledger behind every settled,
--                                waived or re-dated loan installment
--   PayrollExceptionCode         LOAN_ARREARS warning
--   case_routing_rules           who a new case in a queue goes to
--   companies.checkOutLocationEnforced   web check-out geofence (off)
--   locations.checkOutRadiusMeters       premises boundary (unset)
--   employees.premisesCheckOutAllowed    per-person opt-in (off)
--   attendance_records.checkOut*         who closed the day and from where

-- CreateEnum
CREATE TYPE "LoanTransactionType" AS ENUM ('PAYROLL_DEDUCTION', 'MANUAL_PAYMENT', 'PAYMENT_REVERSAL', 'WAIVER', 'SCHEDULE_CORRECTION');

-- AlterEnum
ALTER TYPE "PayrollExceptionCode" ADD VALUE 'LOAN_ARREARS';

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "checkOutLocationEnforced" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "checkOutRadiusMeters" INTEGER;

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "premisesCheckOutAllowed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN     "checkOutDistanceMeters" INTEGER,
ADD COLUMN     "checkOutLatitude" DOUBLE PRECISION,
ADD COLUMN     "checkOutLongitude" DOUBLE PRECISION,
ADD COLUMN     "checkOutSource" "AttendanceSource";

-- CreateTable
CREATE TABLE "employee_loan_transactions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "installmentId" TEXT,
    "type" "LoanTransactionType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "payrollRunId" TEXT,
    "reference" TEXT,
    "reason" TEXT,
    "reversesId" TEXT,
    "detail" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_loan_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_routing_rules" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "categoryId" TEXT,
    "responsibleUserId" TEXT NOT NULL,
    "backupUserId" TEXT,
    "escalationUserId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_loan_transactions_reversesId_key" ON "employee_loan_transactions"("reversesId");

-- CreateIndex
CREATE INDEX "employee_loan_transactions_loanId_createdAt_idx" ON "employee_loan_transactions"("loanId", "createdAt");

-- CreateIndex
CREATE INDEX "employee_loan_transactions_installmentId_idx" ON "employee_loan_transactions"("installmentId");

-- CreateIndex
CREATE INDEX "employee_loan_transactions_companyId_type_idx" ON "employee_loan_transactions"("companyId", "type");

-- CreateIndex
CREATE INDEX "case_routing_rules_companyId_idx" ON "case_routing_rules"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "case_routing_rules_departmentId_categoryId_key" ON "case_routing_rules"("departmentId", "categoryId");

-- AddForeignKey
ALTER TABLE "employee_loan_transactions" ADD CONSTRAINT "employee_loan_transactions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loan_transactions" ADD CONSTRAINT "employee_loan_transactions_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "employee_loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loan_transactions" ADD CONSTRAINT "employee_loan_transactions_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "employee_loan_installments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loan_transactions" ADD CONSTRAINT "employee_loan_transactions_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "employee_loan_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_routing_rules" ADD CONSTRAINT "case_routing_rules_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_routing_rules" ADD CONSTRAINT "case_routing_rules_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_routing_rules" ADD CONSTRAINT "case_routing_rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "case_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_routing_rules" ADD CONSTRAINT "case_routing_rules_responsibleUserId_fkey" FOREIGN KEY ("responsibleUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_routing_rules" ADD CONSTRAINT "case_routing_rules_backupUserId_fkey" FOREIGN KEY ("backupUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_routing_rules" ADD CONSTRAINT "case_routing_rules_escalationUserId_fkey" FOREIGN KEY ("escalationUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One department default per department. The composite unique above cannot
-- hold it: PostgreSQL treats the null category of every default as distinct.
CREATE UNIQUE INDEX "case_routing_rules_department_default_key" ON "case_routing_rules"("departmentId") WHERE "categoryId" IS NULL;
