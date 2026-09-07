-- Attendance records that arrive from a connector on the device's own LAN.
--
-- Additive only. No existing row is read, rewritten or deleted: the enum gains
-- a value, the device table gains one nullable column, and one new table is
-- created. A device already recorded as ZKTECO_TCP keeps behaving exactly as it
-- does today until somebody changes it deliberately.

-- AlterEnum
ALTER TYPE "AttendanceDeviceProtocol" ADD VALUE 'ZKTECO_LAN_CONNECTOR';

-- AlterTable
ALTER TABLE "attendance_devices" ADD COLUMN "connectorVersion" TEXT;

-- CreateTable
CREATE TABLE "attendance_device_enrolled_users" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceUserId" TEXT NOT NULL,
    "name" TEXT,
    "privilege" INTEGER,
    "cardNumber" TEXT,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_device_enrolled_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_device_enrolled_users_companyId_deviceId_idx" ON "attendance_device_enrolled_users"("companyId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_device_enrolled_users_deviceId_deviceUserId_key" ON "attendance_device_enrolled_users"("deviceId", "deviceUserId");

-- AddForeignKey
ALTER TABLE "attendance_device_enrolled_users" ADD CONSTRAINT "attendance_device_enrolled_users_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_device_enrolled_users" ADD CONSTRAINT "attendance_device_enrolled_users_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "attendance_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
