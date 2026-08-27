-- CreateEnum
CREATE TYPE "AttendancePolicyScope" AS ENUM ('COMPANY', 'DEPARTMENT', 'TEAM', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "TimesheetEntrySource" AS ENUM ('MANUAL', 'CAPTURED');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "allowedCheckInCidrs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "ipRestrictionEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "timesheet_entries" ADD COLUMN     "attendanceRecordId" TEXT,
ADD COLUMN     "source" "TimesheetEntrySource" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "attendance_policies" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "graceMinutes" INTEGER NOT NULL DEFAULT 10,
    "halfDayMinutes" INTEGER NOT NULL DEFAULT 240,
    "fullDayMinutes" INTEGER NOT NULL DEFAULT 480,
    "earlyLeaveGraceMinutes" INTEGER NOT NULL DEFAULT 10,
    "overtimeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "overtimeAfterMinutes" INTEGER NOT NULL DEFAULT 480,
    "overtimeDailyCapMinutes" INTEGER NOT NULL DEFAULT 240,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_policy_assignments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "scope" "AttendancePolicyScope" NOT NULL,
    "targetId" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_policy_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_policies_companyId_isActive_idx" ON "attendance_policies"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_policies_companyId_name_key" ON "attendance_policies"("companyId", "name");

-- CreateIndex
CREATE INDEX "attendance_policy_assignments_companyId_scope_targetId_idx" ON "attendance_policy_assignments"("companyId", "scope", "targetId");

-- CreateIndex
CREATE INDEX "attendance_policy_assignments_policyId_idx" ON "attendance_policy_assignments"("policyId");

-- AddForeignKey
ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_policy_assignments" ADD CONSTRAINT "attendance_policy_assignments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_policy_assignments" ADD CONSTRAINT "attendance_policy_assignments_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "attendance_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
