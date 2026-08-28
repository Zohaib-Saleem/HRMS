-- AlterEnum
ALTER TYPE "AttendanceSyncTrigger" ADD VALUE 'PUSH';

-- AlterTable
ALTER TABLE "attendance_devices" ADD COLUMN     "allowedPushCidrs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "lastPushAt" TIMESTAMP(3),
ADD COLUMN     "pushTokenCipher" TEXT;
