-- @Mention on case messages. Additive only: one enum value, one new table,
-- no existing row touched.
--
--   NotificationType.CASE_MENTION  "you were tagged in a case"
--   case_message_mentions          one row per person tagged in one message

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'CASE_MENTION';

-- CreateTable
CREATE TABLE "case_message_mentions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mentionedUserId" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "notificationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_message_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "case_message_mentions_notificationId_key" ON "case_message_mentions"("notificationId");

-- CreateIndex
CREATE INDEX "case_message_mentions_mentionedUserId_createdAt_idx" ON "case_message_mentions"("mentionedUserId", "createdAt");

-- CreateIndex
CREATE INDEX "case_message_mentions_caseId_idx" ON "case_message_mentions"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "case_message_mentions_messageId_mentionedUserId_key" ON "case_message_mentions"("messageId", "mentionedUserId");

-- AddForeignKey
ALTER TABLE "case_message_mentions" ADD CONSTRAINT "case_message_mentions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_message_mentions" ADD CONSTRAINT "case_message_mentions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_message_mentions" ADD CONSTRAINT "case_message_mentions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "case_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_message_mentions" ADD CONSTRAINT "case_message_mentions_mentionedUserId_fkey" FOREIGN KEY ("mentionedUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_message_mentions" ADD CONSTRAINT "case_message_mentions_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

