-- Celebration greetings: letting an employee actually say something.
--
-- The dashboard has shown whose birthday it is, who is celebrating a year and
-- who has just joined for a release now, and the only thing an employee could
-- do about it was read the card. This adds the reply.
--
-- Two decisions are enforced here rather than in application code.
--
-- The first is the unique key. A greeting is identified by (recipient, sender,
-- occasion, occasionDate), so "you have already greeted them" is a fact the
-- database knows. Without it a double-tap on a slow connection sends the same
-- birthday wish twice, and the count under the card starts lying.
--
-- The second is what occasionDate means, because it is not simply the day the
-- row was written. A birthday or an anniversary is dated to the day it falls
-- on; a new joiner's welcome is dated to their HIRE DATE, since that window
-- runs five working days and one welcome per joiner is the sensible number
-- however many of those days the sender happened to look at the dashboard.
--
-- Additive throughout: one new enum, one new enum VALUE on notifications, one
-- new table. Nothing existing is altered, so this cannot change what any
-- current row means.

-- CreateEnum
CREATE TYPE "MomentOccasion" AS ENUM ('BIRTHDAY', 'ANNIVERSARY', 'NEW_JOINER');

-- AlterEnum: greetings arrive in the same inbox as everything else, but a
-- celebration is not an approval and should not have to pretend to be SYSTEM.
ALTER TYPE "NotificationType" ADD VALUE 'CELEBRATION';

-- CreateTable
CREATE TABLE "moment_greetings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "recipientEmployeeId" TEXT NOT NULL,
    "senderEmployeeId" TEXT NOT NULL,
    "occasion" "MomentOccasion" NOT NULL,
    "occasionDate" DATE NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moment_greetings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the dashboard's own lookup - this person, this occasion, today.
CREATE INDEX "moment_greetings_recipientEmployeeId_occasion_occasionDate_idx"
  ON "moment_greetings"("recipientEmployeeId", "occasion", "occasionDate");

CREATE INDEX "moment_greetings_companyId_occasionDate_idx"
  ON "moment_greetings"("companyId", "occasionDate");

-- CreateIndex: one greeting per sender, per person, per occasion.
CREATE UNIQUE INDEX "moment_greetings_recipient_sender_occasion_date_key"
  ON "moment_greetings"("recipientEmployeeId", "senderEmployeeId", "occasion", "occasionDate");

-- AddForeignKey
ALTER TABLE "moment_greetings" ADD CONSTRAINT "moment_greetings_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "moment_greetings" ADD CONSTRAINT "moment_greetings_recipientEmployeeId_fkey"
  FOREIGN KEY ("recipientEmployeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "moment_greetings" ADD CONSTRAINT "moment_greetings_senderEmployeeId_fkey"
  FOREIGN KEY ("senderEmployeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
