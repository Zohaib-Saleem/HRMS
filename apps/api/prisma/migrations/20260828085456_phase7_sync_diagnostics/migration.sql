-- AlterTable
ALTER TABLE "attendance_device_syncs" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "errorDetails" JSONB;
