-- Asset management, step 2: the lifecycle.
--
-- Three tables, five enums and columns added to the two tables step 1 created.
-- ENTIRELY ADDITIVE: every ALTER is an ADD COLUMN, no column changes type, no
-- column is dropped, no existing row is written and no table outside this
-- module is touched. `companies`, `employees`, `users`, `departments`,
-- `locations` and `audit_logs` gain nothing but inbound foreign keys. Rolling
-- the application back leaves unused tables and unread columns behind and
-- nothing else.
--
-- The decisions this file enforces, rather than hoping application code will:
--
-- ONE ACTIVE ASSIGNMENT PER ASSET, still without a partial index. Step 1
-- recorded why one is not used (Prisma cannot describe it and would drop it on
-- the next migration) and left the rule to the service layer. Step 2 makes it a
-- real database guarantee anyway, by a different route: the ASSET ROW IS THE
-- LOCK. Assigning is `UPDATE assets SET status='ASSIGNED' WHERE id=$1 AND
-- status IN ('AVAILABLE','RETURNED')`, and the service refuses unless exactly
-- one row was affected. Two people assigning the same laptop in the same second
-- produce one assignment and one 422, because the second UPDATE matches nothing.
-- Returning and transferring lock on the ACTIVE ASSIGNMENT ROW the same way.
-- Neither is a hopeful read-then-write.
--
-- HISTORY IS APPENDED, NEVER OVERWRITTEN. A transfer does not edit the previous
-- assignment's employee - it closes that row as TRANSFERRED and inserts a new
-- one. `asset_assignments_previousAssignmentId_key` is what makes the chain a
-- chain: one closed handover can have at most one successor, so
-- "Muhammad -> Ahmed -> Sana" is a sequence rather than three rows that happen
-- to share an asset.
--
-- A REPAIR DOES NOT UN-ASSIGN ANYBODY. `asset_repairs.statusBeforeRepair` is
-- what section 8 asks for: the status the asset had when it left is written
-- down, and completing the repair puts it back - ASSIGNED if somebody still has
-- it on paper, AVAILABLE if nobody did. Without that column the return from
-- repair would have to guess, and the guess that loses quietly un-assigns a
-- laptop somebody still has at home. The assignment row is untouched throughout.
--
-- NOTHING IS EVER DELETED. `asset_incidents` records a lost or damaged asset as
-- a row beside an asset that stays on the register; retirement and disposal are
-- columns on `assets`, not a DELETE. "We lost eleven laptops last year" is a
-- fact about the company, and a tidy table is not worth it.
--
-- AN EMPLOYEE'S REPORT CHANGES NOTHING. `asset_incidents.kind =
-- 'ISSUE_REPORTED'` is written from the employee's own screen and touches no
-- column on `assets` - not its condition, not its value, not its status. The
-- two administrative kinds move the asset's status; this one raises a flag a
-- person reads.
--
-- ACKNOWLEDGEMENT BELONGS TO A HANDOVER, not to an asset. It is three columns on
-- `asset_assignments` for that reason: the next person issued the same laptop
-- has acknowledged nothing, and a column on `assets` would say they had.
--
-- FILES REUSE THE STORE THE HRMS ALREADY HAS. `asset_documents` is shaped
-- exactly like `case_attachments` and `candidate_documents` - an opaque object
-- key, a sniffed content type, a size and a display name with no bearing on
-- where the bytes live - because it uses the same object store. No second file
-- system was created, which is section 13's instruction taken literally.
--
-- ACCESSORIES ARE TEXT ARRAYS, not a join table. An accessory is a label on a
-- handover, and nothing in this product ever asks a question about "all the
-- chargers". `accessoriesMissing` is derived at return time and then STORED, so
-- the record of what was missing on the day survives somebody later editing
-- what was issued.

-- CreateEnum
CREATE TYPE "AssetAcknowledgementStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'ISSUE_REPORTED');

-- CreateEnum
CREATE TYPE "AssetRepairStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssetIncidentKind" AS ENUM ('ISSUE_REPORTED', 'DAMAGED', 'LOST');

-- CreateEnum
CREATE TYPE "AssetDisposalMethod" AS ENUM ('SOLD', 'SCRAPPED', 'DONATED', 'RECYCLED', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetDocumentType" AS ENUM ('INVOICE', 'PURCHASE_RECEIPT', 'WARRANTY', 'REPAIR_RECEIPT', 'HANDOVER', 'OTHER');

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "retiredOn" DATE,
ADD COLUMN     "retiredReason" TEXT,
ADD COLUMN     "disposedOn" DATE,
ADD COLUMN     "disposalMethod" "AssetDisposalMethod",
ADD COLUMN     "disposalReason" TEXT,
ADD COLUMN     "disposalFinalValue" DECIMAL(12,2),
ADD COLUMN     "disposalApprovedById" TEXT,
ADD COLUMN     "disposalNotes" TEXT;

-- AlterTable
ALTER TABLE "asset_assignments" ADD COLUMN     "accessoriesIssued" TEXT[],
ADD COLUMN     "accessoriesReturned" TEXT[],
ADD COLUMN     "accessoriesMissing" TEXT[],
ADD COLUMN     "damageDescription" TEXT,
ADD COLUMN     "returnNotes" TEXT,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "previousAssignmentId" TEXT,
ADD COLUMN     "acknowledgementStatus" "AssetAcknowledgementStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "acknowledgedById" TEXT;

-- CreateTable
CREATE TABLE "asset_repairs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "reportedOn" DATE NOT NULL,
    "sentOn" DATE NOT NULL,
    "expectedReturnOn" DATE,
    "returnedOn" DATE,
    "vendor" TEXT,
    "estimatedCost" DECIMAL(12,2),
    "actualCost" DECIMAL(12,2),
    "notes" TEXT,
    "completionNotes" TEXT,
    "status" "AssetRepairStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "statusBeforeRepair" "AssetStatus" NOT NULL,
    "sentById" TEXT,
    "completedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_repairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_incidents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "kind" "AssetIncidentKind" NOT NULL,
    "occurredOn" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "notes" TEXT,
    "reportedById" TEXT,
    "reportedByEmployeeId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "repairId" TEXT,
    "type" "AssetDocumentType" NOT NULL DEFAULT 'OTHER',
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "asset_assignments_previousAssignmentId_key" ON "asset_assignments"("previousAssignmentId");

-- CreateIndex
CREATE INDEX "asset_repairs_assetId_status_idx" ON "asset_repairs"("assetId", "status");

-- CreateIndex
CREATE INDEX "asset_repairs_assetId_sentOn_idx" ON "asset_repairs"("assetId", "sentOn");

-- CreateIndex
CREATE INDEX "asset_repairs_companyId_status_idx" ON "asset_repairs"("companyId", "status");

-- CreateIndex
CREATE INDEX "asset_incidents_assetId_occurredOn_idx" ON "asset_incidents"("assetId", "occurredOn");

-- CreateIndex
CREATE INDEX "asset_incidents_companyId_kind_idx" ON "asset_incidents"("companyId", "kind");

-- CreateIndex
CREATE INDEX "asset_incidents_assignmentId_idx" ON "asset_incidents"("assignmentId");

-- CreateIndex
CREATE INDEX "asset_documents_assetId_createdAt_idx" ON "asset_documents"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "asset_documents_repairId_idx" ON "asset_documents"("repairId");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_disposalApprovedById_fkey" FOREIGN KEY ("disposalApprovedById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_previousAssignmentId_fkey" FOREIGN KEY ("previousAssignmentId") REFERENCES "asset_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_repairs" ADD CONSTRAINT "asset_repairs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_repairs" ADD CONSTRAINT "asset_repairs_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_repairs" ADD CONSTRAINT "asset_repairs_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_repairs" ADD CONSTRAINT "asset_repairs_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_incidents" ADD CONSTRAINT "asset_incidents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_incidents" ADD CONSTRAINT "asset_incidents_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_incidents" ADD CONSTRAINT "asset_incidents_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "asset_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_incidents" ADD CONSTRAINT "asset_incidents_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_incidents" ADD CONSTRAINT "asset_incidents_reportedByEmployeeId_fkey" FOREIGN KEY ("reportedByEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_incidents" ADD CONSTRAINT "asset_incidents_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_documents" ADD CONSTRAINT "asset_documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_documents" ADD CONSTRAINT "asset_documents_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_documents" ADD CONSTRAINT "asset_documents_repairId_fkey" FOREIGN KEY ("repairId") REFERENCES "asset_repairs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_documents" ADD CONSTRAINT "asset_documents_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
