-- Salary advances: a kind on the loan, and a ceiling on the policy.
-- Additive only. Every existing loan is a LOAN; every policy version gets 50%.
CREATE TYPE "LoanKind" AS ENUM ('LOAN', 'SALARY_ADVANCE');

ALTER TABLE "employee_loans" ADD COLUMN "kind" "LoanKind" NOT NULL DEFAULT 'LOAN';
CREATE INDEX "employee_loans_companyId_kind_idx" ON "employee_loans"("companyId", "kind");

ALTER TABLE "loan_policies" ADD COLUMN "advanceMaxSalaryPercent" DECIMAL(5,2) NOT NULL DEFAULT 50;
