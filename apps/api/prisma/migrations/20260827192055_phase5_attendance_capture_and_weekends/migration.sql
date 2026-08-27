-- CreateEnum
CREATE TYPE "AttendanceMode" AS ENUM ('OFFICE', 'REMOTE');

-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN     "lateMinutes" INTEGER,
ADD COLUMN     "mode" "AttendanceMode",
ADD COLUMN     "shiftId" TEXT;

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "weekendDays" "WeekDay"[] DEFAULT ARRAY['SATURDAY', 'SUNDAY']::"WeekDay"[];

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
