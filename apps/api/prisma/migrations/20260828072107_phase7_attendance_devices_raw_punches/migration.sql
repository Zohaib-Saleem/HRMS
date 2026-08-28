-- CreateEnum
CREATE TYPE "AttendanceDeviceProtocol" AS ENUM ('ZKTECO_TCP', 'ZKTECO_ADMS');

-- CreateEnum
CREATE TYPE "AttendanceDeviceStatus" AS ENUM ('UNKNOWN', 'ONLINE', 'OFFLINE', 'ERROR');

-- CreateEnum
CREATE TYPE "AttendancePunchPairing" AS ENUM ('FIRST_IN_LAST_OUT', 'DEVICE_STATE');

-- CreateEnum
CREATE TYPE "AttendanceSyncStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "AttendanceSyncTrigger" AS ENUM ('SCHEDULED', 'MANUAL', 'STARTUP');

-- AlterEnum
ALTER TYPE "AttendanceSource" ADD VALUE 'DEVICE';

-- CreateTable
CREATE TABLE "attendance_devices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "protocol" "AttendanceDeviceProtocol" NOT NULL DEFAULT 'ZKTECO_TCP',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 4370,
    "serialNumber" TEXT,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "commKeyCipher" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "syncIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "punchPairing" "AttendancePunchPairing" NOT NULL DEFAULT 'FIRST_IN_LAST_OUT',
    "status" "AttendanceDeviceStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastSeenAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastPunchAt" TIMESTAMP(3),
    "lastError" TEXT,
    "syncCursorAt" TIMESTAMP(3),
    "syncLockedAt" TIMESTAMP(3),
    "syncLockToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_device_user_mappings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceUserId" TEXT NOT NULL,
    "deviceUserName" TEXT,
    "employeeId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_device_user_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_device_syncs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "AttendanceSyncStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" "AttendanceSyncTrigger" NOT NULL DEFAULT 'SCHEDULED',
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "inserted" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "unmapped" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "cursorFrom" TIMESTAMP(3),
    "cursorTo" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "attendance_device_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_raw_punches" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "syncId" TEXT,
    "deviceUserId" TEXT NOT NULL,
    "employeeId" TEXT,
    "deviceTransactionId" TEXT,
    "rawTimestamp" TEXT NOT NULL,
    "deviceTimeZone" TEXT NOT NULL,
    "punchedAt" TIMESTAMP(3) NOT NULL,
    "localDayKey" TEXT NOT NULL,
    "punchState" TEXT,
    "verifyMode" TEXT,
    "fingerprint" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "attendance_raw_punches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_devices_companyId_isEnabled_idx" ON "attendance_devices"("companyId", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_devices_companyId_name_key" ON "attendance_devices"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_devices_companyId_serialNumber_key" ON "attendance_devices"("companyId", "serialNumber");

-- CreateIndex
CREATE INDEX "attendance_device_user_mappings_companyId_employeeId_idx" ON "attendance_device_user_mappings"("companyId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_device_user_mappings_deviceId_deviceUserId_key" ON "attendance_device_user_mappings"("deviceId", "deviceUserId");

-- CreateIndex
CREATE INDEX "attendance_device_syncs_deviceId_startedAt_idx" ON "attendance_device_syncs"("deviceId", "startedAt");

-- CreateIndex
CREATE INDEX "attendance_device_syncs_companyId_status_idx" ON "attendance_device_syncs"("companyId", "status");

-- CreateIndex
CREATE INDEX "attendance_raw_punches_companyId_employeeId_localDayKey_idx" ON "attendance_raw_punches"("companyId", "employeeId", "localDayKey");

-- CreateIndex
CREATE INDEX "attendance_raw_punches_companyId_deviceUserId_idx" ON "attendance_raw_punches"("companyId", "deviceUserId");

-- CreateIndex
CREATE INDEX "attendance_raw_punches_deviceId_punchedAt_idx" ON "attendance_raw_punches"("deviceId", "punchedAt");

-- CreateIndex
CREATE INDEX "attendance_raw_punches_companyId_employeeId_processedAt_idx" ON "attendance_raw_punches"("companyId", "employeeId", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_raw_punches_deviceId_fingerprint_key" ON "attendance_raw_punches"("deviceId", "fingerprint");

-- AddForeignKey
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_device_user_mappings" ADD CONSTRAINT "attendance_device_user_mappings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_device_user_mappings" ADD CONSTRAINT "attendance_device_user_mappings_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "attendance_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_device_user_mappings" ADD CONSTRAINT "attendance_device_user_mappings_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_device_syncs" ADD CONSTRAINT "attendance_device_syncs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_device_syncs" ADD CONSTRAINT "attendance_device_syncs_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "attendance_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_raw_punches" ADD CONSTRAINT "attendance_raw_punches_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_raw_punches" ADD CONSTRAINT "attendance_raw_punches_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "attendance_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_raw_punches" ADD CONSTRAINT "attendance_raw_punches_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_raw_punches" ADD CONSTRAINT "attendance_raw_punches_syncId_fkey" FOREIGN KEY ("syncId") REFERENCES "attendance_device_syncs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
