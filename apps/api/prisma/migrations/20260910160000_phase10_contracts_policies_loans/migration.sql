-- CreateEnum
CREATE TYPE "CompanyLinkKind" AS ENUM ('WEBSITE', 'LINKEDIN', 'FACEBOOK', 'INSTAGRAM', 'X', 'YOUTUBE', 'DISCORD', 'GITHUB', 'CAREERS', 'OTHER');

-- CreateEnum
CREATE TYPE "EmployeeContractType" AS ENUM ('PERMANENT', 'FIXED_TERM', 'PROBATION', 'INTERNSHIP', 'CONSULTANCY', 'PART_TIME', 'TEMPORARY');

-- CreateEnum
CREATE TYPE "EmployeeContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED', 'RENEWED');

-- CreateEnum
CREATE TYPE "PolicyAcknowledgementStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'DECLINED');

-- CreateEnum
CREATE TYPE "EmployeeLoanStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LoanInstallmentStatus" AS ENUM ('SCHEDULED', 'PENDING_PAYROLL', 'PAID', 'WAIVED', 'SKIPPED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EmployeeStatus" ADD VALUE 'INACTIVE';
ALTER TYPE "EmployeeStatus" ADD VALUE 'RESIGNED';

-- AlterEnum
ALTER TYPE "ApprovalSubjectType" ADD VALUE 'LOAN_REQUEST';

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "resignationDate" DATE;

-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN     "documentName" TEXT,
ADD COLUMN     "documentUrl" TEXT;

-- CreateTable
CREATE TABLE "company_links" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "CompanyLinkKind" NOT NULL DEFAULT 'OTHER',
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_contracts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "contractType" "EmployeeContractType" NOT NULL DEFAULT 'PERMANENT',
    "status" "EmployeeContractStatus" NOT NULL DEFAULT 'ACTIVE',
    "reference" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "documentUrl" TEXT,
    "documentName" TEXT,
    "previousContractId" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_policies" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "category" TEXT,
    "description" TEXT,
    "effectiveDate" DATE NOT NULL,
    "documentUrl" TEXT,
    "documentName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "supersedesId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_policy_assignments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "PolicyAcknowledgementStatus" NOT NULL DEFAULT 'PENDING',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT,
    "dueDate" DATE,
    "acknowledgedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_policy_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_revisions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "previousSalaryId" TEXT,
    "salaryId" TEXT,
    "salaryType" "PayrollSalaryType" NOT NULL DEFAULT 'MONTHLY',
    "currency" CHAR(3) NOT NULL,
    "currentAmount" DECIMAL(14,2) NOT NULL,
    "newAmount" DECIMAL(14,2) NOT NULL,
    "incrementAmount" DECIMAL(14,2) NOT NULL,
    "incrementPercent" DECIMAL(8,2) NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "approvedByUserId" TEXT,
    "approvedByName" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_loans" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reference" TEXT,
    "principalAmount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "installmentCount" INTEGER NOT NULL,
    "monthlyDeduction" DECIMAL(14,2) NOT NULL,
    "startMonth" DATE NOT NULL,
    "status" "EmployeeLoanStatus" NOT NULL DEFAULT 'PENDING',
    "purpose" TEXT,
    "notes" TEXT,
    "requestedByUserId" TEXT,
    "requestedAt" TIMESTAMP(3),
    "approvalRequestId" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "activatedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_loan_installments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "dueMonth" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "LoanInstallmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "payrollRunId" TEXT,
    "paidAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_loan_installments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_links_companyId_isActive_displayOrder_idx" ON "company_links"("companyId", "isActive", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "company_links_companyId_label_key" ON "company_links"("companyId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "employee_contracts_previousContractId_key" ON "employee_contracts"("previousContractId");

-- CreateIndex
CREATE INDEX "employee_contracts_companyId_status_idx" ON "employee_contracts"("companyId", "status");

-- CreateIndex
CREATE INDEX "employee_contracts_employeeId_startDate_idx" ON "employee_contracts"("employeeId", "startDate");

-- CreateIndex
CREATE INDEX "employee_contracts_companyId_endDate_idx" ON "employee_contracts"("companyId", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "company_policies_supersedesId_key" ON "company_policies"("supersedesId");

-- CreateIndex
CREATE INDEX "company_policies_companyId_isActive_idx" ON "company_policies"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "company_policies_companyId_name_version_key" ON "company_policies"("companyId", "name", "version");

-- CreateIndex
CREATE INDEX "employee_policy_assignments_companyId_status_idx" ON "employee_policy_assignments"("companyId", "status");

-- CreateIndex
CREATE INDEX "employee_policy_assignments_employeeId_assignedAt_idx" ON "employee_policy_assignments"("employeeId", "assignedAt");

-- CreateIndex
CREATE UNIQUE INDEX "employee_policy_assignments_policyId_employeeId_key" ON "employee_policy_assignments"("policyId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "salary_revisions_salaryId_key" ON "salary_revisions"("salaryId");

-- CreateIndex
CREATE INDEX "salary_revisions_employeeId_effectiveDate_idx" ON "salary_revisions"("employeeId", "effectiveDate");

-- CreateIndex
CREATE INDEX "salary_revisions_companyId_effectiveDate_idx" ON "salary_revisions"("companyId", "effectiveDate");

-- CreateIndex
CREATE UNIQUE INDEX "employee_loans_approvalRequestId_key" ON "employee_loans"("approvalRequestId");

-- CreateIndex
CREATE INDEX "employee_loans_companyId_status_idx" ON "employee_loans"("companyId", "status");

-- CreateIndex
CREATE INDEX "employee_loans_employeeId_status_idx" ON "employee_loans"("employeeId", "status");

-- CreateIndex
CREATE INDEX "employee_loan_installments_employeeId_dueMonth_idx" ON "employee_loan_installments"("employeeId", "dueMonth");

-- CreateIndex
CREATE INDEX "employee_loan_installments_companyId_status_dueMonth_idx" ON "employee_loan_installments"("companyId", "status", "dueMonth");

-- CreateIndex
CREATE INDEX "employee_loan_installments_payrollRunId_idx" ON "employee_loan_installments"("payrollRunId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_loan_installments_loanId_sequence_key" ON "employee_loan_installments"("loanId", "sequence");

-- AddForeignKey
ALTER TABLE "company_links" ADD CONSTRAINT "company_links_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_previousContractId_fkey" FOREIGN KEY ("previousContractId") REFERENCES "employee_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_policies" ADD CONSTRAINT "company_policies_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_policies" ADD CONSTRAINT "company_policies_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "company_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_policy_assignments" ADD CONSTRAINT "employee_policy_assignments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_policy_assignments" ADD CONSTRAINT "employee_policy_assignments_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "company_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_policy_assignments" ADD CONSTRAINT "employee_policy_assignments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_revisions" ADD CONSTRAINT "salary_revisions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_revisions" ADD CONSTRAINT "salary_revisions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_revisions" ADD CONSTRAINT "salary_revisions_salaryId_fkey" FOREIGN KEY ("salaryId") REFERENCES "employee_salaries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loans" ADD CONSTRAINT "employee_loans_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loans" ADD CONSTRAINT "employee_loans_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loan_installments" ADD CONSTRAINT "employee_loan_installments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loan_installments" ADD CONSTRAINT "employee_loan_installments_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "employee_loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loan_installments" ADD CONSTRAINT "employee_loan_installments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loan_installments" ADD CONSTRAINT "employee_loan_installments_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

