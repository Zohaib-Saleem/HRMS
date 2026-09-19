-- Recruitment and interview scheduling, phase 1.
--
-- Nine tables and eight enums, plus five values appended to an existing enum.
-- ENTIRELY ADDITIVE: nothing existing is altered, dropped, backfilled or
-- re-typed. No column on `employees`, `users`, `departments`, `teams`,
-- `designations`, `locations`, `audit_logs` or `notifications` changes shape,
-- and not one existing row is written. Rolling the application back leaves
-- unused tables behind and nothing else.
--
-- The decisions this file enforces, rather than hoping application code will:
--
-- A CANDIDATE IS NOT AN EMPLOYEE. There is no foreign key from `employees` to
-- anything here. The single bridge is `candidates.hiredEmployeeId`, and
-- `candidates_hiredEmployeeId_key` is what makes Convert to Employee
-- unrepeatable: one candidate cannot become two employees, under a race or
-- otherwise. Its ON DELETE is SET NULL, so removing an employee record does
-- not destroy the recruitment history that produced them.
--
-- ONE PERSON, ONE RECORD. `candidates_companyId_email_key` is why a candidate
-- who applies for three roles is one row rather than three. The join that
-- carries the three applications is `candidate_applications`, and
-- `candidate_applications_candidateId_jobOpeningId_key` is why applying twice
-- for the same job is the same application.
--
-- ONE PANELLIST, ONE EVALUATION, AND NOBODY OVERWRITES ANYBODY.
-- `interview_participants_interviewId_employeeId_key` gives each interviewer
-- exactly one seat, and `interview_evaluations_participantId_key` gives each
-- seat exactly one evaluation. Three panellists therefore produce three rows
-- that cannot collide, which is the database saying what section 12 asks for.
-- A missing row is "pending" - an honest absence rather than a row of zeros.
--
-- INTERVIEW HISTORY IS NOT OVERWRITTEN. A rescheduled interview keeps its id,
-- its panel and its evaluations, because it is the same appointment; the old
-- time would simply be lost, so `interview_schedule_changes` records one row
-- per move with both times and a compulsory reason. Nothing in this module
-- deletes an interview that happened.
--
-- THE INTERVIEWER'S OWN SCREEN IS AN INDEX, NOT A SCAN.
-- `interview_participants_employeeId_idx` and
-- `interviews_companyId_status_startsAt_idx` are what make "my interviews
-- today" and the panellist clash check cheap enough to run on every schedule.
--
-- EMPLOYMENT STATUS IS NOT DUPLICATED. `job_openings.expectedEmploymentStatus`
-- and `offers.employmentStatus` are the EXISTING `EmploymentStatus` enum -
-- PROBATION / PERMANENT / INTERNEE - not a second copy of it. A conversion
-- carries the value across rather than translating between two vocabularies.
--
-- MONEY IS DECIMAL(12,2) everywhere it appears, matching payroll, loans and
-- lunch. What is NOT here is any link from an offer to payroll: no salary row,
-- no payroll profile, no contract. An accepted offer is a number on an offer
-- until a person sets pay in payroll on purpose.
--
-- Files follow the store the HRMS already has. `candidate_documents` is shaped
-- exactly like `case_attachments` - an opaque object key, a sniffed content
-- type, a size and a display name with no bearing on where the bytes live -
-- because it uses the same object store. No second file system was created.

-- CreateEnum
CREATE TYPE "JobOpeningStatus" AS ENUM ('DRAFT', 'OPEN', 'ON_HOLD', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CandidateStage" AS ENUM ('NEW', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'SELECTED', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "InterviewType" AS ENUM ('HR', 'TECHNICAL', 'MANAGER', 'FINAL', 'OTHER');

-- CreateEnum
CREATE TYPE "InterviewRound" AS ENUM ('ROUND_1', 'ROUND_2', 'ROUND_3', 'FINAL');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('SCHEDULED', 'CONFIRMED', 'COMPLETED', 'RESCHEDULED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "InterviewRecommendation" AS ENUM ('STRONG_YES', 'YES', 'MAYBE', 'NO');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CandidateDocumentType" AS ENUM ('RESUME', 'COVER_LETTER', 'PORTFOLIO', 'CERTIFICATE', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'INTERVIEW_SCHEDULED';
ALTER TYPE "NotificationType" ADD VALUE 'INTERVIEW_RESCHEDULED';
ALTER TYPE "NotificationType" ADD VALUE 'INTERVIEW_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE 'INTERVIEW_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE 'INTERVIEW_EVALUATION_PENDING';

-- CreateTable
CREATE TABLE "job_openings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "departmentId" TEXT,
    "teamId" TEXT,
    "locationId" TEXT,
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'FULL_TIME',
    "expectedEmploymentStatus" "EmploymentStatus",
    "vacancies" INTEGER NOT NULL DEFAULT 1,
    "hiringManagerId" TEXT,
    "recruiterId" TEXT,
    "description" TEXT,
    "requirements" TEXT,
    "skills" TEXT,
    "minExperienceYears" INTEGER,
    "salaryMin" DECIMAL(12,2),
    "salaryMax" DECIMAL(12,2),
    "salaryCurrency" TEXT,
    "openingDate" DATE,
    "closingDate" DATE,
    "status" "JobOpeningStatus" NOT NULL DEFAULT 'DRAFT',
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_openings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "currentLocation" TEXT,
    "linkedinUrl" TEXT,
    "portfolioUrl" TEXT,
    "skills" TEXT,
    "experienceYears" INTEGER,
    "currentCompany" TEXT,
    "currentTitle" TEXT,
    "currentSalary" DECIMAL(12,2),
    "expectedSalary" DECIMAL(12,2),
    "salaryCurrency" TEXT,
    "notes" TEXT,
    "noticePeriodDays" INTEGER,
    "source" TEXT,
    "recruiterId" TEXT,
    "stage" "CandidateStage" NOT NULL DEFAULT 'NEW',
    "hiredEmployeeId" TEXT,
    "hiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_applications" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobOpeningId" TEXT NOT NULL,
    "stage" "CandidateStage" NOT NULL DEFAULT 'NEW',
    "stageChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stageChangedBy" TEXT,
    "outcomeReason" TEXT,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "type" "CandidateDocumentType" NOT NULL DEFAULT 'OTHER',
    "uploadedByUserId" TEXT,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "isConfidential" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobOpeningId" TEXT,
    "applicationId" TEXT,
    "type" "InterviewType" NOT NULL,
    "round" "InterviewRound" NOT NULL DEFAULT 'ROUND_1',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "location" TEXT,
    "meetingLink" TEXT,
    "notes" TEXT,
    "status" "InterviewStatus" NOT NULL DEFAULT 'SCHEDULED',
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "scheduledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_participants" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "isLead" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_evaluations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "technicalScore" INTEGER,
    "problemSolvingScore" INTEGER,
    "communicationScore" INTEGER,
    "experienceScore" INTEGER,
    "cultureFitScore" INTEGER,
    "recommendation" "InterviewRecommendation" NOT NULL,
    "comments" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_schedule_changes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "previousStartsAt" TIMESTAMP(3) NOT NULL,
    "previousEndsAt" TIMESTAMP(3) NOT NULL,
    "previousTimezone" TEXT NOT NULL,
    "newStartsAt" TIMESTAMP(3) NOT NULL,
    "newEndsAt" TIMESTAMP(3) NOT NULL,
    "newTimezone" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_schedule_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobOpeningId" TEXT,
    "applicationId" TEXT,
    "designationId" TEXT,
    "proposedTitle" TEXT,
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'FULL_TIME',
    "employmentStatus" "EmploymentStatus",
    "proposedSalary" DECIMAL(12,2),
    "salaryCurrency" TEXT,
    "expectedJoiningDate" DATE,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "expiresAt" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_openings_companyId_status_idx" ON "job_openings"("companyId", "status");

-- CreateIndex
CREATE INDEX "job_openings_companyId_departmentId_idx" ON "job_openings"("companyId", "departmentId");

-- CreateIndex
CREATE INDEX "job_openings_companyId_teamId_idx" ON "job_openings"("companyId", "teamId");

-- CreateIndex
CREATE INDEX "job_openings_hiringManagerId_idx" ON "job_openings"("hiringManagerId");

-- CreateIndex
CREATE INDEX "job_openings_recruiterId_idx" ON "job_openings"("recruiterId");

-- CreateIndex
CREATE INDEX "job_openings_companyId_openingDate_idx" ON "job_openings"("companyId", "openingDate");

-- CreateIndex
CREATE UNIQUE INDEX "job_openings_companyId_reference_key" ON "job_openings"("companyId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_hiredEmployeeId_key" ON "candidates"("hiredEmployeeId");

-- CreateIndex
CREATE INDEX "candidates_companyId_stage_idx" ON "candidates"("companyId", "stage");

-- CreateIndex
CREATE INDEX "candidates_companyId_recruiterId_idx" ON "candidates"("companyId", "recruiterId");

-- CreateIndex
CREATE INDEX "candidates_companyId_createdAt_idx" ON "candidates"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "candidates_companyId_fullName_idx" ON "candidates"("companyId", "fullName");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_companyId_email_key" ON "candidates"("companyId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_companyId_reference_key" ON "candidates"("companyId", "reference");

-- CreateIndex
CREATE INDEX "candidate_applications_companyId_stage_idx" ON "candidate_applications"("companyId", "stage");

-- CreateIndex
CREATE INDEX "candidate_applications_jobOpeningId_stage_idx" ON "candidate_applications"("jobOpeningId", "stage");

-- CreateIndex
CREATE INDEX "candidate_applications_companyId_stageChangedAt_idx" ON "candidate_applications"("companyId", "stageChangedAt");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_applications_candidateId_jobOpeningId_key" ON "candidate_applications"("candidateId", "jobOpeningId");

-- CreateIndex
CREATE INDEX "candidate_documents_candidateId_isConfidential_createdAt_idx" ON "candidate_documents"("candidateId", "isConfidential", "createdAt");

-- CreateIndex
CREATE INDEX "candidate_documents_companyId_createdAt_idx" ON "candidate_documents"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "interviews_companyId_startsAt_idx" ON "interviews"("companyId", "startsAt");

-- CreateIndex
CREATE INDEX "interviews_companyId_status_startsAt_idx" ON "interviews"("companyId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "interviews_candidateId_startsAt_idx" ON "interviews"("candidateId", "startsAt");

-- CreateIndex
CREATE INDEX "interviews_jobOpeningId_idx" ON "interviews"("jobOpeningId");

-- CreateIndex
CREATE INDEX "interviews_applicationId_idx" ON "interviews"("applicationId");

-- CreateIndex
CREATE INDEX "interview_participants_employeeId_idx" ON "interview_participants"("employeeId");

-- CreateIndex
CREATE INDEX "interview_participants_companyId_employeeId_idx" ON "interview_participants"("companyId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "interview_participants_interviewId_employeeId_key" ON "interview_participants"("interviewId", "employeeId");

-- CreateIndex
CREATE INDEX "interview_evaluations_interviewId_idx" ON "interview_evaluations"("interviewId");

-- CreateIndex
CREATE INDEX "interview_evaluations_companyId_submittedAt_idx" ON "interview_evaluations"("companyId", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "interview_evaluations_participantId_key" ON "interview_evaluations"("participantId");

-- CreateIndex
CREATE INDEX "interview_schedule_changes_interviewId_createdAt_idx" ON "interview_schedule_changes"("interviewId", "createdAt");

-- CreateIndex
CREATE INDEX "offers_companyId_status_idx" ON "offers"("companyId", "status");

-- CreateIndex
CREATE INDEX "offers_candidateId_idx" ON "offers"("candidateId");

-- CreateIndex
CREATE INDEX "offers_jobOpeningId_idx" ON "offers"("jobOpeningId");

-- CreateIndex
CREATE INDEX "offers_applicationId_idx" ON "offers"("applicationId");

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_hiringManagerId_fkey" FOREIGN KEY ("hiringManagerId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_recruiterId_fkey" FOREIGN KEY ("recruiterId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_recruiterId_fkey" FOREIGN KEY ("recruiterId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_hiredEmployeeId_fkey" FOREIGN KEY ("hiredEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_applications" ADD CONSTRAINT "candidate_applications_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_applications" ADD CONSTRAINT "candidate_applications_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_applications" ADD CONSTRAINT "candidate_applications_jobOpeningId_fkey" FOREIGN KEY ("jobOpeningId") REFERENCES "job_openings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_jobOpeningId_fkey" FOREIGN KEY ("jobOpeningId") REFERENCES "job_openings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "candidate_applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_scheduledById_fkey" FOREIGN KEY ("scheduledById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_participants" ADD CONSTRAINT "interview_participants_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_participants" ADD CONSTRAINT "interview_participants_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_participants" ADD CONSTRAINT "interview_participants_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_evaluations" ADD CONSTRAINT "interview_evaluations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_evaluations" ADD CONSTRAINT "interview_evaluations_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_evaluations" ADD CONSTRAINT "interview_evaluations_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "interview_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_schedule_changes" ADD CONSTRAINT "interview_schedule_changes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_schedule_changes" ADD CONSTRAINT "interview_schedule_changes_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_jobOpeningId_fkey" FOREIGN KEY ("jobOpeningId") REFERENCES "job_openings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "candidate_applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "designations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

