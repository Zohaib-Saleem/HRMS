-- Organisation hierarchy and multi-level approvals.
--
-- Six tables, three enums, one new enum VALUE, two added columns on
-- `approval_steps`, one on `asset_assignments` - and two BACKFILLS, which are
-- the only statements in this file that write a row that already existed.
--
-- ENTIRELY ADDITIVE. Every ALTER is an ADD COLUMN or an ADD VALUE. No column
-- changes type, no column is dropped, no table is renamed, and nothing outside
-- the backfills below is written. Rolling the application back leaves unused
-- tables, two unread columns and a copy of the team leads behind, and nothing
-- else: the code that reads the old shape still finds the old shape intact.
--
-- WHAT THIS FILE IS FOR, in one paragraph. This product could already route a
-- request through several approvers, one per step, resolved from the
-- requester's `managerId`. What it could not do is say WHAT A STEP IS - "the
-- team's managers", "HR", "the CEO" - or let any one of three managers sign
-- for the team. Those two absences are why an approval chain here had to be a
-- list of named people, and why "who manages Development" was answered by
-- reading job titles. This migration gives both questions a table.
--
-- THE DECISIONS IT ENFORCES, rather than hoping application code will:
--
-- A TEAM MANAGER IS A ROW. `team_managers` is the only place this product will
-- look to answer "who runs this team". Not a job title, not a designation, not
-- the department head, not a role called MANAGER, not the `leadEmployeeId`
-- column this table supersedes. The unique index on (teamId, employeeId) makes
-- re-appointing somebody reactivate their existing row rather than writing a
-- second one, so the history of an appointment stays on one line.
--
-- THE CEILING OF THREE IS NOT HERE, and that is deliberate rather than
-- forgotten. "At most three ACTIVE rows per team" is a partial constraint;
-- Postgres can express it only as an exclusion constraint or a trigger, and
-- Prisma can describe neither - it would drop whichever we wrote on the next
-- migration, silently, which is worse than not having it. The rule is enforced
-- in the service layer INSIDE the transaction that inserts the row, by counting
-- the active rows for that team first. Two administrators appointing a fourth
-- manager in the same second is the race this leaves, and its outcome is four
-- managers on one team rather than corruption.
--
-- AUTHORITY ON A STEP MOVES TO `approval_step_approvers`. A step used to hold
-- one `approverEmployeeId`, which is exactly one person and cannot express "any
-- one of Manager A, B or C". The new table holds the candidates and records
-- which of them decided. THE FIRST BACKFILL below copies every existing step's
-- approver into it, so every request already in flight keeps working, keeps its
-- approver, and keeps the same inbox - the new code reads only the new table.
--
-- TEAM LEADS BECOME TEAM MANAGERS. THE SECOND BACKFILL copies every
-- `teams.leadEmployeeId` into `team_managers` as an active appointment. The
-- column is left in place and stops being read. A company that had named leads
-- finds them already managing their teams on the morning of the upgrade, which
-- is the difference between a feature that works on arrival and one that waits
-- for HR to re-key eleven teams.
--
-- NOTHING HERE CONFIGURES A WORKFLOW. `approval_workflows` is empty after this
-- runs, on purpose: the default chain - Team Manager, then HR Manager, then CEO
-- - lives in the shared package and is what a company gets when it has stored
-- no workflow of its own. A row here is an OVERRIDE. An empty table therefore
-- means "every company uses the default", which is the state a fresh
-- installation should boot into without an administrator visiting a settings
-- screen.
--
-- AN ASSET REQUEST IS NOT AN ASSET. `asset_requests` carries a category and a
-- quantity, never an asset id: which laptop somebody gets is chosen by the
-- asset manager at fulfilment time, after the chain has agreed, and is recorded
-- as an ordinary row in `asset_assignments` carrying the request line's id.
-- That is what `asset_assignments.assetRequestItemId` is for, and it is why
-- approving a request and issuing the kit cannot be the same act.

-- CreateEnum
CREATE TYPE "ApprovalStage" AS ENUM ('TEAM_MANAGER', 'HR_MANAGER', 'CEO', 'LINE_MANAGER', 'DEPARTMENT_HEAD');

-- CreateEnum
CREATE TYPE "ApprovalStageMode" AS ENUM ('ANY_ONE', 'ALL');

-- CreateEnum
CREATE TYPE "AssetRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'FULFILLED');

-- AlterEnum
-- Safe inside the migration's transaction on PostgreSQL 12 and later PROVIDED
-- the new value is not used by a later statement in the same transaction.
-- Nothing below reads or writes it; the first row carrying it is written by the
-- application, after this has committed.
ALTER TYPE "ApprovalSubjectType" ADD VALUE 'ASSET_REQUEST';

-- AlterTable
ALTER TABLE "approval_steps" ADD COLUMN     "mode" "ApprovalStageMode" NOT NULL DEFAULT 'ANY_ONE',
ADD COLUMN     "stage" "ApprovalStage";

-- AlterTable
ALTER TABLE "asset_assignments" ADD COLUMN     "assetRequestItemId" TEXT;

-- CreateTable
CREATE TABLE "team_managers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedByUserId" TEXT,
    "endedAt" TIMESTAMP(3),
    "endedByUserId" TEXT,
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedByEmployeeId" TEXT,

    CONSTRAINT "team_managers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_step_approvers" (
    "id" TEXT NOT NULL,
    "approvalStepId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_step_approvers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_workflows" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "subjectType" "ApprovalSubjectType" NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_workflow_stages" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "stageOrder" INTEGER NOT NULL,
    "stage" "ApprovalStage" NOT NULL,
    "mode" "ApprovalStageMode" NOT NULL DEFAULT 'ANY_ONE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_workflow_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_stage_assignees" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stage" "ApprovalStage" NOT NULL,
    "employeeId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_stage_assignees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_requests" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "AssetRequestStatus" NOT NULL DEFAULT 'PENDING',
    "justification" TEXT NOT NULL,
    "neededBy" DATE,
    "approvalRequestId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "fulfilledByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_request_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetRequestId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "declinedAt" TIMESTAMP(3),
    "declinedByUserId" TEXT,
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_managers_companyId_employeeId_isActive_idx" ON "team_managers"("companyId", "employeeId", "isActive");

-- CreateIndex
CREATE INDEX "team_managers_teamId_isActive_idx" ON "team_managers"("teamId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "team_managers_teamId_employeeId_key" ON "team_managers"("teamId", "employeeId");

-- CreateIndex
CREATE INDEX "approval_step_approvers_employeeId_status_idx" ON "approval_step_approvers"("employeeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "approval_step_approvers_approvalStepId_employeeId_key" ON "approval_step_approvers"("approvalStepId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "approval_workflows_companyId_subjectType_key" ON "approval_workflows"("companyId", "subjectType");

-- CreateIndex
CREATE UNIQUE INDEX "approval_workflow_stages_workflowId_stageOrder_key" ON "approval_workflow_stages"("workflowId", "stageOrder");

-- CreateIndex
CREATE INDEX "approval_stage_assignees_companyId_stage_isActive_idx" ON "approval_stage_assignees"("companyId", "stage", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "approval_stage_assignees_companyId_stage_employeeId_key" ON "approval_stage_assignees"("companyId", "stage", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_requests_approvalRequestId_key" ON "asset_requests"("approvalRequestId");

-- CreateIndex
CREATE INDEX "asset_requests_companyId_status_idx" ON "asset_requests"("companyId", "status");

-- CreateIndex
CREATE INDEX "asset_requests_companyId_employeeId_status_idx" ON "asset_requests"("companyId", "employeeId", "status");

-- CreateIndex
CREATE INDEX "asset_request_items_assetRequestId_idx" ON "asset_request_items"("assetRequestId");

-- CreateIndex
CREATE INDEX "asset_request_items_companyId_categoryId_idx" ON "asset_request_items"("companyId", "categoryId");

-- CreateIndex
CREATE INDEX "asset_assignments_assetRequestItemId_idx" ON "asset_assignments"("assetRequestItemId");

-- AddForeignKey
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_endedByEmployeeId_fkey" FOREIGN KEY ("endedByEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step_approvers" ADD CONSTRAINT "approval_step_approvers_approvalStepId_fkey" FOREIGN KEY ("approvalStepId") REFERENCES "approval_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step_approvers" ADD CONSTRAINT "approval_step_approvers_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_workflows" ADD CONSTRAINT "approval_workflows_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_workflow_stages" ADD CONSTRAINT "approval_workflow_stages_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "approval_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_stage_assignees" ADD CONSTRAINT "approval_stage_assignees_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_stage_assignees" ADD CONSTRAINT "approval_stage_assignees_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_assetRequestItemId_fkey" FOREIGN KEY ("assetRequestItemId") REFERENCES "asset_request_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_requests" ADD CONSTRAINT "asset_requests_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_requests" ADD CONSTRAINT "asset_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_request_items" ADD CONSTRAINT "asset_request_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_request_items" ADD CONSTRAINT "asset_request_items_assetRequestId_fkey" FOREIGN KEY ("assetRequestId") REFERENCES "asset_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_request_items" ADD CONSTRAINT "asset_request_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "asset_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- backfill 1
--
-- Every existing approval step becomes a step with one named approver.
--
-- Without this, every request in flight on the morning of the upgrade would
-- have an empty approver set, and the new code - which reads only this table -
-- would find nobody able to decide it. The step's own status and decision are
-- copied across so a step that was already approved comes back approved BY THE
-- PERSON WHO APPROVED IT, rather than reappearing in somebody's inbox.
--
-- `gen_random_uuid()` is pgcrypto, available in PostgreSQL 13+ as a built-in.
-- Ids generated here are UUIDs rather than the cuids the application writes;
-- nothing reads the shape of an id, and both are opaque text.
INSERT INTO "approval_step_approvers" ("id", "approvalStepId", "employeeId", "status", "decidedByUserId", "decidedAt", "comment", "createdAt")
SELECT gen_random_uuid()::text, s."id", s."approverEmployeeId", s."status", s."decidedByUserId", s."decidedAt", s."comment", s."createdAt"
FROM "approval_steps" s
WHERE s."approverEmployeeId" IS NOT NULL;

-- ---------------------------------------------------------------- backfill 2
--
-- Every named team lead becomes an active team manager.
--
-- `teams.leadEmployeeId` is left exactly as it is. Nothing reads it after this
-- release, and it stays so that rolling back restores the old behaviour whole.
-- The WHERE guard on `employees` keeps the insert honest if a lead points at a
-- row in another company - a shape the old `@unique` column could not prevent.
INSERT INTO "team_managers" ("id", "companyId", "teamId", "employeeId", "isActive", "assignedAt", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."companyId", t."id", t."leadEmployeeId", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "teams" t
JOIN "employees" e ON e."id" = t."leadEmployeeId" AND e."companyId" = t."companyId"
WHERE t."leadEmployeeId" IS NOT NULL;
