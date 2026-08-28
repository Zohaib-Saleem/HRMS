-- CreateEnum
CREATE TYPE "PayrollSalaryType" AS ENUM ('MONTHLY', 'DAILY', 'HOURLY');

-- CreateEnum
CREATE TYPE "PayrollBasis" AS ENUM ('CALENDAR_DAYS', 'FIXED_DAYS', 'WORKING_DAYS');

-- CreateEnum
CREATE TYPE "PayrollOvertimeMode" AS ENUM ('NONE', 'MULTIPLIER', 'FIXED_RATE');

-- CreateEnum
CREATE TYPE "PayrollTimeDeductionMode" AS ENUM ('NONE', 'PER_MINUTE', 'PER_OCCURRENCE');

-- CreateEnum
CREATE TYPE "PayrollComponentKind" AS ENUM ('EARNING', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "PayrollComponentCalc" AS ENUM ('FIXED', 'PERCENT_OF_BASIC', 'PERCENT_OF_GROSS');

-- CreateEnum
CREATE TYPE "PayrollComponentFrequency" AS ENUM ('RECURRING', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "PayrollPeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'CALCULATING', 'REVIEW', 'APPROVED', 'FINALIZED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayrollExceptionCode" AS ENUM ('MISSING_SALARY', 'MISSING_PROFILE', 'OVERLAPPING_SALARY', 'INVALID_ATTENDANCE', 'MISSING_SHIFT', 'UNAPPROVED_OVERTIME', 'NON_POSITIVE_NET', 'INCOMPLETE_EMPLOYEE');

-- CreateEnum
CREATE TYPE "PayrollExceptionSeverity" AS ENUM ('BLOCKING', 'WARNING');

-- CreateTable
CREATE TABLE "payroll_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "basis" "PayrollBasis" NOT NULL DEFAULT 'FIXED_DAYS',
    "fixedBasisDays" INTEGER NOT NULL DEFAULT 30,
    "standardHoursPerDay" DECIMAL(6,2) NOT NULL DEFAULT 8,
    "overtimeMode" "PayrollOvertimeMode" NOT NULL DEFAULT 'MULTIPLIER',
    "overtimeMultiplier" DECIMAL(6,3) NOT NULL DEFAULT 1.5,
    "overtimeFixedRate" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "requireApprovedOvertime" BOOLEAN NOT NULL DEFAULT true,
    "deductUnpaidAbsence" BOOLEAN NOT NULL DEFAULT true,
    "deductUnpaidLeave" BOOLEAN NOT NULL DEFAULT true,
    "lateDeductionMode" "PayrollTimeDeductionMode" NOT NULL DEFAULT 'NONE',
    "lateDeductionRate" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "lateGraceMinutes" INTEGER NOT NULL DEFAULT 0,
    "earlyLeaveDeductionMode" "PayrollTimeDeductionMode" NOT NULL DEFAULT 'NONE',
    "earlyLeaveDeductionRate" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "earlyLeaveGraceMinutes" INTEGER NOT NULL DEFAULT 0,
    "roundingDecimals" INTEGER NOT NULL DEFAULT 2,
    "payslipPrefix" TEXT NOT NULL DEFAULT 'PS-',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_profiles" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "basis" "PayrollBasis",
    "fixedBasisDays" INTEGER,
    "standardHoursPerDay" DECIMAL(6,2),
    "overtimeMode" "PayrollOvertimeMode",
    "overtimeMultiplier" DECIMAL(6,3),
    "overtimeFixedRate" DECIMAL(14,4),
    "hourlyRateOverride" DECIMAL(14,4),
    "deductUnpaidAbsence" BOOLEAN,
    "deductUnpaidLeave" BOOLEAN,
    "paymentMethod" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_salaries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "salaryType" "PayrollSalaryType" NOT NULL DEFAULT 'MONTHLY',
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_salaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_components" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "kind" "PayrollComponentKind" NOT NULL,
    "calc" "PayrollComponentCalc" NOT NULL DEFAULT 'FIXED',
    "isTaxable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_salary_components" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "value" DECIMAL(14,4) NOT NULL,
    "frequency" "PayrollComponentFrequency" NOT NULL DEFAULT 'RECURRING',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_salary_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_periods" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "payDate" DATE,
    "status" "PayrollPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "currency" CHAR(3) NOT NULL,
    "employeeCount" INTEGER NOT NULL DEFAULT 0,
    "grossTotal" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "deductionTotal" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "netTotal" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "exceptionCount" INTEGER NOT NULL DEFAULT 0,
    "blockingCount" INTEGER NOT NULL DEFAULT 0,
    "calculatedAt" TIMESTAMP(3),
    "calculatedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "finalizedBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "calculationStartedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_lines" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "salaryType" "PayrollSalaryType" NOT NULL,
    "salaryAmount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "basis" "PayrollBasis" NOT NULL,
    "basisDays" DECIMAL(8,2) NOT NULL,
    "dailyRate" DECIMAL(14,4) NOT NULL,
    "hourlyRate" DECIMAL(14,4) NOT NULL,
    "salarySegments" INTEGER NOT NULL DEFAULT 1,
    "scheduledDays" DECIMAL(8,2) NOT NULL,
    "scheduledMinutes" INTEGER NOT NULL DEFAULT 0,
    "presentDays" DECIMAL(8,2) NOT NULL,
    "halfDays" DECIMAL(8,2) NOT NULL,
    "absentDays" DECIMAL(8,2) NOT NULL,
    "paidLeaveDays" DECIMAL(8,2) NOT NULL,
    "unpaidLeaveDays" DECIMAL(8,2) NOT NULL,
    "holidayDays" DECIMAL(8,2) NOT NULL,
    "weekendDays" DECIMAL(8,2) NOT NULL,
    "payableDays" DECIMAL(8,2) NOT NULL,
    "unpaidDays" DECIMAL(8,2) NOT NULL,
    "workedMinutes" INTEGER NOT NULL DEFAULT 0,
    "lateOccurrences" INTEGER NOT NULL DEFAULT 0,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "earlyLeaveOccurrences" INTEGER NOT NULL DEFAULT 0,
    "earlyLeaveMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "approvedOvertimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "basicAmount" DECIMAL(14,2) NOT NULL,
    "earningsTotal" DECIMAL(14,2) NOT NULL,
    "overtimeAmount" DECIMAL(14,2) NOT NULL,
    "deductionsTotal" DECIMAL(14,2) NOT NULL,
    "adjustmentTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grossAmount" DECIMAL(14,2) NOT NULL,
    "netAmount" DECIMAL(14,2) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_earnings" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "componentId" TEXT,
    "code" TEXT,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'COMPONENT',
    "calc" "PayrollComponentCalc" NOT NULL DEFAULT 'FIXED',
    "rate" DECIMAL(14,4),
    "amount" DECIMAL(14,2) NOT NULL,
    "isTaxable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_deductions" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "componentId" TEXT,
    "code" TEXT,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'COMPONENT',
    "calc" "PayrollComponentCalc" NOT NULL DEFAULT 'FIXED',
    "rate" DECIMAL(14,4),
    "units" DECIMAL(10,2),
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_deductions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_adjustments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "originLineId" TEXT,
    "appliedRunId" TEXT,
    "kind" "PayrollComponentKind" NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_exceptions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "lineId" TEXT,
    "employeeId" TEXT,
    "code" "PayrollExceptionCode" NOT NULL,
    "severity" "PayrollExceptionSeverity" NOT NULL DEFAULT 'BLOCKING',
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payroll_settings_companyId_key" ON "payroll_settings"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_profiles_employeeId_key" ON "payroll_profiles"("employeeId");

-- CreateIndex
CREATE INDEX "payroll_profiles_companyId_isActive_idx" ON "payroll_profiles"("companyId", "isActive");

-- CreateIndex
CREATE INDEX "employee_salaries_employeeId_effectiveFrom_idx" ON "employee_salaries"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "employee_salaries_companyId_effectiveFrom_idx" ON "employee_salaries"("companyId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "salary_components_companyId_kind_isActive_idx" ON "salary_components"("companyId", "kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "salary_components_companyId_name_key" ON "salary_components"("companyId", "name");

-- CreateIndex
CREATE INDEX "employee_salary_components_employeeId_effectiveFrom_idx" ON "employee_salary_components"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "employee_salary_components_companyId_componentId_idx" ON "employee_salary_components"("companyId", "componentId");

-- CreateIndex
CREATE INDEX "payroll_periods_companyId_status_idx" ON "payroll_periods"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_companyId_startDate_endDate_key" ON "payroll_periods"("companyId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "payroll_runs_companyId_status_idx" ON "payroll_runs"("companyId", "status");

-- CreateIndex
CREATE INDEX "payroll_runs_periodId_status_idx" ON "payroll_runs"("periodId", "status");

-- CreateIndex
CREATE INDEX "payroll_lines_companyId_employeeId_idx" ON "payroll_lines"("companyId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_runId_employeeId_key" ON "payroll_lines"("runId", "employeeId");

-- CreateIndex
CREATE INDEX "payroll_earnings_lineId_idx" ON "payroll_earnings"("lineId");

-- CreateIndex
CREATE INDEX "payroll_deductions_lineId_idx" ON "payroll_deductions"("lineId");

-- CreateIndex
CREATE INDEX "payroll_adjustments_companyId_employeeId_idx" ON "payroll_adjustments"("companyId", "employeeId");

-- CreateIndex
CREATE INDEX "payroll_adjustments_appliedRunId_idx" ON "payroll_adjustments"("appliedRunId");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_lineId_key" ON "payslips"("lineId");

-- CreateIndex
CREATE INDEX "payslips_employeeId_issuedAt_idx" ON "payslips"("employeeId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_companyId_number_key" ON "payslips"("companyId", "number");

-- CreateIndex
CREATE INDEX "payroll_exceptions_runId_severity_idx" ON "payroll_exceptions"("runId", "severity");

-- CreateIndex
CREATE INDEX "payroll_exceptions_companyId_code_idx" ON "payroll_exceptions"("companyId", "code");

-- AddForeignKey
ALTER TABLE "payroll_settings" ADD CONSTRAINT "payroll_settings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_profiles" ADD CONSTRAINT "payroll_profiles_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_profiles" ADD CONSTRAINT "payroll_profiles_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_components" ADD CONSTRAINT "salary_components_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary_components" ADD CONSTRAINT "employee_salary_components_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary_components" ADD CONSTRAINT "employee_salary_components_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary_components" ADD CONSTRAINT "employee_salary_components_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "salary_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "payroll_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_earnings" ADD CONSTRAINT "payroll_earnings_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "payroll_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "payroll_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "payroll_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "payroll_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
