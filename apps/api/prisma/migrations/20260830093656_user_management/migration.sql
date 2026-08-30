-- CreateEnum
CREATE TYPE "UserSuspensionReason" AS ENUM ('EMPLOYMENT_TERMINATED', 'ADMINISTRATIVE');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "statusBeforeSuspension" "UserStatus",
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedById" TEXT,
ADD COLUMN     "suspendedReason" "UserSuspensionReason";
