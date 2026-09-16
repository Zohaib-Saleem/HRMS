-- Case management (helpdesk), phase 1: the foundation and the employee's side.
--
-- Four tables, two enums and one new enum VALUE. Entirely additive: nothing
-- existing is altered, dropped or backfilled, so this cannot change what any
-- current row means and rolling the application back leaves only unused tables.
--
-- Three decisions are enforced here rather than in application code.
--
-- The first is that a case points at the company's OWN departments. There is no
-- department name copied into this module and no lookup table beside the real
-- one: `case_categories.departmentId` and `cases.departmentId` are foreign keys
-- into `departments`. A helpdesk that kept its own department list would drift
-- from the org chart inside a release.
--
-- The second is the case number. `cases_companyId_caseNumber_key` is what makes
-- CASE-2026-000001 unique under a race - the generator reads the highest number
-- issued this year and retries on this constraint rather than trusting its own
-- read, which is the only arrangement that survives two people clicking Submit
-- at the same moment.
--
-- The third is what is NOT here: there is no company-wide or department-wide
-- read path, because phase 1 has no agent side. Every employee query is pinned
-- to `cases.requesterEmployeeId`, and `cases_requesterEmployeeId_status_createdAt_idx`
-- is the index that makes their whole list, filtered and sorted, one lookup.

-- CreateEnum
CREATE TYPE "CasePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'PENDING', 'ON_HOLD', 'RESOLVED', 'CLOSED', 'REOPENED');

-- AlterEnum: a case update arrives in the same inbox as everything else, but it
-- is not an approval and should not have to pretend to be SYSTEM.
ALTER TYPE "NotificationType" ADD VALUE 'CASE_UPDATE';

-- CreateTable
CREATE TABLE "case_categories" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "parentCategoryId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cases" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "requesterEmployeeId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "subcategoryId" TEXT,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "CasePriority" NOT NULL DEFAULT 'NORMAL',
    "status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
    "assignedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_messages" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "senderUserId" TEXT,
    "message" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_attachments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "messageId" TEXT,
    "uploadedByUserId" TEXT,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the catalogue endpoint's read - this company's live queues, in order.
CREATE INDEX "case_categories_companyId_isActive_sortOrder_idx" ON "case_categories"("companyId", "isActive", "sortOrder");

CREATE INDEX "case_categories_departmentId_isActive_idx" ON "case_categories"("departmentId", "isActive");

CREATE INDEX "case_categories_parentCategoryId_idx" ON "case_categories"("parentCategoryId");

-- CreateIndex: one name per level, per department.
--
-- Honest about its reach: PostgreSQL treats NULLs as distinct, so this holds
-- for SUBCATEGORIES, whose parent is never null, and cannot hold for top-level
-- categories. Duplicate top-level names are refused in the service layer
-- instead - the same place the department hierarchy refuses a cycle.
CREATE UNIQUE INDEX "case_categories_departmentId_parentCategoryId_name_key" ON "case_categories"("departmentId", "parentCategoryId", "name");

-- CreateIndex: one case number per company, and the constraint the generator retries on.
CREATE UNIQUE INDEX "cases_companyId_caseNumber_key" ON "cases"("companyId", "caseNumber");

-- CreateIndex: the employee's own list, filtered and sorted, as one lookup.
CREATE INDEX "cases_requesterEmployeeId_status_createdAt_idx" ON "cases"("requesterEmployeeId", "status", "createdAt");

CREATE INDEX "cases_companyId_status_createdAt_idx" ON "cases"("companyId", "status", "createdAt");

-- CreateIndex: phase 2's queue - a department's open cases, worst first.
CREATE INDEX "cases_companyId_departmentId_status_priority_idx" ON "cases"("companyId", "departmentId", "status", "priority");

CREATE INDEX "cases_companyId_categoryId_idx" ON "cases"("companyId", "categoryId");

CREATE INDEX "cases_assignedUserId_status_idx" ON "cases"("assignedUserId", "status");

CREATE INDEX "cases_companyId_updatedAt_idx" ON "cases"("companyId", "updatedAt");

-- CreateIndex: how a case detail reads its thread - and, for an employee, only
-- the messages that are not staff-only notes.
CREATE INDEX "case_messages_caseId_isInternal_createdAt_idx" ON "case_messages"("caseId", "isInternal", "createdAt");

CREATE INDEX "case_messages_companyId_createdAt_idx" ON "case_messages"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "case_attachments_caseId_isInternal_createdAt_idx" ON "case_attachments"("caseId", "isInternal", "createdAt");

CREATE INDEX "case_attachments_messageId_idx" ON "case_attachments"("messageId");

CREATE INDEX "case_attachments_companyId_createdAt_idx" ON "case_attachments"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "case_categories" ADD CONSTRAINT "case_categories_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "case_categories" ADD CONSTRAINT "case_categories_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "case_categories" ADD CONSTRAINT "case_categories_parentCategoryId_fkey" FOREIGN KEY ("parentCategoryId") REFERENCES "case_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cases" ADD CONSTRAINT "cases_requesterEmployeeId_fkey" FOREIGN KEY ("requesterEmployeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, by omission of a cascade: a department with cases filed against it
-- cannot be deleted out from under them. The same goes for the two category
-- references below - the history of why a case was routed somewhere outlives
-- any tidying of the catalogue.
ALTER TABLE "cases" ADD CONSTRAINT "cases_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cases" ADD CONSTRAINT "cases_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "case_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cases" ADD CONSTRAINT "cases_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "case_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SET NULL: deleting the account of somebody who left must not delete the cases
-- they were working on.
ALTER TABLE "cases" ADD CONSTRAINT "cases_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_messages" ADD CONSTRAINT "case_messages_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "case_messages" ADD CONSTRAINT "case_messages_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "case_messages" ADD CONSTRAINT "case_messages_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "case_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
