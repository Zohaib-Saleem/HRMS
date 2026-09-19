-- Asset management, step 1: the foundation.
--
-- Three tables and three enums. ENTIRELY ADDITIVE: nothing existing is altered,
-- dropped, backfilled or re-typed. No column on `companies`, `employees`,
-- `users`, `departments`, `locations`, `audit_logs` or any other existing table
-- changes shape, and not one existing row is written. Rolling the application
-- back leaves three unused tables behind and nothing else.
--
-- The decisions this file enforces, rather than hoping application code will:
--
-- WHO HAS IT IS A HISTORY, NOT A COLUMN. There is deliberately no
-- `currentEmployeeId` on `assets`. A laptop that has been through three people
-- is three rows in `asset_assignments`, of which at most one is ACTIVE, and the
-- handover to the fourth destroys none of them. `asset_assignments_assetId_status_idx`
-- is what makes "who has this now" an index lookup on every row of the register
-- rather than a scan of the history.
--
-- STATUS AND CONDITION ARE DIFFERENT QUESTIONS, so they are different enums and
-- different columns. `AssetStatus` says where the thing is in the company's
-- custody; `AssetCondition` says what state it is in. DAMAGED appears in both
-- and means two different things: "not issuing this to anybody" and "the screen
-- is cracked". An asset is routinely ASSIGNED and DAMAGED at once.
--
-- THE ASSET TAG IS UNIQUE PER COMPANY. `assets_companyId_assetTag_key` is what
-- makes that true under a race rather than under a hopeful read-then-write, and
-- the route reports it as a field error before it is ever reached.
--
-- THE SERIAL NUMBER IS UNIQUE WHEN PRESENT, and that is `assets_companyId_serialNumber_key`
-- doing exactly what PostgreSQL does with NULLs: a hundred chairs with no serial
-- do not collide, two laptops claiming the same one do. No partial index, no
-- application-side special case.
--
-- CATEGORIES ARE DATA AND ARE NEVER DELETED. `assets_categoryId_fkey` is ON
-- DELETE RESTRICT, so a category with assets filed under it cannot be removed
-- out from under them - which is why the API offers retirement (`isActive`) and
-- no delete at all. `asset_categories_parentCategoryId_fkey` is RESTRICT for the
-- same reason: deleting "IT Equipment" must not silently take "Laptop" with it.
--
-- THE EMPLOYEE BEHIND A HANDOVER SURVIVES. `asset_assignments_employeeId_fkey`
-- is ON DELETE RESTRICT: an employee who has ever been issued company property
-- cannot be deleted out from under that record. The two ACTOR columns are
-- SET NULL instead - an account can be removed years later, and losing the name
-- of whoever handed a laptop over is survivable where losing the handover is not.
--
-- ONE ACTIVE ASSIGNMENT PER ASSET is NOT enforced here, and the omission is
-- deliberate rather than an oversight. The constraint that would express it is a
-- partial unique index (`... WHERE status = 'ACTIVE'`), which Prisma cannot
-- describe in the schema and would therefore try to drop on the next migration.
-- The rule lives in the service layer instead - the same trade-off, and the same
-- disclosure, as the top-level name rule on `case_categories`.
--
-- NO SECOND AUDIT SYSTEM. There is no `asset_events` table. Asset activity is
-- written to `audit_logs`, which is already company-scoped and already carries
-- `@@index([companyId, entityType, entityId])` - so an asset's timeline is an
-- indexed query against the trail the whole product shares, rather than a second
-- half-implemented one only this module knows how to read.

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'UNDER_REPAIR', 'LOST', 'DAMAGED', 'RETURNED', 'RETIRED', 'DISPOSED');

-- CreateEnum
CREATE TYPE "AssetCondition" AS ENUM ('NEW', 'GOOD', 'FAIR', 'DAMAGED', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AssetAssignmentStatus" AS ENUM ('ACTIVE', 'RETURNED', 'TRANSFERRED', 'WRITTEN_OFF');

-- CreateTable
CREATE TABLE "asset_categories" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "parentCategoryId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetTag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "purchaseDate" DATE,
    "purchasePrice" DECIMAL(12,2),
    "currentValue" DECIMAL(12,2),
    "vendor" TEXT,
    "warrantyStart" DATE,
    "warrantyEnd" DATE,
    "locationId" TEXT,
    "location" TEXT,
    "departmentId" TEXT,
    "condition" "AssetCondition" NOT NULL DEFAULT 'GOOD',
    "status" "AssetStatus" NOT NULL DEFAULT 'AVAILABLE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_assignments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedAt" TIMESTAMP(3),
    "assignedById" TEXT,
    "returnedById" TEXT,
    "conditionAtAssignment" "AssetCondition",
    "conditionAtReturn" "AssetCondition",
    "notes" TEXT,
    "status" "AssetAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_categories_companyId_isActive_sortOrder_idx" ON "asset_categories"("companyId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "asset_categories_parentCategoryId_idx" ON "asset_categories"("parentCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_categories_companyId_parentCategoryId_name_key" ON "asset_categories"("companyId", "parentCategoryId", "name");

-- CreateIndex
CREATE INDEX "assets_companyId_status_idx" ON "assets"("companyId", "status");

-- CreateIndex
CREATE INDEX "assets_companyId_condition_idx" ON "assets"("companyId", "condition");

-- CreateIndex
CREATE INDEX "assets_companyId_categoryId_idx" ON "assets"("companyId", "categoryId");

-- CreateIndex
CREATE INDEX "assets_companyId_departmentId_idx" ON "assets"("companyId", "departmentId");

-- CreateIndex
CREATE INDEX "assets_companyId_locationId_idx" ON "assets"("companyId", "locationId");

-- CreateIndex
CREATE INDEX "assets_companyId_createdAt_idx" ON "assets"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "assets_companyId_name_idx" ON "assets"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "assets_companyId_assetTag_key" ON "assets"("companyId", "assetTag");

-- CreateIndex
CREATE UNIQUE INDEX "assets_companyId_serialNumber_key" ON "assets"("companyId", "serialNumber");

-- CreateIndex
CREATE INDEX "asset_assignments_assetId_status_idx" ON "asset_assignments"("assetId", "status");

-- CreateIndex
CREATE INDEX "asset_assignments_companyId_employeeId_status_idx" ON "asset_assignments"("companyId", "employeeId", "status");

-- CreateIndex
CREATE INDEX "asset_assignments_companyId_status_idx" ON "asset_assignments"("companyId", "status");

-- CreateIndex
CREATE INDEX "asset_assignments_assetId_assignedAt_idx" ON "asset_assignments"("assetId", "assignedAt");

-- AddForeignKey
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_parentCategoryId_fkey" FOREIGN KEY ("parentCategoryId") REFERENCES "asset_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "asset_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_returnedById_fkey" FOREIGN KEY ("returnedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
