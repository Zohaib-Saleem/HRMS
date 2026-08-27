-- AlterEnum
ALTER TYPE "AttendanceStatus" ADD VALUE 'HALF_DAY';

-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN     "checkInLatitude" DOUBLE PRECISION,
ADD COLUMN     "checkInLongitude" DOUBLE PRECISION,
ADD COLUMN     "earlyLeaveMinutes" INTEGER,
ADD COLUMN     "overtimeMinutes" INTEGER;

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "defaultGeofenceRadiusM" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "earlyLeaveGraceMinutes" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "fullDayMinutes" INTEGER NOT NULL DEFAULT 480,
ADD COLUMN     "graceMinutes" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "halfDayMinutes" INTEGER NOT NULL DEFAULT 240,
ADD COLUMN     "locationRestrictionEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "overtimeAfterMinutes" INTEGER NOT NULL DEFAULT 480,
ADD COLUMN     "overtimeDailyCapMinutes" INTEGER NOT NULL DEFAULT 240,
ADD COLUMN     "overtimeEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "geofenceRadiusMeters" INTEGER,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;
